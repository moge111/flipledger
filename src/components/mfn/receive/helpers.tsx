
import { BatchItem, Chip, ProfitCalc, ReceiveProgress, SearchResult, ShippingTemplate } from '@/components/mfn/receive/types';

// Match a stored value (which may be an old display name OR a current key) to
// a template entry by checking key first, then name. Returns null if unknown.
export function resolveShippingTemplate(value: string, templates: ShippingTemplate[] | null): ShippingTemplate | null {
  if (!value || !templates) return null;
  return templates.find(t => t.key === value || t.name === value) ?? null;
}

// Return the user-facing label for a stored value. If the value matches a
// known template (by key or name), returns the template's name. Unknown values
// are returned as-is so nothing is silently lost.

export function liveStateBadge(status: string | null, qty: number | null) {
  if (!status) return null;
  if (status === 'Active' && (qty ?? 0) > 0) {
    return <span className="tag text-positive">Live</span>;
  }
  if (status === 'Active' && (qty ?? 0) === 0) {
    return <span className="tag text-warning">OOS</span>;
  }
  if (status === 'Inactive' || status === 'Incomplete') {
    return <span className="tag text-negative">{status}</span>;
  }
  return null;
}

export function calcProfit(item: BatchItem): ProfitCalc {
  const listRaw  = parseFloat(item.draft_list_price);
  const listCents = Number.isFinite(listRaw) && listRaw > 0 ? Math.round(listRaw * 100) : null;

  // For existing lots, cost is locked in from buy_price; for new lots use the draft field
  const costRaw  = item.il_id != null
    ? (item.buy_price ?? (item.draft_buy_price ? parseFloat(item.draft_buy_price) * 100 : null))
    : (item.draft_buy_price ? parseFloat(item.draft_buy_price) * 100 : null);
  const costCents = costRaw != null && Number.isFinite(costRaw) && costRaw >= 0
    ? Math.round(costRaw) : null;

  const shipRaw  = parseFloat(item.draft_shipping_est);
  const shipCents = Number.isFinite(shipRaw) && shipRaw >= 0 ? Math.round(shipRaw * 100) : 800;

  // Fee data from fee_estimates_cache
  const cachedReferral    = item.referral_fee_cents != null ? Number(item.referral_fee_cents) : null;
  const cachedTotal       = item.fee_cents != null ? Number(item.fee_cents) : null;
  const feeEstimatedAtCents = item.fee_list_price_cents != null ? Number(item.fee_list_price_cents) : null;

  // VCF = flat per-item component (e.g. $1.80 for media). Derived from cache.
  const vcfCents = (cachedTotal != null && cachedReferral != null)
    ? Math.max(0, cachedTotal - cachedReferral)
    : 0;

  // Referral rate — apply to CURRENT list price for accuracy
  const referralRate = (cachedReferral != null && feeEstimatedAtCents != null && feeEstimatedAtCents > 0)
    ? cachedReferral / feeEstimatedAtCents
    : null;

  const hasFee = referralRate != null;

  // Adjusted referral at current list price
  const referralCents = (referralRate != null && listCents != null)
    ? Math.round(referralRate * listCents)
    : null;

  // Total Amazon fee = adjusted referral + flat VCF
  const feeCents = referralCents != null ? referralCents + vcfCents : null;

  if (listCents == null || costCents == null) {
    return { netCents: null, roiPct: null, marginPct: null, listCents, costCents, shipCents,
             referralCents, referralRate, vcfCents, feeCents, hasFee, feeEstimatedAtCents };
  }

  const netCents  = listCents - costCents - shipCents - (feeCents ?? 0);
  const roiPct    = costCents > 0 ? (netCents / costCents) * 100 : null;
  const marginPct = listCents > 0 ? (netCents / listCents) * 100 : null;

  return { netCents, roiPct, marginPct, listCents, costCents, shipCents,
           referralCents, referralRate, vcfCents, feeCents, hasFee, feeEstimatedAtCents };
}

// ---------------------------------------------------------------------------
// Warning chips — compact per-item status indicators for the batch row
// ---------------------------------------------------------------------------

export function chipsForBatchItem(item: BatchItem): Chip[] {
  const chips: Chip[] = [];
  if (item.il_id != null && !item.inspected_at) {
    chips.push({ label: 'Not inspected', tone: 'warn', title: 'Inspection required before pushing to Amazon' });
  }
  // List price is a true push blocker — surface it as red.
  const priceNum = parseFloat(item.draft_list_price);
  if (item.il_id != null && (!Number.isFinite(priceNum) || priceNum <= 0)) {
    chips.push({ label: 'No price', tone: 'blocker', title: 'No list price set — required to push' });
  }
  if (item.amazon_status && item.amazon_status !== 'Active') {
    chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${item.amazon_status}" — push will still attempt qty/price update` });
  }
  if (item.referral_fee_cents == null) {
    chips.push({ label: 'Fee unknown', tone: 'info', title: 'No cached referral fee — ROI excludes Amazon fee' });
  }
  const condSet = !!(item.condition || item.draft_condition.trim());
  if (!condSet) chips.push({ label: 'No condition', tone: 'info', title: 'Condition not set' });
  return chips;
}

export function getReceiveProgress(item: BatchItem): ReceiveProgress | null {
  if (item.il_id == null) return null;
  const parsedTotal = item.parsed_order_qty != null && item.parsed_order_qty > 0 ? Number(item.parsed_order_qty) : null;
  const received    = item.quantity_received != null ? Math.max(0, Number(item.quantity_received)) : 0;
  const total       = parsedTotal ?? (received > 0 ? received : null);
  if (total == null || total <= 0) return null;
  // Keep `received` as the actual quantity_received. Cap the bar's pct at 100% but
  // surface the over-receive condition so callers can flag it visually.
  const remaining = Math.max(0, total - received);
  const pct = Math.min(100, Math.round((Math.min(received, total) / total) * 100));
  const isOver = received > total;
  return { total, received, remaining, pct, isOver };
}

// Discriminator: a BatchItem has draft_* fields and save_state; a bare
// SearchResult does not. Used by the details drawer to render fewer
// sections when opened from a search result that hasn't been added.
export function isBatchItem(item: SearchResult | BatchItem): item is BatchItem {
  return 'draft_qty' in item;
}
