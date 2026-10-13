import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { lastCost } from '../src/lib/wfs-batch';

function db() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE inventory_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, asin TEXT, sku TEXT, buy_price INTEGER,
      quantity INTEGER, quantity_remaining INTEGER, supplier_id INTEGER, date_purchased TEXT, created_at TEXT);
    INSERT INTO suppliers VALUES (1, 'Walmart'), (2, 'Target');
  `);
  return d;
}
const lot = (d: Database.Database, sku: string, cents: number, supplier: number | null, date: string) =>
  d.prepare('INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(sku, sku, cents, 1, 1, supplier, date, date);

test('restock cost = the newest purchase, not the newest row', () => {
  const d = db();
  lot(d, 'wm-yoshiegg-55', 1500, 1, '2026-06-26');
  lot(d, 'wm-yoshiegg-55', 5500, 2, '2026-01-10'); // entered later, bought earlier
  assert.deepEqual(lastCost(d, 'wm-yoshiegg-55'), { buyPriceCents: 1500, supplier: 'Walmart', datePurchased: '2026-06-26' });
});

test('same purchase date: the newest lot wins', () => {
  const d = db();
  lot(d, 'sku-a', 1000, 1, '2026-10-01');
  lot(d, 'sku-a', 1200, 2, '2026-10-01');
  assert.equal(lastCost(d, 'sku-a')?.buyPriceCents, 1200);
});

test('$0 lots are skipped; no paid lot or no SKU means no cost', () => {
  const d = db();
  lot(d, 'sku-b', 0, null, '2026-10-05');
  assert.equal(lastCost(d, 'sku-b'), null);
  lot(d, 'sku-b', 800, null, '2026-09-01');
  assert.deepEqual(lastCost(d, 'sku-b'), { buyPriceCents: 800, supplier: null, datePurchased: '2026-09-01' });
  assert.equal(lastCost(d, ''), null);
  assert.equal(lastCost(d, 'nope'), null);
});
