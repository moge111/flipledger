/**
 * formatters.ts — Display formatting for currency, dates, percentages.
 * Only place cents → dollars conversion happens.
 */

/** Convert cents to formatted USD string: $1,234.56 */
export function formatCurrency(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

/** Format cents as parenthetical negative: ($123.45) */
export function formatCurrencyParens(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
  return cents < 0 ? `(${formatted})` : formatted;
}

/** Format percentage: 23.5% */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** Format integer with commas: 1,234 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * Parse a date string for display.
 *
 * A bare `YYYY-MM-DD` (how expenses, refunds, and settlement rows store dates)
 * is parsed as UTC midnight by `new Date()`, which renders as the PREVIOUS day
 * in any negative-offset timezone. Those dates carry no time component, so they
 * are built as local midnight instead. Full timestamps parse normally.
 */
function parseDisplayDate(dateStr: string): Date {
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (bareDate) {
    const [, year, month, day] = bareDate;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  return new Date(dateStr);
}

/** Format date: "Apr 8, 2026" */
export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parseDisplayDate(dateStr));
}

/** Format date long: "April 08, 2026" */
export function formatDateLong(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: '2-digit',
    year: 'numeric',
  }).format(parseDisplayDate(dateStr));
}

/** Format relative time: "2h ago", "3d ago" */
export function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

/** Cents to raw dollar number (for charts) */
export function centsToDollars(cents: number): number {
  return cents / 100;
}
