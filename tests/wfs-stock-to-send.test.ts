/**
 * Oct 7 2026: "Walmart stock to send" holds units bought for WFS (SKU created,
 * cost lot recorded) until they move into a shipment batch. Moving must never
 * create a second lot or change cost: a whole line is re-pointed; a partial
 * move splits the line and its lot at the same cost, supplier and date.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
let holdId: number;
let shipId: number;
const NOW = "'2026-10-07T00:00:00Z'";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>) {
  const req = new Request(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res: Response = params ? await mod[method](req, { params: Promise.resolve(params) }) : await mod[method](req);
  return { status: res.status, json: await res.json() };
}

function addWaiting(sku: string, qty: number, priceCents: number): number {
  const id = Number(db.prepare(`INSERT INTO listing_batch_items (batch_id, asin, sku, msku, product_name, condition, quantity, list_price_cents,
      buy_price_cents, supplier, purchase_date, fulfillment_channel, walmart_item_id, walmart_setup_status, created_at)
    VALUES (?, ?, ?, ?, 'Test product', 'New', ?, 5000, ?, 'Walmart', '2026-10-01', 'WFS', '999', 'READY', ${NOW})`)
    .run(holdId, sku, sku, sku, qty, priceCents).lastInsertRowid);
  const lot = Number(db.prepare(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES (?, ?, ?, ?, ?, '2026-10-01', ${NOW})`).run(sku, sku, priceCents, qty, qty).lastInsertRowid);
  db.prepare('UPDATE listing_batch_items SET inventory_ledger_id = ? WHERE id = ?').run(lot, id);
  return id;
}

const lotsFor = (sku: string) => db.prepare('SELECT buy_price, quantity, quantity_remaining, date_purchased FROM inventory_ledger WHERE sku = ? ORDER BY id').all(sku) as
  { buy_price: number; quantity: number; quantity_remaining: number; date_purchased: string }[];

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  const { getOrCreateHoldingBatch } = await import('../src/lib/wfs-batch');
  holdId = getOrCreateHoldingBatch(db);
  assert.equal(getOrCreateHoldingBatch(db), holdId, 'one holding list only');
  shipId = Number(db.prepare(`INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
    VALUES ('Ship', 'draft', 'WFS', 'walmart', ${NOW}, ${NOW})`).run().lastInsertRowid);
});

after(() => { db?.close(); golden?.cleanup(); });

test('moving part of a line splits it and its lot at the same cost — no units or dollars created', async () => {
  const move = await import('../src/app/api/list/batches/[id]/wfs/move/route');
  const itemId = addWaiting('wm-Split-30', 10, 3000);
  const r = await call(move, 'POST', 'http://t', { itemId, quantity: 4 }, { id: String(shipId) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const lots = lotsFor('wm-Split-30');
  assert.deepEqual(lots.map(l => [l.buy_price, l.quantity, l.quantity_remaining, l.date_purchased]),
    [[3000, 6, 6, '2026-10-01'], [3000, 4, 4, '2026-10-01']]);
  const rows = db.prepare('SELECT batch_id, quantity, inventory_ledger_id, walmart_setup_status FROM listing_batch_items WHERE sku = ? ORDER BY id').all('wm-Split-30') as any[];
  assert.deepEqual(rows.map(x => [x.batch_id, x.quantity, x.walmart_setup_status]), [[holdId, 6, 'READY'], [shipId, 4, 'READY']]);
  assert.notEqual(rows[0].inventory_ledger_id, rows[1].inventory_ledger_id, 'each line owns its own lot');
});

test('moving a whole line re-points it and keeps its one lot', async () => {
  const move = await import('../src/app/api/list/batches/[id]/wfs/move/route');
  const itemId = addWaiting('wm-Whole-20', 3, 2000);
  const r = await call(move, 'POST', 'http://t', { itemId, quantity: 3 }, { id: String(shipId) });
  assert.equal(r.status, 200);
  assert.equal(lotsFor('wm-Whole-20').length, 1);
  assert.equal((db.prepare('SELECT batch_id FROM listing_batch_items WHERE id = ?').get(itemId) as any).batch_id, shipId);
});

test('refuses moving more than is waiting, into the holding list, or from a normal batch', async () => {
  const move = await import('../src/app/api/list/batches/[id]/wfs/move/route');
  const itemId = addWaiting('wm-Guard-10', 2, 1000);
  assert.equal((await call(move, 'POST', 'http://t', { itemId, quantity: 3 }, { id: String(shipId) })).status, 400);
  assert.equal((await call(move, 'POST', 'http://t', { itemId, quantity: 1 }, { id: String(holdId) })).status, 400);
  const shipped = db.prepare('SELECT id FROM listing_batch_items WHERE sku = ? AND batch_id = ?').get('wm-Whole-20', shipId) as { id: number };
  assert.equal((await call(move, 'POST', 'http://t', { itemId: shipped.id, quantity: 1 }, { id: String(shipId) })).status, 404);
  assert.equal(lotsFor('wm-Guard-10')[0].quantity, 2, 'nothing changed');
});

test('the holding list can never be sent as a shipment', async () => {
  const wfs = await import('../src/app/api/list/batches/[id]/wfs/route');
  db.prepare("UPDATE listing_batches SET ship_from_address_line1='1 Main', ship_from_city='X', ship_from_state='UT', ship_from_postal_code='84000' WHERE id = ?").run(holdId);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('walmart_client_id', 'x'), ('walmart_client_secret', 'y')").run();
  const r = await call(wfs, 'POST', 'http://t', { action: 'send' }, { id: String(holdId) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /waiting list/);
});
