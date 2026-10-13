/**
 * POST /api/list/batches/[id]/items/[itemId]/amazon-qty   body { send: boolean }
 *
 * The MFN "Qty → Amazon" switch on a batch item (Oct 4 2026).
 *   send: false — FlipLedger stops setting the Amazon quantity. Nothing is sent
 *                 to Amazon; whatever it shows now stays (managed in Seller
 *                 Central from here).
 *   send: true  — Amazon is set to the SKU's stock in FlipLedger (units bought
 *                 minus sold, all lots of the SKU). The switch is saved ON only
 *                 after Amazon accepts, so a failure leaves it OFF and nothing
 *                 half-done. An unpriced item is switched ON without a call:
 *                 its offer is created at that quantity once a price exists.
 * Works in any batch status. Never touches inventory_ledger or FIFO.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { getSellerId, getListing, getProductType, createOrUpdateListing } from '@/lib/sp-api/listingsItems';
import { mfnQuantityToPut, mfnLiveQuantity } from '@/lib/listing-send-policy';
import { skuStockInFlipLedger } from '@/lib/listing-ledger';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/list/amazon-qty');
const getDb = () => openDb();

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return {
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    refreshToken: s.refreshToken,
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function saveSwitch(itemId: number, batchId: number, send: boolean, submissionId: string | null = null) {
  const db = getDb();
  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE listing_batch_items SET send_qty_to_amazon = ?, listing_submission_id = COALESCE(?, listing_submission_id)
      WHERE id = ? AND batch_id = ?
    `).run(send ? 1 : 0, submissionId, itemId, batchId);
    db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itId = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  if (typeof body?.send !== 'boolean') {
    return NextResponse.json({ error: 'send (true/false) is required' }, { status: 400 });
  }
  const send: boolean = body.send;

  const db = getDb();
  let item: any, skuStock: number, creds: SPAPICredentials | null;
  try {
    const batch = db.prepare('SELECT channel FROM listing_batches WHERE id = ?').get(batchId) as { channel: string } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.channel !== 'MFN') {
      return NextResponse.json({ error: 'Qty → Amazon is only for MFN batches (FBA stock is counted by Amazon\'s warehouse)' }, { status: 400 });
    }
    item = db.prepare(`
      SELECT id, asin, sku, condition, list_price_cents AS listPriceCents
      FROM listing_batch_items WHERE id = ? AND batch_id = ?
    `).get(itId, batchId);
    if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    skuStock = skuStockInFlipLedger(db, item.sku);
    creds = send ? getAmazonCredentials(db) : null;
  } finally {
    db.close();
  }

  if (!send) {
    saveSwitch(itId, batchId, false);
    return NextResponse.json({ success: true, sendQtyToAmazon: false, amazonUpdated: false });
  }
  if (!item.listPriceCents || item.listPriceCents <= 0) {
    saveSwitch(itId, batchId, true);
    return NextResponse.json({
      success: true, sendQtyToAmazon: true, amazonUpdated: false, skuStock,
      reason: 'No list price yet — the offer is created with this quantity once a price is set.',
    });
  }
  if (!creds) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });

  try {
    const sellerId = await getSellerId(creds);
    const existing = await getListing(creds, sellerId, item.sku);
    const amazonQuantity = mfnQuantityToPut({ channel: 'MFN', sendQty: true, skuStock }, existing);
    const productType = existing?.productTypes?.[0]?.productType || await getProductType(creds, item.asin);
    const result = await createOrUpdateListing(creds, sellerId, {
      sku: item.sku,
      asin: item.asin,
      condition: item.condition,
      quantity: amazonQuantity,
      listPriceCents: item.listPriceCents,
      channel: 'MFN',
      productType,
    });
    if (result.status === 'INVALID') {
      const issueMsg = (result.issues || [])
        .map((i: any) => `[${i.severity}] ${i.attributeNames?.join(',') || i.code}: ${i.message}`)
        .join(' | ');
      return NextResponse.json({ success: false, error: `Amazon rejected the quantity — ${issueMsg || 'no details'}` }, { status: 502 });
    }
    saveSwitch(itId, batchId, true, result.submissionId);
    const before = existing ? mfnLiveQuantity(existing) : null;
    log.info(`${item.sku}: Qty → Amazon on, Amazon quantity ${before ?? 'new'} → ${amazonQuantity}`);
    return NextResponse.json({
      success: true, sendQtyToAmazon: true, amazonUpdated: true,
      amazonQuantityBefore: before, amazonQuantity, submissionId: result.submissionId,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 502 });
  }
}
