/**
 * Amazon order-less service fees (storage, subscription, inbound placement,
 * Partnered UPS transportation, removals, customer-return fees) sourced from
 * the v2024 Finances ledger (`finances_transactions_v2`, transaction_type
 * 'ServiceFee').
 *
 * Why (Sept 22 2026 review, A1): three writers used to book these fees and
 * none could tell a repeat from a new fee.
 *   - v0 ServiceFeeEvents carry no PostedDate, so each copy was dated "now"
 *     and deduped on amount inside a 30/60-day window. A 90-day manual sync
 *     re-booked every fee older than the window.
 *   - The settlement parser writes per-item placement lines while the
 *     transaction report writes per-shipment totals, so its amount check
 *     never matched.
 *   - The transaction-report import replaced ServiceFeeEvents, and the next
 *     sync re-inserted them.
 * Net effect: about $646 of 2026 fees counted twice (some three times).
 *
 * v2024 gives each fee a stable transaction_id and a real posted date.
 * From the cutover onward, the fee rows are a PROJECTION of that table:
 * every run deletes the projection and rebuilds it in one transaction, so it
 * is idempotent by construction. The other three writers are told to stay
 * out of the post-cutover window (see isV2024CoveredServiceFee).
 */
import Database from 'better-sqlite3';
import { marketDate } from '../market-day';
import { createLogger } from '../log';
import { openDb } from '../db-conn';

const log = createLogger('sp-api/serviceFeesV2024');

/** v2024 data is continuous from 2026-04-11 18:26Z; the first ServiceFee is Apr 19. */
export const V2024_SERVICE_FEE_CUTOVER = '2026-04-12T00:00:00Z';

export const V2024_SERVICE_FEE_EVENT_TYPE = 'AmazonV2024ServiceFee';

/**
 * v2024 description → the fee_type/fee_category already used for the same fee
 * before the cutover (transaction-report names), so P&L and Tax groupings
 * don't move.
 */
const FEE_MAP: Record<string, { feeType: string; feeCategory: string }> = {
  FBAPostInboundTransportation: { feeType: 'FBAInboundTransportationFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBAInboundConvenience: { feeType: 'FBAInboundPlacementServiceFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBAStorageBilling: { feeType: 'FBAStorageFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBALongTermStorageBilling: { feeType: 'FBALongTermStorageFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBARemoval: { feeType: 'FBARemovalFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBADisposal: { feeType: 'FBADisposalFee', feeCategory: 'FBA Inventory and Inbound Service Fees' },
  FBACustomerReturn: { feeType: 'FBACustomerReturnPerUnitFee', feeCategory: 'Other Fees' },
  Subscription: { feeType: 'Subscription', feeCategory: 'Other Fees' },
};

export function mapV2024ServiceFee(description: string | null): { feeType: string; feeCategory: string } {
  const d = (description || 'ServiceFee').trim();
  return FEE_MAP[d] || { feeType: d.replace(/\s+/g, ''), feeCategory: 'Other Fees' };
}

/**
 * True when a service fee from another source (settlement parser, transaction
 * report) falls in the window v2024 now owns and must not be written. Keeps
 * the non-service settlement rows v2024 ServiceFee does not cover:
 * Adjustment, FeeAdjustment, COMPENSATED_CLAWBACK, return-label purchases,
 * advertising.
 */
export function isV2024CoveredServiceFee(description: string, postedDateIso: string): boolean {
  if (!postedDateIso || postedDateIso < V2024_SERVICE_FEE_CUTOVER.substring(0, 10)) return false;
  return /storage|subscription|inbound|placement|transportation|removal|disposal|customer\s*return/i.test(description);
}

interface V2Row { transaction_id: string; posted_date: string; total_amount_cents: number; order_id: string | null; description: string | null }

/**
 * Rebuild the post-cutover Amazon service-fee rows from finances_transactions_v2.
 * One financial_event + one fee_details row per (fee_type, marketplace day);
 * the raw_data lists the source transactions. Grouping keeps the rows clear of
 * the day-level fee_details unique index, which would otherwise collapse two
 * genuine same-amount fees on one day (e.g. two $43.30 Partnered UPS charges
 * on Jun 24).
 */
export function rebuildAmazonServiceFeesFromV2024(db: Database.Database): { groups: number; transactions: number; totalCents: number } {
  const txns = db.prepare(`
    SELECT transaction_id, posted_date, total_amount_cents, order_id, description
    FROM finances_transactions_v2
    WHERE transaction_type = 'ServiceFee'
      AND posted_date >= ?
      AND total_amount_cents != 0
    ORDER BY posted_date, transaction_id
  `).all(V2024_SERVICE_FEE_CUTOVER) as V2Row[];

  const groups = new Map<string, { feeType: string; feeCategory: string; postedDate: string; cents: number; txns: { id: string; ref: string | null; cents: number; posted: string }[] }>();
  for (const t of txns) {
    const { feeType, feeCategory } = mapV2024ServiceFee(t.description);
    const key = `${feeType}|${marketDate(new Date(t.posted_date))}`;
    let g = groups.get(key);
    if (!g) {
      g = { feeType, feeCategory, postedDate: t.posted_date, cents: 0, txns: [] };
      groups.set(key, g);
    }
    g.cents += t.total_amount_cents;
    g.txns.push({ id: t.transaction_id, ref: t.order_id, cents: t.total_amount_cents, posted: t.posted_date });
  }

  const run = db.transaction(() => {
    db.prepare(`
      DELETE FROM fee_details WHERE financial_event_id IN (
        SELECT id FROM financial_events WHERE event_type = ?
      )
    `).run(V2024_SERVICE_FEE_EVENT_TYPE);
    db.prepare('DELETE FROM financial_events WHERE event_type = ?').run(V2024_SERVICE_FEE_EVENT_TYPE);

    // Plain INSERT (not OR IGNORE): a collision must fail loudly and roll back
    // rather than silently drop a fee.
    const insEvent = db.prepare(`
      INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES (?, ?, NULL, NULL, ?, 'amazon', ?, ?, datetime('now'))
    `);
    const insFee = db.prepare(`
      INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, NULL, NULL, ?, ?, ?, ?)
    `);
    let totalCents = 0;
    for (const g of groups.values()) {
      if (g.cents === 0) continue;
      // sku carries the fee type: it disambiguates two fee types that land on
      // the same instant with the same total in the financial_events index.
      const ev = insEvent.run(V2024_SERVICE_FEE_EVENT_TYPE, g.postedDate, g.feeType, g.cents, JSON.stringify({ source: 'finances_transactions_v2', transactions: g.txns }));
      insFee.run(Number(ev.lastInsertRowid), g.feeType, g.feeCategory, g.cents, g.postedDate);
      totalCents += g.cents;
    }
    return totalCents;
  });

  const totalCents = run();

  const lastFetch = (db.prepare(`SELECT MAX(fetched_at) AS f FROM finances_transactions_v2`).get() as { f: string | null }).f;
  if (lastFetch && Date.now() - new Date(lastFetch).getTime() > 25 * 86400000) {
    log.warn(`v2024 ledger last fetched ${lastFetch} — the sync pulls 30 days, so service fees older than that may be missing. Run a v2024 sync with an explicit postedAfter.`);
  }

  return { groups: groups.size, transactions: txns.length, totalCents };
}

/**
 * Removes post-cutover service-fee rows written by the legacy sources
 * (ServiceFeeEvent, settlement parser, transaction report). Order-linked fees
 * and the non-service settlement rows are untouched.
 */
export function purgeLegacyPostCutoverServiceFees(db: Database.Database): number {
  const legacy = db.prepare(`
    SELECT fe.id AS event_id, fd.id AS fee_id, fe.event_type, fd.fee_type, fe.raw_data
    FROM financial_events fe
    LEFT JOIN fee_details fd ON fd.financial_event_id = fe.id
    WHERE fe.marketplace = 'amazon'
      AND fe.event_type IN ('ServiceFeeEvent', 'SettlementServiceFee', 'TransactionReportServiceFee', 'TransactionReportInventoryFee')
      AND fe.posted_date >= ?
  `).all(V2024_SERVICE_FEE_CUTOVER.substring(0, 10)) as { event_id: number; fee_id: number | null; event_type: string; fee_type: string | null; raw_data: string | null }[];

  const doomed = legacy.filter(r => {
    if (r.event_type !== 'SettlementServiceFee') return true;
    let desc = r.fee_type || '';
    try { desc = JSON.parse(r.raw_data || '{}').description || desc; } catch { /* keep fee_type */ }
    return isV2024CoveredServiceFee(desc, V2024_SERVICE_FEE_CUTOVER);
  });

  const delFee = db.prepare('DELETE FROM fee_details WHERE id = ?');
  const delEvent = db.prepare('DELETE FROM financial_events WHERE id = ?');
  db.transaction(() => {
    for (const r of doomed) {
      if (r.fee_id != null) delFee.run(r.fee_id);
      delEvent.run(r.event_id);
    }
  })();
  return doomed.length;
}

/** Post-sync step: drop stray legacy rows in the v2024 window, then rebuild the projection. */
export function syncAmazonServiceFeesFromV2024(): { purged: number; groups: number; transactions: number; totalCents: number } {
  const db = openDb();
  try {
    const purged = purgeLegacyPostCutoverServiceFees(db);
    const rebuilt = rebuildAmazonServiceFeesFromV2024(db);
    if (purged > 0) log.warn(`Removed ${purged} legacy service-fee rows inside the v2024 window`);
    return { purged, ...rebuilt };
  } finally {
    db.close();
  }
}
