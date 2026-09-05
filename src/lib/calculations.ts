/**
 * calculations.ts — the JS-side money formulas.
 *
 * The books-of-record totals (P&L / Dashboard / Cash Flow / Tax Report) are
 * computed in SQL; the shared fragments that keep those four in agreement
 * live in src/lib/accounting-sql.ts. The helpers here are the derived
 * ratios and per-row arithmetic used by those routes and by the UI, so ROI,
 * margin and per-order profit are defined exactly once.
 *
 * All monetary values are INTEGER CENTS internally.
 * Only convert to dollars for display via formatters.ts.
 * Never round intermediate calculations.
 */

/**
 * Profit = Revenue − COGS − Fees − Shipping.
 *
 * Fees are the SIGNED net (charges negative, clawbacks positive, summed as
 * -SUM(amount)), so a referral-fee clawback on a refund is already inside
 * `totalFees`. There is deliberately no separate clawback term — adding one
 * double-counted the credit (May 14, 2026 P&L bug #3).
 */
export function calculateProfit(
  revenue: number,
  cogs: number,
  totalFees: number,
  shippingCost: number = 0
): number {
  return revenue - cogs - totalFees - shippingCost;
}

/** ROI = Profit / COGS × 100 (NOT profit / revenue — that's margin) */
export function calculateROI(profit: number, cogs: number): number {
  if (cogs === 0) return 0;
  return (profit / cogs) * 100;
}

/** Margin = Profit / Revenue × 100 */
export function calculateMargin(profit: number, revenue: number): number {
  if (revenue === 0) return 0;
  return (profit / revenue) * 100;
}

/** Sum an array of cent values */
export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Average of cent values */
export function avgCents(values: number[]): number {
  if (values.length === 0) return 0;
  return sumCents(values) / values.length;
}

/** Net impact of a refund = refund amount - fee clawback */
export function calculateRefundNetImpact(refundAmount: number, feeClawback: number): number {
  return refundAmount - feeClawback;
}

/** Shipping profit for MFN orders = shipping charged to customer - actual shipping cost */
export function calculateShippingProfit(shippingCharged: number, shippingCost: number): number {
  return shippingCharged - shippingCost;
}

/** Expected profit for inventory = (list price - estimated fees - COGS) × quantity */
export function calculateExpectedProfit(
  listPrice: number,
  estimatedFees: number,
  cogs: number,
  quantity: number
): number {
  return (listPrice - estimatedFees - cogs) * quantity;
}

/** Percent change between two values */
export function calculatePercentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}
