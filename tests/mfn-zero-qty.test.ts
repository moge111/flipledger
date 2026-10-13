/**
 * Oct 4 2026: an MFN batch item may have quantity 0, so a SKU can be
 * registered on Amazon (out of stock) before anything is bought.
 *   - The add writes NO cost lot and runs no FIFO: nothing was bought.
 *   - FBA batches still require quantity >= 1.
 *   - Raising the quantity later writes the lot then, like a normal add.
 *   - Deleting a 0-qty item touches no lot and warns about nothing.
 *   - A registered 0-qty listing counts as ready (it never goes BUYABLE),
 *     and a 0-qty PUT never zeroes units already live on Amazon.
 * And the MFN "Qty → Amazon" switch (same day):
 *   - The cost lot is written at the full quantity either way.
 *   - ON: Amazon is set to the SKU's stock in FlipLedger (bought minus sold),
 *     never the batch quantity.
 *   - OFF: FlipLedger never changes the Amazon quantity — a new offer is
 *     created at 0, a price re-push keeps Amazon's count, Publish skips it.
 *   - Switching ON pushes the stock and is saved only when Amazon accepts.
 * An item whose units already sold can't be deleted (or shrunk below them):
 * those sales' COGS comes from its lot.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';
import { isItemListingReady, skipMfnPut, mfnQuantityToPut, offeredQuantity } from '../src/lib/listing-send-policy';

let golden: GoldenDb;
let db: Database.Database;
let mfnBatch: number;
let fbaBatch: number;
const NOW = "'2026-10-04T00:00:00Z'";
const ASIN = 'B0ZEROQTY01';
const SKU = 'amz-ZeroQtyTest-12.50-mfn';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>) {
  const req = new Request(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res: Response = params ? await mod[method](req, { params: Promise.resolve(params) }) : await mod[method](req);
  return { status: res.status, json: await res.json() };
}

const ledgerSnapshot = () => db.prepare('SELECT id, sku, buy_price, quantity, quantity_remaining FROM inventory_ledger ORDER BY id').all();

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  mfnBatch = Number(db.prepare(`INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
    VALUES ('MFN zero', 'draft', 'MFN', 'amazon', ${NOW}, ${NOW})`).run().lastInsertRowid);
  fbaBatch = Number(db.prepare(`INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
    VALUES ('FBA zero', 'draft', 'FBA', 'amazon', ${NOW}, ${NOW})`).run().lastInsertRowid);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('MFN add with quantity 0 writes no lot and runs no FIFO', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const before = ledgerSnapshot();
  const add = await call(items, 'POST', `http://t/api/list/batches/${mfnBatch}/items`,
    { asin: ASIN, sku: SKU, quantity: 0, listPrice: 24.99, buyPrice: 12.5, supplier: 'Target' }, { id: String(mfnBatch) });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.success, true);
  assert.equal(add.json.quantity, 0);
  assert.equal(add.json.lotCreated, false);
  assert.equal(add.json.fifo, null, 'FIFO not run');
  const row = db.prepare('SELECT quantity, inventory_ledger_id, list_price_cents FROM listing_batch_items WHERE id = ?').get(add.json.id) as
    { quantity: number; inventory_ledger_id: number | null; list_price_cents: number };
  assert.equal(row.quantity, 0);
  assert.equal(row.inventory_ledger_id, null);
  assert.equal(row.list_price_cents, 2499);
  assert.deepEqual(ledgerSnapshot(), before, 'inventory_ledger untouched');
});

test('FBA add with quantity 0 is still rejected with the same error', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM listing_batch_items WHERE batch_id = ?').get(fbaBatch) as { n: number }).n;
  const r = await call(items, 'POST', `http://t/api/list/batches/${fbaBatch}/items`,
    { asin: ASIN, sku: 'amz-ZeroQtyTest-12.50', quantity: 0, listPrice: 24.99, buyPrice: 12.5 }, { id: String(fbaBatch) });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'quantity must be >= 1');
  assert.equal(count(), 0);
});

test('MFN add still rejects a negative quantity', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const r = await call(items, 'POST', `http://t/api/list/batches/${mfnBatch}/items`,
    { asin: ASIN, sku: SKU, quantity: -1, listPrice: 24.99, buyPrice: 12.5 }, { id: String(mfnBatch) });
  assert.equal(r.status, 400);
});

test('raising a 0-qty item to N writes its lot then; deleting a 0-qty item touches nothing', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const item = await import('../src/app/api/list/batches/[id]/items/[itemId]/route');
  const base = `http://t/api/list/batches/${mfnBatch}/items`;

  // Edit price on a 0-qty item: still no lot.
  const zeroId = (db.prepare('SELECT id FROM listing_batch_items WHERE batch_id = ? AND quantity = 0').get(mfnBatch) as { id: number }).id;
  const before = ledgerSnapshot();
  const priceOnly = await call(item, 'PATCH', `${base}/${zeroId}`, { buyPrice: 13 }, { id: String(mfnBatch), itemId: String(zeroId) });
  assert.equal(priceOnly.status, 200, JSON.stringify(priceOnly.json));
  assert.equal(priceOnly.json.ledgerUpdated, false);
  assert.equal(priceOnly.json.ledgerWarning, undefined, 'a 0-qty item is not a legacy unlinked item');
  assert.deepEqual(ledgerSnapshot(), before);

  // 0 → 3: the lot appears, linked, at the item's cost.
  const raise = await call(item, 'PATCH', `${base}/${zeroId}`, { quantity: 3 }, { id: String(mfnBatch), itemId: String(zeroId) });
  assert.equal(raise.status, 200, JSON.stringify(raise.json));
  assert.equal(raise.json.ledgerUpdated, true);
  const linked = db.prepare('SELECT inventory_ledger_id AS lot FROM listing_batch_items WHERE id = ?').get(zeroId) as { lot: number | null };
  assert.ok(linked.lot, 'item now owns a lot');
  const lot = db.prepare('SELECT sku, asin, buy_price, quantity, quantity_remaining, supplier_id FROM inventory_ledger WHERE id = ?').get(linked.lot) as
    { sku: string; asin: string; buy_price: number; quantity: number; quantity_remaining: number; supplier_id: number | null };
  assert.equal(lot.sku, SKU);
  assert.equal(lot.asin, ASIN);
  assert.equal(lot.buy_price, 1300);
  assert.equal(lot.quantity, 3);
  assert.equal(lot.quantity_remaining, 3);
  assert.ok(lot.supplier_id, 'supplier carried from the item');

  // Delete it: the normal path removes exactly that lot.
  const del = await call(item, 'DELETE', `${base}/${zeroId}`, undefined, { id: String(mfnBatch), itemId: String(zeroId) });
  assert.equal(del.status, 200);
  assert.deepEqual(ledgerSnapshot(), before);

  // A fresh 0-qty item deletes cleanly with no lot and no warning.
  const add = await call(items, 'POST', base, { asin: ASIN, sku: SKU, quantity: 0, listPrice: 24.99, buyPrice: 12.5 }, { id: String(mfnBatch) });
  assert.equal(add.status, 200);
  const del2 = await call(item, 'DELETE', `${base}/${add.json.id}`, undefined, { id: String(mfnBatch), itemId: String(add.json.id) });
  assert.equal(del2.status, 200);
  assert.equal(del2.json.ledgerWarning, undefined);
  assert.deepEqual(ledgerSnapshot(), before);
});

test('a registered 0-qty MFN listing is ready; a stocked MFN listing still needs BUYABLE', () => {
  // Shape of a real 0-qty MFN listing (read from Amazon, Oct 4 2026).
  const outOfStock = {
    summaries: [{ status: ['DISCOVERABLE'] }],
    offers: [{ price: { amount: '34.0' } }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 0 }],
  };
  assert.equal(isItemListingReady('MFN', 0, outOfStock), true);
  assert.equal(isItemListingReady('MFN', 2, outOfStock), true, 'sold out on Amazon: the offer exists at 0');
  const propagating = { ...outOfStock, fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 2 }] };
  assert.equal(isItemListingReady('MFN', 2, propagating), false, 'shows units but not BUYABLE yet: still propagating');
  assert.equal(isItemListingReady('MFN', 0, { ...outOfStock, offers: [] }), false, 'no offer attached yet');
  assert.equal(isItemListingReady('MFN', 0, { ...outOfStock, fulfillmentAvailability: [] }), false);
  assert.equal(isItemListingReady('MFN', 0, null), false);
  assert.equal(isItemListingReady('MFN', 2, { summaries: [{ status: ['BUYABLE'] }] }), true);
  assert.equal(isItemListingReady('FBA', 0, outOfStock), false, 'FBA still needs an FNSKU');
  assert.equal(isItemListingReady('FBA', 1, { summaries: [{ fnSku: 'X00TEST' }] }), true);
});

test('Qty → Amazon: what gets PUT', () => {
  const live = { summaries: [{ status: ['BUYABLE'] }], fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 4 }] };
  assert.equal(skipMfnPut('MFN', false, live), true, 'off + existing: Publish leaves it alone');
  assert.equal(skipMfnPut('MFN', true, live), false);
  assert.equal(skipMfnPut('MFN', false, null), false, 'new listing still gets created');
  assert.equal(skipMfnPut('FBA', false, live), false);
  assert.equal(mfnQuantityToPut({ channel: 'MFN', sendQty: true, skuStock: 2 }, live), 2, 'on: FlipLedger stock');
  assert.equal(mfnQuantityToPut({ channel: 'MFN', sendQty: false, skuStock: 2 }, live), 4, 'off: Amazon keeps its count');
  assert.equal(mfnQuantityToPut({ channel: 'MFN', sendQty: false, skuStock: 2 }, null), 0, 'off + new: created at 0');
  assert.equal(offeredQuantity(false, 5), 0);
  assert.equal(offeredQuantity(true, 5), 5);
});

// ─── Awaiting delivery ─────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let putBodies: any[] = [];
let liveQty = 0;
let putStatus = 'ACCEPTED';
let listingExists = true;

function mockAmazon() {
  putBodies = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('api.amazon.com/auth/o2/token')) return json({ access_token: 'test-token', expires_in: 3600 });
    if (url.includes('/listings/2021-08-01/items/') && init?.method === 'PUT') {
      putBodies.push(JSON.parse(String(init.body)));
      return json({ sku: 'x', status: putStatus, submissionId: 'sub-1', issues: putStatus === 'INVALID' ? [{ severity: 'ERROR', code: '1', message: 'nope' }] : [] });
    }
    if (url.includes('/catalog/')) return json({ productTypes: [{ productType: 'TOY_FIGURE' }] });
    if (url.includes('/listings/2021-08-01/items/')) {
      if (!listingExists) return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404 });
      return json({
        sku: 'x',
        summaries: [{ status: liveQty > 0 ? ['BUYABLE', 'DISCOVERABLE'] : ['DISCOVERABLE'] }],
        productTypes: [{ productType: 'TOY_FIGURE' }],
        offers: [{ price: { amount: '24.99' } }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: liveQty }],
        issues: [],
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

const putQty = (body: any) => body.attributes.fulfillment_availability[0].quantity;
const AW_SKU = 'amz-QtyOffTest-12.50-mfn';

test('Qty → Amazon off: the add writes the full cost lot; FBA rejects it; the legacy flag maps to off', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const add = await call(items, 'POST', `http://t/api/list/batches/${mfnBatch}/items`,
    { asin: 'B0QTYOFF001', sku: AW_SKU, quantity: 5, listPrice: 24.99, buyPrice: 12.5, supplier: 'Target', sendQtyToAmazon: false }, { id: String(mfnBatch) });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.sendQtyToAmazon, false);
  assert.equal(add.json.lotCreated, true);
  assert.ok(add.json.fifo, 'FIFO ran: the units were bought');
  const row = db.prepare(`SELECT bi.send_qty_to_amazon AS send, il.quantity, il.quantity_remaining AS rem, il.buy_price
    FROM listing_batch_items bi JOIN inventory_ledger il ON il.id = bi.inventory_ledger_id WHERE bi.id = ?`).get(add.json.id) as
    { send: number; quantity: number; rem: number; buy_price: number };
  assert.deepEqual(row, { send: 0, quantity: 5, rem: 5, buy_price: 1250 });

  const fba = await call(items, 'POST', `http://t/api/list/batches/${fbaBatch}/items`,
    { asin: 'B0QTYOFF001', sku: 'amz-QtyOffTest-12.50', quantity: 5, listPrice: 24.99, buyPrice: 12.5, sendQtyToAmazon: false }, { id: String(fbaBatch) });
  assert.equal(fba.status, 400);

  const legacy = await call(items, 'POST', `http://t/api/list/batches/${mfnBatch}/items`,
    { asin: 'B0QTYOFF002', sku: 'amz-QtyLegacy-9.99-mfn', quantity: 1, listPrice: 19.99, buyPrice: 9.99, awaitingDelivery: true }, { id: String(mfnBatch) });
  assert.equal(legacy.json.sendQtyToAmazon, false, 'older FBA Scout builds still land OFF');
  const dflt = await call(items, 'POST', `http://t/api/list/batches/${mfnBatch}/items`,
    { asin: 'B0QTYOFF003', sku: 'amz-QtyDefault-9.99-mfn', quantity: 1, listPrice: 19.99, buyPrice: 9.99 }, { id: String(mfnBatch) });
  assert.equal(dflt.json.sendQtyToAmazon, true, 'default is on');
  const itemsMod = await import('../src/app/api/list/batches/[id]/items/[itemId]/route');
  for (const id of [legacy.json.id, dflt.json.id]) {
    await call(itemsMod, 'DELETE', `http://t/x/${id}`, undefined, { id: String(mfnBatch), itemId: String(id) });
  }
});

test('Qty → Amazon: off never changes Amazon; switching on pushes FlipLedger stock', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const { clearTokenCache } = await import('../src/lib/sp-api/auth');
  clearTokenCache();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clientId','x'),('clientSecret','y'),('refreshToken','z'),('marketplaceId','ATVPDKIKX0DER'),('amazon_seller_id','ATESTSELLER01')").run();
  mockAmazon();
  const createListing = await import('../src/app/api/list/batches/[id]/items/[itemId]/create-listing/route');
  const amazonQty = await import('../src/app/api/list/batches/[id]/items/[itemId]/amazon-qty/route');
  const send = await import('../src/app/api/list/batches/[id]/send/route');
  const row = db.prepare('SELECT id, inventory_ledger_id AS lot FROM listing_batch_items WHERE sku = ?').get(AW_SKU) as { id: number; lot: number };
  const params = { id: String(mfnBatch), itemId: String(row.id) };
  const url = `http://t/api/list/batches/${mfnBatch}/items/${row.id}`;
  const sendFlag = () => (db.prepare('SELECT send_qty_to_amazon AS s FROM listing_batch_items WHERE id = ?').get(row.id) as { s: number }).s;
  const ledgerBefore = ledgerSnapshot();

  // OFF, new listing: created at 0.
  listingExists = false;
  liveQty = 0;
  const created = await call(createListing, 'POST', `${url}/create-listing`, undefined, params);
  assert.equal(created.json.status, 'PROCESSING', JSON.stringify(created.json));
  assert.equal(putQty(putBodies.at(-1)), 0, 'created at 0 on Amazon');

  // Stock added in Seller Central (4 live). OFF: a price re-push keeps it, Publish skips it.
  listingExists = true;
  liveQty = 4;
  await call(createListing, 'POST', `${url}/create-listing?force=1`, undefined, params);
  assert.equal(putQty(putBodies.at(-1)), 4, 'Seller Central quantity kept');
  let puts = putBodies.length;
  const pub = await call(send, 'POST', `http://t/api/list/batches/${mfnBatch}/send`, {}, { id: String(mfnBatch) });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.equal(putBodies.length, puts, 'Publish sent nothing for an OFF item');
  assert.equal((db.prepare('SELECT listing_status AS s FROM listing_batch_items WHERE id = ?').get(row.id) as { s: string }).s, 'ACTIVE');

  // Switch ON while Amazon rejects: stays OFF.
  putStatus = 'INVALID';
  const rejected = await call(amazonQty, 'POST', `${url}/amazon-qty`, { send: true }, params);
  assert.equal(rejected.status, 502);
  assert.equal(sendFlag(), 0);

  // Switch ON: Amazon gets FlipLedger's stock — bought minus sold (2 of 5 sold), not the batch's 5.
  putStatus = 'ACCEPTED';
  db.prepare('UPDATE inventory_ledger SET quantity_remaining = 3 WHERE id = ?').run(row.lot);
  const on = await call(amazonQty, 'POST', `${url}/amazon-qty`, { send: true }, params);
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.amazonQuantity, 3);
  assert.equal(on.json.amazonQuantityBefore, 4);
  assert.equal(putQty(putBodies.at(-1)), 3);
  assert.equal(sendFlag(), 1);

  // Switch OFF: nothing is sent to Amazon.
  puts = putBodies.length;
  const off = await call(amazonQty, 'POST', `${url}/amazon-qty`, { send: false }, params);
  assert.equal(off.json.sendQtyToAmazon, false);
  assert.equal(putBodies.length, puts);
  assert.equal(sendFlag(), 0);
  db.prepare('UPDATE inventory_ledger SET quantity_remaining = 5 WHERE id = ?').run(row.lot);
  assert.deepEqual(ledgerSnapshot(), ledgerBefore, 'listing calls never touch the cost lot');
});

test('an item whose units already sold cannot be deleted or shrunk below them', async () => {
  const items = await import('../src/app/api/list/batches/[id]/items/route');
  const item = await import('../src/app/api/list/batches/[id]/items/[itemId]/route');
  const batches = await import('../src/app/api/list/batches/[id]/route');
  const batchId = Number(db.prepare(`INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
    VALUES ('MFN sold', 'draft', 'MFN', 'amazon', ${NOW}, ${NOW})`).run().lastInsertRowid);
  const add = await call(items, 'POST', `http://t/api/list/batches/${batchId}/items`,
    { asin: 'B0SOLD00001', sku: 'poke-SoldTest-43.94-mfn', quantity: 3, listPrice: 98, buyPrice: 43.94 }, { id: String(batchId) });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const lot = (db.prepare('SELECT inventory_ledger_id AS id FROM listing_batch_items WHERE id = ?').get(add.json.id) as { id: number }).id;
  db.prepare('UPDATE inventory_ledger SET quantity_remaining = 1 WHERE id = ?').run(lot); // FIFO gave 2 to sales
  const before = ledgerSnapshot();
  const params = { id: String(batchId), itemId: String(add.json.id) };
  const url = `http://t/api/list/batches/${batchId}/items/${add.json.id}`;

  const del = await call(item, 'DELETE', url, undefined, params);
  assert.equal(del.status, 409, JSON.stringify(del.json));
  assert.equal(del.json.unitsSold, 2);
  const delBatch = await call(batches, 'DELETE', `http://t/api/list/batches/${batchId}`, undefined, { id: String(batchId) });
  assert.equal(delBatch.status, 409, JSON.stringify(delBatch.json));
  const shrink = await call(item, 'PATCH', url, { quantity: 1 }, params);
  assert.equal(shrink.status, 409);
  assert.deepEqual(ledgerSnapshot(), before, 'nothing moved');
  assert.ok(db.prepare('SELECT 1 FROM listing_batch_items WHERE id = ?').get(add.json.id), 'item still there');

  // Dropping only the unsold unit is fine.
  const toSold = await call(item, 'PATCH', url, { quantity: 2 }, params);
  assert.equal(toSold.status, 200, JSON.stringify(toSold.json));
  assert.equal((db.prepare('SELECT quantity FROM inventory_ledger WHERE id = ?').get(lot) as { quantity: number }).quantity, 2);
});

