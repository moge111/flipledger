/**
 * Pre-flight validation for listing batch items — runs at ADD/scan time so
 * problems surface in the batch UI immediately instead of 10 minutes into a
 * send (July 8, 2026 hardening: batch 28 took ~3 hours because gating,
 * catalog defects, prep classification, and FNSKU registration were all
 * discovered one at a time, mid-send).
 *
 * For every item in a draft batch this checks and persists:
 *   - Gating: GET /listings/2021-08-01/restrictions → GATED + approval link
 *   - Listing state: FNSKU assigned (FBA) / BUYABLE (MFN) → READY; an MFN
 *     item with quantity 0 is READY once Amazon holds its out-of-stock offer
 *   - Catalog defects: ERROR-severity issues that persist without an FNSKU
 *     (the "demand-but-reject" pattern — Monster High B0F974HHQ8,
 *     Giganotosaurus B0G3QFR36W) → CATALOG_ISSUE
 *   - Prep classification: reads it back, and SETS it (NONE/ITEM_NO_PREP) as
 *     soon as the FNSKU exists — so by send time prep is already classified
 *     and propagated, and the send skips its 90s prep wait entirely.
 *
 * Also self-heals: items that have a price but whose listing was never
 * created (auto-create failed or predates the feature) get their listing PUT
 * here.
 *
 * Everything is best-effort per item — one item's API error never blocks the
 * others (the same exclude-and-proceed philosophy as the send flow).
 */
import Database from 'better-sqlite3';
import { spApiRequest } from '@/lib/sp-api/auth';
import {
  getSellerId,
  getListing,
  getProductType,
  createOrUpdateListing,
  CONDITION_MAP,
} from '@/lib/sp-api/listingsItems';
import { getPrepDetails, setPrepDetails } from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { isItemListingReady, mfnQuantityToPut, offeredQuantity, mfnLiveQuantity } from '@/lib/listing-send-policy';

const log = createLogger('listing-preflight');

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

export type PreflightStatus =
  | 'UNPRICED'        // no list price — listing deliberately not created yet
  | 'GATED'           // Amazon restrictions: needs approval / not eligible
  | 'FAILED'          // listing PUT was rejected (see listing_error)
  | 'READY'           // FBA: FNSKU assigned; MFN: BUYABLE
  | 'CATALOG_ISSUE'   // no FNSKU + persistent ERROR issues (likely Amazon-side catalog defect)
  | 'STUCK'           // no FNSKU after 10+ min, no visible errors
  | 'PENDING';        // listing created, Amazon still propagating

export interface PreflightDetail {
  restriction?: {
    status: 'OK' | 'APPROVAL_REQUIRED' | 'NOT_ELIGIBLE';
    reasons: string[];
    approvalUrl: string | null;
    checkedAt: string;
  };
  errorIssues?: string[];
  catalogDefect?: boolean;   // the demand-but-reject signature
  mfnAvailable?: number;     // MFN: units Amazon shows available on the offer
  rePutAt?: string;          // one-time re-PUT of a listing whose offer never attached
}

export interface PreflightItemResult {
  itemId: number;
  sku: string;
  status: PreflightStatus;
  fnsku: string | null;
  prepCategory: string | null;
  detail: PreflightDetail;
}

export interface PreflightSummary {
  ready: number;
  pending: number;
  gated: number;
  catalogIssue: number;
  stuck: number;
  failed: number;
  unpriced: number;
}

/** Minutes since an ISO timestamp; Infinity when missing/unparseable. */
const REPUT_AFTER_MIN = 8;

function minutesSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60_000;
}

/**
 * The "demand-but-reject" catalog-defect signature: Amazon reports an
 * attribute as invalid/unacceptable on OUR listing when the bad value
 * actually lives in Amazon's own catalog contribution store (codes 90244 /
 * "We can't accept the X you entered"). Not seller-fixable — needs a Seller
 * Support catalog case; blocks FNSKU generation. Exported for tests.
 */
export function isCatalogDefectIssue(issues: string[]): boolean {
  return issues.some((m) =>
    /\b90244\b/.test(m) ||
    /we can't accept the .* you (entered|provided)/i.test(m) ||
    /does not belong.*ignoring/i.test(m)
  );
}

/**
 * Check gating for an ASIN+condition. Returns OK when Amazon reports no
 * restrictions. APPROVAL_REQUIRED includes the Seller Central approval link
 * when Amazon provides one.
 */
export async function checkRestriction(
  creds: SPAPICredentials,
  sellerId: string,
  asin: string,
  condition: string
): Promise<NonNullable<PreflightDetail['restriction']>> {
  const conditionType = CONDITION_MAP[condition] || 'new_new';
  const data = await spApiRequest(creds, '/listings/2021-08-01/restrictions', {
    asin,
    sellerId,
    conditionType,
    marketplaceIds: creds.marketplaceId,
  });
  const restrictions: any[] = data?.restrictions || [];
  if (restrictions.length === 0) {
    return { status: 'OK', reasons: [], approvalUrl: null, checkedAt: new Date().toISOString() };
  }
  const reasons: string[] = [];
  let approvalUrl: string | null = null;
  let status: 'APPROVAL_REQUIRED' | 'NOT_ELIGIBLE' = 'NOT_ELIGIBLE';
  for (const r of restrictions) {
    for (const reason of r.reasons || []) {
      if (reason.message) reasons.push(reason.message);
      if (reason.reasonCode === 'APPROVAL_REQUIRED') status = 'APPROVAL_REQUIRED';
      for (const link of reason.links || []) {
        if (link.resource && !approvalUrl) approvalUrl = link.resource;
      }
    }
  }
  // Fallback approval deep link — Amazon doesn't always include one.
  if (status === 'APPROVAL_REQUIRED' && !approvalUrl) {
    approvalUrl = `https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=${encodeURIComponent(asin)}`;
  }
  return { status, reasons, approvalUrl, checkedAt: new Date().toISOString() };
}

/**
 * Run pre-flight for every item in a draft batch. Persists per-item results
 * on listing_batch_items and returns them plus a batch summary.
 */
export async function preflightBatch(batchId: number): Promise<{
  ran: boolean;
  reason?: string;
  items: PreflightItemResult[];
  summary: PreflightSummary;
}> {
  const empty: PreflightSummary = { ready: 0, pending: 0, gated: 0, catalogIssue: 0, stuck: 0, failed: 0, unpriced: 0 };

  const db = getDb();
  let batch: any, items: any[], creds: SPAPICredentials | null;
  try {
    batch = db.prepare('SELECT id, status, channel FROM listing_batches WHERE id = ?').get(batchId);
    if (!batch) return { ran: false, reason: 'Batch not found', items: [], summary: empty };
    if (batch.status !== 'draft') return { ran: false, reason: `Batch status is ${batch.status}`, items: [], summary: empty };
    if (batch.channel !== 'FBA' && batch.channel !== 'MFN') {
      return { ran: false, reason: `Channel ${batch.channel} not supported`, items: [], summary: empty };
    }
    items = db.prepare(`
      SELECT id, asin, sku, condition, quantity,
             list_price_cents as listPriceCents,
             listing_status as listingStatus,
             listing_error as listingError,
             listing_updated_at as listingUpdatedAt,
             created_at as createdAt,
             fnsku, inbound_ready as inboundReady,
             prep_category as prepCategory,
             preflight_detail as preflightDetail,
             send_qty_to_amazon as sendQty,
             (SELECT COALESCE(SUM(il.quantity_remaining), 0) FROM inventory_ledger il WHERE il.sku = listing_batch_items.sku) AS skuStock
      FROM listing_batch_items WHERE batch_id = ? ORDER BY id ASC
    `).all(batchId) as any[];
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) return { ran: false, reason: 'Amazon SP-API credentials not configured', items: [], summary: empty };
  if (items.length === 0) return { ran: true, items: [], summary: empty };

  let sellerId: string;
  try {
    sellerId = await getSellerId(creds);
  } catch (err) {
    return { ran: false, reason: `Could not resolve seller ID: ${err}`, items: [], summary: empty };
  }

  const results: PreflightItemResult[] = [];

  for (const item of items) {
    const detail: PreflightDetail = safeParseDetail(item.preflightDetail);
    let status: PreflightStatus = 'PENDING';
    let fnsku: string | null = item.fnsku || null;
    let listingStatus: string | null = item.listingStatus || null;
    let listingError: string | null = item.listingError || null;
    let listingUpdatedAt: string | null = item.listingUpdatedAt || null;

    try {
      // 1. Gating — check once per item, and re-check items previously GATED
      //    (so an approval the user obtained flips the badge without a re-add).
      const needsRestrictionCheck =
        !detail.restriction ||
        detail.restriction.status !== 'OK' ||
        /listing limitations/i.test(listingError || '');
      if (needsRestrictionCheck) {
        try {
          detail.restriction = await checkRestriction(creds, sellerId, item.asin, item.condition);
        } catch (err) {
          // Leave prior restriction info; gating is best-effort.
          log.warn(`restriction check failed for ${item.sku}:`, String(err));
        }
      }

      // 2. Listing state — self-heal missing listings, then read FNSKU/BUYABLE.
      if (!item.listPriceCents || item.listPriceCents <= 0) {
        status = 'UNPRICED';
      } else {
        // Never PUT a gated ASIN — the PUT would just fail with "listing
        // limitations". Surface the badge and stop.
        const gated = detail.restriction && detail.restriction.status !== 'OK';

        const listing = fnsku ? null : await getListing(creds, sellerId, item.sku);
        if (fnsku) {
          // Already known inbound-ready — no need to re-poll Amazon.
          status = 'READY';
        } else if (!listing && !gated && listingStatus !== 'FAILED') {
          // Listing doesn't exist yet — create it now (front-load the PUT).
          try {
            const productType = await getProductType(creds, item.asin);
            const result = await createOrUpdateListing(creds, sellerId, {
              sku: item.sku,
              asin: item.asin,
              condition: item.condition,
              quantity: mfnQuantityToPut({ channel: batch.channel, sendQty: !!item.sendQty, skuStock: item.skuStock }, null),
              listPriceCents: item.listPriceCents,
              channel: batch.channel,
              productType,
            });
            if (result.status === 'INVALID') {
              const issueMsg = (result.issues || [])
                .map((i: any) => `[${i.severity}] ${i.attributeNames?.join(',') || i.code}: ${i.message}`)
                .join(' | ');
              listingStatus = 'FAILED';
              listingError = `Listing rejected by Amazon — ${issueMsg || 'no details'}`;
            } else {
              listingStatus = 'PROCESSING';
              listingError = null;
            }
            // The registration clock starts at this PUT, not when the item was
            // added — an item that sat gated for a day isn't STUCK seconds after
            // its listing is finally created.
            listingUpdatedAt = new Date().toISOString();
          } catch (err) {
            listingStatus = 'FAILED';
            listingError = String(err);
          }
        } else if (listing) {
          const summary = listing.summaries?.[0];
          fnsku = summary?.fnSku || null;

          const issues: any[] = listing.issues || [];
          const errorIssues = issues
            .filter((i: any) => (i?.severity || '').toUpperCase() === 'ERROR')
            .map((i: any) => String(i.message || i.code || ''));
          detail.errorIssues = errorIssues.length > 0 ? errorIssues : undefined;
          detail.catalogDefect = errorIssues.length > 0 && isCatalogDefectIssue(errorIssues) ? true : undefined;

          // MFN qty 0 is ready once registered out of stock (never BUYABLE).
          const isReady = isItemListingReady(batch.channel, offeredQuantity(!!item.sendQty, item.skuStock), listing);
          detail.mfnAvailable = batch.channel === 'MFN' ? mfnLiveQuantity(listing) : undefined;
          if (isReady) {
            status = 'READY';
            listingStatus = 'ACTIVE';
            listingError = errorIssues.length > 0 ? errorIssues.join('; ') : null;
          } else {
            listingError = errorIssues.length > 0 ? errorIssues.join('; ') : listingError;
            // Listing registered but Amazon never attached the offer (offers []
            // and no FNSKU, no errors). A second PUT often kicks it — the send
            // flow does the same mid-wait. Once per item, then the clock restarts.
            const noOffer = (listing.offers || []).length === 0;
            if (
              noOffer && !gated && errorIssues.length === 0 && !detail.rePutAt &&
              minutesSince(listingUpdatedAt || item.createdAt) > REPUT_AFTER_MIN
            ) {
              try {
                const productType = await getProductType(creds, item.asin);
                const result = await createOrUpdateListing(creds, sellerId, {
                  sku: item.sku,
                  asin: item.asin,
                  condition: item.condition,
                  quantity: mfnQuantityToPut({ channel: batch.channel, sendQty: !!item.sendQty, skuStock: item.skuStock }, listing),
                  listPriceCents: item.listPriceCents,
                  channel: batch.channel,
                  productType,
                });
                detail.rePutAt = new Date().toISOString();
                listingUpdatedAt = detail.rePutAt;
                log.info(`re-PUT ${item.sku} (no offer after ${REPUT_AFTER_MIN} min): ${result.status}`);
              } catch (err) {
                log.warn(`re-PUT failed for ${item.sku}:`, String(err));
              }
            }
          }
        }

        // Classify the not-ready cases by precedence.
        if (status !== 'READY') {
          const ageMin = minutesSince(listingUpdatedAt || item.createdAt);
          if (gated) {
            status = 'GATED';
          } else if (listingStatus === 'FAILED') {
            status = 'FAILED';
          } else if ((detail.errorIssues?.length || 0) > 0 && ageMin > 5) {
            status = 'CATALOG_ISSUE';
          } else if (ageMin > 10) {
            status = 'STUCK';
          } else {
            status = 'PENDING';
          }
        }
      }
    } catch (err) {
      // Network/API error on this item — keep whatever we knew, mark PENDING.
      log.warn(`check failed for ${item.sku}:`, String(err));
      status = fnsku ? 'READY' : 'PENDING';
    }

    results.push({
      itemId: item.id,
      sku: item.sku,
      status,
      fnsku,
      prepCategory: item.prepCategory || null,
      detail,
    });

    // Persist this item's result (fresh handle per write, same as send flow).
    const wdb = getDb();
    try {
      wdb.prepare(`
        UPDATE listing_batch_items SET
          fnsku = ?,
          inbound_ready = ?,
          preflight_status = ?,
          preflight_detail = ?,
          preflight_checked_at = ?,
          listing_status = COALESCE(?, listing_status),
          listing_error = ?,
          listing_updated_at = ?
        WHERE id = ? AND batch_id = ?
      `).run(
        fnsku,
        status === 'READY' ? 1 : 0,
        status,
        JSON.stringify(detail),
        new Date().toISOString(),
        listingStatus,
        listingError,
        listingUpdatedAt,
        item.id,
        batchId
      );
    } finally {
      wdb.close();
    }
  }

  // 3. Prep classification (FBA only) — read back what Amazon has on file,
  //    and SET prep for any FNSKU'd MSKU still UNKNOWN. Doing this here means
  //    prep is classified + propagated long before send. Best-effort; the
  //    next preflight run reads back the result.
  if (batch.channel === 'FBA') {
    const fnskud = results.filter((r) => r.fnsku);
    if (fnskud.length > 0) {
      try {
        const prep = await getPrepDetails(creds, fnskud.map((r) => r.sku));
        const byMsku = new Map(prep.map((p) => [p.msku, p.prepCategory || 'UNKNOWN']));
        const wdb = getDb();
        try {
          for (const r of fnskud) {
            const cat = byMsku.get(r.sku) || 'UNKNOWN';
            r.prepCategory = cat;
            wdb.prepare('UPDATE listing_batch_items SET prep_category = ? WHERE id = ?').run(cat, r.itemId);
          }
        } finally {
          wdb.close();
        }
        const unknown = fnskud.filter((r) => (r.prepCategory || 'UNKNOWN') === 'UNKNOWN');
        if (unknown.length > 0) {
          // Fire the classification; don't poll the operation — the next
          // preflight run (or the send's verify loop) confirms it stuck.
          const res = await setPrepDetails(creds, unknown.map((r) => ({
            msku: r.sku,
            prepCategory: 'NONE',
            prepTypes: ['ITEM_NO_PREP'],
          })));
          log.info(`batch ${batchId}: prep classification fired for ${unknown.length} MSKU(s)` +
            (res.skipped.length > 0 ? ` (${res.skipped.length} already Amazon-classified: ${res.skipped.join(', ')})` : ''));
        }
      } catch (err) {
        log.warn(`prep read/set failed (non-fatal):`, String(err));
      }
    }
  }

  const summary: PreflightSummary = { ...empty };
  for (const r of results) {
    if (r.status === 'READY') summary.ready++;
    else if (r.status === 'PENDING') summary.pending++;
    else if (r.status === 'GATED') summary.gated++;
    else if (r.status === 'CATALOG_ISSUE') summary.catalogIssue++;
    else if (r.status === 'STUCK') summary.stuck++;
    else if (r.status === 'FAILED') summary.failed++;
    else if (r.status === 'UNPRICED') summary.unpriced++;
  }

  return { ran: true, items: results, summary };
}

function safeParseDetail(raw: string | null | undefined): PreflightDetail {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
