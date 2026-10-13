/**
 * Batch results (Sept 23 2026): what each sent batch did afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = "'2026-06-01T00:00:00Z'";
const SKU = 'amz-br-test-10';

function sale(orderId: string, date: string, qty: number, price: number, cogs: number) {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, ?, 'Shipped', 'amazon', 'FBA', ${NOW})`).run(orderId, date);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, 'B0BRTEST', ?, ?, ?, ?, 0, 0, 0, ?)`).run(orderId, SKU, qty, price, price * qty, cogs);
}

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  const batch = db.prepare(`INSERT INTO listing_batches (name, status, channel, marketplace, sent_at, created_at, updated_at)
    VALUES (?, 'shipping', 'FBA', 'amazon', ?, ${NOW}, ${NOW})`);
  const b1 = Number(batch.run('B1', '2026-06-01T00:00:00Z').lastInsertRowid);
  const b2 = Number(batch.run('B2', '2026-06-20T00:00:00Z').lastInsertRowid);
  // B1 owns a lot of 4 (2 left → 2 sold, exact); B2's item has no lot link.
  const lot = Number(db.prepare(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0BRTEST', ?, 1000, 4, 2, '2026-06-01', ${NOW})`).run(SKU).lastInsertRowid);
  const item = db.prepare(`INSERT INTO listing_batch_items (batch_id, asin, sku, quantity, list_price_cents, buy_price_cents, estimated_fee_cents, inventory_ledger_id, created_at)
    VALUES (?, 'B0BRTEST', ?, ?, 3000, 1000, 500, ?, ${NOW})`);
  item.run(b1, SKU, 4, lot);
  item.run(b2, SKU, 3, null);
  // B2 shipped 3, Amazon received only 2.
  db.prepare(`INSERT INTO batch_receipts VALUES (?, 'FBA1', ?, 4, 4, 'CLOSED', ${NOW})`).run(b1, SKU);
  db.prepare(`INSERT INTO batch_receipts VALUES (?, 'FBA2', ?, 3, 2, 'CLOSED', ${NOW})`).run(b2, SKU);
  sale('BR-0', '2026-05-20T12:00:00Z', 1, 3000, 1000); // before either batch: nobody's
  sale('BR-1', '2026-06-05T12:00:00Z', 1, 3000, 1000);
  sale('BR-2', '2026-06-11T12:00:00Z', 1, 3000, 1000);
  sale('BR-3', '2026-06-25T12:00:00Z', 2, 2800, 1000);
  sale('BR-4', '2026-06-28T12:00:00Z', 1, 2800, 1000);
  db.prepare(`INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES ('BR-3', '2026-07-01T00:00:00Z', NULL, ?, 1, 2800, 'DEFECTIVE', 0, 0, 'amazon', ${NOW})`).run(SKU);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('sales are handed to batches oldest-first; sold is exact from the lot and never exceeds received', async () => {
  const { computeBatchResults } = await import('../src/lib/batch-results');
  const [b2, b1] = computeBatchResults(db);
  assert.equal(b1.name, 'B1');
  assert.equal(b1.sold, 2, 'lot quantity − remaining');
  assert.equal(b1.items[0].soldExact, true);
  assert.equal(b1.items[0].plannedProfitPerUnit, 3000 - 1000 - 500);
  assert.equal(b1.actualProfit, 2 * (3000 - 1000), 'BR-1 and BR-2 (no fees in fixture); BR-0 predates the batch');
  assert.equal(b1.daysTo50, 11, 'the 2nd of 4 units sold Jun 11 at noon');
  assert.equal(b2.received, 2);
  assert.equal(b2.sold, 2, 'capped at the 2 units Amazon received, though 3 sales followed');
  assert.equal(b2.items[0].soldExact, false);
  assert.equal(b2.returned, 1);
  assert.equal(b2.actualProfit, (2800 - 1000) * 2 - 2800, 'the settled refund comes off profit');
});
