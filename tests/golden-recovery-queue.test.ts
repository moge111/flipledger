/**
 * Regression tests for the Recovery Hub unified action queue (July 7, 2026).
 *
 * The hub aggregates all five recovery surfaces into ONE normalized queue —
 * warehouse-loss claims, reimbursement re-evaluations, Amazon SAFE-T disputes,
 * Walmart disputes, and the discrepancy detectors — each with server-rendered
 * claim text, a filing URL, and a deadline. PATCH dispatches lifecycle updates
 * to the right underlying table by `source`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);

  db.exec(`
    -- 1. discrepancy detector row (eligible refund-no-return)
    INSERT INTO recovery_discrepancies (discrepancy_type, ref_key, order_id, asin, sku, product_name, event_date, quantity,
      estimated_value_cents, eligibility, eligibility_reasons, eligible_from, window_until, detail, status, created_at, updated_at)
    VALUES ('refund_no_return', 'rnr-1', 'GOLD-AMZ-A1', 'B0GOLD0001', 'amz-gold1-10', 'Golden Widget', '2026-05-01', 1,
      2500, 'eligible', '["Refund issued, no FC return record after 45 days"]', '2026-06-15', '2026-08-14', '{}', 'pending', datetime('now'), datetime('now'));

    -- 2. warehouse-loss claim
    INSERT INTO reimbursement_candidates (adjustment_date, asin, sku, product_name, fulfillment_center_id, reason, disposition,
      quantity, estimated_value_cents, eligible_until, status)
    VALUES ('2026-06-20', 'B0GOLD0001', 'amz-gold1-10', 'Golden Widget', 'ABE8', 'M', 'SELLABLE', -2, 2000, '2026-08-19', 'pending');

    -- 3. underpaid reimbursement (re-eval)
    INSERT INTO amazon_reimbursement_reevaluations (reimbursement_id, reimbursement_date, asin, sku, product_name, quantity,
      paid_cents, expected_cents, gap_cents, reason, status)
    VALUES ('99887766554', '2026-06-25', 'B0GOLD0002', 'amz-gold2-30', 'Golden Headphones', 1, 1000, 3000, 2000, 'Lost_Warehouse', 'pending');

    -- 4. Amazon SAFE-T dispute (MFN, eligible)
    INSERT INTO amazon_dispute_candidates (refund_id, order_id, refund_date, return_reason, asin, sku, product_name,
      refund_amount_cents, fulfillment_channel, eligibility, eligibility_reasons, dispute_window_until, status)
    VALUES (901, 'GOLD-AMZ-A2', '2026-06-10', 'NEVER_ARRIVED', 'B0GOLD0002', 'amz-gold2-30', 'Golden Headphones',
      8000, 'MFN', 'eligible', '["Carrier shows delivered"]', '2026-09-08', 'pending');

    -- 5. Walmart dispute (maybe)
    INSERT INTO walmart_dispute_candidates (refund_id, order_id, refund_date, return_reason, asin, sku, product_name,
      refund_amount_cents, fulfillment_channel, eligibility, eligibility_reasons, dispute_window_until, status)
    VALUES (902, 'GOLD-WMT-W1', '2026-06-12', 'DAMAGED', '100001', 'wm-gold3-99', 'Golden Fitness Tracker',
      7000, 'WFS', 'maybe', '["WFS handled storage and shipping"]', '2026-07-12', 'pending');
  `);

  mod = await import('../src/app/api/data/recovery/route');
});

after(() => {
  db?.close();
  golden?.cleanup();
});

async function get(tab: string) {
  const res: Response = await mod.GET(new Request(`http://test.local/api/data/recovery?tab=${tab}`));
  assert.equal(res.status, 200);
  return res.json();
}

async function patch(source: string, id: number, action: string) {
  const res: Response = await mod.PATCH(new Request('http://test.local/api/data/recovery', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, id, action }),
  }));
  assert.equal(res.status, 200);
  return res.json();
}

test('File-now tab unifies eligible items from every source', async () => {
  const data = await get('tofile');
  const bySource = new Map(data.queue.map((q: { source: string }) => [q.source, q]));
  // eligible: discrepancy + claims + reevals + amz. The Walmart row is
  // 'maybe' → belongs in the waiting tab, not here.
  assert.deepEqual([...bySource.keys()].sort(), ['amz', 'claims', 'discrepancy', 'reevals']);

  // Every actionable row must ship with claim text, a filing URL, and steps
  for (const q of data.queue as Array<Record<string, unknown>>) {
    assert.ok((q.claimText as string).length > 50, `${q.source}: claimText rendered`);
    assert.match(q.fileUrl as string, /^https:\/\//, `${q.source}: fileUrl present`);
    assert.ok((q.steps as string[]).length >= 3, `${q.source}: filing steps present`);
  }

  // Normalization spot-checks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reeval = bySource.get('reevals') as any;
  assert.equal(reeval.amountCents, 2000); // the GAP, not the paid amount
  assert.equal(reeval.refId, '99887766554');
  assert.match(reeval.windowUntil, /^2026-08-24/); // reimbursement_date + 60d
  assert.match(reeval.claimText, /99887766554/); // template embeds the reimb ID

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const amz = bySource.get('amz') as any;
  assert.equal(amz.marketplace, 'amazon');
  assert.equal(amz.fileUrl, 'https://sellercentral.amazon.com/safetclaim/dashboard'); // MFN → SAFE-T
  assert.match(amz.claimText, /GOLD-AMZ-A2/);

  // Sorted by deadline: the earliest window (claims 08-19) before later ones
  const sources = data.queue.map((q: { source: string }) => q.source);
  assert.equal(sources[0], 'discrepancy'); // window 08-14 is earliest of the four
});

test('Waiting/maybe tab holds the Walmart maybe-dispute with rendered template', async () => {
  const data = await get('waiting');
  assert.equal(data.queue.length, 1);
  const w = data.queue[0];
  assert.equal(w.source, 'wmt');
  assert.equal(w.marketplace, 'walmart');
  assert.equal(w.eligibility, 'maybe');
  assert.match(w.claimText, /GOLD-WMT-W1/); // Walmart template rendered with vars
  assert.equal(w.fileUrl, 'https://seller.walmart.com/returns-reimbursements/dashboard');
});

test('PATCH dispatches by source to the right table', async () => {
  // File the re-eval through the hub → row in amazon_reimbursement_reevaluations flips
  const reevalId = (db.prepare(`SELECT id FROM amazon_reimbursement_reevaluations WHERE reimbursement_id = '99887766554'`).get() as { id: number }).id;
  await patch('reevals', reevalId, 'file');
  let row = db.prepare(`SELECT status, filed_at FROM amazon_reimbursement_reevaluations WHERE id = ?`).get(reevalId) as { status: string; filed_at: string | null };
  assert.equal(row.status, 'filed');
  assert.ok(row.filed_at);

  // It moves to the Filed tab and out of File-now
  const filed = await get('filed');
  assert.ok(filed.queue.some((q: { source: string; id: number }) => q.source === 'reevals' && q.id === reevalId));
  const tofile = await get('tofile');
  assert.ok(!tofile.queue.some((q: { source: string; id: number }) => q.source === 'reevals' && q.id === reevalId));

  // Reopen restores it
  await patch('reevals', reevalId, 'reopen');
  row = db.prepare(`SELECT status, filed_at FROM amazon_reimbursement_reevaluations WHERE id = ?`).get(reevalId) as { status: string; filed_at: string | null };
  assert.equal(row.status, 'pending');
  assert.equal(row.filed_at, null);

  // Dismiss a Walmart dispute through the hub
  const wmtId = (db.prepare(`SELECT id FROM walmart_dispute_candidates WHERE order_id = 'GOLD-WMT-W1'`).get() as { id: number }).id;
  await patch('wmt', wmtId, 'dismiss');
  const w = db.prepare(`SELECT status FROM walmart_dispute_candidates WHERE id = ?`).get(wmtId) as { status: string };
  assert.equal(w.status, 'dismissed');
  await patch('wmt', wmtId, 'reopen');
});

test('grand totals count all five sources', async () => {
  const data = await get('all');
  assert.equal(data.sources.length, 5);
  // 4 eligible-pending (+ wmt maybe counts as pending in the dispute aggregate)
  assert.equal(data.grand.pendingCount, 5);
  assert.equal(data.grand.pendingValueCents, 2500 + 2000 + 2000 + 8000 + 7000);
});

test('unknown PATCH source is rejected', async () => {
  const res: Response = await mod.PATCH(new Request('http://test.local/api/data/recovery', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'nope', id: 1, action: 'file' }),
  }));
  assert.equal(res.status, 400);
});
