/**
 * eBay costs that only exist on the payout side: shipping labels and
 * order-less fees (Promoted Listings, insertion, subscription, store).
 *
 * The regular eBay sync reads the Fulfillment API, which carries revenue,
 * buyer-paid shipping and `totalMarketplaceFee` (Final Value + international
 * fees only). These two cost types come from either:
 *   - the Finances API (automatic, daily): syncEbayPayoutCosts(), or
 *   - a Seller Hub "Transaction report" CSV (manual fallback):
 *     /api/sync/import-ebay-transactions.
 * Both build the same PayoutCosts shape and write through applyEbayPayoutCosts,
 * so they produce identical rows and replace each other's window cleanly.
 *
 * NOT booked here (each would double-count): sales and refunds (Fulfillment
 * sync), payouts, TRANSFER (eBay debiting your bank to cover a negative
 * balance), and DISPUTE/CREDIT pairs that net to zero.
 *
 * The Finances API is served from apiz.ebay.com. On api.ebay.com every
 * Finances endpoint returns 404, which from April 2025 to Sept 2026 was read
 * as "Application Growth Check not approved".
 */
import type Database from 'better-sqlite3';
import { openDb } from '@/lib/db-conn';
import { marketDate, addDays } from '@/lib/market-day';
import { createLogger } from '@/lib/log';
import { getAccessToken, getEbayCredentials } from './auth';

const log = createLogger('ebay-api/payoutCosts');

export const PAYOUT_FEE_EVENT = 'EbayTransactionReportFee';
const FINANCES_API = 'https://apiz.ebay.com/sell/finances/v1';

export interface PayoutCosts {
  source: 'ebay-finances-api' | 'ebay-transaction-report';
  /** Inclusive calendar window (YYYY-MM-DD) the source fully covers. */
  fromDate: string;
  throughDate: string;
  /** Net label cost per order, cents (purchases positive, voids negative). */
  labelByOrder: Map<string, { cents: number; count: number }>;
  /** Signed fee cents (charges negative) per (feeType, day). */
  fees: Map<string, { date: string; feeType: string; feeCategory: string; cents: number; count: number }>;
}

export function addPayoutFee(pc: PayoutCosts, date: string, fee: { feeType: string; feeCategory: string }, cents: number) {
  const key = `${fee.feeType}|${date}`;
  const cur = pc.fees.get(key);
  if (cur) { cur.cents += cents; cur.count += 1; }
  else pc.fees.set(key, { date, ...fee, cents, count: 1 });
}

export function addPayoutLabel(pc: PayoutCosts, orderId: string, cents: number) {
  const cur = pc.labelByOrder.get(orderId);
  if (cur) { cur.cents += cents; cur.count += 1; }
  else pc.labelByOrder.set(orderId, { cents, count: 1 });
}

export interface PayoutApplyResult {
  labelsApplied: number;
  labelCents: number;
  ordersNotFound: string[];
  feeRows: number;
  feeCents: number;
  priorEventsRemoved: number;
  priorFeesRemoved: number;
}

/**
 * Write the costs. Fees in [fromDate, throughDate] are REPLACED (bounded, never
 * unbounded: see the July 6 2026 import-transactions staleness bug). Label cost
 * is set only on orders the source mentions, on the order's lowest-id line.
 */
export function applyEbayPayoutCosts(db: Database.Database, pc: PayoutCosts, now = new Date().toISOString()): PayoutApplyResult {
  const r: PayoutApplyResult = { labelsApplied: 0, labelCents: 0, ordersNotFound: [], feeRows: 0, feeCents: 0, priorEventsRemoved: 0, priorFeesRemoved: 0 };
  const endNext = addDays(pc.throughDate, 1);

  db.transaction(() => {
    const prior = db.prepare(`
      SELECT id FROM financial_events
      WHERE event_type = ? AND date(posted_date) >= ? AND date(posted_date) < ?
    `).all(PAYOUT_FEE_EVENT, pc.fromDate, endNext) as { id: number }[];
    if (prior.length) {
      const ids = prior.map(e => e.id);
      const ph = ids.map(() => '?').join(',');
      r.priorFeesRemoved = db.prepare(`DELETE FROM fee_details WHERE financial_event_id IN (${ph})`).run(...ids).changes;
      r.priorEventsRemoved = db.prepare(`DELETE FROM financial_events WHERE id IN (${ph})`).run(...ids).changes;
    }

    const findItem = db.prepare(`
      SELECT MIN(oi.id) AS id FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE oi.order_id = ? AND o.marketplace = 'ebay'
    `);
    const zeroOrder = db.prepare(`UPDATE order_items SET shipping_cost = 0 WHERE order_id = ?`);
    const setCost = db.prepare(`UPDATE order_items SET shipping_cost = ? WHERE id = ?`);
    for (const [order, info] of pc.labelByOrder) {
      const row = findItem.get(order) as { id: number | null } | undefined;
      if (!row?.id) { r.ordersNotFound.push(order); continue; }
      // Whole label on the lowest-id line only: spreading it multiplies it in
      // every SUM. Never negative (a void exceeding purchases would read as income).
      const cost = Math.max(0, info.cents);
      zeroOrder.run(order);
      setCost.run(cost, row.id);
      r.labelsApplied++; r.labelCents += cost;
    }

    // order_id NULL so the P&L picks these up via its service-fee query, scoped
    // by financial_events.marketplace. Aggregated per (feeType, day) because
    // idx_fee_details_unique is day-level.
    const insEvent = db.prepare(`
      INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, NULL, NULL, NULL, 'ebay', ?, ?, ?)
    `);
    const insFee = db.prepare(`
      INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, NULL, NULL, ?, ?, ?, ?)
    `);
    for (const f of pc.fees.values()) {
      if (f.cents === 0) continue;
      const evId = Number(insEvent.run(PAYOUT_FEE_EVENT, f.date, f.cents,
        JSON.stringify({ source: pc.source, feeType: f.feeType, rowsAggregated: f.count }), now).lastInsertRowid);
      if (insFee.run(evId, f.feeType, f.feeCategory, f.cents, f.date).changes > 0) { r.feeRows++; r.feeCents += f.cents; }
      else db.prepare(`DELETE FROM financial_events WHERE id = ?`).run(evId);
    }
  })();
  return r;
}

/** Finances API feeType → our fee_type / category (same names the CSV importer uses). */
export function classifyApiFee(feeType: string | undefined): { feeType: string; feeCategory: string } {
  switch (feeType) {
    case 'AD_FEE': return { feeType: 'EbayPromotedListing', feeCategory: 'eBay Advertising Fees' };
    case 'INSERTION_FEE': return { feeType: 'EbayInsertionFee', feeCategory: 'eBay Listing Fees' };
    case 'SUBSCRIPTION_FEE': return { feeType: 'EbaySubscriptionFee', feeCategory: 'eBay Service Fees' };
    case 'STORE_SUBSCRIPTION_FEE': return { feeType: 'EbayStoreFee', feeCategory: 'eBay Service Fees' };
    default: return { feeType: 'EbayOtherFee', feeCategory: 'eBay Service Fees' };
  }
}

export interface LabelTxn { transactionId: string; orderId: string; cents: number; date: string; memo: string | null }

/**
 * Split Finances API transactions (dated on the marketplace day) into fees for
 * the window and label transactions. Label cost is signed as a cost: a purchase
 * (DEBIT) is positive, a void or postage refund (CREDIT) negative.
 */
export function parseFinanceTransactions(txns: any[], fromDate: string, throughDate: string): { pc: PayoutCosts; labels: LabelTxn[] } {
  const pc: PayoutCosts = { source: 'ebay-finances-api', fromDate, throughDate, labelByOrder: new Map(), fees: new Map() };
  const labels: LabelTxn[] = [];
  for (const t of txns) {
    const cents = Math.round(Number(t.amount?.value ?? 0) * 100) * (t.bookingEntry === 'DEBIT' ? -1 : 1);
    if (!cents) continue;
    const date = marketDate(new Date(t.transactionDate));
    if (t.transactionType === 'SHIPPING_LABEL') {
      if (t.orderId && t.transactionId) labels.push({ transactionId: t.transactionId, orderId: t.orderId, cents: -cents, date, memo: t.transactionMemo ?? null });
    } else if (t.transactionType === 'NON_SALE_CHARGE' && date >= fromDate && date <= throughDate) {
      addPayoutFee(pc, date, classifyApiFee(t.feeType), cents);
    }
  }
  return { pc, labels };
}

/**
 * Record label transactions and set each touched order's label cost to the sum
 * of ALL its recorded transactions, so a window that sees only a later
 * adjustment (e.g. "underpaid postage") keeps the original label.
 */
export function recordLabelTransactions(db: Database.Database, pc: PayoutCosts, labels: LabelTxn[]) {
  const upsert = db.prepare(`
    INSERT INTO ebay_label_transactions (transaction_id, order_id, amount_cents, transaction_date, memo)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET order_id = excluded.order_id, amount_cents = excluded.amount_cents,
      transaction_date = excluded.transaction_date, memo = excluded.memo
  `);
  const total = db.prepare(`SELECT SUM(amount_cents) AS cents, COUNT(*) AS n FROM ebay_label_transactions WHERE order_id = ?`);
  db.transaction(() => { for (const l of labels) upsert.run(l.transactionId, l.orderId, l.cents, l.date, l.memo); })();
  for (const orderId of new Set(labels.map(l => l.orderId))) {
    const row = total.get(orderId) as { cents: number; n: number };
    pc.labelByOrder.set(orderId, { cents: row.cents, count: row.n });
  }
}

async function fetchTransactions(token: string, fromIso: string, toIso: string): Promise<any[]> {
  const out: any[] = [];
  let offset = 0, total = 0;
  do {
    const url = `${FINANCES_API}/transaction?limit=200&offset=${offset}&filter=transactionDate:%5B${fromIso}..${toIso}%5D`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    if (!res.ok) throw new Error(`eBay Finances ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    total = j.total ?? 0;
    out.push(...(j.transactions || []));
    offset += 200;
  } while (offset < total);
  return out;
}

/**
 * Pull the last `days` of Finances transactions (month-sized requests; one
 * unbounded request stops at ~3 months) and apply labels + fees. Today is
 * excluded because it is still accruing.
 */
export async function syncEbayPayoutCosts(days = 120): Promise<PayoutApplyResult & { fromDate: string; throughDate: string; transactions: number }> {
  const creds = getEbayCredentials();
  if (!creds) throw new Error('eBay credentials not configured');
  const token = await getAccessToken(creds);
  const throughDate = addDays(marketDate(new Date()), -1);
  const fromDate = addDays(throughDate, -days + 1);

  const txns: any[] = [];
  const seen = new Set<string>();
  // Pad the UTC request window by a day either side; rows are filtered by marketplace day.
  for (let start = addDays(fromDate, -1); start <= addDays(throughDate, 1); start = addDays(start, 30)) {
    const end = addDays(start, 30);
    for (const t of await fetchTransactions(token, `${start}T00:00:00.000Z`, `${end}T00:00:00.000Z`)) {
      const k = `${t.transactionId}|${t.transactionType}`;
      if (!seen.has(k)) { seen.add(k); txns.push(t); }
    }
  }

  const { pc, labels } = parseFinanceTransactions(txns, fromDate, throughDate);
  const db = openDb();
  try {
    recordLabelTransactions(db, pc, labels);
    const r = applyEbayPayoutCosts(db, pc);
    log.info(`eBay payout costs ${fromDate}..${throughDate}: ${txns.length} transactions, ${r.labelsApplied} label orders ($${(r.labelCents / 100).toFixed(2)}), ${r.feeRows} fee rows ($${(-r.feeCents / 100).toFixed(2)})`);
    return { ...r, fromDate, throughDate, transactions: txns.length };
  } finally {
    db.close();
  }
}
