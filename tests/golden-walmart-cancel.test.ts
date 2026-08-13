/**
 * Regression tests for Walmart cancellation handling (July 6, 2026 fix).
 *
 * Two historical bugs, both encoded here so they can't come back:
 *  1. A PARTIAL cancellation (one line cancelled, others shipped) dropped the
 *     WHOLE order — revenue understated.
 *  2. An order cancelled AFTER it synced was never reversed — phantom revenue
 *     (order_items + ShipmentEvent) stayed on the books forever.
 *
 * Order JSON shapes mirror the live Walmart API (verified July 6, 2026):
 * cancelled lines KEEP their full ItemPrice charge, and each orderLineStatus
 * carries a statusQuantity, so surviving quantity must come from statuses.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processWalmartOrder: (db: Database.Database, order: any) => void;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  processWalmartOrder = (await import('../src/lib/walmart-api/orders')).processWalmartOrder;
});

after(() => {
  db?.close();
  golden?.cleanup();
});

type StatusPair = [string, number];

function line(sku: string, qty: number, priceDollars: number, statuses: StatusPair[]) {
  return {
    lineNumber: '1',
    item: { sku, productName: `Test ${sku}` },
    charges: {
      charge: [{
        chargeType: 'PRODUCT',
        chargeName: 'ItemPrice',
        chargeAmount: { currency: 'USD', amount: priceDollars },
        tax: { taxAmount: { amount: 0 } },
      }],
    },
    orderLineQuantity: { unitOfMeasurement: 'EACH', amount: String(qty) },
    orderLineStatuses: {
      orderLineStatus: statuses.map(([status, q]) => ({
        status,
        statusQuantity: { unitOfMeasurement: 'EACH', amount: String(q) },
      })),
    },
    fulfillment: { fulfillmentOption: 'DELIVERY' },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walmartOrder(orderId: string, lines: any[]) {
  return {
    purchaseOrderId: orderId,
    orderDate: '2026-03-05T12:00:00.000Z',
    shippingInfo: { postalAddress: { state: 'UT' } },
    shipNode: { type: 'WFSFulfilled', name: 'Test', id: '1' },
    orderLines: { orderLine: lines },
  };
}

function rowsFor(orderId: string) {
  return {
    order: db.prepare('SELECT status FROM orders WHERE order_id = ?').get(orderId) as { status: string } | undefined,
    items: db.prepare('SELECT sku, quantity, price_per_unit, total_price FROM order_items WHERE order_id = ? ORDER BY sku').all(orderId) as
      { sku: string; quantity: number; price_per_unit: number; total_price: number }[],
    events: db.prepare(`SELECT sku, total_amount FROM financial_events WHERE order_id = ? AND event_type = 'ShipmentEvent' ORDER BY sku`).all(orderId) as
      { sku: string; total_amount: number }[],
    tax: db.prepare('SELECT COUNT(*) as n FROM sales_tax WHERE order_id = ?').get(orderId) as { n: number },
  };
}

test('clean order records all lines and is idempotent on re-sync', () => {
  const order = walmartOrder('WMT-CANCEL-T1', [
    line('wm-t1-a', 2, 40, [['Delivered', 2]]),
    line('wm-t1-b', 1, 25, [['Shipped', 1]]),
  ]);
  processWalmartOrder(db, order);
  processWalmartOrder(db, order); // re-sync must not duplicate

  const r = rowsFor('WMT-CANCEL-T1');
  assert.equal(r.order?.status, 'Shipped');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { sku: 'wm-t1-a', quantity: 2, price_per_unit: 2000, total_price: 4000 });
  assert.deepEqual(r.items[1], { sku: 'wm-t1-b', quantity: 1, price_per_unit: 2500, total_price: 2500 });
  assert.equal(r.events.length, 2);
});

test('BUG 1: partial cancellation keeps the surviving line (whole order used to be dropped)', () => {
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T2', [
    line('wm-t2-live', 1, 50, [['Shipped', 1]]),
    line('wm-t2-dead', 1, 30, [['Cancelled', 1]]),
  ]));

  const r = rowsFor('WMT-CANCEL-T2');
  assert.equal(r.order?.status, 'Shipped', 'order with a surviving line must be recorded');
  assert.equal(r.items.length, 1, 'only the surviving line is recorded');
  assert.equal(r.items[0].sku, 'wm-t2-live');
  assert.equal(r.items[0].total_price, 5000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].sku, 'wm-t2-live');
});

test('partial-QUANTITY cancellation within a line pro-rates the charge', () => {
  // qty 3 at $30 line total; 1 unit cancelled. Live API keeps the full $30
  // charge on the line, so surviving revenue must be pro-rated: 2/3 × 3000.
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T3', [
    line('wm-t3', 3, 30, [['Shipped', 2], ['Cancelled', 1]]),
  ]));

  const r = rowsFor('WMT-CANCEL-T3');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].quantity, 2);
  assert.equal(r.items[0].total_price, 2000);
  assert.equal(r.items[0].price_per_unit, 1000);
  assert.equal(r.events[0].total_amount, 2000);
});

test('BUG 2: full cancellation after sync reverses the order (was phantom revenue forever)', () => {
  const liveOrder = walmartOrder('WMT-CANCEL-T4', [line('wm-t4', 1, 114, [['Delivered', 1]])]);
  processWalmartOrder(db, liveOrder);
  let r = rowsFor('WMT-CANCEL-T4');
  assert.equal(r.items.length, 1);
  assert.equal(r.events.length, 1);

  // Same order comes back cancelled on a later sync
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T4', [line('wm-t4', 1, 114, [['Cancelled', 1]])]));
  r = rowsFor('WMT-CANCEL-T4');
  assert.equal(r.order?.status, 'Cancelled');
  assert.equal(r.items.length, 0, 'phantom order_items must be deleted');
  assert.equal(r.events.length, 0, 'phantom ShipmentEvent must be deleted');
  assert.equal(r.tax.n, 0);

  // Re-processing the cancelled order again is a no-op
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T4', [line('wm-t4', 1, 114, [['Cancelled', 1]])]));
  assert.equal(rowsFor('WMT-CANCEL-T4').items.length, 0);
});

test('partial cancellation AFTER sync deletes only the cancelled line', () => {
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T5', [
    line('wm-t5-a', 1, 60, [['Acknowledged', 1]]),
    line('wm-t5-b', 1, 20, [['Acknowledged', 1]]),
  ]));
  assert.equal(rowsFor('WMT-CANCEL-T5').items.length, 2);

  // Later sync: line B cancelled, line A shipped
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T5', [
    line('wm-t5-a', 1, 60, [['Shipped', 1]]),
    line('wm-t5-b', 1, 20, [['Cancelled', 1]]),
  ]));
  const r = rowsFor('WMT-CANCEL-T5');
  assert.equal(r.order?.status, 'Shipped');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].sku, 'wm-t5-a');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].sku, 'wm-t5-a');
});

test('quantity reduction AFTER sync updates the stored row and event in place', () => {
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T6', [
    line('wm-t6', 3, 90, [['Acknowledged', 3]]),
  ]));
  let r = rowsFor('WMT-CANCEL-T6');
  assert.equal(r.items[0].quantity, 3);
  assert.equal(r.items[0].total_price, 9000);

  // 1 of 3 units cancelled after the first sync
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T6', [
    line('wm-t6', 3, 90, [['Shipped', 2], ['Cancelled', 1]]),
  ]));
  r = rowsFor('WMT-CANCEL-T6');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].quantity, 2);
  assert.equal(r.items[0].total_price, 6000);
  assert.equal(r.events.length, 1, 'event must be updated in place, not duplicated');
  assert.equal(r.events[0].total_amount, 6000);
});

test('never-synced fully-cancelled order inserts nothing', () => {
  processWalmartOrder(db, walmartOrder('WMT-CANCEL-T7', [line('wm-t7', 1, 40, [['Cancelled', 1]])]));
  const r = rowsFor('WMT-CANCEL-T7');
  assert.equal(r.order, undefined);
  assert.equal(r.items.length, 0);
  assert.equal(r.events.length, 0);
});

test('Cancelled status without statusQuantity cancels the whole line', () => {
  const order = walmartOrder('WMT-CANCEL-T8', [line('wm-t8', 2, 50, [['Cancelled', 0]])]);
  // strip the statusQuantity to simulate the field missing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (order.orderLines.orderLine[0].orderLineStatuses.orderLineStatus[0] as any).statusQuantity;
  processWalmartOrder(db, order);
  assert.equal(rowsFor('WMT-CANCEL-T8').items.length, 0);
});
