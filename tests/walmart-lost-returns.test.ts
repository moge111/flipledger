/**
 * Regression tests for Walmart returns that never came back (Sept 22 2026,
 * review A2 + D2).
 *
 * returns.ts writes item_returned=1 on every Walmart refund, and FIFO zeroed
 * COGS once the refund settled, as if the unit went back into stock. When
 * Walmart loses the return (it pays a LostReturnAdjustment months later) or the
 * order was lost in transit, the unit is gone: ~$730 of COGS had been erased.
 * The dispute detector couldn't see those payouts either, so 4 already-paid
 * returns were filed as claims and denied.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = "'2026-03-20T00:00:00Z'";

/** A settled WFS sale + full refund of one unit on its own SKU. */
function settledReturn(id: string, sku: string, reason: string, rma: string) {
  db.exec(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('${sku}', '${sku}', 4000, 5, 5, '2026-01-01', ${NOW});
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('${id}', '2026-02-01T12:00:00Z', 'Shipped', 'walmart', 'WFS', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES ('${id}', '${sku}', '${sku}', 1, 9000, 9000, 0, 0, 0, 0);
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartReconEvent', '2026-02-03T00:00:00Z', '${id}', '${sku}', '${sku}', 'walmart', 9000, NULL, ${NOW});
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartRefundEvent', '2026-02-20T00:00:00Z', '${id}', '${sku}', '${sku}', 'walmart', -9000, '{"Amount Type":"Product Price"}', ${NOW});
    INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, return_order_id, created_at)
    VALUES ('${id}', '2026-02-18T12:00:00Z', '${sku}', '${sku}', 1, 9000, '${reason}', 1, 0, 'walmart', '${rma}', ${NOW});
  `);
}

const cogs = (id: string) =>
  (db.prepare('SELECT cogs_per_unit FROM order_items WHERE order_id = ?').get(id) as { cogs_per_unit: number }).cogs_per_unit;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  settledReturn('WMT-LOST-LRA', 'wm-lost-lra-40', 'NO_LONGER_WANTED', 'RMA-LRA-1');
  settledReturn('WMT-LOST-TRANSIT', 'wm-lost-transit-40', 'LOST_IN_TRANSIT', 'RMA-TRANSIT-1');
  settledReturn('WMT-CAME-BACK', 'wm-came-back-40', 'NO_LONGER_WANTED', 'RMA-BACK-1');
  // Walmart paid for the first return: it lost the unit.
  db.exec(`
    INSERT INTO wfs_lost_returns (po, rma, gtin, credit_date, quantity, credit_cents, wfs_reference_id, source_file)
    VALUES ('WMT-LOST-LRA', 'RMA-LRA-1', '00000000000001', '2026-06-30', 1, 7500, 'ref-lra-1', 'Refund_test.csv');
  `);
  const { recalculateFIFO } = await import('../src/lib/fifo');
  for (const sku of ['wm-lost-lra-40', 'wm-lost-transit-40', 'wm-came-back-40']) {
    assert.deepEqual(recalculateFIFO({ sku }).errors, []);
  }
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('a return Walmart lost and paid for keeps its COGS', () => {
  assert.equal(cogs('WMT-LOST-LRA'), 4000);
});

test('a settled LOST_IN_TRANSIT refund keeps its COGS', () => {
  assert.equal(cogs('WMT-LOST-TRANSIT'), 4000);
});

test('an ordinary settled return still zeroes COGS (the unit came back)', () => {
  assert.equal(cogs('WMT-CAME-BACK'), 0);
});

test('the dispute detector labels a paid lost return "already reimbursed" and never eligible', async () => {
  const { syncWalmartDisputeCandidates } = await import('../src/lib/walmart-api/disputeCandidates');
  syncWalmartDisputeCandidates();
  const row = db.prepare(`
    SELECT c.eligibility, c.eligibility_reasons FROM walmart_dispute_candidates c
    JOIN refunds r ON r.id = c.refund_id WHERE r.order_id = 'WMT-LOST-LRA'
  `).get() as { eligibility: string; eligibility_reasons: string };
  assert.equal(row.eligibility, 'not_eligible');
  assert.match(row.eligibility_reasons, /already reimbursed.*\$75\.00 LostReturnAdjustment on 2026-06-30/);
  assert.match(row.eligibility_reasons, /Paid \$75\.00 of the \$90\.00 refund/);
});
