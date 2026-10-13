/**
 * POST /api/list/batches/[id]/items/[itemId]/create-listing
 *
 * Creates (or updates) the Amazon listing for a SINGLE batch item, immediately
 * — so the user can fire this right after adding each product instead of
 * waiting to create every listing at "Send" time.
 *
 * Why this matters: the slow part of the Send flow is Amazon-side propagation
 * AFTER the listing PUT — FNSKU generation (~minutes), prep classification,
 * and inbound-plan registration. By PUTting each listing as it's added, those
 * propagate in the background while the user keeps scanning, so the final Send
 * (which still creates the inbound plan) finds the FNSKUs already ready and
 * completes quickly.
 *
 * This is additive and best-effort: it never modifies the item's own data
 * (SKU/cost/etc.), and a failure just marks listing_status=FAILED — the item
 * stays in the batch and the regular Send flow will retry. The Send route
 * already handles pre-existing listings (it GETs then updates in place), so
 * pre-creating here doesn't conflict with it.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { getSellerId, getListing, getProductType, createOrUpdateListing } from '@/lib/sp-api/listingsItems';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { mfnQuantityToPut } from '@/lib/listing-send-policy';

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

function saveStatus(itemId: number, batchId: number, status: string, submissionId: string | null, error: string | null) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batch_items SET listing_status = ?, listing_submission_id = ?, listing_error = ?, listing_updated_at = ?
      WHERE id = ? AND batch_id = ?
    `).run(status, submissionId, error, new Date().toISOString(), itemId, batchId);
  } finally {
    db.close();
  }
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itId = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  // force=1 re-pushes a known-good listing (e.g. a corrected price) even after
  // the batch is sent/ACTIVE. Used to fix listings on a ready batch.
  const force = new URL(_request.url).searchParams.get('force') === '1';

  const db = getDb();
  let batch: any, item: any, creds: SPAPICredentials | null;
  try {
    batch = db.prepare('SELECT id, status, channel FROM listing_batches WHERE id = ?').get(batchId);
    if (!batch) { db.close(); return NextResponse.json({ error: 'Batch not found' }, { status: 404 }); }
    // Only pre-create while the batch is still being built. Once it's sending/
    // ready/etc the Send flow owns listing creation — unless force re-push.
    if (!force && batch.status !== 'draft') { db.close(); return NextResponse.json({ skipped: true, reason: `batch status is ${batch.status}` }); }
    if (batch.channel !== 'FBA' && batch.channel !== 'MFN') { db.close(); return NextResponse.json({ skipped: true, reason: `channel ${batch.channel}` }); }

    item = db.prepare(`
      SELECT id, asin, sku, condition, quantity, list_price_cents as listPriceCents, listing_status as listingStatus,
             send_qty_to_amazon AS sendQty,
             (SELECT COALESCE(SUM(il.quantity_remaining), 0) FROM inventory_ledger il WHERE il.sku = listing_batch_items.sku) AS skuStock
      FROM listing_batch_items WHERE id = ? AND batch_id = ?
    `).get(itId, batchId);
    if (!item) { db.close(); return NextResponse.json({ error: 'Item not found' }, { status: 404 }); }

    // Already live — nothing to do (idempotent; avoids redundant PUTs) — unless force re-push.
    if (!force && item.listingStatus === 'ACTIVE') { db.close(); return NextResponse.json({ skipped: true, reason: 'already active', status: 'ACTIVE' }); }

    // NEVER push a $0 price to Amazon. Auto-create-on-add can fire before the
    // user has typed a list price; a $0 offer is silently accepted by Amazon and
    // then can't be sold (and breaks downstream packing/placement). Wait until a
    // real price exists — Send re-checks this too. Applies even with force.
    if (!item.listPriceCents || item.listPriceCents <= 0) {
      db.close();
      return NextResponse.json({ skipped: true, reason: 'no list price yet — not creating a $0 listing' });
    }

    creds = getAmazonCredentials(db);
    db.close();
  } catch (err) {
    try { db.close(); } catch {}
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (!creds) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });

  // Mark in-progress so the UI shows a chip while Amazon works.
  saveStatus(itId, batchId, 'PROCESSING', null, null);

  try {
    const sellerId = await getSellerId(creds);
    const existing = await getListing(creds, sellerId, item.sku);
    // Qty → Amazon ON: the SKU's stock in FlipLedger. OFF: 0 for a new offer,
    // Amazon's own count for an existing one (a PUT SETS the quantity).
    const offerQty = mfnQuantityToPut({ channel: batch.channel, sendQty: !!item.sendQty, skuStock: item.skuStock }, existing);
    const productType = existing?.productTypes?.[0]?.productType || await getProductType(creds, item.asin);

    const result = await createOrUpdateListing(creds, sellerId, {
      sku: item.sku,
      asin: item.asin,
      condition: item.condition,
      quantity: offerQty,
      listPriceCents: item.listPriceCents,
      channel: batch.channel,
      productType,
    });

    if (result.status === 'INVALID') {
      const issueMsg = (result.issues || [])
        .map((i: any) => `[${i.severity}] ${i.attributeNames?.join(',') || i.code}: ${i.message}`)
        .join(' | ');
      const err = `Listing rejected by Amazon — ${issueMsg || 'no details'}`;
      saveStatus(itId, batchId, 'FAILED', result.submissionId, err);
      return NextResponse.json({ status: 'FAILED', error: err });
    }

    // Submitted OK. FNSKU/BUYABLE will propagate over the next few minutes;
    // the Send flow (or a later status check) confirms it. Leave as PROCESSING.
    saveStatus(itId, batchId, 'PROCESSING', result.submissionId, null);
    return NextResponse.json({ status: 'PROCESSING', submissionId: result.submissionId });
  } catch (err) {
    saveStatus(itId, batchId, 'FAILED', null, String(err));
    return NextResponse.json({ status: 'FAILED', error: String(err) }, { status: 200 });
  }
}
