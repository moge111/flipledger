/**
 * Server-side per-unit fee estimate for an Amazon batch item.
 *
 * The scan form computes the fee in the browser and sends it with the add.
 * Anything that skips that path — an item added with no list price and priced
 * later in the row editor, FBA Scout, a CSV import — used to keep a stored fee
 * of 0, so the batch overstated profit. These helpers let the item routes fill
 * the fee themselves whenever an Amazon item has a price.
 */
import type Database from 'better-sqlite3';
import { getFeesEstimate } from '@/lib/sp-api/feesEstimate';
import { getListing, getSellerId } from '@/lib/sp-api/listingsItems';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { createLogger } from '@/lib/log';

const log = createLogger('listing-fees');

const AMAZON_CHANNELS = new Set(['FBA', 'MFN']);

export function isAmazonChannel(channel: string | null | undefined): boolean {
  return AMAZON_CHANNELS.has(String(channel || 'FBA').toUpperCase());
}

export function amazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('clientId','clientSecret','refreshToken','marketplaceId')"
  ).all() as { key: string; value: string }[];
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

/**
 * Per-unit fee in cents (FBA = referral + fulfillment, MFN = referral only),
 * or null when there is no price, the channel isn't Amazon, or no estimate
 * could be made. Never throws.
 */
export async function estimateItemFeeCents(
  db: Database.Database,
  item: { asin: string; channel: string; listPriceCents: number }
): Promise<number | null> {
  if (!item.asin || item.listPriceCents <= 0 || !isAmazonChannel(item.channel)) return null;
  const creds = amazonCredentials(db);
  if (!creds) return null;
  const category = (db.prepare('SELECT category FROM products WHERE asin = ? LIMIT 1').get(item.asin) as { category: string | null } | undefined)?.category ?? null;
  try {
    const isFba = String(item.channel).toUpperCase() !== 'MFN';
    const est = await getFeesEstimate(creds, item.asin, item.listPriceCents, category, isFba);
    return est.totalFeeCents > 0 ? est.totalFeeCents : null;
  } catch (err) {
    log.warn(`fee estimate failed for ${item.asin}: ${String(err)}`);
    return null;
  }
}

/** Estimate and store the fee for one batch item. Returns the stored fee or null. */
export async function refreshItemFee(db: Database.Database, batchId: number, itemId: number): Promise<number | null> {
  const row = db.prepare(`
    SELECT i.asin, i.list_price_cents, b.channel
    FROM listing_batch_items i JOIN listing_batches b ON b.id = i.batch_id
    WHERE i.id = ? AND i.batch_id = ?
  `).get(itemId, batchId) as { asin: string; list_price_cents: number; channel: string } | undefined;
  if (!row) return null;
  const fee = await estimateItemFeeCents(db, { asin: row.asin, channel: row.channel, listPriceCents: row.list_price_cents });
  if (fee == null) return null;
  db.prepare('UPDATE listing_batch_items SET estimated_fee_cents = ? WHERE id = ? AND batch_id = ?').run(fee, itemId, batchId);
  return fee;
}

/** The price on a listing's own offer (B2C, everyone), in cents, or null. */
export function listingOfferPriceCents(listing: any): number | null {
  const offers: any[] = Array.isArray(listing?.offers) ? listing.offers : [];
  const offer = offers.find((o) => o?.offerType === 'B2C' && (o?.audience?.value ?? 'ALL') === 'ALL')
    ?? offers.find((o) => o?.offerType === 'B2C')
    ?? offers[0];
  const amount = parseFloat(offer?.price?.amount ?? '');
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

/**
 * What an existing SKU sells for on Amazon right now, in cents, or null when
 * the SKU has no listing, no priced offer, or Amazon can't be reached.
 * Never throws.
 */
export async function liveOfferPriceCents(db: Database.Database, sku: string): Promise<number | null> {
  const creds = amazonCredentials(db);
  if (!creds || !sku) return null;
  try {
    const sellerId = await getSellerId(creds);
    return listingOfferPriceCents(await getListing(creds, sellerId, sku));
  } catch (err) {
    log.warn(`live price lookup failed for ${sku}: ${String(err)}`);
    return null;
  }
}
