/**
 * Marketplace-day bucketing.
 *
 * Amazon and Walmart close their sales day at midnight Pacific (= 1 AM
 * Mountain). Their 1099-K, Seller Central dashboards and settlement reports
 * are all cut on that boundary. FlipLedger historically bucketed on the UTC
 * calendar date, which closes the day at 6 PM Mountain (5 PM in winter) — so
 * every sale from late afternoon onward landed on the FOLLOWING day, and at
 * each month/year boundary that revenue landed in the following period.
 *
 * ── Why this is a guarded CASE and not a plain date() ────────────────────────
 *
 * The timestamp columns hold three different value shapes (audited 2026-08-31):
 *
 *   real UTC instant   2026-09-01T00:39:31Z   Amazon/eBay ShipmentEvent,
 *                                             RefundEvent, ServiceFeeEvent,
 *                                             TransactionReport*  → CONVERT
 *   pseudo-date        2026-08-31T00:00:00Z   100% Walmart recon rows
 *                                             (WalmartReconEvent, …). Walmart's
 *                                             recon report carries a calendar
 *                                             DATE with no time-of-day, already
 *                                             in Walmart's reporting day.
 *                                             Midnight is an artifact.  → LEAVE
 *   bare date          2026-08-01             settlement/report sourced → LEAVE
 *
 * Converting a midnight-UTC pseudo-date to Pacific moves it to the PREVIOUS
 * day. There are ~14,000 such rows; doing that silently would corrupt every
 * Walmart figure in the books. The partition is exact, not heuristic: zero
 * rows anywhere store `T00:00:00.` with milliseconds, so no genuine event
 * timestamp can be mistaken for a pseudo-date.
 *
 * ── Why 'localtime','-1 hour' ───────────────────────────────────────────────
 *
 * SQLite has no timezone database of its own; 'localtime' delegates to the
 * host's tzdata, which handles DST correctly. This machine runs America/Denver,
 * and Pacific is always exactly one hour behind Mountain (both observe US DST
 * on the same dates), so Mountain − 1h is a DST-correct Pacific date.
 *
 * If the host timezone is ever changed, this silently shifts. That is locked
 * down by an invariant test that asserts a known instant buckets to the
 * expected Pacific date — see tests/live-invariants.test.ts.
 */

/** True when the stored value is a real instant rather than a calendar date. */
const IS_INSTANT = (col: string) =>
  `${col} LIKE '%T%' AND ${col} NOT LIKE '%T00:00:00%'`;

/** SQL fragment: the marketplace (Pacific) calendar date, `YYYY-MM-DD`. */
export const MKT_DATE = (col: string) =>
  `(CASE WHEN ${IS_INSTANT(col)} THEN date(${col}, 'localtime', '-1 hour') ELSE date(${col}) END)`;

/** SQL fragment: the marketplace calendar month, `YYYY-MM`. */
export const MKT_MONTH = (col: string) =>
  `(CASE WHEN ${IS_INSTANT(col)} THEN strftime('%Y-%m', ${col}, 'localtime', '-1 hour') ELSE strftime('%Y-%m', ${col}) END)`;

/** SQL fragment: first day of the marketplace calendar month, `YYYY-MM-01`. */
export const MKT_MONTH_START = (col: string) =>
  `(CASE WHEN ${IS_INSTANT(col)} THEN strftime('%Y-%m-01', ${col}, 'localtime', '-1 hour') ELSE strftime('%Y-%m-01', ${col}) END)`;

/**
 * SQL fragment: start of the marketplace week (Sunday) containing the row.
 * SQLite's 'weekday 0' moves FORWARD to the next Sunday (or stays if already
 * Sunday), so step back six days first and then forward to Sunday: every day
 * Sun..Sat lands on that week's own Sunday. The previous
 * `'weekday 0', '-6 days'` order produced Monday-start weeks.
 */
export const MKT_WEEK_START = (col: string) =>
  `date(${MKT_DATE(col)}, '-6 days', 'weekday 0')`;

// ── JS-side helpers ─────────────────────────────────────────────────────────

const MARKET_TZ = 'America/Los_Angeles';

/** The marketplace calendar date for an instant, as `YYYY-MM-DD`. */
export function marketDate(d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Today, on the marketplace calendar. */
export function marketToday(): string {
  return marketDate();
}

/** Shift a `YYYY-MM-DD` string by whole days. Calendar math, no timezone. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return t.toISOString().slice(0, 10);
}

/** The marketplace date `n` days before today. */
export function marketDaysAgo(n: number): string {
  return addDays(marketToday(), -n);
}
