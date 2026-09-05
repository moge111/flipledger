/**
 * Regression tests for Amazon RefundEvent parsing (Sept 4, 2026 fix).
 *
 * refund_amount must be the SIGNED sum of non-tax charge adjustments, negated:
 *  - Principal / ShippingCharge are negative (money leaving the seller)
 *  - ReturnShipping / RestockingFee are POSITIVE (withheld from the buyer,
 *    reducing the seller's cost)
 *  - every *Tax* line is excluded (marketplace-facilitator pass-through)
 * The old code took Math.abs of every line, so a $9.52 ReturnShipping offset
 * was ADDED to a $92 principal and stored as $101.52 instead of $82.48.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processRefundEvent: (db: Database.Database, event: any) => void;

const usd = (n: number) => ({ CurrencyCode: 'USD', CurrencyAmount: n });

function refundEvent(orderId: string, sku: string, charges: [string, number][], fees: [string, number][] = [], qty = 1) {
  return {
    AmazonOrderId: orderId,
    PostedDate: '2026-04-17T18:22:10Z',
    ShipmentItemAdjustmentList: [{
      SellerSKU: sku,
      QuantityShipped: qty,
      ItemChargeAdjustmentList: charges.map(([t, a]) => ({ ChargeType: t, ChargeAmount: usd(a) })),
      ItemFeeAdjustmentList: fees.map(([t, a]) => ({ FeeType: t, FeeAmount: usd(a) })),
    }],
  };
}

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('GOLD-RF-MFN', '2026-04-01T10:00:00Z', 'Shipped', 'amazon', 'MFN', '2026-04-01T10:00:00Z'),
           ('GOLD-RF-FBA', '2026-04-02T10:00:00Z', 'Shipped', 'amazon', 'FBA', '2026-04-02T10:00:00Z');
  `);
  processRefundEvent = (await import('../src/lib/sp-api/finances')).processRefundEvent;
});

after(() => {
  db?.close();
  golden?.cleanup();
});

function refundRow(orderId: string) {
  return db.prepare('SELECT refund_amount, fee_clawback, item_returned, quantity FROM refunds WHERE order_id = ?').get(orderId) as
    { refund_amount: number; fee_clawback: number; item_returned: number; quantity: number };
}

test('positive ReturnShipping offset REDUCES the refund cost (not added to it)', () => {
  // Mirrors live order 114-7265945-2105053: Principal −92, Tax −7.36, ReturnShipping +9.52
  processRefundEvent(db, refundEvent('GOLD-RF-MFN', 'amz-rf-1',
    [['Tax', -7.36], ['Tax', 0], ['Principal', -92], ['ReturnShipping', 9.52]],
    [['Commission', 13.8], ['RefundCommission', -2.76]]));
  const r = refundRow('GOLD-RF-MFN');
  assert.equal(r.refund_amount, 8248, 'refund = 92.00 − 9.52, tax excluded');
  assert.equal(r.fee_clawback, 1380, 'only positive fee lines are clawback');
  assert.equal(r.item_returned, 1, 'MFN refund → unit comes back to the seller');
  const ev = db.prepare("SELECT total_amount FROM financial_events WHERE event_type = 'RefundEvent' AND order_id = ?").get('GOLD-RF-MFN') as { total_amount: number };
  assert.equal(ev.total_amount, -8248 + 1380, 'RefundEvent total mirrors refund − clawback');
});

test('RestockingFee offset and ShippingCharge reversal are signed correctly; tax lines excluded', () => {
  // Mirrors live 112-0942719-0466659 (RestockingFee +8.30) with a shipping reversal added
  processRefundEvent(db, refundEvent('GOLD-RF-FBA', 'amz-rf-2',
    [['Tax', -3.42], ['ShippingTax', -0.25], ['ShippingCharge', -3.00], ['RestockingFee', 8.30], ['Principal', -41.50]],
    [['Commission', 6.23], ['VariableClosingFee', 1.8], ['RefundCommission', -1.25], ['ShippingChargeback', 3.0]]));
  const r = refundRow('GOLD-RF-FBA');
  assert.equal(r.refund_amount, 4150 + 300 - 830, '41.50 + 3.00 − 8.30 = 36.20');
  assert.equal(r.fee_clawback, 623 + 180 + 300);
  assert.equal(r.item_returned, 0, 'FBA disposition comes from the customer-returns report later');
});

test('re-processing the same event is idempotent (no duplicate refund row)', () => {
  processRefundEvent(db, refundEvent('GOLD-RF-MFN', 'amz-rf-1',
    [['Tax', -7.36], ['Principal', -92], ['ReturnShipping', 9.52]], [['Commission', 13.8]]));
  const n = (db.prepare('SELECT COUNT(*) as n FROM refunds WHERE order_id = ?').get('GOLD-RF-MFN') as { n: number }).n;
  assert.equal(n, 1);
  const fees = (db.prepare("SELECT COUNT(*) as n FROM fee_details WHERE order_id = 'GOLD-RF-MFN'").get() as { n: number }).n;
  assert.equal(fees, 2, 'clawback fee rows linked once (Commission + RefundCommission)');
});
