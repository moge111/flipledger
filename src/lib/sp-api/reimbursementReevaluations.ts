/**
 * Amazon reimbursement re-evaluation candidate detection.
 *
 * For each Amazon reimbursement Amazon paid, compare the amount paid to
 * the seller's expected value (18-month avg sale price × quantity).
 * When Amazon paid significantly less, the seller can file a
 * "Submit a reimbursement claim dispute" case to request re-evaluation.
 *
 * That form requires a reimbursement_id, so this only surfaces records
 * that have one (skips synthetic SETTLEMENT-* and ADJ-* derived IDs
 * that Amazon's UI won't accept).
 */
import { openDb } from '@/lib/db-conn';

const UNDERPAID_THRESHOLD_PCT = 0.15; // gap must be at least 15% of expected
const MIN_GAP_CENTS = 1000;            // at least $10 gap to surface
// Amazon's re-evaluation window: 60 days from the original reimbursement.
// Confirmed via a real denial June 12, 2026 ("Re-evaluation requests must
// be submitted within 60 days of the original reimbursement") — the old
// 365-day assumption produced claims Amazon auto-denied as out-of-window.
const REIMBURSEMENT_DISPUTE_WINDOW_DAYS = 60;

const getDb = () => openDb();

export interface ReevaluationSyncResult {
  scanned: number;
  newCandidates: number;
  updated: number;
  totalGapCents: number;
}

export function syncReimbursementReevaluations(): ReevaluationSyncResult {
  const db = getDb();

  // Reimbursements with a real numeric reimbursement_id (excludes synthetic
  // SETTLEMENT-* and ADJ-* IDs that Amazon's dispute form won't accept).
  // Joined to avg sale price per ASIN over the last 18 months. The
  // reimbursements table stores the MSKU in `sku`, which links to
  // order_items.sku, which gives us the real ASIN.
  const rows = db.prepare(`
    SELECT
      r.id as id,
      r.reimbursement_id as reimbursementId,
      r.reimbursement_date as reimbursementDate,
      r.sku as sku,
      r.quantity as quantity,
      r.amount as paidCents,
      r.reason as reason,
      COALESCE(oi_match.real_asin, r.asin) as asin,
      COALESCE(p.name, oi_match.product_name) as productName,
      avg_prices.avg_sale_price_cents as avgSalePriceCents
    FROM reimbursements r
    LEFT JOIN (
      SELECT oi.sku, oi.asin as real_asin, p.name as product_name
      FROM order_items oi
      LEFT JOIN products p ON p.asin = oi.asin
      WHERE oi.asin LIKE 'B%' AND length(oi.asin) = 10
      GROUP BY oi.sku
    ) oi_match ON oi_match.sku = r.sku
    LEFT JOIN products p ON p.asin = oi_match.real_asin
    LEFT JOIN (
      SELECT oi.asin, AVG(oi.price_per_unit) as avg_sale_price_cents
      FROM order_items oi
      INNER JOIN orders o ON o.order_id = oi.order_id
      WHERE oi.asin LIKE 'B%' AND length(oi.asin) = 10
        AND o.purchase_date >= date('now','-18 months')
      GROUP BY oi.asin
    ) avg_prices ON avg_prices.asin = oi_match.real_asin
    WHERE r.marketplace = 'amazon'
      AND r.reimbursement_id GLOB '[0-9]*'
      AND length(r.reimbursement_id) >= 8
  `).all() as Array<{
    id: number;
    reimbursementId: string;
    reimbursementDate: string;
    sku: string | null;
    quantity: number;
    paidCents: number;
    reason: string | null;
    asin: string | null;
    productName: string | null;
    avgSalePriceCents: number | null;
  }>;

  const upsert = db.prepare(`
    INSERT INTO amazon_reimbursement_reevaluations (
      reimbursement_id, reimbursement_date, asin, sku, product_name,
      quantity, paid_cents, expected_cents, gap_cents, reason, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(reimbursement_id) DO UPDATE SET
      asin = excluded.asin,
      product_name = excluded.product_name,
      paid_cents = excluded.paid_cents,
      expected_cents = excluded.expected_cents,
      gap_cents = excluded.gap_cents,
      reason = excluded.reason,
      status = CASE
        WHEN amazon_reimbursement_reevaluations.status IN ('filed', 'received', 'dismissed') THEN amazon_reimbursement_reevaluations.status
        ELSE excluded.status
      END,
      updated_at = datetime('now')
  `);

  // Latest documented buy cost per item — checked by SKU/MSKU first, then
  // real ASIN (inventory_ledger.asin often holds the MSKU).
  const costLookup = db.prepare(`
    SELECT buy_price FROM inventory_ledger
    WHERE asin = ? OR sku = ? OR asin = ? OR sku = ?
    ORDER BY date_purchased DESC LIMIT 1
  `);

  // Reasons where the unit was lost/damaged BEFORE a customer order.
  // Amazon's reimbursement policy values these at the seller's SOURCING
  // COST (provable with an invoice), not the sale price — so the
  // realistic expected value is buy cost × qty. Post-order reasons
  // (CustomerReturn etc.) remain sale-price based.
  const PRE_ORDER_REASONS = new Set([
    'Lost_Warehouse', 'Damaged_Warehouse', 'Lost_Inbound', 'Damaged_Inbound',
    'Reimbursement_Reversal',
  ]);

  let newCandidates = 0;
  let updated = 0;
  let totalGap = 0;
  const qualifyingIds: string[] = [];

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.quantity <= 0) continue;

      // Pre-order losses are valued at documented SOURCING COST, which exists
      // even when the item has never sold (e.g. a unit lost inbound before its
      // first sale — those were previously skipped by the avg-sale-price guard
      // and could never surface). Post-order reasons still need sale history.
      let expected = 0;
      if (PRE_ORDER_REASONS.has(r.reason || '')) {
        const lot = costLookup.get(r.sku || '', r.sku || '', r.asin || '', r.asin || '') as { buy_price: number } | undefined;
        if (lot && lot.buy_price > 0) {
          expected = lot.buy_price * r.quantity;
        } else if (r.avgSalePriceCents) {
          // No documented cost — fall back to the sale-price estimate
          // (better than dropping the candidate).
          expected = Math.round(r.avgSalePriceCents * r.quantity);
        }
      } else if (r.avgSalePriceCents) {
        expected = Math.round(r.avgSalePriceCents * r.quantity);
      }
      if (expected <= 0) continue;
      const gap = expected - r.paidCents;

      // Only surface meaningful gaps
      if (gap < MIN_GAP_CENTS) continue;
      if (gap < expected * UNDERPAID_THRESHOLD_PCT) continue;

      // Also skip if outside the dispute window (12 months from reimbursement date)
      const ageDays = (Date.now() - new Date(r.reimbursementDate).getTime()) / 86400000;
      if (ageDays > REIMBURSEMENT_DISPUTE_WINDOW_DAYS) continue;

      const result = upsert.run(
        r.reimbursementId,
        r.reimbursementDate,
        r.asin,
        r.sku,
        r.productName,
        r.quantity,
        r.paidCents,
        expected,
        gap,
        r.reason
      );
      qualifyingIds.push(r.reimbursementId);
      if (result.changes === 1) {
        newCandidates++;
        totalGap += gap;
      } else {
        updated++;
      }
    }

    // Drop pending candidates that no longer qualify (e.g. the expected
    // value moved to cost basis and the gap fell below threshold). Rows
    // the user already acted on (filed/received/dismissed) are preserved.
    const open = db.prepare(`
      SELECT id, reimbursement_id as rid FROM amazon_reimbursement_reevaluations
      WHERE status = 'pending'
    `).all() as Array<{ id: number; rid: string }>;
    const keep = new Set(qualifyingIds);
    const drop = db.prepare(`DELETE FROM amazon_reimbursement_reevaluations WHERE id = ?`);
    for (const o of open) {
      if (!keep.has(o.rid)) drop.run(o.id);
    }
  });
  tx();

  db.close();
  return {
    scanned: rows.length,
    newCandidates,
    updated,
    totalGapCents: totalGap,
  };
}
