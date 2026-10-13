/**
 * Estimated fees for Walmart orders that recon hasn't settled yet.
 *
 * Walmart books an order's revenue the moment it syncs, but its referral and
 * WFS fulfillment fees only arrive with the next recon report (biweekly), so
 * for up to ~2 weeks recent Walmart sales showed $0 fees and overstated
 * profit. This fills the gap with estimates that the real recon rows replace.
 *
 * Rows use the estimator sentinel financial_event_id = 0 (same as the Amazon
 * estimator) and their own fee types, so they can never collide with a real
 * recon row in idx_fee_details_unique. The whole set is rebuilt on every run:
 * estimates improve once a SKU has settled history, and orders that settle,
 * cancel or age out drop out on their own.
 *
 * Referral and WFS fulfillment fees settle in the same recon report (495 of
 * 499 orders since May on the same day, the rest one day apart), so an order
 * counts as settled once it has any real fee row.
 */
import type Database from 'better-sqlite3';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { estimateWfsFee } from './fee-rates';

const log = createLogger('walmart-api/feeEstimates');

export const WALMART_ESTIMATE_FEE_TYPES = ['WalmartReferralFeeEstimate', 'WFSFulfillmentFeeEstimate'] as const;
export const WALMART_ESTIMATE_CATEGORY = 'Walmart Fees (estimated)';

/** Walmart's standard referral rate for most categories (toys, home, games). */
const DEFAULT_REFERRAL_RATE = 0.15;
/** Only orders this recent are estimated, so settled history is never touched. */
const ESTIMATE_WINDOW_DAYS = 45;
/** Fallback WFS fee when neither the SKU nor the account has recent history. */
const DEFAULT_WFS_FEE_CENTS = 525;

interface OrderLine {
  order_id: string;
  sku: string;
  quantity: number;
  total_price: number;
  fulfillment_channel: string;
  purchase_date: string;
}

export interface WalmartEstimateResult {
  removed: number;
  orders: number;
  rows: number;
  totalCents: number;
}

const ESTIMATE_TYPES_SQL = `('WalmartReferralFeeEstimate', 'WFSFulfillmentFeeEstimate')`;

/** Latest real commission rate (decimal) Walmart charged on this SKU, or null. */
function skuReferralRate(db: Database.Database, sku: string): number | null {
  const row = db.prepare(`
    SELECT json_extract(fe.raw_data, '$."Commission Rate"') AS rate
    FROM financial_events fe
    WHERE fe.event_type = 'WalmartReconEvent' AND fe.sku = ?
      AND json_extract(fe.raw_data, '$."Amount Type"') = 'Commission on Product'
      AND json_extract(fe.raw_data, '$."Transaction Type"') = 'Sale'
      AND fe.total_amount < 0
    ORDER BY fe.posted_date DESC, fe.id DESC LIMIT 1
  `).get(sku) as { rate: string | number | null } | undefined;
  const rate = Number(row?.rate);
  return Number.isFinite(rate) && rate > 0 && rate < 50 ? rate / 100 : null;
}

/** Latest real WFS fulfillment fee per unit (cents, positive) on this SKU, or null. */
function skuWfsFeePerUnit(db: Database.Database, sku: string): number | null {
  const row = db.prepare(`
    SELECT -fe.total_amount AS cents,
           CAST(COALESCE(NULLIF(json_extract(fe.raw_data, '$."Ship Qty"'), ''), 1) AS INTEGER) AS qty
    FROM financial_events fe
    WHERE fe.event_type = 'WalmartReconEvent' AND fe.sku = ?
      AND json_extract(fe.raw_data, '$."Transaction Description"') = 'WFS Fulfillment fee'
      AND fe.total_amount < 0
    ORDER BY fe.posted_date DESC, fe.id DESC LIMIT 1
  `).get(sku) as { cents: number; qty: number } | undefined;
  if (!row) return null;
  return Math.round(row.cents / Math.max(1, row.qty || 1));
}

/** Average WFS fulfillment fee per unit across the account over the last 90 days. */
function accountWfsFeePerUnit(db: Database.Database): number {
  const row = db.prepare(`
    SELECT SUM(-fe.total_amount) AS cents,
           SUM(CAST(COALESCE(NULLIF(json_extract(fe.raw_data, '$."Ship Qty"'), ''), 1) AS INTEGER)) AS units
    FROM financial_events fe
    WHERE fe.event_type = 'WalmartReconEvent'
      AND json_extract(fe.raw_data, '$."Transaction Description"') = 'WFS Fulfillment fee'
      AND fe.total_amount < 0
      AND fe.posted_date >= datetime('now', '-90 days')
  `).get() as { cents: number | null; units: number | null };
  return row.cents && row.units ? Math.round(row.cents / row.units) : DEFAULT_WFS_FEE_CENTS;
}

/**
 * Rebuild every Walmart fee estimate. Pure SQL + the local DB; safe to run
 * on every sync. Pass `db` in tests; otherwise opens (and closes) its own.
 */
export function refreshWalmartFeeEstimates(dbIn?: Database.Database): WalmartEstimateResult {
  const db = dbIn ?? openDb();
  try {
    const cutoff = new Date(Date.now() - ESTIMATE_WINDOW_DAYS * 86400000).toISOString();
    const lines = db.prepare(`
      SELECT oi.order_id, oi.sku, oi.quantity, oi.total_price, o.fulfillment_channel, o.purchase_date
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.marketplace = 'walmart'
        AND o.status NOT IN ('Cancelled', 'Canceled')
        AND o.purchase_date >= ?
        AND oi.total_price > 0 AND oi.quantity > 0
        AND NOT EXISTS (
          SELECT 1 FROM fee_details fd
          WHERE fd.order_id = o.order_id AND fd.fee_type NOT IN ${ESTIMATE_TYPES_SQL}
        )
    `).all(cutoff) as OrderLine[];

    const wfsFallback = accountWfsFeePerUnit(db);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (0, ?, ?, ?, '${WALMART_ESTIMATE_CATEGORY}', ?, ?)
    `);

    let removed = 0;
    let rows = 0;
    let totalCents = 0;
    const orders = new Set<string>();

    db.transaction(() => {
      removed = db.prepare(`DELETE FROM fee_details WHERE financial_event_id = 0 AND fee_type IN ${ESTIMATE_TYPES_SQL}`).run().changes;
      for (const line of lines) {
        const rate = skuReferralRate(db, line.sku) ?? DEFAULT_REFERRAL_RATE;
        const referral = Math.round(line.total_price * rate);
        if (referral > 0 && insert.run(line.order_id, line.sku, 'WalmartReferralFeeEstimate', -referral, line.purchase_date).changes) {
          rows++; totalCents += referral; orders.add(line.order_id);
        }
        if (line.fulfillment_channel === 'WFS') {
          const wfs = (skuWfsFeePerUnit(db, line.sku) ?? wfsFallback) * line.quantity;
          if (wfs > 0 && insert.run(line.order_id, line.sku, 'WFSFulfillmentFeeEstimate', -wfs, line.purchase_date).changes) {
            rows++; totalCents += wfs; orders.add(line.order_id);
          }
        }
      }
    })();

    if (orders.size > 0 || removed > 0) {
      log.info(`Estimated fees on ${orders.size} unsettled orders ($${(totalCents / 100).toFixed(2)}); replaced ${removed} prior estimate rows`);
    }
    return { removed, orders: orders.size, rows, totalCents };
  } finally {
    if (!dbIn) db.close();
  }
}

export interface WalmartUnitFeeEstimate {
  /** Referral fee per unit, cents (positive). */
  referralCents: number;
  /** WFS fulfillment fee per unit, cents (positive); 0 for seller-fulfilled. */
  fulfillmentCents: number;
  referralRate: number;
  referralSource: 'sku' | 'default';
  fulfillmentSource: 'sku' | 'weight' | 'account' | 'none';
}

/**
 * Per-unit Walmart fee estimate for a SKU that hasn't sold yet at `priceCents`
 * (batch pages). Same sources as the order estimates above: the SKU's last
 * settled commission rate and WFS fee, else 15% and the WFS rate card by
 * weight, else the account's 90-day average WFS fee.
 */
export function estimateWalmartUnitFees(
  db: Database.Database,
  opts: { sku: string; priceCents: number; wfs: boolean; weightLb?: number | null },
): WalmartUnitFeeEstimate {
  const skuRate = skuReferralRate(db, opts.sku);
  const referralRate = skuRate ?? DEFAULT_REFERRAL_RATE;
  const referralCents = Math.max(0, Math.round(opts.priceCents * referralRate));
  if (!opts.wfs) {
    return { referralCents, fulfillmentCents: 0, referralRate, referralSource: skuRate ? 'sku' : 'default', fulfillmentSource: 'none' };
  }
  const skuFee = skuWfsFeePerUnit(db, opts.sku);
  let fulfillmentCents: number;
  let fulfillmentSource: WalmartUnitFeeEstimate['fulfillmentSource'];
  if (skuFee) { fulfillmentCents = skuFee; fulfillmentSource = 'sku'; }
  else if (opts.weightLb && opts.weightLb > 0) {
    fulfillmentCents = estimateWfsFee(opts.weightLb, { priceUnder10: opts.priceCents > 0 && opts.priceCents < 1000 });
    fulfillmentSource = 'weight';
  } else { fulfillmentCents = accountWfsFeePerUnit(db); fulfillmentSource = 'account'; }
  return { referralCents, fulfillmentCents, referralRate, referralSource: skuRate ? 'sku' : 'default', fulfillmentSource };
}
