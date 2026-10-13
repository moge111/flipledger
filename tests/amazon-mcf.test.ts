/**
 * Regression tests for Amazon Multi-Channel Fulfillment (Sept 23 2026, review A4).
 *
 * An MCF shipment is Amazon shipping FBA stock for a sale made on Walmart or
 * eBay. It arrives as a $0 Amazon ShipmentEvent (MarketplaceName
 * "Non-Amazon US"), and FIFO used to cost it on top of the sale's own COGS:
 * one unit, two costs ($161.16 over 4 LEGO orders).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = '2026-05-01T00:00:00Z';
const AMZ_SKU = 'amz-lego42652';
const WMT_SKU = 'wm-lego42652-40.29';

function mcfEvent(orderId: string, posted: string, sellerOrderId: string) {
  return {
    AmazonOrderId: orderId, PostedDate: posted, MarketplaceName: 'Non-Amazon US', SellerOrderId: sellerOrderId,
    ShipmentItemList: [{ SellerSKU: AMZ_SKU, QuantityShipped: 1, ItemChargeList: [],
      ItemFeeList: [{ FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyCode: 'USD', CurrencyAmount: -13.15 } }] }],
  };
}

function walmartSale(po: string, purchased: string, customerOrderId: string) {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, ?, 'Shipped', 'walmart', 'Seller', ?)`).run(po, purchased, NOW);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, ?, ?, 1, 6999, 6999, 0, 0, 0, 0)`).run(po, WMT_SKU, WMT_SKU);
  db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartReconEvent', ?, ?, ?, ?, 'walmart', 6999, ?, ?)`).run(purchased, po, WMT_SKU, WMT_SKU, JSON.stringify({ 'Customer Order #': customerOrderId }), NOW);
}

const cogs = (orderId: string) => (db.prepare('SELECT cogs_per_unit c FROM order_items WHERE order_id = ?').get(orderId) as { c: number }).c;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    INSERT INTO products (asin, sku, name, created_at, updated_at) VALUES
      ('${AMZ_SKU}', '${AMZ_SKU}', 'LEGO Friends Friendship Tree House Hangout Building Toy Playset with 4 Minidolls - 42652', '${NOW}', '${NOW}'),
      ('${WMT_SKU}', '${WMT_SKU}', 'LEGO Friends Friendship Tree House Hangout - Building Toys Playset - 4 Minifigures - 42652', '${NOW}', '${NOW}');
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at) VALUES
      ('${AMZ_SKU}', '${AMZ_SKU}', 4029, 10, 10, '2026-01-01', '${NOW}'),
      ('${WMT_SKU}', '${WMT_SKU}', 4029, 10, 10, '2026-01-01', '${NOW}');
  `);
  walmartSale('WMT-EXACT', '2026-03-12T23:35:00Z', '200000000000001');
  walmartSale('WMT-FUZZY', '2026-03-17T18:49:00Z', '200099999999999');
  const { processShipmentEvent } = await import('../src/lib/sp-api/finances');
  processShipmentEvent(db, mcfEvent('S01-EXACT', '2026-03-14T14:19:47Z', '200000000000001'));
  processShipmentEvent(db, mcfEvent('S01-FUZZY', '2026-03-18T07:35:04Z', 'CONSUMER-2026317-20445'));
  processShipmentEvent(db, mcfEvent('S01-ORPHAN', '2026-04-20T07:35:04Z', 'CONSUMER-2026420-1'));
  db.prepare(`UPDATE order_items SET asin = ? WHERE order_id LIKE 'S01-%'`).run(AMZ_SKU);
  const { recalculateFIFO } = await import('../src/lib/fifo');
  assert.deepEqual(recalculateFIFO({ recalcAll: true }).errors, []);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('MCF shipments are marked MCF, not FBA', () => {
  const ch = db.prepare(`SELECT DISTINCT fulfillment_channel c FROM orders WHERE order_id LIKE 'S01-%'`).all();
  assert.deepEqual(ch, [{ c: 'MCF' }]);
});

test('MCF shipments pair with their sale: by order id, else by product and date', () => {
  const pairs = db.prepare(`SELECT mcf_order_id m, sale_order_id s, method FROM mcf_fulfillments ORDER BY m`).all();
  assert.deepEqual(pairs, [
    { m: 'S01-EXACT', s: 'WMT-EXACT', method: 'exact' },
    { m: 'S01-FUZZY', s: 'WMT-FUZZY', method: 'product+date' },
  ]);
});

test('a paired MCF line carries no COGS; the sale keeps it', () => {
  assert.equal(cogs('S01-EXACT'), 0);
  assert.equal(cogs('S01-FUZZY'), 0);
  assert.equal(cogs('WMT-EXACT'), 4029);
});

test('an unpaired MCF line keeps its COGS (conservative)', () => {
  assert.equal(cogs('S01-ORPHAN'), 4029);
});

test('product similarity: a shared model number is a match, unrelated names are not', async () => {
  const { productSimilarity } = await import('../src/lib/sp-api/mcf');
  assert.equal(productSimilarity('LEGO Porsche 911 - 10295', 'Lego Icons Porsche 911 Building Kit 10295'), 1);
  assert.ok(productSimilarity('Fitbit Ace LTE kids watch', 'LEGO Friends Tree House 42652') < 0.5);
});
