/**
 * Regression test for duplicate suppliers (Sept 23 2026).
 *
 * Every lot-writing path matched suppliers by exact name, so "walmart",
 * "Walmart" and "/ Walmart" became three suppliers, and Supplier
 * Profitability split each company across rows. resolveSupplierId matches
 * ignoring case, spaces and punctuation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';
import { resolveSupplierId, supplierKey } from '../src/lib/suppliers';

let golden: GoldenDb;
let db: Database.Database;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('spelling variants resolve to the existing supplier', () => {
  const walmart = resolveSupplierId(db, 'Walmart')!;
  const bestBuy = resolveSupplierId(db, 'Best Buy')!;
  for (const v of ['walmart', ' WALMART ', '/ Walmart']) assert.equal(resolveSupplierId(db, v), walmart, v);
  for (const v of ['bestbuy', 'BestBuy', 'best-buy']) assert.equal(resolveSupplierId(db, v), bestBuy, v);
  const pokemonCenter = resolveSupplierId(db, 'pokémon center')!;
  assert.equal(resolveSupplierId(db, 'pokemon center'), pokemonCenter, 'accents are ignored');
  assert.notEqual(resolveSupplierId(db, 'Amazon / Walmart'), walmart, 'a genuinely different name stays separate');
  const n = (db.prepare("SELECT COUNT(*) n FROM suppliers").get() as { n: number }).n;
  assert.equal(n, new Set((db.prepare('SELECT name FROM suppliers').all() as { name: string }[]).map(r => supplierKey(r.name))).size);
});

test('a blank name is no supplier', () => {
  assert.equal(resolveSupplierId(db, ''), null);
  assert.equal(resolveSupplierId(db, '  '), null);
  assert.equal(resolveSupplierId(db, null), null);
});

test('adding a lot through the Lots API reuses the supplier', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lots: any = await import('../src/app/api/data/inventory-lots/route');
  const res: Response = await lots.POST(new Request('http://t/api/data/inventory-lots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'sup-test-1', asin: 'sup-test-1', quantity: 2, buyPrice: 5, supplier: 'target' }),
  }));
  assert.equal(res.status, 200, await res.clone().text());
  const target = resolveSupplierId(db, 'Target');
  const lot = db.prepare("SELECT supplier_id FROM inventory_ledger WHERE sku = 'sup-test-1'").get() as { supplier_id: number };
  assert.equal(lot.supplier_id, target);
});
