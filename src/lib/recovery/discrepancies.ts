/**
 * Recovery Hub discrepancy detectors.
 *
 * Same pattern as amazonDisputeCandidates / walmartDisputeCandidates —
 * pure SQL against tables we already sync, no extra API calls, runs in ms.
 * Two detector types not covered by the four existing recovery surfaces:
 *
 * 1. refund_no_return — FBA refund where the customer never physically
 *    returned the item. Signal: the refund's reason is still the
 *    'CUSTOMER_RETURN' placeholder (the FBA customer-returns report sync
 *    rewrites it to a real reason when a return is processed at the FC),
 *    60+ days have passed, and no reimbursement covers it. Amazon's FBA
 *    reimbursement policy (post-Oct 2024) accepts these claims no sooner
 *    than day 60 and no later than day 120 after the refund date. Since
 *    Nov 1, 2024 Amazon also auto-reimburses many of these — the detector
 *    only surfaces the ones automation missed.
 *
 * 2. fee_overcharge — the per-unit FBA fulfillment fee for an ASIN jumped
 *    vs its own historical baseline (typical cause: a cubiscan
 *    remeasurement assigned a bigger size tier). Recoverable by filing a
 *    remeasurement request; Amazon refunds the fee delta if the remeasure
 *    confirms the smaller dimensions. fd.asin is NULL on most fee rows, so
 *    the ASIN is resolved through order_items by order_id (restricted to
 *    single-ASIN orders when ambiguous).
 */
import Database from 'better-sqlite3';
import path from 'path';

const RNR_ELIGIBLE_FROM_DAYS = 60;
const RNR_WINDOW_DAYS = 120;
const RNR_REIMB_MATCH_DAYS = 120;

// Fee spike thresholds: recent 90d avg per-unit fee must exceed the prior
// baseline by at least 40 cents AND 8%, with 3+ orders in each period.
// Keeps the annual fee-schedule bumps (~10-25 cents) below the bar.
const FEE_MIN_DELTA_CENTS = 40;
const FEE_MIN_RATIO = 1.08;
const FEE_MIN_ORDERS = 3;
const FEE_RECENT_DAYS = 90;

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface RecoveryScanResult {
  refundNoReturn: { scanned: number; eligible: number; waiting: number; expired: number; eligibleValueCents: number };
  feeOvercharge: { asinsChecked: number; flagged: number; estimatedValueCents: number };
}

export function syncRecoveryDiscrepancies(): RecoveryScanResult {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO recovery_discrepancies (
      discrepancy_type, ref_key, order_id, asin, sku, product_name,
      event_date, quantity, estimated_value_cents,
      eligibility, eligibility_reasons, eligible_from, window_until,
      detail, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(discrepancy_type, ref_key) DO UPDATE SET
      eligibility = excluded.eligibility,
      eligibility_reasons = excluded.eligibility_reasons,
      eligible_from = excluded.eligible_from,
      window_until = excluded.window_until,
      estimated_value_cents = excluded.estimated_value_cents,
      product_name = excluded.product_name,
      detail = excluded.detail,
      status = CASE
        WHEN recovery_discrepancies.status IN ('filed', 'received', 'dismissed') THEN recovery_discrepancies.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  // ---------- Detector 1: refund without return (Amazon FBA) ----------
  // reason = 'CUSTOMER_RETURN' means the FBA customer-returns report has
  // never matched this refund — no physical return was processed at the FC.
  const rnrRows = db.prepare(`
    SELECT
      r.id as refundId, r.order_id as orderId, r.refund_date as refundDate,
      r.asin, r.sku, r.quantity, r.refund_amount as refundAmount,
      COALESCE(p.name, p2.name, p3.name, r.asin, r.sku) as productName
    FROM refunds r
    LEFT JOIN orders o ON o.order_id = r.order_id
    LEFT JOIN products p ON p.asin = r.asin
    LEFT JOIN products p2 ON p2.asin = r.sku
    LEFT JOIN order_items oi ON oi.order_id = r.order_id AND (oi.asin = r.asin OR oi.sku = r.sku)
    LEFT JOIN products p3 ON p3.asin = oi.asin
    WHERE r.marketplace = 'amazon'
      AND UPPER(COALESCE(o.fulfillment_channel, '')) IN ('AFN', 'FBA')
      AND r.reason = 'CUSTOMER_RETURN'
    GROUP BY r.id
  `).all() as Array<{
    refundId: number; orderId: string; refundDate: string;
    asin: string | null; sku: string | null; quantity: number;
    refundAmount: number; productName: string | null;
  }>;

  // Skip refunds Amazon already reimbursed (match by asin/sku within the
  // window after the refund — same content-matching as the dispute pages).
  const reimbCheck = db.prepare(`
    SELECT id FROM reimbursements
    WHERE marketplace = 'amazon'
      AND julianday(reimbursement_date) >= julianday(?) - 1
      AND julianday(reimbursement_date) <= julianday(?) + ${RNR_REIMB_MATCH_DAYS}
      AND ((? != '' AND asin = ?) OR (? != '' AND sku = ?))
    LIMIT 1
  `);

  let rnrEligible = 0, rnrWaiting = 0, rnrExpired = 0, rnrEligibleValue = 0;

  const tx = db.transaction(() => {
    for (const r of rnrRows) {
      const ageDays = (Date.now() - new Date(r.refundDate).getTime()) / 86400000;
      const eligibleFrom = new Date(new Date(r.refundDate).getTime() + RNR_ELIGIBLE_FROM_DAYS * 86400000).toISOString().slice(0, 10);
      const windowUntil = new Date(new Date(r.refundDate).getTime() + RNR_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

      const reimbursed = !!reimbCheck.get(
        r.refundDate, r.refundDate,
        r.asin || '', r.asin || '', r.sku || '', r.sku || ''
      );

      let eligibility: 'eligible' | 'waiting' | 'not_eligible';
      let status: string;
      const tags: string[] = [];

      if (reimbursed) {
        eligibility = 'not_eligible';
        status = 'expired';
        tags.push('Amazon already reimbursed this refund');
      } else if (ageDays > RNR_WINDOW_DAYS) {
        eligibility = 'not_eligible';
        status = 'expired';
        tags.push(`Past the ${RNR_WINDOW_DAYS}-day claim window (${Math.floor(ageDays)} days old)`);
      } else if (ageDays < RNR_ELIGIBLE_FROM_DAYS) {
        eligibility = 'waiting';
        status = 'pending';
        tags.push(`Claimable starting ${eligibleFrom} — Amazon opens these claims 60 days after the refund (and often auto-reimburses before then)`);
        tags.push('No return has been processed at the FC yet (reason is still the CUSTOMER_RETURN placeholder)');
      } else {
        eligibility = 'eligible';
        status = 'pending';
        tags.push(`Refunded ${Math.floor(ageDays)} days ago — no return ever processed at the FC, no reimbursement found`);
        tags.push('File a reimbursement claim for "Customer return not received"');
      }

      const result = upsert.run(
        'refund_no_return', `rnr-${r.refundId}`, r.orderId, r.asin, r.sku, r.productName,
        r.refundDate, r.quantity || 1, r.refundAmount,
        eligibility, JSON.stringify(tags), eligibleFrom, windowUntil,
        JSON.stringify({ refundId: r.refundId }), status
      );

      if (result.changes === 1) {
        if (eligibility === 'eligible') { rnrEligible++; rnrEligibleValue += r.refundAmount; }
        else if (eligibility === 'waiting') rnrWaiting++;
        else rnrExpired++;
      }
    }
  });
  tx();

  // ---------- Detector 2: FBA fulfillment fee overcharge ----------
  const feeRows = db.prepare(`
    WITH per_unit AS (
      SELECT COALESCE(NULLIF(fd.asin, ''), oi.asin) AS asin, fd.posted_date,
             ABS(fd.amount) * 1.0 / MAX(oi.quantity, 1) AS unit_fee
      FROM fee_details fd
      JOIN order_items oi ON oi.order_id = fd.order_id
        AND (oi.asin = fd.asin OR fd.asin IS NULL OR fd.asin = '')
      JOIN (SELECT order_id, COUNT(DISTINCT asin) na FROM order_items GROUP BY order_id) oc
        ON oc.order_id = fd.order_id
      WHERE fd.fee_type = 'FBAPerUnitFulfillmentFee' AND fd.amount < 0
        AND ((fd.asin IS NOT NULL AND fd.asin != '') OR oc.na = 1)
    ),
    recent AS (
      SELECT asin, AVG(unit_fee) fee, COUNT(*) n, MAX(posted_date) lastCharged FROM per_unit
      WHERE julianday('now') - julianday(posted_date) <= ${FEE_RECENT_DAYS}
      GROUP BY asin HAVING n >= ${FEE_MIN_ORDERS}
    ),
    baseline AS (
      SELECT asin, AVG(unit_fee) fee, COUNT(*) n FROM per_unit
      WHERE julianday('now') - julianday(posted_date) > ${FEE_RECENT_DAYS}
      GROUP BY asin HAVING n >= ${FEE_MIN_ORDERS}
    )
    SELECT r.asin,
           CAST(ROUND(b.fee) AS INTEGER) as baselineCents,
           CAST(ROUND(r.fee) AS INTEGER) as recentCents,
           r.n as recentOrders, b.n as baselineOrders,
           r.lastCharged,
           COALESCE(p.name, li.product_name, r.asin) as productName
    FROM recent r
    JOIN baseline b ON b.asin = r.asin
    LEFT JOIN products p ON p.asin = r.asin
    LEFT JOIN live_inventory li ON li.asin = r.asin
    WHERE r.fee - b.fee >= ${FEE_MIN_DELTA_CENTS} AND r.fee >= b.fee * ${FEE_MIN_RATIO}
    GROUP BY r.asin
  `).all() as Array<{
    asin: string; baselineCents: number; recentCents: number;
    recentOrders: number; baselineOrders: number; lastCharged: string;
    productName: string | null;
  }>;

  let feeFlagged = 0, feeValue = 0;

  const feeTx = db.transaction(() => {
    for (const f of feeRows) {
      const deltaCents = f.recentCents - f.baselineCents;
      const overchargeCents = deltaCents * f.recentOrders;
      const tags = [
        `Per-unit FBA fee rose from ${(f.baselineCents / 100).toFixed(2)} to ${(f.recentCents / 100).toFixed(2)} (+${(deltaCents / 100).toFixed(2)}/unit)`,
        `${f.recentOrders} units charged the higher fee in the last ${FEE_RECENT_DAYS} days`,
        'Likely a cubiscan remeasurement — request a remeasure; if dimensions confirm smaller, Amazon refunds the delta',
      ];

      const result = upsert.run(
        'fee_overcharge', `fee-${f.asin}`, null, f.asin, null, f.productName,
        f.lastCharged.slice(0, 10), f.recentOrders, overchargeCents,
        'eligible', JSON.stringify(tags), null, null,
        JSON.stringify({
          baselineCents: f.baselineCents, recentCents: f.recentCents,
          deltaCents, recentOrders: f.recentOrders, baselineOrders: f.baselineOrders,
        }), 'pending'
      );
      if (result.changes === 1) { feeFlagged++; feeValue += overchargeCents; }
    }

    // Clear fee flags that no longer trip the threshold (fee dropped back,
    // or the remeasure fixed it) — only pending ones; filed/received stay.
    const stillFlagged = new Set(feeRows.map((f) => `fee-${f.asin}`));
    const open = db.prepare(`
      SELECT id, ref_key as refKey FROM recovery_discrepancies
      WHERE discrepancy_type = 'fee_overcharge' AND status = 'pending'
    `).all() as Array<{ id: number; refKey: string }>;
    const expire = db.prepare(`
      UPDATE recovery_discrepancies SET status = 'expired',
        eligibility = 'not_eligible',
        eligibility_reasons = json_array('Fee returned to baseline — no longer overcharged'),
        updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const o of open) {
      if (!stillFlagged.has(o.refKey)) expire.run(o.id);
    }
  });
  feeTx();

  // Expire refund-no-return candidates whose window closed while pending
  db.prepare(`
    UPDATE recovery_discrepancies
    SET status = 'expired', eligibility = 'not_eligible', updated_at = datetime('now')
    WHERE discrepancy_type = 'refund_no_return'
      AND status = 'pending'
      AND date(window_until) < date('now')
  `).run();

  // Promote 'waiting' candidates whose eligible_from date arrived
  db.prepare(`
    UPDATE recovery_discrepancies
    SET eligibility = 'eligible', updated_at = datetime('now')
    WHERE discrepancy_type = 'refund_no_return'
      AND status = 'pending' AND eligibility = 'waiting'
      AND date(eligible_from) <= date('now')
  `).run();

  db.close();

  return {
    refundNoReturn: {
      scanned: rnrRows.length,
      eligible: rnrEligible,
      waiting: rnrWaiting,
      expired: rnrExpired,
      eligibleValueCents: rnrEligibleValue,
    },
    feeOvercharge: {
      asinsChecked: feeRows.length,
      flagged: feeFlagged,
      estimatedValueCents: feeValue,
    },
  };
}
