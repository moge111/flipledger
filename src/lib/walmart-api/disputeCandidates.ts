/**
 * Walmart dispute candidate detection.
 *
 * Walmart auto-refunds customers when a return is initiated. For WFS-fulfilled
 * items, the seller can DISPUTE that refund within ~30 days if the return
 * reason indicates customer-caused damage, theft (LOST_AFTER_DELIVERY), wrong
 * item returned (INCORRECT_ITEM), or carrier-side issues. Successful disputes
 * result in Walmart reimbursing the seller for the refund amount.
 *
 * This module scans the existing `refunds` table (no new API call needed —
 * we already sync Walmart returns), classifies each refund as eligible /
 * maybe / not_eligible for dispute, and stores candidates in
 * `walmart_dispute_candidates`.
 *
 * NOTE: This is detection only. Filing the dispute itself happens via
 * Seller Center deeplink — Walmart's dispute API is undocumented and
 * inconsistent across seller accounts.
 */
import { openDb } from '@/lib/db-conn';

// Walmart's published dispute rule (Marketplace Learn, "WFS customer returns,
// reimbursement and dispute processes", verified July 2026): disputes must be
// submitted within 45 DAYS of the dispute window opening. Openings vary by
// scenario (RTS tracking delivery for damaged/wrong item, settlement date for
// non-returnable charges); we approximate from the refund date.
const DISPUTE_WINDOW_DAYS = 45;

// WALMART-FAULT returns — WFS policy says Walmart covers these: "damaged in
// transit, lost in transit, late arrival, incorrect item, unable to deliver,
// damaged shipping box, or lost after delivery." These are the real dispute
// targets.
const HIGH_ELIGIBILITY_REASONS = new Set([
  'LOST_AFTER_DELIVERY',     // Customer claims package never arrived (porch piracy or fraud)
  'LOST_IN_TRANSIT',         // Carrier lost it
  'INCORRECT_ITEM',          // Customer claims wrong item received
  'DAMAGED',                 // Damaged in transit / damaged shipping box — WFS handled it
  'ARRIVED_LATE',            // "Late arrival" is on Walmart's own fault list
]);

// SELLER/CUSTOMER-FAULT returns — WFS policy is explicit that SELLERS cover
// "wrong size, poor quality, missing parts, not as described, defective
// items, customer refusals, changed mind, lower price elsewhere." Reason-based
// disputes on these lose; they're only recoverable via the lost-in-pipeline
// rule (unit vanished) which takes precedence above.
const NOT_ELIGIBLE_REASONS = new Set([
  'NO_LONGER_WANTED',
  'LOWER_PRICE',
  'BETTER_PRICE',
  'CHANGED_MIND',
  'FOUND_ELSEWHERE',
  'DIFFICULT_TO_SETUP_NOT_COMPATIBLE',
  'DEFECTIVE',
  'NOT_AS_DESCRIBED_PICTURED',
  'MISSING_PARTS',
]);

const getDb = () => openDb();

// How long Walmart's recon reports typically take to settle a return.
// If a refund is younger than this and we don't see a financial event yet,
// classify as "pending settlement" rather than "no deduction" — the recon
// row may simply not exist yet.
const RECON_SETTLEMENT_LAG_DAYS = 14;

// A settled WFS return whose unit never reappears (no RTV fee, no current
// stock, no post-refund sale) for this many days is presumed lost in
// Walmart's returns pipeline. Two sources agree on the timing:
// - Walmart's own case reply (15145714, June 2026): lost returns are
//   auto-reimbursed if not delivered/processed within 60 days, posting can
//   take up to 90 further days.
// - Marketplace Learn (verified July 2026): the "item not processed / no
//   reimbursement seen" dispute window OPENS 90 days after the return was
//   initiated. Filing before day 90 earns a canned "wait" reply.
const LOST_IN_PIPELINE_DAYS = 90;
// Disputes must be submitted within 45 days of the window opening → the
// claim is actionable days 90–135 after the return.
const LOST_CLAIM_WINDOW_DAYS = 135;

function alreadyReimbursed(creditCents: number, creditDate: string, refundCents: number): { eligibility: 'not_eligible'; reasons: string[]; windowDays?: number } {
  const reasons = [`Walmart already reimbursed this lost return: $${(creditCents / 100).toFixed(2)} LostReturnAdjustment on ${creditDate}. Do not file.`];
  if (creditCents < refundCents) {
    reasons.push(`Paid $${(creditCents / 100).toFixed(2)} of the $${(refundCents / 100).toFixed(2)} refund. Walmart values lost returns at its own restock value, not the refund amount.`);
  }
  return { eligibility: 'not_eligible', reasons };
}

function classifyEligibility(
  reason: string,
  fulfillmentChannel: string | null,
  refundDate: string,
  hasRefundEvent: boolean,
  unitLostInPipeline: boolean
): { eligibility: 'eligible' | 'maybe' | 'not_eligible'; reasons: string[]; windowDays?: number } {
  const tags: string[] = [];

  const refundTime = new Date(refundDate).getTime();
  const ageDays = (Date.now() - refundTime) / 86400000;

  // Lost-in-pipeline rule: takes precedence over reason-based rules — the
  // claim isn't about WHY the customer returned it, it's that Walmart
  // deducted the refund AND the unit never came back to the seller's
  // inventory. Applies even to "customer's right" reasons like LOWER_PRICE.
  if (hasRefundEvent && fulfillmentChannel === 'WFS' && unitLostInPipeline && ageDays >= LOST_IN_PIPELINE_DAYS) {
    // The window CLOSES 45 days after it opens. This branch originally had
    // only a lower bound, so a return stayed labelled "eligible" forever —
    // Parker filed 6 claims on 2026-08-29 that were 60-105 days past their
    // deadline (one 239 days old) and Walmart denied every one. Walmart
    // states "no appeals", so a dead claim is not worth a filing slot.
    if (ageDays > LOST_CLAIM_WINDOW_DAYS) {
      tags.push(`Unit never returned, but the claim window closed ${Math.floor(ageDays - LOST_CLAIM_WINDOW_DAYS)} days ago (opens day ${LOST_IN_PIPELINE_DAYS}, closes day ${LOST_CLAIM_WINDOW_DAYS} after the return)`);
      tags.push('Walmart states "no appeals" on these — filing now gets denied on timing regardless of merit');
      return { eligibility: 'not_eligible', reasons: tags, windowDays: LOST_CLAIM_WINDOW_DAYS };
    }
    tags.push(`Walmart deducted this refund ${Math.floor(ageDays)} days ago, but the unit never returned: no RTV fee, no restock, no resale, no reimbursement`);
    tags.push('The "return not processed / no reimbursement" dispute window opens 90 days after the return — it is open now, and closes 45 days later. Open a Seller Support case ("Initiate claim")');
    tags.push('Before filing: export Seller Center → Payments → Services Fees (Refund and RC_InventoryRTVFee CSVs) into data/walmart-service-fees and run "Import RTV & lost returns" in Settings. A LostReturnAdjustment or RTV newer than your last import clears this claim.');
    return { eligibility: 'eligible', reasons: tags, windowDays: LOST_CLAIM_WINDOW_DAYS };
  }

  // No financial deduction detected
  if (!hasRefundEvent) {
    if (ageDays <= RECON_SETTLEMENT_LAG_DAYS) {
      // Recent — Walmart's recon may not have caught up yet. Surface as
      // "maybe" with a wait-and-see note. User can check back in 1-2 weeks.
      tags.push(`Refund posted ${Math.floor(ageDays)} days ago — Walmart's recon settlement may take 1-3 weeks to confirm a deduction`);
      tags.push('Check back later — re-running the Walmart sync will update this if Walmart settles the deduction');
      // Still gate on the other eligibility criteria below
      if (fulfillmentChannel !== 'WFS') {
        return { eligibility: 'not_eligible', reasons: ['Not WFS-fulfilled'] };
      }
      if (NOT_ELIGIBLE_REASONS.has(reason)) {
        return { eligibility: 'not_eligible', reasons: [`Reason ${reason} is customer's right to return`] };
      }
      // Settlement-pending eligible refund — flag as 'maybe' so user knows to verify
      return { eligibility: 'maybe', reasons: tags };
    }
    // Old enough that recon should have settled by now → genuinely no charge
    tags.push('No financial deduction detected — Walmart likely never charged you for this return');
    return { eligibility: 'not_eligible', reasons: tags };
  }
  if (fulfillmentChannel !== 'WFS') {
    tags.push('Not WFS-fulfilled (Walmart only reimburses WFS returns)');
    return { eligibility: 'not_eligible', reasons: tags };
  }
  if (NOT_ELIGIBLE_REASONS.has(reason)) {
    tags.push(`Reason ${reason} is customer's right to return`);
    return { eligibility: 'not_eligible', reasons: tags };
  }

  // Window check
  if (ageDays > DISPUTE_WINDOW_DAYS) {
    tags.push(`Past ${DISPUTE_WINDOW_DAYS}-day dispute window (${Math.floor(ageDays)} days old)`);
    return { eligibility: 'not_eligible', reasons: tags };
  }

  if (HIGH_ELIGIBILITY_REASONS.has(reason)) {
    tags.push(`Reason ${reason} is on Walmart's own "Walmart fault" list — WFS covers these`);
    tags.push('WFS-fulfilled — Walmart liability');
    return { eligibility: 'eligible', reasons: tags };
  }

  // Unknown reason code — surface as maybe so the user can decide
  tags.push(`Reason ${reason} not classified — review manually`);
  return { eligibility: 'maybe', reasons: tags };
}

export interface WalmartDisputeSyncResult {
  scanned: number;
  newEligible: number;
  newMaybe: number;
  newNotEligible: number;
  expired: number;
  totalEligibleValueCents: number;
}

/**
 * Scan the refunds table, classify each Walmart refund, upsert into
 * walmart_dispute_candidates. Cheap (pure SQL) — runs in ms.
 */
export function syncWalmartDisputeCandidates(): WalmartDisputeSyncResult {
  const db = getDb();

  const refunds = db
    .prepare(
      `
      SELECT
        r.id as refundId, r.order_id as orderId, r.refund_date as refundDate,
        r.asin, r.sku, r.refund_amount as refundAmount, r.reason,
        r.return_order_id as returnOrderId,
        o.fulfillment_channel as fulfillmentChannel,
        COALESCE(p.name, p2.name, p3.name, r.asin, r.sku) as productName
      FROM refunds r
      LEFT JOIN orders o ON o.order_id = r.order_id
      LEFT JOIN products p ON p.asin = r.asin
      LEFT JOIN products p2 ON p2.asin = r.sku
      LEFT JOIN order_items oi ON oi.order_id = r.order_id AND (oi.asin = r.asin OR oi.sku = r.sku)
      LEFT JOIN products p3 ON p3.asin = oi.asin
      WHERE r.marketplace = 'walmart'
      GROUP BY r.id
    `
    )
    .all() as Array<{
      refundId: number;
      orderId: string;
      refundDate: string;
      asin: string | null;
      sku: string | null;
      refundAmount: number;
      reason: string;
      returnOrderId: string | null;
      fulfillmentChannel: string | null;
      productName: string | null;
    }>;

  // Pre-load the set of order IDs that have an actual WalmartRefundEvent in
  // financial_events. These are refunds where Walmart actually deducted
  // money from the seller's payout (verified via recon report). Refunds
  // NOT in this set are "ghosts" — the customer initiated a return but
  // Walmart never settled it. Don't surface those as disputable.
  const settledOrderIds = new Set(
    (db.prepare(`
      SELECT DISTINCT order_id FROM financial_events
      WHERE event_type = 'WalmartRefundEvent' AND order_id IS NOT NULL
    `).all() as Array<{ order_id: string }>).map((r) => r.order_id)
  );

  // Evidence the returned unit made it back: an RTV fee for the order's GTIN
  // (shipped back to the seller), current sellable stock for the SKU, or a
  // sale of the SKU after the refund. Absence of all three = lost in pipeline.
  // Reads wfs_rtv_units (per-GTIN, from the Services Fees CSVs), NOT the
  // WFSInventoryRTVFee rows. Since the Aug 2026 recon migration those fee rows
  // are period-level roll-ups with a NULL GTIN, so the old `fe.asin = <gtin>`
  // predicate could never match and this evidence check was silently dead —
  // every settled WFS return looked lost. Same defect as the Refunds page.
  // Units are allocated oldest-refund-first so one returned unit clears
  // exactly one refund of that GTIN, never all of them.
  const rtvCoveredRefundIds = new Set<number>(
    (db.prepare(`
      SELECT id FROM (
        SELECT rr.id AS id,
               ROW_NUMBER() OVER (PARTITION BY gg.gtin ORDER BY rr.refund_date) AS rn,
               (SELECT COALESCE(SUM(u2.quantity), 0) FROM wfs_rtv_units u2 WHERE u2.gtin = gg.gtin) AS units
        FROM refunds rr
        JOIN orders oo ON oo.order_id = rr.order_id AND oo.fulfillment_channel = 'WFS'
        JOIN (
          SELECT order_id, MAX(json_extract(raw_data, '$."Partner GTIN"')) AS gtin
          FROM financial_events
          WHERE marketplace = 'walmart' AND order_id IS NOT NULL
            AND json_extract(raw_data, '$."Partner GTIN"') IS NOT NULL
          GROUP BY order_id
        ) gg ON gg.order_id = rr.order_id
        WHERE rr.marketplace = 'walmart'
          AND EXISTS (SELECT 1 FROM wfs_rtv_units u
                      WHERE u.gtin = gg.gtin AND u.rtv_date >= date(rr.refund_date, '-7 days'))
      ) WHERE rn <= units
    `).all() as Array<{ id: number }>).map((r) => r.id)
  );
  const hasStock = db.prepare(`SELECT 1 FROM live_inventory WHERE sku = ? AND fulfillable_qty > 0 LIMIT 1`);
  // Walmart's auto-reimbursement for a lost return arrives as a Walmart
  // reimbursement — match by the order's GTIN (LostInventory rows from the
  // Services Fees import store GTIN in asin) or by the order id appearing in
  // the reimbursement id/reason (recon-sourced credits). Shape is best-effort
  // until the first real auto-reimbursement is observed.
  const hasReimbursement = db.prepare(`
    SELECT 1 FROM reimbursements
    WHERE marketplace = 'walmart' AND reimbursement_date >= ?
      AND (
        (? IS NOT NULL AND asin = ?)
        OR reimbursement_id LIKE '%' || ? || '%'
        OR reason LIKE '%' || ? || '%'
      )
    LIMIT 1
  `);
  const orderGtinStmt = db.prepare(`
    SELECT MAX(json_extract(raw_data, '$."Partner GTIN"')) as gtin FROM financial_events
    WHERE order_id = ? AND marketplace = 'walmart'
      AND event_type IN ('WalmartReconEvent', 'WalmartRefundEvent')
  `);
  const hasLaterSale = db.prepare(`
    SELECT 1 FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    WHERE oi.sku = ? AND o.purchase_date > ? AND o.status != 'Cancelled' LIMIT 1
  `);

  // Walmart already paid for the lost return (LostReturnAdjustment, from the
  // Services Fees Refund CSVs). Matched on the RMA, which is the refund's own
  // return_order_id; PO only when the row carries no RMA. Sept 22 2026: the
  // recon roll-ups carry no PO or GTIN, so hasReimbursement could never see
  // these, and 4 already-paid returns were filed on Aug 29 and denied.
  const lostReturnCredit = db.prepare(`
    SELECT SUM(credit_cents) AS cents, MAX(credit_date) AS date FROM wfs_lost_returns
    WHERE rma = ? OR (rma IS NULL AND po = ?)
  `);

  const upsert = db.prepare(`
    INSERT INTO walmart_dispute_candidates (
      refund_id, order_id, refund_date, return_reason, asin, sku, product_name,
      refund_amount_cents, fulfillment_channel, eligibility, eligibility_reasons,
      dispute_window_until, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(refund_id) DO UPDATE SET
      eligibility = excluded.eligibility,
      eligibility_reasons = excluded.eligibility_reasons,
      dispute_window_until = excluded.dispute_window_until,
      product_name = excluded.product_name,
      fulfillment_channel = excluded.fulfillment_channel,
      -- Refresh everything derived from the refunds row. These are NOT
      -- immutable: a refund's amount, reason, date or SKU can all be
      -- corrected upstream (a re-synced return line, a recon settlement
      -- overwriting a placeholder amount). Writing them once at insert and
      -- never again left the claim page showing a stale dollar value —
      -- order 119124132800655 sat at $440 after its refund was corrected to
      -- $880, which is the number Parker would have put on the claim.
      refund_amount_cents = excluded.refund_amount_cents,
      return_reason = excluded.return_reason,
      refund_date = excluded.refund_date,
      asin = excluded.asin,
      sku = excluded.sku,
      -- Don't overwrite filed/received/dismissed states
      status = CASE
        WHEN walmart_dispute_candidates.status IN ('filed', 'received', 'dismissed', 'denied') THEN walmart_dispute_candidates.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  let newEligible = 0, newMaybe = 0, newNotEligible = 0;
  let totalEligibleValue = 0;

  const tx = db.transaction(() => {
    for (const r of refunds) {
      const hasRefundEvent = settledOrderIds.has(r.orderId);
      const gtin = hasRefundEvent && r.fulfillmentChannel === 'WFS'
        ? (orderGtinStmt.get(r.orderId) as { gtin: string | null } | undefined)?.gtin ?? null
        : null;
      const unitLostInPipeline =
        hasRefundEvent &&
        r.fulfillmentChannel === 'WFS' &&
        !rtvCoveredRefundIds.has(r.refundId) &&
        !(r.sku && hasStock.get(r.sku)) &&
        !(r.sku && hasLaterSale.get(r.sku, r.refundDate)) &&
        !hasReimbursement.get(r.refundDate, gtin, gtin, r.orderId, r.orderId);
      const credit = lostReturnCredit.get(r.returnOrderId, r.orderId) as { cents: number | null; date: string | null };
      const { eligibility, reasons, windowDays } = credit.cents
        ? alreadyReimbursed(credit.cents, credit.date!, r.refundAmount)
        : classifyEligibility(r.reason, r.fulfillmentChannel, r.refundDate, hasRefundEvent, unitLostInPipeline);
      const windowEnd = new Date(new Date(r.refundDate).getTime() + (windowDays || DISPUTE_WINDOW_DAYS) * 86400000)
        .toISOString().slice(0, 10);

      const status = eligibility === 'not_eligible' ? 'expired' : 'pending';

      const result = upsert.run(
        r.refundId, r.orderId, r.refundDate, r.reason,
        r.asin, r.sku, r.productName,
        r.refundAmount, r.fulfillmentChannel,
        eligibility, JSON.stringify(reasons),
        windowEnd, status
      );

      if (result.changes === 1) {
        if (eligibility === 'eligible') { newEligible++; totalEligibleValue += r.refundAmount; }
        else if (eligibility === 'maybe') newMaybe++;
        else newNotEligible++;
      }
    }
  });
  tx();

  // Auto-expire pending candidates past their dispute window
  const expiredResult = db.prepare(`
    UPDATE walmart_dispute_candidates
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'pending' AND date(dispute_window_until) < date('now')
  `).run();

  db.close();

  return {
    scanned: refunds.length,
    newEligible,
    newMaybe,
    newNotEligible,
    expired: expiredResult.changes,
    totalEligibleValueCents: totalEligibleValue,
  };
}
