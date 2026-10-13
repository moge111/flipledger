/**
 * Regression test for refund-no-return claims that never retracted (Sept 22
 * 2026 review, D1).
 *
 * The detector only reads FBA refunds whose reason is still the
 * CUSTOMER_RETURN placeholder. When the customer-returns sync later writes a
 * real reason (the FC processed the return), the refund leaves that set, but
 * the Hub row froze as pending and the promote sweep kept moving it to
 * "File now". 13 false claims ($860.38) were in the queue.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scan: () => any;

function fbaRefund(orderId: string, sku: string, daysAgo: number): number {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, datetime('now', ?), 'Shipped', 'amazon', 'AFN', datetime('now'))`).run(orderId, `-${daysAgo + 5} days`);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, ?, ?, 1, 4500, 4500, 0, 0, 0, 2000)`).run(orderId, sku, sku);
  return Number(db.prepare(`INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES (?, datetime('now', ?), NULL, ?, 1, 4500, 'CUSTOMER_RETURN', 0, 0, 'amazon', datetime('now'))`).run(orderId, `-${daysAgo} days`, sku).lastInsertRowid);
}

const row = (refundId: number) => db.prepare(
  `SELECT status, eligibility, eligibility_reasons AS reasons FROM recovery_discrepancies WHERE ref_key = ?`,
).get(`rnr-${refundId}`) as { status: string; eligibility: string; reasons: string };

let fileNowId = 0, waitingId = 0, stillOpenId = 0;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  fileNowId = fbaRefund('RNR-FILE-NOW', 'rnr-sku-a', 75);   // inside days 60–120
  waitingId = fbaRefund('RNR-WAITING', 'rnr-sku-b', 30);    // before day 60
  stillOpenId = fbaRefund('RNR-STILL-OPEN', 'rnr-sku-c', 80);
  scan = (await import('../src/lib/recovery/discrepancies')).syncRecoveryDiscrepancies;
  scan();
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('placeholder refunds are flagged: eligible inside the window, waiting before it', () => {
  assert.equal(row(fileNowId).eligibility, 'eligible');
  assert.equal(row(waitingId).eligibility, 'waiting');
  assert.equal(row(stillOpenId).status, 'pending');
});

test('once the FC processes the return, the rescan retracts the claim', () => {
  db.prepare(`UPDATE refunds SET reason = 'NOT_AS_DESCRIBED' WHERE id = ?`).run(fileNowId);
  db.prepare(`UPDATE refunds SET reason = 'UNWANTED_ITEM', item_returned = 1 WHERE id = ?`).run(waitingId);
  const result = scan();
  assert.equal(result.refundNoReturn.retracted, 2);

  const a = row(fileNowId);
  assert.equal(a.status, 'expired');
  assert.equal(a.eligibility, 'not_eligible');
  assert.match(a.reasons, /Return processed at the FC \(reason: NOT_AS_DESCRIBED\)/);
  const b = row(waitingId);
  assert.equal(b.status, 'expired', 'a waiting row is retracted, never promoted');
  assert.equal(row(stillOpenId).status, 'pending', 'unaffected refunds stay open');
});

test('retracted claims leave the Recovery Hub File-now queue', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hub: any = await import('../src/app/api/data/recovery/route');
  const res: Response = await hub.GET(new Request('http://t/api/data/recovery?tab=tofile'));
  const { queue } = await res.json() as { queue: { orderId?: string; ref?: string }[] };
  const text = JSON.stringify(queue);
  assert.ok(!text.includes('RNR-FILE-NOW'), 'retracted claim still in File-now');
  assert.ok(text.includes('RNR-STILL-OPEN'), 'the genuine claim is still listed');
});

test('a filed claim is never retracted', () => {
  db.prepare(`UPDATE recovery_discrepancies SET status = 'filed' WHERE ref_key = ?`).run(`rnr-${stillOpenId}`);
  db.prepare(`UPDATE refunds SET reason = 'DEFECTIVE' WHERE id = ?`).run(stillOpenId);
  scan();
  assert.equal(row(stillOpenId).status, 'filed');
});
