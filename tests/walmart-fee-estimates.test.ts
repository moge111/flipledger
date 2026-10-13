/**
 * Walmart fee estimates (Sept 27 2026). Walmart revenue books when the order
 * syncs but its fees arrive with the biweekly recon report, so recent sales
 * showed $0 fees (10 mahjong sets at ~$87 "profit" each instead of ~$62).
 * refreshWalmartFeeEstimates fills the gap; real recon fees replace it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
const NOW = new Date().toISOString();

type Est = { fee_type: string; amount: number };
const estimates = (orderId: string) => db.prepare(`
  SELECT fee_type, amount FROM fee_details
  WHERE order_id = ? AND financial_event_id = 0 ORDER BY fee_type`).all(orderId) as Est[];

function addOrder(id: string, sku: string, qty: number, priceCents: number, opts: { channel?: string; age?: number; status?: string } = {}) {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, ?, ?, 'walmart', ?, ?)`).run(id, daysAgo(opts.age ?? 1), opts.status ?? 'Shipped', opts.channel ?? 'WFS', NOW);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, sku, sku, qty, priceCents / qty, priceCents);
}

function reconLine(orderId: string, sku: string, cents: number, raw: Record<string, string>, feeType: string) {
  const ev = db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartReconEvent', ?, ?, ?, ?, 'walmart', ?, ?, ?)`)
    .run(daysAgo(20), orderId, sku, sku, cents, JSON.stringify({ 'Transaction Type': 'Sale', ...raw }), NOW);
  db.prepare(`INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
    VALUES (?, ?, ?, ?, 'Walmart Fees', ?, ?)`).run(Number(ev.lastInsertRowid), orderId, sku, feeType, cents, daysAgo(20));
}

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  // Settled history: wm-hist at 14.25% and $3.00/unit WFS (a 2-unit $6.00 fee);
  // wm-other $9.00/unit. Account WFS average = (600 + 900) / 3 units = 500.
  addOrder('HIST-1', 'wm-hist', 2, 4000, { age: 25 });
  reconLine('HIST-1', 'wm-hist', -570, { 'Amount Type': 'Commission on Product', 'Commission Rate': '14.25' }, 'WalmartReferralFee');
  reconLine('HIST-1', 'wm-hist', -600, { 'Amount Type': 'Fee/Reimbursement', 'Transaction Description': 'WFS Fulfillment fee', 'Ship Qty': '2' }, 'WalmartFee');
  addOrder('HIST-2', 'wm-other', 1, 3000, { age: 25 });
  reconLine('HIST-2', 'wm-other', -900, { 'Amount Type': 'Fee/Reimbursement', 'Transaction Description': 'WFS Fulfillment fee', 'Ship Qty': '1' }, 'WalmartFee');

  addOrder('NEW-HIST', 'wm-hist', 1, 2000);             // SKU with settled history
  addOrder('NEW-FRESH', 'wm-mahjong-49.70', 1, 14000);  // never settled before
  addOrder('NEW-SELLER', 'wm-fresh-seller', 1, 5000, { channel: 'Seller' });
  addOrder('OLD', 'wm-old', 1, 5000, { age: 90 });      // outside the window
  addOrder('GONE', 'wm-gone', 1, 5000, { status: 'Cancelled' });
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('unsettled orders get referral + WFS estimates, from SKU history when it exists', async () => {
  const { refreshWalmartFeeEstimates } = await import('../src/lib/walmart-api/feeEstimates');
  refreshWalmartFeeEstimates(db);
  assert.deepEqual(estimates('NEW-HIST'), [
    { fee_type: 'WFSFulfillmentFeeEstimate', amount: -300 },  // SKU's own $3.00/unit
    { fee_type: 'WalmartReferralFeeEstimate', amount: -285 }, // 14.25% of $20.00
  ]);
  assert.deepEqual(estimates('NEW-FRESH'), [
    { fee_type: 'WFSFulfillmentFeeEstimate', amount: -500 },   // account average
    { fee_type: 'WalmartReferralFeeEstimate', amount: -2100 }, // standard 15%
  ]);
  assert.deepEqual(estimates('NEW-SELLER'), [{ fee_type: 'WalmartReferralFeeEstimate', amount: -750 }],
    'seller-fulfilled orders have no WFS fee');
});

test('settled, old and cancelled orders are never estimated', () => {
  for (const id of ['HIST-1', 'HIST-2', 'OLD', 'GONE']) assert.deepEqual(estimates(id), [], id);
  // Golden-fixture Walmart orders (January) stay untouched too.
  assert.deepEqual(estimates('GOLD-WMT-W1'), []);
});

test('rebuilding is idempotent and real recon fees replace the estimate', async () => {
  const { refreshWalmartFeeEstimates } = await import('../src/lib/walmart-api/feeEstimates');
  const total = () => (db.prepare(`SELECT COUNT(*) n, SUM(amount) s FROM fee_details WHERE financial_event_id = 0`).get() as { n: number; s: number });
  const first = total();
  refreshWalmartFeeEstimates(db);
  assert.deepEqual(total(), first, 'a second run changes nothing');

  reconLine('NEW-FRESH', 'wm-mahjong-49.70', -2100, { 'Amount Type': 'Commission on Product', 'Commission Rate': '15.00' }, 'WalmartReferralFee');
  refreshWalmartFeeEstimates(db);
  assert.deepEqual(estimates('NEW-FRESH'), [], 'settled order carries only real fees');

  // Once cancelled (order_items removed by the cancellation reversal), the estimate goes too.
  db.prepare(`DELETE FROM order_items WHERE order_id = 'NEW-SELLER'`).run();
  db.prepare(`UPDATE orders SET status = 'Cancelled' WHERE order_id = 'NEW-SELLER'`).run();
  refreshWalmartFeeEstimates(db);
  assert.deepEqual(estimates('NEW-SELLER'), []);
  assert.equal(estimates('NEW-HIST').length, 2, 'untouched orders keep their estimate');
});

test('estimates carry their own fee category', async () => {
  const { refreshWalmartFeeEstimates } = await import('../src/lib/walmart-api/feeEstimates');
  refreshWalmartFeeEstimates(db);
  const row = db.prepare(`SELECT fee_category, SUM(amount) s FROM fee_details WHERE order_id = 'NEW-HIST' GROUP BY 1`).get() as { fee_category: string; s: number };
  assert.deepEqual(row, { fee_category: 'Walmart Fees (estimated)', s: -585 });
});
