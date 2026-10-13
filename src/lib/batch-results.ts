/**
 * What happened to a listing batch after it was sent: units received, sold
 * and returned, how fast they sold, and planned vs actual profit.
 *
 * Received (FBA): Amazon's per-SKU QuantityShipped / QuantityReceived from the
 * v0 shipment items endpoint, cached in batch_receipts. The v2024 "list
 * shipments" call 403s for this account, so shipments come from the plan
 * itself and the v0 confirmation id (FBA19…) from a box id, as the label code
 * does. MFN batches have no receiving step: received = sent.
 *
 * Sold: exact when the batch item owns its cost lot (lot quantity − remaining,
 * as FIFO consumed it). For older items without a lot link, the SKU's sales
 * after the send date, capped at the batch quantity.
 *
 * Which sales: each SKU's sales after a batch's send date are handed to that
 * SKU's batch items oldest-first, so two batches of one SKU never claim the
 * same sale. Timing, returns and profit come from those sales. A sale of
 * stock that was already on hand before the batch can be counted towards it;
 * that is the limit of the attribution without per-unit tracking.
 */
import type Database from 'better-sqlite3';
import { spApiRequest } from './sp-api/auth';
import type { SPAPICredentials } from './sp-api/types';
import { lineSettledRefundExpr, mfnShippingCreditExpr, mfnShippingCostExpr } from './accounting-sql';
import { createLogger } from './log';

const log = createLogger('batch-results');

// ── Receipts ─────────────────────────────────────────────────────────────────

interface ReceiptLine { confirmationId: string; sku: string; shipped: number; received: number }

async function fetchShipmentItems(creds: SPAPICredentials, confirmationId: string): Promise<ReceiptLine[]> {
  // getShipmentItemsByShipmentId returns every item of the shipment in one
  // response. It also returns a NextToken, but ignores one sent back: paging on
  // it re-requests the same page forever (found live: an endless 429 loop).
  const data = await spApiRequest(creds, `/fba/inbound/v0/shipments/${encodeURIComponent(confirmationId)}/items`, { MarketplaceId: creds.marketplaceId });
  return (data?.payload?.ItemData ?? []).map((it: { SellerSKU: string; QuantityShipped: number; QuantityReceived: number }) => ({
    confirmationId, sku: it.SellerSKU, shipped: Number(it.QuantityShipped) || 0, received: Number(it.QuantityReceived) || 0,
  }));
}

/** Refresh one FBA batch's received quantities from Amazon. */
export async function syncBatchReceipts(db: Database.Database, creds: SPAPICredentials, batchId: number): Promise<number> {
  const batch = db.prepare(`SELECT inbound_plan_id FROM listing_batches WHERE id = ? AND channel = 'FBA'`).get(batchId) as { inbound_plan_id: string | null } | undefined;
  if (!batch?.inbound_plan_id) return 0;
  const plan = await spApiRequest(creds, `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inbound_plan_id)}`);
  const lines: ReceiptLine[] = [];
  const statuses = new Map<string, string>();
  for (const sh of plan?.shipments ?? []) {
    const boxes = await spApiRequest(creds, `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(batch.inbound_plan_id)}/shipments/${encodeURIComponent(sh.shipmentId)}/boxes`);
    const boxId: string | undefined = boxes?.boxes?.[0]?.boxId;
    const conf = boxId?.match(/^(FBA[A-Z0-9]+?)U\d{6}$/)?.[1];
    if (!conf) continue; // shipment not packed yet
    statuses.set(conf, sh.status ?? '');
    lines.push(...await fetchShipmentItems(creds, conf));
    await new Promise(r => setTimeout(r, 1500)); // the v0 inbound endpoints throttle hard
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO batch_receipts (batch_id, shipment_confirmation_id, sku, shipped, received, shipment_status, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shipment_confirmation_id, sku) DO UPDATE SET batch_id = excluded.batch_id, shipped = excluded.shipped,
      received = excluded.received, shipment_status = excluded.shipment_status, fetched_at = excluded.fetched_at
  `);
  db.transaction(() => { for (const l of lines) upsert.run(batchId, l.confirmationId, l.sku, l.shipped, l.received, statuses.get(l.confirmationId) ?? '', now); })();
  return lines.length;
}

/**
 * Refresh receipts for FBA batches sent in the last 150 days that are not yet
 * fully received and were not checked in the last 20 hours. Runs daily.
 */
export async function refreshBatchReceipts(db: Database.Database, creds: SPAPICredentials): Promise<{ checked: number; errors: number }> {
  const batches = db.prepare(`
    SELECT b.id FROM listing_batches b
    WHERE b.channel = 'FBA' AND b.inbound_plan_id IS NOT NULL AND b.sent_at >= date('now', '-150 days')
      AND b.status NOT IN ('draft', 'failed', 'sending')
      AND NOT EXISTS (SELECT 1 FROM batch_receipts r WHERE r.batch_id = b.id AND r.fetched_at >= datetime('now', '-20 hours'))
      AND (NOT EXISTS (SELECT 1 FROM batch_receipts r WHERE r.batch_id = b.id)
           OR EXISTS (SELECT 1 FROM batch_receipts r WHERE r.batch_id = b.id AND r.shipment_status NOT IN ('CLOSED', 'DELETED', 'CANCELLED')))
  `).all() as { id: number }[];
  let errors = 0;
  for (const b of batches) {
    try { await syncBatchReceipts(db, creds, b.id); }
    catch (err) { errors++; log.warn(`Batch ${b.id} receipts: ${err instanceof Error ? err.message : err}`); }
  }
  return { checked: batches.length, errors };
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface BatchItemResult {
  itemId: number; sku: string; asin: string; productName: string | null;
  sent: number; received: number | null; sold: number; returned: number; remaining: number;
  soldExact: boolean;
  plannedProfitPerUnit: number; actualProfitPerUnit: number | null;
  plannedProfit: number; actualProfit: number; revenue: number;
  daysTo50: number | null; daysTo80: number | null; lastSale: string | null;
}
export interface BatchResult {
  batchId: number; name: string; channel: string; status: string; sentAt: string;
  sent: number; received: number | null; sold: number; returned: number;
  sellThrough: number; plannedProfit: number; plannedProfitSold: number; actualProfit: number; revenue: number;
  daysTo50: number | null; daysTo80: number | null; receiptsCheckedAt: string | null;
  items: BatchItemResult[];
}

interface SaleLine { id: number; sku: string; date: string; qty: number; revenue: number; profit: number; refundedUnits: number }

const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));

export function computeBatchResults(db: Database.Database, batchId?: number): BatchResult[] {
  const batches = db.prepare(`
    SELECT id, name, channel, status, sent_at FROM listing_batches
    WHERE sent_at IS NOT NULL AND status NOT IN ('draft', 'failed')
    ORDER BY sent_at
  `).all() as { id: number; name: string; channel: string; status: string; sent_at: string }[];
  if (!batches.length) return [];

  const items = db.prepare(`
    SELECT i.id, i.batch_id, i.sku, i.asin, i.product_name, i.quantity, i.list_price_cents, i.buy_price_cents,
           COALESCE(i.estimated_fee_cents, 0) AS fee, COALESCE(i.estimated_ship_cents, 0) AS ship,
           i.listing_status, l.quantity AS lot_qty, l.quantity_remaining AS lot_remaining
    FROM listing_batch_items i
    LEFT JOIN inventory_ledger l ON l.id = i.inventory_ledger_id
    WHERE i.batch_id IN (${batches.map(() => '?').join(',')})
      AND COALESCE(i.listing_status, '') NOT IN ('NOT_INBOUND_READY', 'FAILED')
  `).all(...batches.map(b => b.id)) as {
    id: number; batch_id: number; sku: string; asin: string; product_name: string | null; quantity: number;
    list_price_cents: number; buy_price_cents: number; fee: number; ship: number; listing_status: string | null;
    lot_qty: number | null; lot_remaining: number | null;
  }[];
  if (!items.length) return [];

  // Every sale of every batch SKU, with per-line profit on the same basis as the Sales pages.
  const skus = [...new Set(items.map(i => i.sku))];
  const sales = db.prepare(`
    SELECT oi.id, oi.sku, o.purchase_date AS date, oi.quantity AS qty,
      oi.total_price + ${mfnShippingCreditExpr()} AS revenue,
      oi.total_price + ${mfnShippingCreditExpr()}
        - COALESCE(ofees.total_fee * oi.total_price * 1.0 / NULLIF(ot.order_total, 0), 0)
        - COALESCE(oi.cogs_per_unit, 0) * oi.quantity
        - ${mfnShippingCostExpr()}
        - ${lineSettledRefundExpr()} AS profit,
      MIN(oi.quantity, (SELECT COALESCE(SUM(r.quantity), 0) FROM refunds r WHERE r.order_id = oi.order_id AND r.sku = oi.sku)) AS refundedUnits
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN (SELECT order_id, -SUM(amount) AS total_fee FROM fee_details WHERE order_id IS NOT NULL AND order_id != '' GROUP BY order_id) ofees
      ON ofees.order_id = oi.order_id
    LEFT JOIN (SELECT order_id, SUM(total_price) AS order_total FROM order_items GROUP BY order_id) ot ON ot.order_id = oi.order_id
    WHERE oi.sku IN (${skus.map(() => '?').join(',')})
      AND o.status NOT IN ('Canceled', 'Cancelled')
      AND COALESCE(o.fulfillment_channel, '') != 'MCF'
    ORDER BY o.purchase_date, oi.id
  `).all(...skus) as SaleLine[];

  const salesBySku = new Map<string, SaleLine[]>();
  for (const s of sales) salesBySku.set(s.sku, [...(salesBySku.get(s.sku) ?? []), s]);
  const receipts = db.prepare(`SELECT batch_id, sku, SUM(received) AS received, MAX(fetched_at) AS fetched FROM batch_receipts GROUP BY batch_id, sku`).all() as
    { batch_id: number; sku: string; received: number; fetched: string }[];
  const received = new Map(receipts.map(r => [`${r.batch_id}|${r.sku}`, r]));
  const batchById = new Map(batches.map(b => [b.id, b]));

  // Hand each SKU's sales to its batch items oldest-first.
  const itemResult = new Map<number, BatchItemResult>();
  const itemSaleDates = new Map<number, string[]>();
  const bySku = new Map<string, typeof items>();
  for (const i of items) bySku.set(i.sku, [...(bySku.get(i.sku) ?? []), i]);
  for (const [sku, skuItems] of bySku) {
    skuItems.sort((a, b) => batchById.get(a.batch_id)!.sent_at.localeCompare(batchById.get(b.batch_id)!.sent_at) || a.id - b.id);
    const queue = (salesBySku.get(sku) ?? []).map(s => ({ ...s, left: s.qty }));
    for (const it of skuItems) {
      const b = batchById.get(it.batch_id)!;
      const soldExact = it.lot_qty != null;
      const lotSold = soldExact ? Math.max(0, (it.lot_qty ?? 0) - (it.lot_remaining ?? 0)) : null;
      const rec = b.channel === 'FBA' ? (received.get(`${b.id}|${sku}`)?.received ?? null) : it.quantity;
      // Never more than arrived: an older item's lot can also hold other stock.
      const cap = Math.min(it.quantity, lotSold ?? it.quantity, rec ?? it.quantity);
      let taken = 0, revenue = 0, profit = 0, returned = 0;
      const saleDates: string[] = [];
      for (const s of queue) {
        if (taken >= cap) break;
        if (s.left <= 0 || s.date < b.sent_at) continue;
        const use = Math.min(s.left, cap - taken);
        const share = use / s.qty;
        revenue += s.revenue * share;
        profit += s.profit * share;
        returned += Math.round(s.refundedUnits * share);
        for (let k = 0; k < use; k++) saleDates.push(s.date);
        s.left -= use;
        taken += use;
      }
      const sold = Math.min(lotSold ?? taken, cap);
      itemSaleDates.set(it.id, saleDates.slice(0, sold));
      const plannedPerUnit = it.list_price_cents - it.buy_price_cents - it.fee - it.ship;
      const at = (frac: number) => { const n = Math.ceil(it.quantity * frac); return n > 0 && saleDates.length >= n ? days(b.sent_at, saleDates[n - 1]) : null; };
      itemResult.set(it.id, {
        itemId: it.id, sku, asin: it.asin, productName: it.product_name,
        sent: it.quantity, received: rec, sold, returned, remaining: Math.max(0, (rec ?? it.quantity) - sold),
        soldExact,
        plannedProfitPerUnit: plannedPerUnit,
        actualProfitPerUnit: taken ? Math.round(profit / taken) : null,
        plannedProfit: plannedPerUnit * it.quantity,
        actualProfit: taken ? Math.round(profit * (sold / taken)) : 0,
        revenue: taken ? Math.round(revenue * (sold / taken)) : 0,
        daysTo50: at(0.5), daysTo80: at(0.8), lastSale: saleDates.at(-1) ?? null,
      });
    }
  }

  const out: BatchResult[] = [];
  for (const b of batches) {
    if (batchId != null && b.id !== batchId) continue;
    const its = items.filter(i => i.batch_id === b.id).map(i => itemResult.get(i.id)!).filter(Boolean);
    if (!its.length) continue;
    const sum = (f: (r: BatchItemResult) => number) => its.reduce((s, r) => s + f(r), 0);
    const sent = sum(r => r.sent), sold = sum(r => r.sold);
    // Batch-level timing: the day cumulative units sold crossed 50% / 80% of units sent.
    const unitDates = its.flatMap(r => itemSaleDates.get(r.itemId) ?? []);
    unitDates.sort();
    const at = (frac: number) => { const n = Math.ceil(sent * frac); return n > 0 && unitDates.length >= n ? days(b.sent_at, unitDates[n - 1]) : null; };
    const recs = its.map(r => r.received);
    const receiptRow = db.prepare(`SELECT MAX(fetched_at) AS f FROM batch_receipts WHERE batch_id = ?`).get(b.id) as { f: string | null };
    out.push({
      batchId: b.id, name: b.name, channel: b.channel, status: b.status, sentAt: b.sent_at,
      sent, received: recs.every(r => r == null) ? null : recs.reduce<number>((s, r) => s + (r ?? 0), 0),
      sold, returned: sum(r => r.returned), sellThrough: sent ? sold / sent : 0,
      plannedProfit: sum(r => r.plannedProfit),
      plannedProfitSold: sum(r => r.plannedProfitPerUnit * r.sold),
      actualProfit: sum(r => r.actualProfit), revenue: sum(r => r.revenue),
      daysTo50: at(0.5), daysTo80: at(0.8), receiptsCheckedAt: receiptRow?.f ?? null,
      items: its,
    });
  }
  return out.reverse();
}
