/**
 * Regression tests for eBay payout costs from the Finances API (Sept 23 2026).
 *
 * Labels and order-less fees (Promoted Listings, insertion) used to need a
 * manual Transaction report CSV because the Finances API "404'd"; it was only
 * being called on the wrong host. Both paths now share applyEbayPayoutCosts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pay: any;
const NOW = "'2026-09-01T00:00:00Z'";

const txn = (id: string, type: string, entry: 'DEBIT' | 'CREDIT', value: string, date: string, extra: object = {}) =>
  ({ transactionId: id, transactionType: type, bookingEntry: entry, amount: { value, currency: 'USD' }, transactionDate: date, ...extra });

const labelCost = (order: string) =>
  (db.prepare('SELECT SUM(shipping_cost) c FROM order_items WHERE order_id = ?').get(order) as { c: number }).c;
const feeTotal = () => (db.prepare(`SELECT COALESCE(SUM(fd.amount), 0) c FROM fee_details fd
  JOIN financial_events fe ON fe.id = fd.financial_event_id WHERE fe.event_type = 'EbayTransactionReportFee'`).get() as { c: number }).c;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  for (const o of ['EB-1', 'EB-2']) {
    db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
      VALUES (?, '2026-08-10T12:00:00Z', 'Shipped', 'ebay', 'MFN', ${NOW})`).run(o);
    for (const sku of ['a', 'b']) db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
      VALUES (?, ?, ?, 1, 2000, 2000, 500, 0, 0, 0)`).run(o, `${o}-${sku}`, `${o}-${sku}`);
  }
  pay = await import('../src/lib/ebay-api/payoutCosts');
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('labels net voids, land on one line, and fees are signed and bucketed by day', () => {
  const { pc, labels } = pay.parseFinanceTransactions([
    txn('L1', 'SHIPPING_LABEL', 'DEBIT', '6.90', '2026-08-17T16:46:43Z', { orderId: 'EB-1' }),
    txn('L2', 'SHIPPING_LABEL', 'DEBIT', '5.00', '2026-08-18T16:00:00Z', { orderId: 'EB-2' }),
    txn('L3', 'SHIPPING_LABEL', 'CREDIT', '5.00', '2026-08-19T16:00:00Z', { orderId: 'EB-2' }),
    txn('F1', 'NON_SALE_CHARGE', 'DEBIT', '21.51', '2026-08-25T13:02:21Z', { feeType: 'AD_FEE' }),
    txn('F2', 'NON_SALE_CHARGE', 'DEBIT', '0.50', '2026-08-25T21:44:18Z', { feeType: 'AD_FEE' }),
    txn('F3', 'NON_SALE_CHARGE', 'CREDIT', '0.35', '2026-08-20T10:00:00Z', { feeType: 'INSERTION_FEE' }),
    txn('S1', 'SALE', 'CREDIT', '46.71', '2026-08-15T23:29:20Z', { orderId: 'EB-1' }),
    txn('T1', 'TRANSFER', 'CREDIT', '8.81', '2026-08-08T10:00:00Z'),
  ], '2026-08-01', '2026-08-31');
  pay.recordLabelTransactions(db, pc, labels);
  pay.applyEbayPayoutCosts(db, pc);
  assert.equal(labelCost('EB-1'), 690);
  assert.equal(labelCost('EB-2'), 0, 'a voided label nets to zero, never negative');
  const lines = db.prepare("SELECT shipping_cost FROM order_items WHERE order_id = 'EB-1' ORDER BY id").all() as { shipping_cost: number }[];
  assert.deepEqual(lines.map(l => l.shipping_cost), [690, 0], 'whole label on the first line only');
  assert.equal(feeTotal(), -2201 + 35, 'AD fees charged, insertion credit positive; sales and transfers ignored');
});

test('a later window that only sees an adjustment keeps the original label', () => {
  const { pc, labels } = pay.parseFinanceTransactions([
    txn('L4', 'SHIPPING_LABEL', 'DEBIT', '2.55', '2026-08-31T16:36:15Z', { orderId: 'EB-1', transactionMemo: 'Charge - underpaid postage' }),
  ], '2026-08-24', '2026-09-22');
  pay.recordLabelTransactions(db, pc, labels);
  pay.applyEbayPayoutCosts(db, pc);
  assert.equal(labelCost('EB-1'), 690 + 255);
});

test('fee replacement is bounded to the window and re-runs converge', () => {
  const before = feeTotal();
  const { pc } = pay.parseFinanceTransactions([
    txn('F4', 'NON_SALE_CHARGE', 'DEBIT', '1.00', '2026-09-05T12:00:00Z', { feeType: 'AD_FEE' }),
  ], '2026-09-01', '2026-09-30');
  pay.applyEbayPayoutCosts(db, pc);
  pay.applyEbayPayoutCosts(db, pc);
  assert.equal(feeTotal(), before - 100, 'August fees untouched by a September window; no duplicate on re-run');
});
