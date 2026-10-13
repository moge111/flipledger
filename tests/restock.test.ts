/**
 * Restock watch (Sept 23 2026): fast sellers with a good ROI and little stock.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
let n = 0;

function sales(marketplace: string, asin: string, sku: string, count: number, price: number, cogs: number, daysAgo = 5) {
  for (let i = 0; i < count; i++) {
    const id = `RS-${++n}`;
    db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
      VALUES (?, datetime('now', ?), 'Shipped', ?, 'FBA', datetime('now'))`).run(id, `-${daysAgo + i} days`, marketplace);
    db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
      VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, ?)`).run(id, asin, sku, price, price, cogs);
  }
}
const stock = (marketplace: string, asin: string, sku: string, qty: number) => db.prepare(`
  INSERT INTO live_inventory (asin, sku, marketplace, product_name, fulfillable_qty, last_updated) VALUES (?, ?, ?, 'x', ?, datetime('now'))`).run(asin, sku, marketplace, qty);

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  // Two buy-price SKUs of one ASIN: 3 + 2 sales, 1 unit left → one product, 5 sold.
  sales('amazon', 'B0RSFAST01', 'amz-Fast-10', 3, 3000, 1000);
  sales('amazon', 'B0RSFAST01', 'amz-Fast-8', 2, 3000, 800);
  stock('amazon', 'B0RSFAST01', 'amz-Fast-8', 1);
  db.exec(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0RSFAST01', 'amz-Fast-8', 800, 3, 1, '2026-09-01', datetime('now'))`);
  // Sells fast but well stocked.
  sales('amazon', 'B0RSSTOCK1', 'amz-Stocked-10', 6, 3000, 1000);
  stock('amazon', 'B0RSSTOCK1', 'amz-Stocked-10', 60);
  // Sells fast, sold out, but thin margin.
  sales('walmart', 'wm-thin-20', 'wm-thin-20', 6, 2100, 2000);
  // MFN stock at home covers it.
  sales('amazon', 'B0RSHOME01', 'amz-Home-10-mfn', 3, 3000, 1000);
  db.exec(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0RSHOME01', 'amz-Home-10-mfn', 1000, 20, 20, '2026-09-01', datetime('now'))`);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('only fast, profitable, nearly-out products are listed, grouped by ASIN', async () => {
  const { computeRestock } = await import('../src/lib/restock');
  const rows = computeRestock(db);
  const mine = rows.filter(r => ['B0RSFAST01', 'B0RSSTOCK1', 'wm-thin-20', 'B0RSHOME01'].includes(r.key));
  assert.deepEqual(mine.map(r => r.key), ['B0RSFAST01']);
  const r = mine[0];
  assert.equal(r.unitsWindow, 5);
  assert.deepEqual([...r.skus].sort(), ['amz-Fast-10', 'amz-Fast-8']);
  assert.equal(r.fulfillable, 1);
  assert.equal(Math.round(r.daysOfCover), 6, '1 unit at 5 per 30 days');
  assert.equal(r.reorderQty, 4, '30 days of cover (5) minus the 1 on hand');
  assert.equal(r.lastBuyPrice, 800);
});

test('home stock counts for merchant-fulfilled SKUs', async () => {
  const { computeRestock } = await import('../src/lib/restock');
  const r = computeRestock(db, { maxCoverDays: 1000 }).find(x => x.key === 'B0RSHOME01');
  assert.equal(r?.onHand, 20);
});
