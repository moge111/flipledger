/**
 * Regression test for the Walmart-funded incentive reversal (Sept 21 2026,
 * with the review A12 fix of Sept 23).
 *
 * When a unit with a Walmart-funded incentive is returned, recon sends a
 * negative "Total Walmart Funded Savings" Refund row. The Refund branch stores
 * it as a WalmartRefundEvent; applyFundedIncentiveReversal books the income
 * reversal as a negative reimbursement. It used to ALSO write a negative
 * WalmartIncentive event, so the per-order Net on /lookup (the sum of the
 * order's events) subtracted the reversal twice: -$268.47 across 25 orders.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const PO = 'WMT-FUNDED-RET';
const NOW = '2026-05-24T00:00:00Z';

// A real order: sale side +12535, refund side -13350 → -815.
const saleLines = [12300, 2411, -711, -1120, -345];
const refundLines = [-470, -12300, -956, 956, 1120, 711];
const FUNDED_REVERSAL = -2411;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, '2026-05-10T12:00:00Z', 'Shipped', 'walmart', 'WFS', ?)`).run(PO, NOW);
  const ev = db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES (?, ?, ?, 'wm-fitbit-99', 'wm-fitbit-99', 'walmart', ?, ?, ?)`);
  saleLines.forEach((c, i) => ev.run(i === 1 ? 'WalmartIncentive' : 'WalmartReconEvent', `2026-05-12T00:00:0${i}Z`, PO, c, '{"Transaction Type":"Sale"}', NOW));
  refundLines.forEach((c, i) => ev.run('WalmartRefundEvent', `2026-05-23T00:00:0${i}Z`, PO, c, '{"Transaction Type":"Refund"}', NOW));
  // The refund-side funded-savings line, as the Refund branch stores it.
  ev.run('WalmartRefundEvent', '2026-05-23T00:00:00Z', PO, FUNDED_REVERSAL,
    JSON.stringify({ 'Transaction Type': 'Refund', 'Amount Type': 'Total Walmart Funded Savings', 'Transaction Key': 'TK-1' }), NOW);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('the reversal is booked once, as a reimbursement, with no extra event', async () => {
  const { applyFundedIncentiveReversal } = await import('../src/lib/walmart-api/recon');
  const events = () => (db.prepare('SELECT COUNT(*) n FROM financial_events WHERE order_id = ?').get(PO) as { n: number }).n;
  const before = events();
  const entry = { 'Transaction Key': 'TK-1', 'Transaction Type': 'Refund', 'Amount Type': 'Total Walmart Funded Savings' };
  applyFundedIncentiveReversal(db, entry, PO, 'wm-fitbit-99', FUNDED_REVERSAL, '2026-05-23T00:00:00Z', NOW);
  applyFundedIncentiveReversal(db, entry, PO, 'wm-fitbit-99', FUNDED_REVERSAL, '2026-05-23T00:00:00Z', NOW);
  assert.equal(events(), before, 'no financial_events row written');
  const r = db.prepare(`SELECT COUNT(*) n, SUM(amount) s FROM reimbursements WHERE reimbursement_id = 'WMT-FUNDED-REV-TK-1'`).get() as { n: number; s: number };
  assert.deepEqual(r, { n: 1, s: FUNDED_REVERSAL }, 'one idempotent reversal reimbursement');
});

test('the order lookup Net equals the Walmart settlement', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('../src/app/api/data/order/[id]/route');
  const res: Response = await mod.GET(new Request(`http://t/api/data/order/${PO}`), { params: Promise.resolve({ id: PO }) });
  const { summary } = await res.json();
  const settlement = [...saleLines, ...refundLines, FUNDED_REVERSAL].reduce((a, b) => a + b, 0);
  assert.equal(settlement, -815);
  assert.equal(summary.netCents, settlement);
});
