/**
 * Regression tests for period-aware COGS reversal (July 7, 2026 fix).
 *
 * The problem: fifo.ts zeroed cogs_per_unit on any fully-returned item with no
 * period scope, so an item SOLD in 2025 but RETURNED in 2026 had its COGS
 * removed from the already-filed 2025 books; the relief belonged in 2026.
 *
 * The fix: a return in a DIFFERENT calendar year than the sale's cash-basis
 * recognition date keeps the sale's COGS and books a cogs_reversals credit
 * dated at the refund. Same-year returns keep the original zero-at-sale
 * behavior (annual totals identical either way). P&L / Dashboard / Cashflow /
 * Tax Report all subtract reversals in the refund's period.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recalculateFIFO: (opts: any) => any;

const SKU = 'amz-xyear-20';
const NOW = "'2026-03-20T00:00:00Z'";

before(async () => {
  golden = await buildGoldenDb(); // sets FLIPLEDGER_DB_PATH
  db = new Database(golden.dbPath);

  // Lot: 5 units at $20.00, bought Nov 2025
  db.exec(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0XYEAR001', '${SKU}', 2000, 5, 5, '2025-11-01', ${NOW});

    -- X1: sold Dec 2025 (cash-basis recognition 2025), RETURNED Feb 2026 → cross-year
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('GOLD-XYEAR-X1', '2025-12-01T10:00:00Z', 'Shipped', 'amazon', 'FBA', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES ('GOLD-XYEAR-X1', 'B0XYEAR001', '${SKU}', 1, 6000, 6000, 0, 0, 0, 0);
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('ShipmentEvent', '2025-12-03T08:00:00Z', 'GOLD-XYEAR-X1', 'B0XYEAR001', '${SKU}', 'amazon', 6000, NULL, ${NOW});
    INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES ('GOLD-XYEAR-X1', '2026-02-15T12:00:00Z', 'B0XYEAR001', '${SKU}', 1, 6000, 'UNWANTED_ITEM', 1, 0, 'amazon', ${NOW});

    -- X2: sold Jan 2026, returned Mar 2026 → SAME year, keeps zero-at-sale behavior
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('GOLD-XYEAR-X2', '2026-01-10T10:00:00Z', 'Shipped', 'amazon', 'FBA', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES ('GOLD-XYEAR-X2', 'B0XYEAR001', '${SKU}', 1, 6000, 6000, 0, 0, 0, 0);
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('ShipmentEvent', '2026-01-12T08:00:00Z', 'GOLD-XYEAR-X2', 'B0XYEAR001', '${SKU}', 'amazon', 6000, NULL, ${NOW});
    INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES ('GOLD-XYEAR-X2', '2026-03-01T12:00:00Z', 'B0XYEAR001', '${SKU}', 1, 6000, 'UNWANTED_ITEM', 1, 0, 'amazon', ${NOW});

    -- X3: normal sale Mar 2026 — consumes the stock the returns put back
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES ('GOLD-XYEAR-X3', '2026-03-15T10:00:00Z', 'Shipped', 'amazon', 'FBA', ${NOW});
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES ('GOLD-XYEAR-X3', 'B0XYEAR001', '${SKU}', 1, 6000, 6000, 0, 0, 0, 0);
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('ShipmentEvent', '2026-03-17T08:00:00Z', 'GOLD-XYEAR-X3', 'B0XYEAR001', '${SKU}', 'amazon', 6000, NULL, ${NOW});
  `);

  recalculateFIFO = (await import('../src/lib/fifo')).recalculateFIFO;
  const result = recalculateFIFO({ sku: SKU });
  assert.deepEqual(result.errors, []);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

function cogsOf(orderId: string): number {
  return (db.prepare('SELECT cogs_per_unit FROM order_items WHERE order_id = ?').get(orderId) as { cogs_per_unit: number }).cogs_per_unit;
}

test('cross-year return KEEPS the sale-year COGS (filed year not rewritten)', () => {
  assert.equal(cogsOf('GOLD-XYEAR-X1'), 2000, 'X1 sold in 2025 must keep its 2025 COGS');
});

test('cross-year return books a cogs_reversals credit dated at the refund', () => {
  const rows = db.prepare('SELECT order_id, quantity, amount, refund_date, marketplace FROM cogs_reversals').all() as
    { order_id: string; quantity: number; amount: number; refund_date: string; marketplace: string }[];
  assert.equal(rows.length, 1, 'exactly one reversal (X1); same-year X2 must not create one');
  assert.equal(rows[0].order_id, 'GOLD-XYEAR-X1');
  assert.equal(rows[0].amount, 2000);
  assert.equal(rows[0].quantity, 1);
  assert.match(rows[0].refund_date, /^2026-02-15/);
  assert.equal(rows[0].marketplace, 'amazon');
});

test('same-year return keeps zero-at-sale behavior', () => {
  assert.equal(cogsOf('GOLD-XYEAR-X2'), 0);
});

test('returned units re-enter stock: later sale consumes them, remaining is right', () => {
  // Lot of 5: X1 consumed-then-restored, X2 skipped consumption, X3 consumed 1.
  assert.equal(cogsOf('GOLD-XYEAR-X3'), 2000);
  const lot = db.prepare('SELECT quantity_remaining FROM inventory_ledger WHERE sku = ?').get(SKU) as { quantity_remaining: number };
  assert.equal(lot.quantity_remaining, 4);
});

test('FIFO re-run is idempotent (no duplicate or resurrected reversals)', () => {
  const r = recalculateFIFO({ sku: SKU });
  assert.deepEqual(r.errors, []);
  assert.equal(r.itemsUpdated, 0);
  const n = (db.prepare('SELECT COUNT(*) as n FROM cogs_reversals').get() as { n: number }).n;
  assert.equal(n, 1);
});

test('P&L: sale year keeps COGS, refund year gets the credit — and Dashboard parity holds', async () => {
  const pnlGET = (await import('../src/app/api/data/profitloss/route')).GET;
  const dashGET = (await import('../src/app/api/data/dashboard/route')).GET;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (GET: any, route: string, params: Record<string, string>) => {
    const res: Response = await GET(new Request(`http://test.local/api/data/${route}?` + new URLSearchParams(params)));
    assert.equal(res.status, 200);
    return res.json();
  };

  // Dec 2025 (sale year): X1's $20.00 COGS stays put
  const dec = await call(pnlGET, 'profitloss', { startDate: '2025-12-01', endDate: '2025-12-31', marketplace: 'amazon' });
  assert.equal(dec.expenses.cogs, 2000);
  assert.equal(dec.expenses.cogsReversals, 0);

  // Feb 2026 (refund month): fixture A2 COGS 3000 − 2000 reversal = 1000 net;
  // refunds = fixture A1 2500 + X1 6000
  const feb = await call(pnlGET, 'profitloss', { startDate: '2026-02-01', endDate: '2026-02-28', marketplace: 'amazon' });
  assert.equal(feb.expenses.cogsReversals, 2000);
  assert.equal(feb.expenses.cogs, 1000);
  assert.equal(feb.refunds.total, 8500);
  assert.equal(feb.netProfit, 8500 - (1000 + 1200 + 842) - 8500 /* = -3042 */);

  // Dashboard must agree on both slices
  for (const [range, p] of [
    [{ startDate: '2025-12-01', endDate: '2025-12-31', marketplace: 'amazon' }, dec],
    [{ startDate: '2026-02-01', endDate: '2026-02-28', marketplace: 'amazon' }, feb],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as [Record<string, string>, any][]) {
    const d = await call(dashGET, 'dashboard', range);
    assert.equal(d.stats.totalCogs, p.expenses.cogs, 'Dashboard COGS parity');
    assert.equal(d.stats.totalProfit, p.netProfit, 'Dashboard profit parity');
  }
});

test('Cash Flow months still equal P&L netProfit with reversals in play', async () => {
  const cfGET = (await import('../src/app/api/data/cashflow/route')).GET;
  const pnlGET = (await import('../src/app/api/data/profitloss/route')).GET;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfRes: Response = await cfGET(new Request('http://test.local/api/data/cashflow?months=24') as any);
  const cf = await cfRes.json();
  const feb = cf.months.find((m: { month: string }) => m.month === '2026-02');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pnlRes: Response = await pnlGET(new Request('http://test.local/api/data/profitloss?startDate=2026-02-01&endDate=2026-02-28') as any);
  const p = await pnlRes.json();
  assert.equal(feb.net, p.netProfit, 'Feb cashflow net must equal P&L netProfit (all marketplaces)');
});

test('Tax report: 2025 keeps the COGS, 2026 gets the relief', async () => {
  const taxGET = (await import('../src/app/api/data/tax-report/route')).GET;
  const call = async (year: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: Response = await taxGET(new Request(`http://test.local/api/data/tax-report?year=${year}`) as any);
    assert.equal(res.status, 200);
    return res.json();
  };
  const y2025 = await call(2025);
  assert.equal(y2025.scheduleC.line4_cogs, 2000, '2025 line 4 must include the returned item sold in 2025');
  const y2026 = await call(2026);
  // 2026 purchase-dated COGS in this fixture: A1 2000 + A2 3000 + W1 9900 +
  // W2 1500 + X2 0 (same-year return) + X3 2000 = 18400, minus the $20.00
  // cross-year relief = 16400.
  assert.equal(y2026.scheduleC.line4_cogs, 16400);
});
