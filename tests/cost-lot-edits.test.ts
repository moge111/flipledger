/**
 * Regression tests for the "one click from wrong books" bugs (Sept 22 2026
 * review, A-latent-1..4).
 *   1. Products & COGS Edit → Save rewrote price, date and quantity on EVERY
 *      lot of a SKU (one save on Yoshi's $15 row: 2026 COGS −$2,200).
 *   2. Deleting a batch item/batch shrank the SKU's OLDEST lot; restock adds
 *      merged into an existing lot and re-dated it.
 *   3. Batch-item buy-price/quantity edits never reached the ledger.
 *   4. The Add Expense form posted to a GET-only route; entries vanished.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = "'2026-03-20T00:00:00Z'";
const SKU = 'wm-multilot-55';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>) {
  const req = new Request(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res: Response = params ? await mod[method](req, { params: Promise.resolve(params) }) : await mod[method](req);
  return { status: res.status, json: await res.json() };
}

type Lot = { id: number; buy_price: number; quantity: number; date_purchased: string };
const lots = (sku: string) => db.prepare('SELECT id, buy_price, quantity, date_purchased FROM inventory_ledger WHERE sku = ? ORDER BY id').all(sku) as Lot[];

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at) VALUES
      ('${SKU}', '${SKU}', 5500, 54, 54, '2025-01-01', ${NOW}),
      ('${SKU}', '${SKU}', 1500, 7, 7, '2026-06-26', ${NOW}),
      ('${SKU}', '${SKU}', 5500, 1, 1, '2026-07-17', ${NOW});
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
      VALUES ('px-zeroed-279', 'px-zeroed-279', 27900, 0, 0, '2026-05-01', ${NOW});
    -- Like the real Px7/Px8: one sale that came back, lot set to 0 on purpose.
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
      VALUES ('GOLD-PX-1', '2026-05-05T12:00:00Z', 'Shipped', 'amazon', 'MFN', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
      VALUES ('GOLD-PX-1', 'px-zeroed-279', 'px-zeroed-279', 1, 41000, 41000, 0, 0, 0, 0);
    INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
      VALUES ('Test batch', 'draft', 'FBA', 'amazon', ${NOW}, ${NOW});
  `);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('A-latent-1: Products Edit on one lot changes only that lot', async () => {
  const mod = await import('../src/app/api/data/products/route');
  const [a, b, c] = lots(SKU);
  const r = await call(mod, 'POST', 'http://t/api/data/products', { sku: SKU, lotId: b.id, buyPrice: 14.5, datePurchased: '2026-06-27' });
  assert.equal(r.status, 200);
  const after = lots(SKU);
  assert.deepEqual(after[0], a, 'first lot untouched');
  assert.deepEqual(after[2], c, 'third lot untouched');
  assert.equal(after[1].buy_price, 1450);
  assert.equal(after[1].quantity, 7, 'quantity is never rewritten by a cost edit');
});

test('A-latent-1: an edit with no lot context updates only the latest lot', async () => {
  const mod = await import('../src/app/api/data/products/route');
  const before = lots(SKU);
  await call(mod, 'POST', 'http://t/api/data/products', { sku: SKU, buyPrice: 56 });
  const after = lots(SKU);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.equal(after[2].buy_price, 5600);
});

test('A-latent-1: a deliberately zeroed lot is not revived as phantom stock', async () => {
  const mod = await import('../src/app/api/data/products/route');
  await call(mod, 'POST', 'http://t/api/data/products', { sku: 'px-zeroed-279', buyPrice: 279 });
  assert.equal(lots('px-zeroed-279')[0].quantity, 0);
});

test('A-latent-1: a lot id from another SKU is rejected', async () => {
  const mod = await import('../src/app/api/data/products/route');
  const other = lots('px-zeroed-279')[0].id;
  const r = await call(mod, 'POST', 'http://t/api/data/products', { sku: SKU, lotId: other, buyPrice: 1 });
  assert.equal(r.status, 400);
});

test('A-latent-2/3: batch items own their lot; edits and deletes touch only it', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const item = await import('../src/app/api/list/batches/[id]/items/[itemId]/route');
  const batchId = (db.prepare("SELECT id FROM listing_batches WHERE name = 'Test batch'").get() as { id: number }).id;
  const base = `http://t/api/list/batches/${batchId}/items`;
  const before = lots(SKU);

  // Restock at an existing price: a NEW lot, and the old lot keeps its date.
  const add = await call(items, 'POST', base, { asin: SKU, sku: SKU, quantity: 3, buyPrice: 55, listPrice: 90, purchaseDate: '2026-09-20' }, { id: String(batchId) });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const itemRow = db.prepare('SELECT id, inventory_ledger_id FROM listing_batch_items WHERE id = ?').get(add.json.id) as { id: number; inventory_ledger_id: number };
  assert.ok(itemRow.inventory_ledger_id, 'item is linked to its lot');
  const withNew = lots(SKU);
  assert.deepEqual(withNew.slice(0, before.length), before, 'existing lots untouched (no merge, no re-date)');
  const own = withNew.find(l => l.id === itemRow.inventory_ledger_id)!;
  assert.equal(own.quantity, 3);

  // Buy-price and quantity edit reaches the item's own lot.
  const edit = await call(item, 'PATCH', `${base}/${itemRow.id}`, { buyPrice: 52.5, quantity: 2 }, { id: String(batchId), itemId: String(itemRow.id) });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.ledgerUpdated, true);
  const edited = lots(SKU).find(l => l.id === itemRow.inventory_ledger_id)!;
  assert.equal(edited.buy_price, 5250);
  assert.equal(edited.quantity, 2);

  // Delete removes exactly that lot; the oldest lot is untouched.
  const del = await call(item, 'DELETE', `${base}/${itemRow.id}`, undefined, { id: String(batchId), itemId: String(itemRow.id) });
  assert.equal(del.status, 200);
  assert.deepEqual(lots(SKU), before);
});

test('A-latent-2: an unlinked (legacy) item is never guessed at', async () => {
  const item = await import('../src/app/api/list/batches/[id]/items/[itemId]/route');
  const batchId = (db.prepare("SELECT id FROM listing_batches WHERE name = 'Test batch'").get() as { id: number }).id;
  const legacyId = Number(db.prepare(`
    INSERT INTO listing_batch_items (batch_id, asin, sku, quantity, list_price_cents, buy_price_cents, created_at)
    VALUES (?, ?, ?, 2, 9000, 5500, ${NOW})`).run(batchId, SKU, SKU).lastInsertRowid);
  const before = lots(SKU);
  const del = await call(item, 'DELETE', `http://t/x/${legacyId}`, undefined, { id: String(batchId), itemId: String(legacyId) });
  assert.equal(del.status, 200);
  assert.match(del.json.ledgerWarning, /no linked cost lot/);
  assert.deepEqual(lots(SKU), before, 'no lot was shrunk');
});

test('A-latent-4: Add Expense saves a one-time expense and rejects bad input', async () => {
  const mod = await import('../src/app/api/data/other-expenses/route');
  const ok = await call(mod, 'POST', 'http://t/api/data/other-expenses', { date: '2026-09-22', category: 'Supplies', amount: 1299, description: 'Tape' });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT date, category, amount, recurring FROM expenses WHERE id = ?').get(ok.json.id);
  assert.deepEqual(row, { date: '2026-09-22', category: 'Supplies', amount: 1299, recurring: 'one-time' });
  for (const bad of [
    { date: '2026-09-22', category: 'Supplies', amount: 0 },
    { date: '2026-09-22', category: 'Supplies', amount: 12.5 },
    { date: 'Sept 22', category: 'Supplies', amount: 100 },
    { date: '2026-09-22', category: '', amount: 100 },
  ]) {
    assert.equal((await call(mod, 'POST', 'http://t/api/data/other-expenses', bad)).status, 400, JSON.stringify(bad));
  }
});
