/**
 * Regression test for the purchase-year scope of COGS reversals (Sept 4, 2026).
 *
 * A sale bought Dec 28 that posts (cash recognition) Jan 3 and is returned in
 * February is SAME-year on the cash books but CROSS-year on the purchase-date
 * books the Tax Report and accrual P&L use. The old rule keyed only on the
 * cash year, so FIFO zeroed the sale's COGS: the prior tax year lost the cost
 * and no year got a relief credit. Now either year mismatch books a reversal,
 * which is correct on both bases (sale keeps COGS, refund period gets relief).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const SKU = 'amz-pyear-20';
const NOW = "'2026-03-20T00:00:00Z'";

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0PYEAR001', '${SKU}', 2000, 3, 3, '2025-11-01', ${NOW});

    -- P1: bought Dec 28 2025, ShipmentEvent Jan 3 2026, returned Feb 20 2026.
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('GOLD-PYEAR-P1', '2025-12-28T22:00:00Z', 'Shipped', 'amazon', 'FBA', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES ('GOLD-PYEAR-P1', 'B0PYEAR001', '${SKU}', 1, 6000, 6000, 0, 0, 0, 0);
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('ShipmentEvent', '2026-01-03T08:00:00Z', 'GOLD-PYEAR-P1', 'B0PYEAR001', '${SKU}', 'amazon', 6000, NULL, ${NOW});
    INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES ('GOLD-PYEAR-P1', '2026-02-20T12:00:00Z', 'B0PYEAR001', '${SKU}', 1, 6000, 'UNWANTED_ITEM', 1, 0, 'amazon', ${NOW});
  `);
  const { recalculateFIFO } = await import('../src/lib/fifo');
  const r = recalculateFIFO({ sku: SKU });
  assert.deepEqual(r.errors, []);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('purchase-year mismatch keeps the sale COGS and books a reversal (not zero-at-sale)', () => {
  const cogs = (db.prepare('SELECT cogs_per_unit FROM order_items WHERE order_id = ?').get('GOLD-PYEAR-P1') as { cogs_per_unit: number }).cogs_per_unit;
  assert.equal(cogs, 2000);
  const rev = db.prepare('SELECT amount, refund_date FROM cogs_reversals WHERE order_id = ?').get('GOLD-PYEAR-P1') as { amount: number; refund_date: string } | undefined;
  assert.ok(rev, 'a cogs_reversals row must exist');
  assert.equal(rev!.amount, 2000);
  assert.match(rev!.refund_date, /^2026-02-20/);
  const lot = db.prepare('SELECT quantity_remaining FROM inventory_ledger WHERE sku = ?').get(SKU) as { quantity_remaining: number };
  assert.equal(lot.quantity_remaining, 3, 'returned unit is back in stock');
});

test('Tax Report: 2025 keeps the cost, 2026 gets the relief; cash P&L annual total unchanged', async () => {
  const taxGET = (await import('../src/app/api/data/tax-report/route')).GET;
  const pnlGET = (await import('../src/app/api/data/profitloss/route')).GET;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (GET: any, url: string) => { const res: Response = await GET(new Request(url)); assert.equal(res.status, 200); return res.json(); };

  const y2025 = await call(taxGET, 'http://test.local/api/data/tax-report?year=2025');
  assert.equal(y2025.scheduleC.line4_cogs, 2000, '2025 (purchase year) keeps the $20 COGS');
  const y2026 = await call(taxGET, 'http://test.local/api/data/tax-report?year=2026');
  // Fixture 2026 purchase-dated COGS: A1 2000 + A2 3000 + W1 9900 + W2 1500 = 16400, minus the $20 relief.
  assert.equal(y2026.scheduleC.line4_cogs, 16400 - 2000);

  // Cash P&L, Jan–Feb 2026 amazon: P1 recognised Jan (COGS 2000) and relieved Feb (−2000) → nets to
  // the fixture's own A1 2000 + A2 3000 = 5000 across the two months.
  const janFeb = await call(pnlGET, 'http://test.local/api/data/profitloss?startDate=2026-01-01&endDate=2026-02-28&marketplace=amazon');
  assert.equal(janFeb.expenses.cogs, 5000);
  assert.equal(janFeb.expenses.cogsReversals, 2000);
});
