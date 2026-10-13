/**
 * Regression test for per-order views ignoring refunds (Sept 22 2026 review, C3).
 *
 * FBA / WFS / Merchant / eBay Sales and the Profitability pages computed
 * profit as sale − cost − fees. A returned unit already has $0 COGS (FIFO),
 * so a refunded sale showed a 90–98% margin: $9,723.87 of 2026 profit was
 * overstated across 118 refunded orders. Settled refunds are now subtracted
 * per line via lineSettledRefundExpr (same Walmart gate as the P&L).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
const NOW = '2026-06-01T00:00:00Z';

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  const order = db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, '2026-06-02T12:00:00Z', 'Shipped', ?, ?, ?)`);
  const line = db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, 0)`);
  const ship = db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, marketplace, total_amount, created_at)
    VALUES ('ShipmentEvent', '2026-06-03T12:00:00Z', ?, ?, 0, ?)`);
  const refund = db.prepare(`INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES (?, ?, NULL, ?, 1, ?, 'CUSTOMER_RETURN', 1, 0, ?, ?)`);

  // Amazon FBA, two lines: $30 refund on line A by SKU, plus a $10 SKU-less
  // refund split 60/40 by revenue → A 3600, B 400.
  order.run('LR-AMZ', 'amazon', 'FBA', NOW);
  line.run('LR-AMZ', 'lr-a', 'lr-a', 6000, 6000);
  line.run('LR-AMZ', 'lr-b', 'lr-b', 4000, 4000);
  ship.run('LR-AMZ', 'amazon', NOW);
  refund.run('LR-AMZ', '2026-06-10T00:00:00Z', 'lr-a', 3000, 'amazon', NOW);
  refund.run('LR-AMZ', '2026-06-11T00:00:00Z', '', 1000, 'amazon', NOW);

  // Walmart WFS return that has not settled in recon yet.
  order.run('LR-WMT', 'walmart', 'WFS', NOW);
  line.run('LR-WMT', 'lr-w', 'lr-w', 5000, 5000);
  ship.run('LR-WMT', 'walmart', NOW);
  refund.run('LR-WMT', '2026-06-10T00:00:00Z', 'lr-w', 5000, 'walmart', NOW);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

const lineRefund = async (orderId: string, sku: string) => {
  const { lineSettledRefundExpr, lineSettledRefundRowsExpr } = await import('../src/lib/accounting-sql');
  return db.prepare(`SELECT ${lineSettledRefundExpr()} AS amt, ${lineSettledRefundRowsExpr('COUNT(*)')} AS n
    FROM order_items oi WHERE oi.order_id = ? AND oi.sku = ?`).get(orderId, sku) as { amt: number; n: number };
};

test('SKU-matched refunds stay on their line; SKU-less refunds are split by revenue', async () => {
  assert.deepEqual(await lineRefund('LR-AMZ', 'lr-a'), { amt: 3600, n: 2 });
  assert.deepEqual(await lineRefund('LR-AMZ', 'lr-b'), { amt: 400, n: 0 });
});

test('an unsettled Walmart refund counts only once recon settles it', async () => {
  assert.deepEqual(await lineRefund('LR-WMT', 'lr-w'), { amt: 0, n: 0 });
  db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartRefundEvent', '2026-06-12T00:00:00Z', 'LR-WMT', 'walmart', -5000, '{"Amount Type":"Product Price"}', ?)`).run(NOW);
  assert.deepEqual(await lineRefund('LR-WMT', 'lr-w'), { amt: 5000, n: 1 });
});

test('FBA Sales and Profitability subtract the refund from profit', async () => {
  const q = 'startDate=2026-06-01&endDate=2026-06-30';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fba: any = await import('../src/app/api/data/fba-sales/route');
  const f = await (await fba.GET(new Request(`http://t/api/data/fba-sales?${q}`))).json();
  const rows = f.items.filter((i: { orderId: string }) => i.orderId === 'LR-AMZ');
  const a = rows.find((i: { sku: string }) => i.sku === 'lr-a');
  assert.equal(a.refunded, 3600);
  assert.equal(a.profit, 6000 - 3600, 'no cost or fees on the fixture line, so profit = sale − refund');
  assert.equal(rows.reduce((s: number, i: { refunded: number }) => s + i.refunded, 0), 4000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prof: any = await import('../src/app/api/data/profitability/route');
  const p = await (await prof.GET(new Request(`http://t/api/data/profitability?groupBy=sku&marketplace=amazon&${q}`))).json();
  const pa = p.rows.find((r: { groupKey: string }) => r.groupKey === 'lr-a');
  assert.equal(pa.refunded, 3600);
  assert.equal(pa.profit, 6000 - 3600);
  assert.equal(pa.refunds, 2);
});
