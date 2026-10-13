/**
 * Recovery Hub detector 3 — replacement_no_return (Sept 19, 2026).
 *
 * A free replacement has no refund row, so nothing else in the hub can see it.
 * Claim window mirrors refund_no_return: days 60–120 after the replacement.
 * Guards locked here:
 *  - window classification (waiting / eligible / expired)
 *  - one reimbursement covers ONE replacement, even when two share a SKU
 *  - a sellable return of the original means nothing was lost
 *  - pending / non-FBA / non-replacement orders are never candidates
 *  - a filed candidate keeps its status across re-scans
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function addReplacement(id: string, ageDays: number, sku: string, opts: { reason?: number | null; status?: string; channel?: string; cogs?: number; flagged?: boolean } = {}) {
  const at = daysAgo(ageDays);
  const orig = `ORIG-${id}`;
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, shipped_at, created_at)
              VALUES (?, ?, 'Shipped', 'amazon', 'FBA', ?, ?)`).run(orig, daysAgo(ageDays + 5), daysAgo(ageDays + 4), at);
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, cogs_per_unit)
              VALUES (?, ?, ?, 1, 5000, 5000, 0, ?)`).run(orig, `B0${sku}`.slice(0, 10), sku, opts.cogs ?? 2000);
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, shipped_at, is_replacement, replaced_order_id, replacement_reason_code, created_at)
              VALUES (?, ?, ?, 'amazon', ?, ?, ?, ?, ?, ?)`)
    .run(id, at, opts.status ?? 'Shipped', opts.channel ?? 'FBA', at, opts.flagged === false ? 0 : 1, orig, opts.reason ?? null, at);
  // replacement line items land via financial events with the SKU in the asin column
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, cogs_per_unit)
              VALUES (?, ?, ?, 1, 0, 0, 0, ?)`).run(id, sku, sku, opts.cogs ?? 2000);
}

function addReimbursement(rid: string, sku: string, ageDays: number, amount = 1500) {
  db.prepare(`INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, marketplace, created_at)
              VALUES (?, ?, '', ?, 'CustomerServiceIssue', ?, 1, 'amazon', ?)`).run(rid, daysAgo(ageDays), sku, amount, daysAgo(ageDays));
}

const row = (id: string) => db.prepare(
  `SELECT eligibility, status, estimated_value_cents as value, eligibility_reasons as reasons, detail
   FROM recovery_discrepancies WHERE discrepancy_type = 'replacement_no_return' AND ref_key = ?`
).get(`repl-${id}`) as { eligibility: string; status: string; value: number; reasons: string; detail: string } | undefined;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);

  addReplacement('R-WAIT', 20, 'sku-wait', { reason: 3 });
  addReplacement('R-ELIG', 75, 'sku-elig', { reason: 3, cogs: 4200 });
  addReplacement('R-OLD', 200, 'sku-old', { reason: 2 });
  addReplacement('R-PAID', 80, 'sku-paid', { reason: 1 });
  addReimbursement('9000000001', 'sku-paid', 60);
  // two replacements of one SKU, only ONE reimbursement
  addReplacement('R-TWIN-A', 100, 'sku-twin', { reason: 0 });
  addReplacement('R-TWIN-B', 90, 'sku-twin', { reason: 0 });
  addReimbursement('9000000002', 'sku-twin', 85);
  // original came back sellable
  addReplacement('R-BACK', 70, 'sku-back', { reason: 2 });
  db.prepare(`INSERT INTO refunds (order_id, asin, sku, refund_date, refund_amount, fee_clawback, reason, item_returned, quantity, marketplace, created_at)
              VALUES ('ORIG-R-BACK', '', 'sku-back', ?, 5000, 0, 'DEFECTIVE', 1, 1, 'amazon', ?)`).run(daysAgo(60), daysAgo(60));
  // never candidates
  addReplacement('R-PENDING', 75, 'sku-pend', { status: 'Pending' });
  addReplacement('R-MFN', 75, 'sku-mfn', { channel: 'MFN' });
  addReplacement('R-NOTFLAGGED', 75, 'sku-plain', { flagged: false });
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('classifies by the 60–120 day window and values the claim at the unit cost', async () => {
  const { syncRecoveryDiscrepancies } = await import('../src/lib/recovery/discrepancies');
  const result = syncRecoveryDiscrepancies();

  assert.equal(row('R-WAIT')?.eligibility, 'waiting');
  assert.equal(row('R-WAIT')?.status, 'pending');
  assert.equal(row('R-ELIG')?.eligibility, 'eligible');
  assert.equal(row('R-ELIG')?.value, 4200);
  assert.deepEqual([row('R-OLD')?.eligibility, row('R-OLD')?.status], ['not_eligible', 'expired']);

  const detail = JSON.parse(row('R-ELIG')!.detail);
  assert.deepEqual(detail, { originalOrderId: 'ORIG-R-ELIG', reasonCode: 3, reasonLabel: 'Damaged in shipping', amazonFault: true });
  assert.match(row('R-ELIG')!.reasons, /carrier\/FC fault/);

  // R-ELIG and the uncovered twin are the only claimable ones
  assert.equal(result.replacementNoReturn.eligible, 2);
  assert.equal(result.replacementNoReturn.waiting, 1);
});

test('a reimbursement covers exactly one replacement, oldest first', () => {
  assert.equal(row('R-PAID')?.eligibility, 'not_eligible');
  assert.match(row('R-PAID')!.reasons, /already reimbursed/);
  assert.equal(row('R-TWIN-A')?.eligibility, 'not_eligible', 'the older twin takes the single reimbursement');
  assert.equal(row('R-TWIN-B')?.eligibility, 'eligible', 'the second twin is still owed');
});

test('a sellable return of the original, pending, MFN and unflagged orders are not claims', () => {
  assert.equal(row('R-BACK')?.eligibility, 'not_eligible');
  assert.match(row('R-BACK')!.reasons, /came back to Amazon sellable/);
  assert.equal(row('R-PENDING'), undefined);
  assert.equal(row('R-MFN'), undefined);
  assert.equal(row('R-NOTFLAGGED'), undefined);
});

test('re-scan is idempotent and a filed claim stays filed; a late reimbursement closes a pending one', async () => {
  const { syncRecoveryDiscrepancies } = await import('../src/lib/recovery/discrepancies');
  db.prepare(`UPDATE recovery_discrepancies SET status = 'filed' WHERE ref_key = 'repl-R-ELIG'`).run();
  addReimbursement('9000000003', 'sku-twin', 10); // Amazon finally pays the second twin

  const before = (db.prepare(`SELECT COUNT(*) c FROM recovery_discrepancies WHERE discrepancy_type = 'replacement_no_return'`).get() as { c: number }).c;
  syncRecoveryDiscrepancies();
  const after = (db.prepare(`SELECT COUNT(*) c FROM recovery_discrepancies WHERE discrepancy_type = 'replacement_no_return'`).get() as { c: number }).c;

  assert.equal(after, before);
  assert.equal(row('R-ELIG')?.status, 'filed');
  assert.deepEqual([row('R-TWIN-B')?.eligibility, row('R-TWIN-B')?.status], ['not_eligible', 'expired']);
});
