/**
 * Shared SQL fragments for the books-of-record routes.
 *
 * P&L, Dashboard, Cash Flow and Tax Report must compute the same money the
 * same way; historically each carried its own copy of these rules and they
 * drifted (the shipping-credit rule existed four times, the Walmart settled-
 * refund gate five times, and the Dashboard's shipping-cost sum silently
 * diverged from the P&L). The parity tests catch drift after the fact — this
 * module removes the opportunity.
 *
 * Every fragment is a plain string (or a function of a table alias) so it can
 * be spliced into the hand-built queries the routes already use. None of them
 * embed request-supplied values.
 */

// ── Order recognition date ───────────────────────────────────────────────────

/**
 * Cash basis: an order is recognised on the marketplace day its FIRST
 * ShipmentEvent posted (settlement), not when the customer bought. Join on
 * order_id; the column is exposed as `posted_date` on the given alias.
 */
export const ORDER_POSTED_DATE = `(
  SELECT order_id, MIN(posted_date) as posted_date
  FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
  GROUP BY order_id
)`;

/** Accrual basis: purchase_date, exposed under the same `posted_date` name so callers can swap. */
export const ORDER_PURCHASE_DATE = `(
  SELECT order_id, purchase_date as posted_date FROM orders
)`;

export type DateBasis = 'posted' | 'purchase';
export function orderDateSubquery(basis: DateBasis): string {
  return basis === 'purchase' ? ORDER_PURCHASE_DATE : ORDER_POSTED_DATE;
}

// ── Refunds ──────────────────────────────────────────────────────────────────

/**
 * Walmart refunds count only once Walmart has actually deducted the seller in
 * the recon report (a WalmartRefundEvent / Product Price row exists). The
 * Returns API surfaces a refund at customer-initiation; ~30% of those are
 * ghosts Walmart never charges, and real ones settle 1–3 weeks later. Every
 * other marketplace's refunds arrive settled.
 *
 * `alias` is the refunds table alias in the enclosing query ('r', 'refunds').
 * `nullIsAmazon` treats a NULL marketplace as Amazon (legacy rows).
 */
export function walmartSettledRefund(alias: string, nullIsAmazon = false): string {
  const mkt = nullIsAmazon ? `COALESCE(${alias}.marketplace, 'amazon')` : `${alias}.marketplace`;
  return `(
    ${mkt} != 'walmart'
    OR EXISTS (
      SELECT 1 FROM financial_events fe_settled
      WHERE fe_settled.event_type = 'WalmartRefundEvent'
        AND fe_settled.order_id = ${alias}.order_id
        AND json_extract(fe_settled.raw_data, '$."Amount Type"') = 'Product Price'
    )
  )`;
}

// ── Shipping ─────────────────────────────────────────────────────────────────

/** Channels where the seller ships the order and keeps what the buyer paid for shipping. */
export const SELLER_SHIPPED_CHANNELS = `('MFN', 'Seller')`;

/**
 * Per-line shipping credit that is INCOME on the cash books: the full charge
 * for seller-shipped orders. (Non-MFN credits are handled at order level by
 * `chargedBackShippingCredit`, because the rule depends on a fee row.)
 * `oi` / `o` are the order_items / orders aliases.
 */
export function mfnShippingCreditExpr(oi = 'oi', o = 'o'): string {
  return `CASE WHEN ${o}.fulfillment_channel IN ${SELLER_SHIPPED_CHANNELS} THEN COALESCE(${oi}.shipping_charged, 0) ELSE 0 END`;
}

/**
 * Out-of-pocket shipping (labels) is a cost only on MFN orders. Walmart
 * seller-fulfilled label charges already arrive through recon → fee_details,
 * so counting order_items.shipping_cost there too would double-count.
 */
export function mfnShippingCostExpr(oi = 'oi', o = 'o'): string {
  return `CASE WHEN ${o}.fulfillment_channel = 'MFN' THEN COALESCE(${oi}.shipping_cost, 0) ELSE 0 END`;
}

/**
 * Non-MFN shipping credits are income ONLY when Amazon also charges them back
 * (the ShippingChargeback fee is already in fees, so the pair nets to zero —
 * dropping the credit while keeping the fee double-penalised every such
 * order). Amazon-Global export orders (credit offset by a promo rebate) and
 * Walmart WFS (no credit line exists) are correctly excluded by the same test.
 *
 * Returns an inner SELECT producing one row per order with `sc` (credit) and
 * `cb` (chargeback); wrap it with `SUM(MIN(x.sc, x.cb)) … WHERE x.sc > 0 AND
 * x.cb > 0`. `dateSub` is the order-date subquery; `dateWhere` the caller's
 * date + marketplace predicate on that alias; `extraSelect` lets a caller add
 * a grouping column (e.g. a month bucket) before `oi.order_id`.
 */
export function chargedBackShippingInner(dateSub: string, dateWhere: string, extraSelect = ''): string {
  return `
    SELECT ${extraSelect}oi.order_id,
           SUM(oi.shipping_charged) as sc,
           COALESCE((SELECT -SUM(fd.amount) FROM fee_details fd
                     WHERE fd.order_id = oi.order_id
                       AND fd.fee_type = 'ShippingChargeback'), 0) as cb
    FROM order_items oi
    JOIN ${dateSub} fe ON oi.order_id = fe.order_id
    JOIN orders o ON oi.order_id = o.order_id
    WHERE ${dateWhere}
      AND o.fulfillment_channel NOT IN ${SELLER_SHIPPED_CHANNELS}
    GROUP BY ${extraSelect ? extraSelect.replace(/ as \w+,\s*$/i, ', ') : ''}oi.order_id`;
}

// ── Fees ─────────────────────────────────────────────────────────────────────

/** Order-linked fee rows (service fees have no order_id). */
export const ORDER_FEE_ROWS = `fd.order_id IS NOT NULL AND fd.order_id != ''`;
/** Service fees: storage, subscription, inbound, placement … no order. */
export const SERVICE_FEE_ROWS = `(fd.order_id IS NULL OR fd.order_id = '')`;
/**
 * Fees are stored SIGNED (charges negative, clawbacks/credits positive). The
 * fee TOTAL is therefore `-SUM(amount)` — never `SUM(ABS(amount))`, which
 * turned every clawback credit into an extra charge (April 11 2026 bug).
 */
export const SIGNED_FEE_TOTAL = `COALESCE(-SUM(fd.amount), 0)`;

// ── Refunds attributed to a sale line ────────────────────────────────────────

/** A refund row matches no line of its order by SKU (eBay multi-item, some Walmart). */
const unmatchedRefund = (r: string) =>
  `(${r}.sku IS NULL OR ${r}.sku = '' OR NOT EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = ${r}.order_id AND x.sku = ${r}.sku))`;

/**
 * Settled refund dollars that belong to one order_items line: refunds whose
 * SKU matches the line, plus any SKU-less refund on the order pro-rated by the
 * line's share of the order's product revenue. Walmart refunds count only
 * once they settle in recon (same gate as the P&L). Use it in per-order views
 * (Sales pages, Profitability), where a refund belongs to the sale it
 * reverses regardless of when it was issued. `oi` is the order_items alias.
 */
export function lineSettledRefundExpr(oi = 'oi'): string {
  return `(
    COALESCE((SELECT SUM(r.refund_amount) FROM refunds r
      WHERE r.order_id = ${oi}.order_id AND r.sku = ${oi}.sku AND ${walmartSettledRefund('r', true)}), 0)
    + COALESCE((SELECT SUM(r.refund_amount) FROM refunds r
      WHERE r.order_id = ${oi}.order_id AND ${unmatchedRefund('r')} AND ${walmartSettledRefund('r', true)}), 0)
      * ${oi}.total_price * 1.0 / NULLIF((SELECT SUM(x.total_price) FROM order_items x WHERE x.order_id = ${oi}.order_id), 0)
  )`;
}

/**
 * Aggregate over the settled refund ROWS that belong to one line (`agg` is
 * e.g. `COUNT(*)` or `SUM(r.quantity)`): SKU matches, plus SKU-less refunds
 * counted once, on the order's first line.
 */
export function lineSettledRefundRowsExpr(agg: string, oi = 'oi'): string {
  return `(
    COALESCE((SELECT ${agg} FROM refunds r
      WHERE r.order_id = ${oi}.order_id AND r.sku = ${oi}.sku AND ${walmartSettledRefund('r', true)}), 0)
    + CASE WHEN ${oi}.id = (SELECT MIN(x.id) FROM order_items x WHERE x.order_id = ${oi}.order_id)
      THEN COALESCE((SELECT ${agg} FROM refunds r
        WHERE r.order_id = ${oi}.order_id AND ${unmatchedRefund('r')} AND ${walmartSettledRefund('r', true)}), 0)
      ELSE 0 END
  )`;
}
