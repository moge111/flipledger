/**
 * POST /api/list/batches/[id]/send
 *
 * Channel-aware "Send/Publish to Amazon":
 *   1. For each batch item, checks if the MSKU already exists as a listing in
 *      Seller Central. If not, creates a LISTING_OFFER_ONLY entry via the
 *      Listings Items API.
 *   2. **FBA batches only**: creates an Amazon inbound plan via the
 *      Fulfillment Inbound v2024 API so the user can ship product to a
 *      warehouse. MFN batches skip this step — once listings are ACTIVE, the
 *      batch is ready for buyers.
 *   3. Stores the submission IDs, inbound plan ID, and operation ID on the
 *      batch so the GET /status endpoint can poll them.
 *   4. Transitions the batch status: draft → sending.
 *
 * After this endpoint returns, the frontend polls GET /status to update the UI
 * as Amazon verifies listings and processes the inbound plan operation.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { clearTokenCache, isTransientNetworkError } from '@/lib/sp-api/auth';
import {
  getSellerId,
  getListing,
  getProductType,
  createOrUpdateListing,
} from '@/lib/sp-api/listingsItems';
import { createInboundPlan, setPrepDetails, getPrepDetails, getInboundOperation, type SourceAddress, type InboundPlanItem } from '@/lib/sp-api/inboundPlansV2';
import { fnskuMaxAttempts, isPropagationError, parsePrepOwnerFlips, isItemListingReady, skipMfnPut, mfnQuantityToPut, offeredQuantity } from '@/lib/listing-send-policy';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/list/batches/[id]/send');

const getDb = () => openDb();

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  // allowPartial: the user has explicitly approved shipping WITHOUT items
  // that can't list/register (gated ASIN, catalog errors, no FNSKU). Without
  // it, the send never silently drops items — it stops, reverts the batch to
  // draft, and returns 409 with the blocked list so the user decides.
  let allowPartial = false;
  try {
    const body = await request.json();
    allowPartial = body?.allowPartial === true;
  } catch { /* no body — default false */ }

  const db = getDb();

  try {
    // 1. Load the batch and validate state
    const batch = db.prepare(`
      SELECT
        id, name, status, channel, marketplace,
        ship_from_name as shipFromName,
        ship_from_address_line1 as shipFromAddressLine1,
        ship_from_city as shipFromCity,
        ship_from_state as shipFromState,
        ship_from_postal_code as shipFromPostalCode,
        ship_from_country_code as shipFromCountryCode,
        ship_from_phone as shipFromPhone,
        inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.status !== 'draft') {
      db.close();
      return NextResponse.json({ error: `Batch is not in draft status (currently: ${batch.status})` }, { status: 400 });
    }
    if (batch.channel !== 'FBA' && batch.channel !== 'MFN') {
      db.close();
      return NextResponse.json({ error: `Unknown channel: ${batch.channel}` }, { status: 400 });
    }

    // 2. Validate ship-from — all fields required for FBA (inbound plans need it).
    //    MFN listings don't need ship-from — the seller handles fulfillment and
    //    ship-from is set on individual shipments later when orders come in.
    if (batch.channel === 'FBA') {
      const required: [string, any][] = [
        ['name', batch.shipFromName],
        ['address', batch.shipFromAddressLine1],
        ['city', batch.shipFromCity],
        ['state', batch.shipFromState],
        ['postal code', batch.shipFromPostalCode],
        ['country', batch.shipFromCountryCode],
        ['phone', batch.shipFromPhone],
      ];
      for (const [label, value] of required) {
        if (!value) {
          db.close();
          return NextResponse.json({ error: `Ship-from ${label} is required for FBA. Check Settings.` }, { status: 400 });
        }
      }
    }

    // 3. Load items
    const items = db.prepare(`
      SELECT id, asin, sku, product_name as productName, condition, quantity, list_price_cents as listPriceCents,
             send_qty_to_amazon as sendQty,
             (SELECT COALESCE(SUM(il.quantity_remaining), 0) FROM inventory_ledger il WHERE il.sku = listing_batch_items.sku) AS skuStock
      FROM listing_batch_items WHERE batch_id = ?
      ORDER BY id ASC
    `).all(batchId) as any[];

    if (items.length === 0) {
      db.close();
      return NextResponse.json({ error: 'Batch has no items' }, { status: 400 });
    }

    // Block Send if any item has no list price — a $0 offer is silently accepted
    // by Amazon, becomes unsellable, and corrupts the downstream packing/placement
    // flow. Fail loudly here instead of pushing $0. (The per-item create-listing
    // path has the same guard.)
    const unpriced = items.filter((it) => !it.listPriceCents || it.listPriceCents <= 0);
    if (unpriced.length > 0) {
      db.close();
      return NextResponse.json({
        error: `Set a list price before sending — these items have no price:\n${unpriced.map((it) => `  • ${it.sku} (${it.productName || it.asin})`).join('\n')}`,
      }, { status: 400 });
    }

    // 4. Get Amazon credentials
    const creds = getAmazonCredentials(db);
    if (!creds) {
      db.close();
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }

    // Force a fresh token to avoid a stale one after a recent re-auth
    clearTokenCache();

    // 5. Transition batch → sending (so any concurrent call is blocked)
    db.prepare(`
      UPDATE listing_batches SET status = 'sending', send_error = NULL, sent_at = ?, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), batchId);

    db.close();
    // From here on, use a fresh DB handle per write to avoid holding the connection
    // while we wait on slow SP-API calls.

    // 6. Resolve seller ID (cached on first call)
    let sellerId: string;
    try {
      sellerId = await getSellerId(creds);
    } catch (err) {
      return failBatch(batchId, `Could not resolve Amazon seller ID: ${err}`);
    }

    // 7. For each item: check if listing exists, create/update it, then
    //    immediately GET the listing and classify it based on issues + offers.
    //    PUT returning "ACCEPTED" is NOT the same as the listing being live —
    //    Amazon can accept the submission but then block the offer during
    //    validation (e.g. catalog-level data errors on the target ASIN).
    const listingResults: { itemId: number; sku: string; status: string; submissionId: string | null; error: string | null }[] = [];

    itemLoop: for (const item of items) {
      // A transient NETWORK error while verifying an item must not brand the
      // item FAILED — the listing itself is fine, the connection blipped.
      // (July 8, 2026: a network brownout survived the transport-level netFetch
      // retries, and the healthy first item of a 20-item batch got marked
      // FAILED with "TypeError: fetch failed", blocking the send.) Retry the
      // whole item a few times on transient errors; only a non-network error
      // or full exhaustion marks it FAILED.
      const ITEM_TRIES = 3;
      for (let itemTry = 0; itemTry < ITEM_TRIES; itemTry++) {
        try {
          // Check if listing already exists (replenishment vs new MSKU).
          const existing = await getListing(creds, sellerId, item.sku);

          // If the listing is ALREADY inbound-ready (FNSKU assigned), do NOT
          // re-PUT it. A fresh createOrUpdateListing re-runs Amazon's full
          // validation against the merged catalog, which can FLIP a working
          // listing back to INVALID when Amazon's own catalog data for the
          // ASIN is broken (July 8, 2026: Monster High B0F974HHQ8 had a valid
          // FNSKU but re-PUTting it re-triggered stale catalog errors and
          // excluded it from the shipment). The offer already exists and is
          // registered for FBA — just use it.
          const existingFnsku = existing?.summaries?.[0]?.fnSku;
          if (existingFnsku) {
            listingResults.push({ itemId: item.id, sku: item.sku, status: 'ACTIVE', submissionId: null, error: null });
            saveListingState(batchId, item.id, { listing_status: 'ACTIVE', listing_submission_id: null, listing_error: null });
            log.info(`${item.sku} already inbound-ready (FNSKU ${existingFnsku}) — skipping re-PUT`);
            continue itemLoop;
          }

          // Qty → Amazon OFF and the MFN listing already exists: Seller Central
          // owns its quantity. Don't PUT it at all (a PUT SETS the quantity).
          if (skipMfnPut(batch.channel, !!item.sendQty, existing)) {
            listingResults.push({ itemId: item.id, sku: item.sku, status: 'ACTIVE', submissionId: null, error: null });
            saveListingState(batchId, item.id, { listing_status: 'ACTIVE', listing_submission_id: null, listing_error: null });
            log.info(`${item.sku} already on Amazon, Qty → Amazon off — skipping re-PUT`);
            continue itemLoop;
          }

          const productType = existing?.productTypes?.[0]?.productType || await getProductType(creds, item.asin);

          const result = await createOrUpdateListing(creds, sellerId, {
            sku: item.sku,
            asin: item.asin,
            condition: item.condition,
            // MFN: the SKU's FlipLedger stock when Qty → Amazon is on, else 0.
            quantity: mfnQuantityToPut({ channel: batch.channel, sendQty: !!item.sendQty, skuStock: item.skuStock }, existing),
            listPriceCents: item.listPriceCents,
            channel: batch.channel,
            productType,
          });

          // CRITICAL: check the PUT response status BEFORE polling for live state.
          // Amazon returns HTTP 200 with `status: "INVALID"` and an `issues` array
          // when required attributes are missing — there's no listing entity
          // created, and a subsequent GET will return 404. If we treat that as
          // PROCESSING, the inbound plan creation later fails with "MSKU not valid"
          // (because the listing literally doesn't exist on Amazon's side).
          if (result.status === 'INVALID') {
            const issueMsg = (result.issues || [])
              .map((i: any) => `[${i.severity}] ${i.attributeNames?.join(',') || i.code}: ${i.message}`)
              .join(' | ');
            listingResults.push({
              itemId: item.id,
              sku: item.sku,
              status: 'FAILED',
              submissionId: result.submissionId,
              error: `Listing rejected by Amazon — ${issueMsg || 'no details'}`,
            });
            saveListingState(batchId, item.id, {
              listing_status: 'FAILED',
              listing_submission_id: result.submissionId,
              listing_error: `Listing rejected by Amazon — ${issueMsg || 'no details'}`,
            });
            continue itemLoop;
          }

          // Status is ACCEPTED or VALID. Now poll to see whether the offer is
          // ready (BUYABLE for MFN, FNSKU-assigned for FBA — see classifyListing).
          const classification = await classifyListing(creds, sellerId, item.sku, batch.channel, offeredQuantity(!!item.sendQty, item.skuStock));

          listingResults.push({
            itemId: item.id,
            sku: item.sku,
            status: classification.status,
            submissionId: result.submissionId,
            error: classification.error,
          });
          saveListingState(batchId, item.id, {
            listing_status: classification.status,
            listing_submission_id: result.submissionId,
            listing_error: classification.error,
          });
          continue itemLoop;
        } catch (err) {
          if (isTransientNetworkError(err) && itemTry < ITEM_TRIES - 1) {
            const waitSec = 8 * (itemTry + 1); // 8s, 16s
            log.warn(`Network error verifying ${item.sku}, retrying item in ${waitSec}s (attempt ${itemTry + 1}/${ITEM_TRIES}):`, String(err));
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            continue;
          }
          listingResults.push({
            itemId: item.id,
            sku: item.sku,
            status: 'FAILED',
            submissionId: null,
            error: String(err),
          });
          saveListingState(batchId, item.id, {
            listing_status: 'FAILED',
            listing_submission_id: null,
            listing_error: String(err),
          });
          continue itemLoop;
        }
      }
    }

    // 8. Listings that FAILED at creation (gated ASIN, rejected attributes,
    //    hard 4xx from Amazon) must not abort the whole batch — one gated $70
    //    item failed an entire 21-item batch on July 8, 2026. But they also
    //    must not be silently dropped (user's explicit requirement). Policy:
    //      - ALL failed → failBatch (nothing to ship)
    //      - some failed + allowPartial → exclude them, proceed with the rest
    //      - some failed, no allowPartial → revert to draft + 409 with the
    //        blocked list; the UI asks the user and re-sends with allowPartial.
    const failedListings = listingResults.filter((r) => r.status === 'FAILED');
    if (failedListings.length === items.length) {
      return failBatch(batchId, `All ${items.length} listing(s) failed. First error: ${failedListings[0].error}`);
    }
    let sendableItems = items;
    if (failedListings.length > 0) {
      if (!allowPartial) {
        return blockSend(batchId, failedListings.map((f) => ({
          sku: f.sku,
          reason: f.error || 'Listing creation failed',
        })));
      }
      const failedItemIds = new Set(failedListings.map((f) => f.itemId));
      sendableItems = items.filter((i) => !failedItemIds.has(i.id));
      for (const f of failedListings) {
        saveListingState(batchId, f.itemId, {
          listing_status: 'FAILED',
          listing_submission_id: f.submissionId,
          listing_error: `Excluded from shipment (user-approved) — ${f.error}`,
        });
      }
      log.warn(`${failedListings.length} listing(s) failed at creation, user approved partial send: ${failedListings.map((f) => f.sku).join(', ')}. Proceeding with ${sendableItems.length}/${items.length}.`);
    }

    // 9. If FBA, create the inbound plan now that listings are in-flight.
    //    Amazon accepts the plan creation even if some listings are still
    //    PROCESSING — the inbound plan operation will itself take a few minutes
    //    to go from IN_PROGRESS to SUCCESS, which gives the listings time to
    //    finish verifying.
    //
    //    MFN batches skip this step — the "ready" state is just "all listings
    //    ACTIVE". No inbound plan, no warehouse shipment.
    if (batch.channel === 'FBA') {
      const sourceAddress: SourceAddress = {
        name: batch.shipFromName,
        addressLine1: batch.shipFromAddressLine1,
        city: batch.shipFromCity,
        stateOrProvinceCode: batch.shipFromState,
        postalCode: batch.shipFromPostalCode,
        countryCode: batch.shipFromCountryCode,
        phoneNumber: batch.shipFromPhone,
      };

      // Build plan items now (used after FNSKU + prep steps below).
      // prepOwner='SELLER' assumes prep classification will be NONE/ITEM_NO_PREP.
      // The smart-retry loop further down handles edge cases where Amazon
      // disagrees about prep ownership for a specific MSKU.
      const planItems: InboundPlanItem[] = sendableItems.map((i) => ({
        msku: i.sku,
        quantity: i.quantity,
        prepOwner: 'SELLER',
        labelOwner: 'SELLER',
      }));
      // Filled in during prep classification: MSKUs Amazon already classified
      // (FC_PROVIDED etc.) whose plan prepOwner must be AMAZON, not SELLER.
      let fcProvidedSkus: string[] = [];

      // Amazon's Listings Items API and Fulfillment Inbound API are different
      // services with separate caches. After PUTting a brand new MSKU, the
      // Listings service knows about it immediately, but the Inbound Plans
      // service can take 30s-10min to register the MSKU as "available for
      // inbound." When you call createInboundPlan too early, Amazon returns
      // a 400 with this specific message:
      //   "The following MSKUs are not available for inbound.
      //    If these were recently added, please try again later."
      // We retry on that exact error string with 30s delay, up to 12 attempts
      // (~6 minutes max wait), which has been observed to cover virtually all
      // cases for newly-created listings. Other 4xx errors are not retried —
      // they indicate a real problem (bad ASIN, missing attributes, etc.).
      // Step 1: Wait for FNSKUs on all new MSKUs. This is the "FBA-registered"
      // signal — without it, Amazon's prep classification system can't see
      // the MSKU yet (and createInboundPlan will reject it).
      const FNSKU_POLL_MS = 20_000;     // 20s between polls
      // When the user has already approved a partial send (allowPartial), they
      // told us "ship without stragglers" — so don't make them sit through the
      // full 10-minute FNSKU window again just to re-confirm a known-stuck item.
      // A short grace (6 × 20s = 2 min) still catches an almost-ready listing
      // but excludes a genuinely-stuck one fast. First-time sends keep the full
      // 10-min window (that's the real one-time wait for brand-new MSKUs).
      // (July 8, 2026: a stuck catalog-broken ASIN made every re-send re-wait
      // the full 10 min before excluding it — this caps the repeat cost.)
      const FNSKU_MAX_ATTEMPTS = fnskuMaxAttempts(allowPartial);
      const skusNeedingFnsku = sendableItems.map((i) => i.sku);
      log.info(`Waiting for FNSKUs on ${skusNeedingFnsku.length} MSKU(s)…`);
      // Track which MSKUs have an FNSKU (the "FBA-registered / inbound-ready"
      // signal). Once ready, a SKU stays ready across polls. Any SKU still
      // missing its FNSKU at the end is NOT available for inbound — including
      // it in createInboundPlan 400s the WHOLE plan, so we exclude it instead
      // of letting one stuck listing block the entire shipment.
      const inboundReadySkus = new Set<string>();
      // Once, mid-wait, re-PUT any listing that still has no FNSKU — catches
      // the case where the offer/fulfillment_availability silently didn't
      // attach on the first PUT (transient). Done one time to avoid PUT spam.
      let rePutDone = false;
      for (let attempt = 0; attempt < FNSKU_MAX_ATTEMPTS; attempt++) {
        for (const sku of skusNeedingFnsku) {
          if (inboundReadySkus.has(sku)) continue;
          try {
            const listing = await getListing(creds, sellerId, sku);
            const fnSku = listing?.summaries?.[0]?.fnSku;
            if (fnSku) {
              inboundReadySkus.add(sku);
              // Persist so preflight/labels see it without re-polling Amazon.
              const item = sendableItems.find((i) => i.sku === sku);
              if (item) {
                const wdb = getDb();
                try {
                  wdb.prepare('UPDATE listing_batch_items SET fnsku = ?, inbound_ready = 1, preflight_status = ? WHERE id = ?')
                    .run(fnSku, 'READY', item.id);
                } finally { wdb.close(); }
              }
            }
          } catch { /* keep polling */ }
        }
        if (inboundReadySkus.size === skusNeedingFnsku.length) {
          log.info(`All ${inboundReadySkus.size}/${skusNeedingFnsku.length} FNSKUs ready after ${(attempt + 1) * FNSKU_POLL_MS / 1000}s`);
          break;
        }
        // After ~3 polls (1 min) with stragglers, re-affirm their listings once.
        if (!rePutDone && attempt >= 3) {
          rePutDone = true;
          for (const item of sendableItems) {
            if (inboundReadySkus.has(item.sku)) continue;
            try {
              log.warn(`Re-PUTting stuck listing (no FNSKU yet): ${item.sku}`);
              await createOrUpdateListing(creds, sellerId, {
                sku: item.sku, asin: item.asin, condition: item.condition,
                quantity: item.quantity, listPriceCents: item.listPriceCents,
                channel: batch.channel, productType: await getProductType(creds, item.asin),
              });
            } catch (e) { log.warn(`Re-PUT failed for ${item.sku}:`, e); }
          }
        }
        if (attempt === FNSKU_MAX_ATTEMPTS - 1) {
          const stuck = skusNeedingFnsku.filter((s) => !inboundReadySkus.has(s));
          log.warn(`FNSKU wait timeout — ${inboundReadySkus.size}/${skusNeedingFnsku.length} ready after ${FNSKU_MAX_ATTEMPTS * FNSKU_POLL_MS / 1000}s. Not inbound-ready (will be EXCLUDED from this shipment): ${stuck.join(', ')}`);
          break;
        }
        log.info(`FNSKU wait: ${inboundReadySkus.size}/${skusNeedingFnsku.length} ready (attempt ${attempt + 1}/${FNSKU_MAX_ATTEMPTS}), waiting ${FNSKU_POLL_MS / 1000}s…`);
        await new Promise((r) => setTimeout(r, FNSKU_POLL_MS));
      }

      // Partition: ship the inbound-ready MSKUs, exclude the stuck ones (one
      // bad listing must not block the whole shipment). Excluded items keep
      // their listing (it stays on Amazon) and stay in the batch flagged so
      // the user can re-send them once they register.
      const stuckItems = sendableItems.filter((i) => !inboundReadySkus.has(i.sku));
      const readyItems = sendableItems.filter((i) => inboundReadySkus.has(i.sku));
      if (readyItems.length === 0) {
        return failBatch(batchId, `None of the ${sendableItems.length} listing(s) became inbound-ready (no FNSKU assigned). Amazon never registered them for FBA. Check each listing's offer/fulfillment status in Seller Central.`);
      }
      if (stuckItems.length > 0) {
        if (!allowPartial) {
          return blockSend(batchId, stuckItems.map((i) => {
            const lr = listingResults.find((r) => r.itemId === i.id);
            return {
              sku: i.sku,
              reason: lr?.error
                ? `No FNSKU after 10 min — Amazon hasn't registered it for FBA. Listing issue: ${lr.error}`
                : 'No FNSKU after 10 min — Amazon hasn\'t registered it for FBA yet (offer/FBA channel did not attach).',
            };
          }));
        }
        const stuckSkus = stuckItems.map((i) => i.sku);
        for (const i of stuckItems) {
          saveListingState(batchId, i.id, {
            listing_status: 'NOT_INBOUND_READY',
            listing_submission_id: null,
            listing_error: 'Excluded from shipment (user-approved): Amazon never assigned an FNSKU (offer/FBA channel did not attach). Re-send once it registers, or re-add under a fresh MSKU.',
          });
        }
        log.warn(`Proceeding with ${readyItems.length}/${sendableItems.length} inbound-ready MSKU(s), user approved partial send. Excluded: ${stuckSkus.join(', ')}`);
      }

      // Step 2: classify prep details for each MSKU at the account level —
      // AFTER FNSKUs are assigned. Setting prep BEFORE FNSKU assignment leaves
      // brand-new MSKUs as prepCategory='UNKNOWN' (the classification doesn't
      // stick), and the inbound plan operation later fails with FBA_INB_0182.
      //
      // Default each MSKU to NONE/ITEM_NO_PREP — safe for typical retail-
      // arbitrage resold goods. Once classified, Amazon's prepOwnerConstraint
      // becomes SELLER_ONLY (the seller still applies FNSKU labels even when
      // no other prep is needed), which matches our planItems above.
      // Pre-flight (listing-preflight.ts) classifies prep at ADD time, so by
      // send time most/all MSKUs are already classified and propagated. Read
      // back what Amazon has on file and only SET the ones still UNKNOWN —
      // when nothing needs setting, the 90s propagation wait is skipped
      // entirely and send drops straight to createInboundPlan.
      let prepItemsToSet = readyItems;
      try {
        const existingPrep = await getPrepDetails(creds, readyItems.map((i) => i.sku));
        const classified = new Set(
          existingPrep.filter((p) => (p.prepCategory || 'UNKNOWN') !== 'UNKNOWN').map((p) => p.msku)
        );
        prepItemsToSet = readyItems.filter((i) => !classified.has(i.sku));
        if (prepItemsToSet.length === 0) {
          log.info(`Prep already classified for all ${readyItems.length} MSKU(s) (front-loaded at add time) — skipping prep set + propagation wait`);
        }
      } catch (err) {
        log.warn('getPrepDetails pre-check failed — setting prep for all items:', String(err));
      }

      log.info('Setting prep classification for', prepItemsToSet.length, 'MSKU(s)…');
      try {
        const prepResult = prepItemsToSet.length === 0
          ? { operationId: '', skipped: [] as string[] }
          : await setPrepDetails(creds, prepItemsToSet.map((i) => ({
          msku: i.sku,
          prepCategory: 'NONE',
          prepTypes: ['ITEM_NO_PREP'],
        })));
        // Items Amazon already classified (e.g. FC_PROVIDED) were dropped from
        // the prep call — they don't need ours, but their plan prepOwner must
        // be AMAZON (Amazon provides the prep), not SELLER.
        if (prepResult.skipped.length > 0) {
          fcProvidedSkus = prepResult.skipped;
          log.info(`${prepResult.skipped.length} MSKU(s) already Amazon-classified (prepOwner→AMAZON): ${prepResult.skipped.join(', ')}`);
        }

        // Poll until the prep operation finishes (usually 3-10 seconds).
        // operationId is '' when every item was already classified (nothing to set).
        const PREP_POLL_MS = 3000;
        const PREP_MAX_ATTEMPTS = 20; // ~60s max
        let prepDone = !prepResult.operationId;
        let prepProblems: any[] = [];
        for (let attempt = 0; prepResult.operationId && attempt < PREP_MAX_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, PREP_POLL_MS));
          const op = await getInboundOperation(creds, prepResult.operationId);
          if (op.operationStatus === 'SUCCESS') {
            prepDone = true;
            prepProblems = op.operationProblems || [];
            log.info(`Prep classification SUCCESS after ${(attempt + 1) * PREP_POLL_MS / 1000}s` +
              (prepProblems.length > 0 ? ` (with ${prepProblems.length} per-MSKU problem(s): ${JSON.stringify(prepProblems)})` : ''));
            break;
          }
          if (op.operationStatus === 'FAILED') {
            log.warn('Prep classification FAILED:', JSON.stringify(op.operationProblems));
            break;
          }
        }
        if (!prepDone) {
          log.warn('Prep classification did not finish within timeout — proceeding anyway');
        }

        // CRITICAL: even after operationStatus=SUCCESS, the prep classification
        // takes ~30-90s to propagate from Amazon's catalog service to the
        // inbound-plans validation service. Calling createInboundPlan too soon
        // returns a planId that then async-fails with FBA_INB_0182 "Prep
        // classification for this SKU was missing." Empirically a 90-second
        // wait clears it; we use a wait + a small retry loop on the create
        // call itself in case the propagation is slower for some accounts.
        // Only wait for propagation when we actually SET something this run —
        // prep classified earlier (at add time via preflight) has already
        // propagated, so the wait would be pure dead time.
        if (prepDone && prepItemsToSet.length > 0) {
          const PREP_PROPAGATION_WAIT_MS = 90_000;
          log.info(`Waiting ${PREP_PROPAGATION_WAIT_MS / 1000}s for prep classification to propagate to Inbound Plans service…`);
          await new Promise((r) => setTimeout(r, PREP_PROPAGATION_WAIT_MS));
        }

        // VERIFY prep actually stuck. If setPrepDetails ran before the FNSKU
        // fully settled, Amazon silently leaves prepCategory='UNKNOWN', and
        // createInboundPlan then fails the OPERATION with FBA_INB_0182 "Prep
        // classification missing" — which the downstream retry can't fix by
        // re-creating the plan. Read it back and re-set any UNKNOWN MSKUs until
        // they flip to NONE. (This is the exact failure mode that blocked
        // batch 26 across three full send attempts on June 22, 2026.)
        const readySkus = readyItems.map((i) => i.sku);
        for (let v = 0; v < 4; v++) {
          let prep: Array<{ msku: string; prepCategory: string }> = [];
          try { prep = await getPrepDetails(creds, readySkus); } catch { break; }
          const unknown = prep.filter((p) => (p.prepCategory || 'UNKNOWN') === 'UNKNOWN').map((p) => p.msku);
          if (unknown.length === 0) {
            log.info(`Prep verified (NONE) for all ${readySkus.length} MSKU(s)`);
            break;
          }
          log.warn(`Prep still UNKNOWN for ${unknown.length} MSKU(s): ${unknown.join(', ')} — re-setting (round ${v + 1}/4)`);
          try {
            const reop = await setPrepDetails(creds, unknown.map((m) => ({ msku: m, prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] })));
            for (let i = 0; reop.operationId && i < 20; i++) {
              await new Promise((r) => setTimeout(r, 3000));
              const o = await getInboundOperation(creds, reop.operationId);
              if (o.operationStatus === 'SUCCESS' || o.operationStatus === 'FAILED') break;
            }
          } catch (e) { log.warn('prep re-set failed:', e); }
          await new Promise((r) => setTimeout(r, 15_000));
        }
      } catch (err) {
        log.warn('setPrepDetails failed (non-fatal, continuing):', err);
      }

      let planResult;
      const MAX_RETRIES = 24;
      const RETRY_DELAY_MS = 30_000;
      let lastErr: any = null;
      // Mutable copy: if Amazon tells us specific MSKUs need prepOwner=SELLER,
      // we flip those entries and retry once. Filtered to the inbound-ready
      // MSKUs only — stuck listings were excluded above so they can't 400 the
      // whole plan.
      const itemsForPlan: InboundPlanItem[] = planItems.filter((p) => inboundReadySkus.has(p.msku));
      // Items Amazon had classified FC_PROVIDED still ship with prepOwner=SELLER.
      // Amazon's own prep service is discontinued in this destination region
      // ("Amazon prep and labeling service is discontinued ... ownerType:
      // PREP_OWNER"), so AMAZON is never a valid prep owner here — the seller
      // preps everything. SELLER is already the planItems default, so these
      // just stay SELLER; the createInboundPlan retry loop below flips any
      // item to NONE if Amazon reports it needs no prep. (fcProvidedSkus kept
      // for logging only — do NOT set their prepOwner to AMAZON.)
      void fcProvidedSkus;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          planResult = await createInboundPlan(creds, {
            name: batch.name,
            sourceAddress,
            destinationMarketplaces: [creds.marketplaceId],
            items: itemsForPlan,
          });
          break;
        } catch (err) {
          lastErr = err;
          const errStr = String(err);

          // Case A: MSKU still propagating in Inbound Plans system. Wait + retry.
          // Amazon uses several different error phrasings depending on which
          // service handles the request — see isPropagationError in
          // src/lib/listing-send-policy.ts (unit-tested there).

          // Case B: Specific MSKUs have the wrong prepOwner. Parse Amazon's
          // per-MSKU complaints and flip the affected MSKUs accordingly.
          // Retry immediately — payload mismatch, not propagation.
          const { needsPrep, doesntNeedPrep: trueDoesntNeed } = parsePrepOwnerFlips(errStr);

          if (needsPrep.length > 0 || trueDoesntNeed.length > 0) {
            if (needsPrep.length > 0) {
              log.info(`Inbound plan: flipping to SELLER prep: ${needsPrep.join(', ')}`);
            }
            if (trueDoesntNeed.length > 0) {
              log.info(`Inbound plan: flipping to NONE prep: ${trueDoesntNeed.join(', ')}`);
            }
            for (const it of itemsForPlan) {
              if (needsPrep.includes(it.msku)) it.prepOwner = 'SELLER';
              if (trueDoesntNeed.includes(it.msku)) it.prepOwner = 'NONE';
            }
            // Retry immediately — no delay
            continue;
          }

          if (!isPropagationError(errStr)) {
            return failBatch(batchId, `Inbound plan creation failed: ${err}`);
          }
          if (attempt === MAX_RETRIES - 1) break;
          log.info(`Inbound plan: MSKUs still propagating (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${RETRY_DELAY_MS / 1000}s…`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      if (!planResult) {
        return failBatch(
          batchId,
          `Inbound plan creation failed after ${MAX_RETRIES} retries (~${(MAX_RETRIES * RETRY_DELAY_MS) / 60_000} min). Amazon never registered the MSKUs in the Inbound system. Last error: ${lastErr}`
        );
      }

      // 9b. VERIFY the plan-creation operation actually succeeds — and auto-retry
      //     on FBA_INB_0182.
      //
      //     createInboundPlan returns a planId + operationId SYNCHRONOUSLY (Amazon
      //     accepted the request), but the plan is built by an ASYNC operation that
      //     can then fail with FBA_INB_0182 "Prep classification for this SKU was
      //     missing" — when prep classification hasn't yet propagated from the
      //     catalog service to the Inbound Plans service for brand-new MSKUs. That
      //     async failure is NOT caught by the createInboundPlan retry loop above
      //     (which only sees synchronous throws), so historically the batch just
      //     failed. Here we poll the operation; on a prep failure we re-affirm prep,
      //     wait longer, and create a FRESH plan — looping until it succeeds.
      const pollPlanOp = async (operationId: string): Promise<{ status: string; problems: any[] }> => {
        const POLL_MS = 5000;
        const MAX = 72; // ~6 min
        for (let a = 0; a < MAX; a++) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          const op = await getInboundOperation(creds, operationId);
          if (op.operationStatus === 'SUCCESS') return { status: 'SUCCESS', problems: op.operationProblems || [] };
          if (op.operationStatus === 'FAILED') return { status: 'FAILED', problems: op.operationProblems || [] };
        }
        return { status: 'TIMEOUT', problems: [] };
      };

      const PLAN_OP_ROUNDS = 5;
      for (let round = 0; round < PLAN_OP_ROUNDS; round++) {
        const opResult = await pollPlanOp(planResult.operationId);
        // SUCCESS → done. TIMEOUT → leave IN_PROGRESS and let /status finish polling.
        if (opResult.status !== 'FAILED') break;

        const problemStr = JSON.stringify(opResult.problems || []);
        const isPrepError = problemStr.includes('FBA_INB_0182') || problemStr.includes('Prep classification');
        if (!isPrepError) {
          return failBatch(batchId, `Inbound plan operation failed: ${problemStr}`);
        }
        if (round === PLAN_OP_ROUNDS - 1) {
          return failBatch(batchId, `Inbound plan operation failed after ${PLAN_OP_ROUNDS} prep-retry rounds — prep classification never propagated to the Inbound service. ${problemStr}`);
        }

        // Re-affirm prep classification, wait for it to propagate (escalating),
        // then create a FRESH inbound plan and re-verify next loop.
        log.info(`Plan operation failed on prep (round ${round + 1}/${PLAN_OP_ROUNDS}) — re-affirming prep + retrying with a fresh plan…`);
        try {
          const pr = await setPrepDetails(creds, readyItems.map((i) => ({ msku: i.sku, prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] })));
          for (let a = 0; pr.operationId && a < 20; a++) {
            await new Promise((r) => setTimeout(r, 3000));
            const op = await getInboundOperation(creds, pr.operationId);
            if (op.operationStatus === 'SUCCESS' || op.operationStatus === 'FAILED') break;
          }
        } catch (e) {
          log.warn('re-affirm prep failed (non-fatal):', e);
        }
        const waitMs = 120_000 + round * 60_000; // 2min, 3min, 4min…
        log.info(`Waiting ${waitMs / 1000}s for prep to propagate before re-creating the plan…`);
        await new Promise((r) => setTimeout(r, waitMs));

        try {
          planResult = await createInboundPlan(creds, {
            name: batch.name,
            sourceAddress,
            destinationMarketplaces: [creds.marketplaceId],
            items: itemsForPlan,
          });
        } catch (err) {
          return failBatch(batchId, `Inbound plan re-creation failed: ${err}`);
        }
      }

      // 10. Persist the plan ID and operation ID on the batch
      const db3 = getDb();
      try {
        db3.prepare(`
          UPDATE listing_batches SET
            inbound_plan_id = ?,
            inbound_operation_id = ?,
            plan_status = 'IN_PROGRESS',
            updated_at = ?
          WHERE id = ?
        `).run(planResult.inboundPlanId, planResult.operationId, new Date().toISOString(), batchId);
      } finally {
        db3.close();
      }

      return NextResponse.json({
        success: true,
        channel: 'FBA',
        inboundPlanId: planResult.inboundPlanId,
        operationId: planResult.operationId,
        listings: listingResults,
      });
    }

    // MFN path: no inbound plan. The status endpoint will transition the
    // batch to 'ready' once all listings have gone ACTIVE.
    return NextResponse.json({
      success: true,
      channel: 'MFN',
      listings: listingResults,
    });
  } catch (err) {
    try { db.close(); } catch {}
    return failBatch(batchId, `Unexpected error: ${err}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function saveListingState(
  batchId: number,
  itemId: number,
  state: { listing_status: string; listing_submission_id: string | null; listing_error: string | null }
) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batch_items SET
        listing_status = ?,
        listing_submission_id = ?,
        listing_error = ?,
        listing_updated_at = ?
      WHERE id = ? AND batch_id = ?
    `).run(
      state.listing_status,
      state.listing_submission_id,
      state.listing_error,
      new Date().toISOString(),
      itemId,
      batchId
    );
  } finally {
    db.close();
  }
}

/**
 * Classify a listing after a PUT. Channel-aware: FBA and MFN have different
 * "ready" signals because FBA listings without inventory never reach BUYABLE.
 *
 *   FBA: ACTIVE = FNSKU populated + no fatal errors. The listing is FBA-
 *        registered and ready to accept inventory; customers will see it as
 *        BUYABLE only after physical units arrive at the warehouse, which
 *        happens after this batch ships and Amazon receives it.
 *
 *   MFN: ACTIVE = summary.status contains 'BUYABLE'. The seller manages
 *        their own stock so the listing should be live as soon as Amazon
 *        verifies it.
 *
 * We deliberately DO NOT treat issues[].severity === "ERROR" as fatal here.
 * Amazon surfaces catalog-level validation errors (e.g. "child variation
 * needs size attribute") that often don't block the FBA inbound or sale
 * flows — they're displayed as warnings and clear on their own as the
 * catalog catches up.
 */
async function classifyListing(
  creds: any,
  sellerId: string,
  sku: string,
  channel: 'FBA' | 'MFN' = 'FBA',
  quantity = 1
): Promise<{ status: 'ACTIVE' | 'PROCESSING' | 'FAILED'; error: string | null }> {
  try {
    const listing = await getListing(creds, sellerId, sku);
    if (!listing) {
      // Listing doesn't exist yet (Amazon hasn't fully registered the PUT).
      // Treat as processing.
      return { status: 'PROCESSING', error: null };
    }

    const summary = listing.summaries?.[0];
    const fnSku: string | undefined = summary?.fnSku;

    // Capture any ERROR-severity issues as informational — displayed to the
    // user but not auto-fatal.
    const issues: any[] = listing.issues || [];
    const errorIssues = issues.filter((i: any) => (i?.severity || '').toUpperCase() === 'ERROR');
    const errorNote = errorIssues.length > 0
      ? errorIssues.map((i: any) => i.message).join('; ')
      : null;

    if (channel === 'FBA') {
      // For FBA, FNSKU presence is the "FBA-registered, ready for inbound"
      // signal. The listing won't be BUYABLE until inventory arrives, but
      // it's ready in every sense the batch flow cares about.
      if (fnSku) {
        return { status: 'ACTIVE', error: errorNote };
      }
      // No fnSku yet — even with ERROR-severity issues, do NOT insta-fail.
      // This classify runs seconds after the PUT, when NO listing has its
      // FNSKU yet (assignment takes 10s-10min), so failing on error-issues
      // here denies those listings the FNSKU wait every other listing gets.
      // Many "errors" are stale catalog-side validation (e.g. legacy
      // attributes that no longer apply to the product type) that don't
      // block FNSKU assignment at all. The FNSKU-wait stage downstream is
      // the real arbiter: if the FNSKU never arrives, the item surfaces
      // there with this errorNote attached (July 8, 2026 incident).
      return { status: 'PROCESSING', error: errorNote };
    }

    // MFN: BUYABLE is the right signal — seller manages stock so the listing
    // should go live immediately once Amazon validates. A 0-qty item never
    // goes BUYABLE: it is done once its out-of-stock offer is registered.
    if (isItemListingReady('MFN', quantity, listing)) {
      return { status: 'ACTIVE', error: errorNote };
    }
    return { status: 'PROCESSING', error: errorNote };
  } catch (err) {
    // On any API error, default to processing and log the error.
    return { status: 'PROCESSING', error: `Could not verify listing status: ${err}` };
  }
}

/**
 * Some items can't ship but the rest can. Revert the batch to draft (nothing
 * committed on Amazon yet — listings stay, no inbound plan exists) and return
 * 409 with the blocked list. The frontend asks the user whether to re-send
 * with allowPartial=true (ship without them) or fix the items first. This is
 * deliberately NOT a failure — the user decides, we never drop items silently.
 */
function blockSend(batchId: number, blockedItems: { sku: string; reason: string }[]): NextResponse {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batches SET status = 'draft', send_error = NULL, sent_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), batchId);
  } finally {
    db.close();
  }
  log.warn(`Blocked pending user decision — ${blockedItems.length} item(s) not shippable: ${blockedItems.map((b) => b.sku).join(', ')}`);
  return NextResponse.json({
    error: `${blockedItems.length} item(s) can't ship yet`,
    blockedItems,
    canRetryPartial: true,
  }, { status: 409 });
}

function failBatch(batchId: number, errorMsg: string): NextResponse {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batches SET
        status = 'failed',
        send_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(errorMsg, new Date().toISOString(), batchId);
  } finally {
    db.close();
  }
  return NextResponse.json({ error: errorMsg }, { status: 500 });
}
