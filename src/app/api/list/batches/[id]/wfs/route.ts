/**
 * WFS batch shipments.
 *
 * GET  /api/list/batches/[id]/wfs                    → the batch's Walmart shipments
 * POST /api/list/batches/[id]/wfs {action:'send'}    → create the Walmart inbound order
 * POST /api/list/batches/[id]/wfs {action:'cancel'}  → cancel it (before any box is received)
 * POST /api/list/batches/[id]/wfs {action:'publish'} → seller-fulfilled batch: set each SKU's Walmart
 *                                                       quantity to its stock in FlipLedger
 *
 * Send creates one inbound order for the whole batch; Walmart answers with one
 * or more shipments (it may split the units across fulfillment centers). The
 * batch moves draft → shipping. Cancel moves it back to draft; cost lots are
 * untouched either way (they record what was bought, not what was shipped).
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import {
  buildInboundOrderBody, cancelInboundOrder, cancelParcelBooking, createInboundOrder,
  DEFAULT_DELIVERY_DAYS, walmartErrorMessage, type WfsBatchItem,
} from '@/lib/walmart-api/wfsInbound';
import {
  batchShipFrom, insertShipments, loadWfsBatch, shipmentView, walmartShipmentStatus, type WfsShipmentRow,
} from '@/lib/wfs-batch';
import { skuStockInFlipLedger } from '@/lib/listing-ledger';
import { walmartFetch } from '@/lib/walmart-api/auth';

const log = createLogger('api/list/batches/wfs');

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const db = openDb({ readonly: true });
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    // Only the current inbound order: a cancelled send's shipments stay on file but aren't shown.
    const rows = db.prepare('SELECT * FROM wfs_batch_shipments WHERE batch_id = ? AND inbound_order_id = ? ORDER BY id')
      .all(batchId, found.batch.inbound_order_id ?? '') as WfsShipmentRow[];
    return NextResponse.json({
      inboundOrderId: found.batch.inbound_order_id,
      shipments: rows.map(r => shipmentView(r, walmartShipmentStatus(db, r.shipment_id))),
    });
  } finally {
    db.close();
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const body = await req.json().catch(() => ({}));
  if (body.action === 'send') return send(batchId);
  if (body.action === 'cancel') return cancel(batchId);
  if (body.action === 'publish') return publish(batchId);
  return NextResponse.json({ error: "action must be 'send', 'cancel' or 'publish'" }, { status: 400 });
}

async function send(batchId: number) {
  const creds = getWalmartCredentials();
  if (!creds) return NextResponse.json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, { status: 400 });

  const db = openDb();
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    const batch = found.batch;
    if (batch.status !== 'draft') return NextResponse.json({ error: `The batch is already ${batch.status}.` }, { status: 400 });
    if (batch.is_holding) return NextResponse.json({ error: 'Walmart stock to send is a waiting list, not a shipment. Move the units into a WFS batch and send that.' }, { status: 400 });
    const from = batchShipFrom(batch);
    if (!from.ok) return NextResponse.json({ error: from.error }, { status: 400 });

    const settingUp = db.prepare(`
      SELECT sku, walmart_setup_status AS status FROM listing_batch_items
      WHERE batch_id = ? AND walmart_setup_status IS NOT NULL AND walmart_setup_status != 'READY'
    `).all(batchId) as { sku: string; status: string }[];
    if (settingUp.length) {
      return NextResponse.json({
        error: `Walmart is still setting up ${settingUp.map(r => `${r.sku} (${r.status === 'FAILED' ? 'failed — retry or remove it' : 'in progress'})`).join(', ')}. Send once every item is ready.`,
      }, { status: 409 });
    }
    const rows = db.prepare(`
      SELECT sku, gtin, product_name AS productName, quantity FROM listing_batch_items WHERE batch_id = ?
    `).all(batchId) as (WfsBatchItem & { gtin: string | null })[];
    const noBarcode = rows.filter(r => !r.gtin).map(r => r.sku);
    if (noBarcode.length) return NextResponse.json({ error: `No barcode on file for ${noBarcode.join(', ')}. Remove and re-add them.` }, { status: 400 });

    const inboundOrderId = `FL${batchId}-${Date.now()}`;
    const expected = new Date(Date.now() + DEFAULT_DELIVERY_DAYS * 86400000).toISOString();
    let orderBody;
    try {
      orderBody = buildInboundOrderBody({
        inboundOrderId, returnAddress: from.address, expectedDeliveryDate: expected,
        items: rows.map(r => ({ sku: r.sku, gtin: r.gtin!, productName: r.productName || r.sku, quantity: r.quantity })),
      });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }

    let shipments;
    try {
      shipments = await createInboundOrder(creds, orderBody);
    } catch (err) {
      const msg = walmartErrorMessage(err);
      log.warn(`batch ${batchId}: inbound order ${inboundOrderId} failed: ${msg}`);
      db.prepare('UPDATE listing_batches SET send_error = ?, updated_at = ? WHERE id = ?').run(msg, new Date().toISOString(), batchId);
      return NextResponse.json({ error: `Walmart didn't accept the shipment: ${msg}` }, { status: 502 });
    }
    if (shipments.length === 0) {
      return NextResponse.json({ error: `Walmart accepted inbound order ${inboundOrderId} but returned no shipments. Check Seller Center → WFS → Shipments before trying again.` }, { status: 502 });
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      insertShipments(db, batchId, inboundOrderId, shipments!, now);
      db.prepare(`UPDATE listing_batches SET status = 'shipping', inbound_order_id = ?, sent_at = ?, send_error = NULL, updated_at = ? WHERE id = ?`)
        .run(inboundOrderId, now, now, batchId);
    })();
    log.info(`batch ${batchId}: inbound order ${inboundOrderId} → ${shipments.map(s => `${s.shipmentId} (${s.shipTo.fcName ?? s.shipTo.city})`).join(', ')}`);
    return NextResponse.json({ success: true, inboundOrderId, shipments });
  } finally {
    db.close();
  }
}

async function cancel(batchId: number) {
  const creds = getWalmartCredentials();
  if (!creds) return NextResponse.json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, { status: 400 });

  const db = openDb();
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    const batch = found.batch;
    if (batch.status !== 'shipping' || !batch.inbound_order_id) {
      return NextResponse.json({ error: 'There is no Walmart shipment to cancel on this batch.' }, { status: 400 });
    }
    const shipments = db.prepare("SELECT * FROM wfs_batch_shipments WHERE batch_id = ? AND status != 'CANCELLED'").all(batchId) as WfsShipmentRow[];

    // A booked FedEx label is paid for: cancel those bookings first (Walmart
    // allows it within 24 hours). If one can't be cancelled, stop.
    for (const s of shipments.filter(x => x.status === 'BOOKED')) {
      try {
        await cancelParcelBooking(creds, s.shipment_id);
      } catch (err) {
        return NextResponse.json({
          error: `Couldn't cancel the FedEx booking on shipment ${s.shipment_id}: ${walmartErrorMessage(err)}. Nothing else was cancelled.`,
        }, { status: 502 });
      }
    }
    try {
      await cancelInboundOrder(creds, batch.inbound_order_id);
    } catch (err) {
      return NextResponse.json({ error: `Walmart didn't cancel the shipment: ${walmartErrorMessage(err)}` }, { status: 502 });
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE wfs_batch_shipments SET status = 'CANCELLED', updated_at = ? WHERE batch_id = ?").run(now, batchId);
      db.prepare(`UPDATE listing_batches SET status = 'draft', inbound_order_id = NULL, sent_at = NULL, updated_at = ? WHERE id = ?`).run(now, batchId);
    })();
    log.info(`batch ${batchId}: inbound order ${batch.inbound_order_id} cancelled`);
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}

/**
 * Seller-fulfilled batch: set each SKU's Walmart quantity to its stock in
 * FlipLedger (all lots' remaining units = bought minus sold), the same rule as
 * Amazon's MFN "Qty → Amazon" switch. Items with the switch off are left alone.
 * Can be run again after edits (batch stays 'ready').
 */
async function publish(batchId: number) {
  const creds = getWalmartCredentials();
  if (!creds) return NextResponse.json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, { status: 400 });
  const db = openDb();
  try {
    const found = loadWfsBatch(db, batchId, ['WMT_SF']);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    if (!['draft', 'ready'].includes(found.batch.status)) return NextResponse.json({ error: `The batch is ${found.batch.status}.` }, { status: 400 });
    const items = db.prepare(`
      SELECT sku, walmart_setup_status AS setup, send_qty_to_amazon AS sendQty FROM listing_batch_items WHERE batch_id = ?
    `).all(batchId) as { sku: string; setup: string | null; sendQty: number }[];
    if (items.length === 0) return NextResponse.json({ error: 'The batch has no items.' }, { status: 400 });
    const notReady = items.filter(i => i.setup && i.setup !== 'READY').map(i => i.sku);
    if (notReady.length) {
      return NextResponse.json({ error: `Walmart is still setting up ${[...new Set(notReady)].join(', ')}. Publish once every item is ready.` }, { status: 409 });
    }

    const skus = [...new Set(items.filter(i => i.sendQty).map(i => i.sku))];
    const results: { sku: string; quantity: number; ok: boolean; error?: string }[] = [];
    for (const sku of skus) {
      const quantity = skuStockInFlipLedger(db, sku);
      try {
        await walmartFetch(creds, '/inventory', { method: 'PUT', params: { sku }, body: { sku, quantity: { unit: 'EACH', amount: quantity } } });
        results.push({ sku, quantity, ok: true });
      } catch (err) {
        results.push({ sku, quantity, ok: false, error: walmartErrorMessage(err) });
      }
    }
    const failed = results.filter(r => !r.ok);
    const now = new Date().toISOString();
    if (failed.length === 0) {
      db.prepare("UPDATE listing_batches SET status = 'ready', sent_at = COALESCE(sent_at, ?), send_error = NULL, updated_at = ? WHERE id = ?").run(now, now, batchId);
    } else {
      db.prepare('UPDATE listing_batches SET send_error = ?, updated_at = ? WHERE id = ?')
        .run(failed.map(f => `${f.sku}: ${f.error}`).join('; '), now, batchId);
    }
    log.info(`batch ${batchId}: published ${results.map(r => `${r.sku}=${r.quantity}${r.ok ? '' : ' (failed)'}`).join(', ')}`);
    return NextResponse.json({ success: failed.length === 0, results }, { status: failed.length ? 502 : 200 });
  } finally {
    db.close();
  }
}
