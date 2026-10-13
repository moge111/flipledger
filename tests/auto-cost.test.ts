/**
 * Regression test for copied buy costs (Sept 23 2026).
 *
 * eBay gives every listing its own custom label, so a second Pokémon Center
 * ETB sold as LOCAL-ITEM_168 with no cost lot while the identical first one
 * (LOCAL-ITEM_169) had $125, and the sale booked $0 COGS.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = "'2026-09-20T00:00:00Z'";
const ETB = 'Pokemon 30th Celebration Pokemon Center Elite Trainer Box ETB Nidorina Promo';

function sale(orderId: string, sku: string, legacyId: string) {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, '2026-09-22T12:00:00Z', 'Shipped', 'ebay', 'MFN', ${NOW})`).run(orderId);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, ?, ?, 1, 31000, 31000, 0, 0, 0, 0)`).run(orderId, legacyId, sku);
  db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, marketplace, total_amount, created_at)
    VALUES ('ShipmentEvent', '2026-09-22T13:00:00Z', ?, 'ebay', 31000, ${NOW})`).run(orderId);
}
const product = (sku: string, name: string) => db.prepare(`INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
  VALUES (?, ?, ?, 'ebay', ${NOW}, ${NOW})`).run(sku, sku, name);
const cogs = (orderId: string) => (db.prepare('SELECT cogs_per_unit c FROM order_items WHERE order_id = ?').get(orderId) as { c: number }).c;
const lot = (sku: string) => db.prepare('SELECT buy_price, quantity, notes FROM inventory_ledger WHERE sku = ?').get(sku) as
  { buy_price: number; quantity: number; notes: string | null } | undefined;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  product('AC-ITEM_169', ETB);
  product('AC-ITEM_168', ETB);
  product('AC-ITEM_200', 'Some Completely Different Product');
  product('AC-ITEM_300', 'Self Pulled Card');
  product('AC-ITEM_301', 'Self Pulled Card');
  db.exec(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at, intentional_zero_cogs) VALUES
    ('AC-ITEM_169', 'AC-ITEM_169', 12500, 1, 1, '2026-09-10', ${NOW}, 0),
    ('AC-ITEM_300', 'AC-ITEM_300', 0, 1, 1, '2026-09-10', ${NOW}, 1)`);
  sale('AC-ORD-169', 'AC-ITEM_169', '1986579708950');
  sale('AC-ORD-168', 'AC-ITEM_168', '1986579708920');
  sale('AC-ORD-200', 'AC-ITEM_200', '1986579708930');
  sale('AC-ORD-301', 'AC-ITEM_301', '1986579708940');
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('a sold SKU with no lot takes the cost of the identically named product', async () => {
  const { recalculateFIFO } = await import('../src/lib/fifo');
  recalculateFIFO({ recalcAll: true });
  assert.equal(cogs('AC-ORD-168'), 12500);
  const l = lot('AC-ITEM_168')!;
  assert.equal(l.quantity, 1, 'quantity = units sold, no phantom stock');
  assert.match(l.notes!, /^\[auto-cost\] copied from AC-ITEM_169/);
});

test('no name match, or only a deliberate $0 lot, leaves the SKU uncosted', () => {
  assert.equal(lot('AC-ITEM_200'), undefined);
  assert.equal(lot('AC-ITEM_301'), undefined, 'a self-pulled $0 lot is not a cost to copy');
  assert.equal(cogs('AC-ORD-301'), 0);
});

test('re-running copies nothing new', async () => {
  const { autoCostMissingLots } = await import('../src/lib/auto-cost');
  assert.deepEqual(autoCostMissingLots(db), []);
});

test('saving the cost on the Products page confirms it', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('../src/app/api/data/products/route');
  const res: Response = await mod.POST(new Request('http://t/api/data/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'AC-ITEM_168', buyPrice: 125 }),
  }));
  assert.equal(res.status, 200);
  assert.equal(lot('AC-ITEM_168')!.notes, null);
});

test('costFromSku reads generated SKUs and rejects counters', async () => {
  const { costFromSku } = await import('../src/lib/auto-cost');
  assert.deepEqual(costFromSku('wm-mahjong-49.70'), { cents: 4970, prefix: 'wm' });
  assert.deepEqual(costFromSku('amz-SpiderManMarvel-39.99-mfn'), { cents: 3999, prefix: 'amz' });
  assert.deepEqual(costFromSku('wm-gopro12blk-262.1'), { cents: 26210, prefix: 'wm' });
  for (const bad of ['SKU-NEW-070', 'eb-card-070', 'LOCAL-ITEM_171', '1070833938', 'wm-yoshiegg', 'wm-thing-0', '9G-39R0-4O1I']) {
    assert.equal(costFromSku(bad), null, bad);
  }
});

test('a stocked SKU with no sales gets its SKU price, supplier and stock quantity', async () => {
  db.exec(`INSERT INTO live_inventory (asin, sku, marketplace, product_name, fulfillable_qty, last_updated)
    VALUES ('ac-mahjong', 'wm-acmahjong-49.70', 'walmart', 'Mahjong Set', 110, ${NOW})`);
  const { autoCostMissingLots } = await import('../src/lib/auto-cost');
  const made = autoCostMissingLots(db);
  assert.deepEqual(made.map(m => [m.sku, m.method, m.buyPrice]), [['wm-acmahjong-49.70', 'sku-price', 4970]]);
  const row = db.prepare(`SELECT il.buy_price, il.quantity, il.notes, s.name supplier FROM inventory_ledger il
    LEFT JOIN suppliers s ON s.id = il.supplier_id WHERE il.sku = 'wm-acmahjong-49.70'`).get() as
    { buy_price: number; quantity: number; notes: string; supplier: string };
  assert.equal(row.quantity, 110);
  assert.match(row.notes, /^\[auto-cost\] \$49\.70 read from the SKU/);
  assert.equal(row.supplier.toLowerCase(), 'walmart');
});
