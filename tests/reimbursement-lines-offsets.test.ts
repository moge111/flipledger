/**
 * Regression tests for Amazon reimbursement lines and lost-inventory offsets
 * (Sept 23 2026, review A3 + A10).
 *
 * A10: one reimbursement id can cover several SKUs. Stored by id alone, each
 * line overwrote the last and the placeholder sweep deleted the rest: $266.02
 * of Sep 6-7 income vanished.
 * A3: inventory lost before it sold needs its cost expensed; none of those
 * offsets had been booked since Jun 19.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';
import type { ReimbursementRow } from '../src/lib/sp-api/reimbursementsReport';

let golden: GoldenDb;
let db: Database.Database;
const NOW = '2026-09-10T00:00:00Z';

const row = (id: string, sku: string, cents: number, qty: number, extra: Partial<ReimbursementRow> = {}): ReimbursementRow => ({
  approvalDate: '2026-09-06T01:34:59+00:00', reimbursementId: id, caseId: null,
  amountPerUnitCents: cents / qty, amountTotalCents: cents, quantityReimbursedCash: qty, quantityReimbursedInventory: 0,
  quantityReimbursedTotal: qty, originalReimbursementId: null, originalReimbursementType: null, amazonOrderId: null,
  asin: `B-${sku}`, fnsku: null, sku, productName: null, condition: null, currencyUnit: 'USD', reason: 'Lost_Inbound', ...extra,
});

const reimb = () => db.prepare(`SELECT reimbursement_id id, amount FROM reimbursements WHERE marketplace = 'amazon' ORDER BY reimbursement_id`).all() as { id: string; amount: number }[];

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  db.exec(`
    DELETE FROM reimbursements WHERE marketplace = 'amazon';
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at) VALUES
      ('B-mtg', 'mtg', 6000, 1, 1, '2026-08-01', '${NOW}'),
      ('B-spidey', 'spidey', 3999, 5, 5, '2026-08-01', '${NOW}'),
      ('B-razer', 'razer', 3599, 3, 3, '2026-08-01', '${NOW}'),
      ('B-found', 'found', 2000, 2, 2, '2026-08-01', '${NOW}'),
      ('B-porsche', 'porsche', 9900, 1, 1, '2026-08-01', '${NOW}'),
      ('B-manual', 'manual', 1000, 1, 1, '2026-08-01', '${NOW}');
    -- the bare row the old code left behind (last line only), and the settlement placeholders
    INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
      VALUES ('900001', '2026-09-06T01:34:59+00:00', 'B-mtg', 'mtg', 'Lost_Inbound', 1583, 1, 'Approved', 'amazon', '${NOW}'),
             ('SETTLEMENT-MISSING_FROM_INBOUND-2026-09-06-4048', '2026-09-06', NULL, NULL, 'MISSING_FROM_INBOUND', 4048, 1, 'Approved', 'amazon', '${NOW}'),
             ('SETTLEMENT-MISSING_FROM_INBOUND-2026-09-06-1800', '2026-09-06', NULL, NULL, 'MISSING_FROM_INBOUND', 1800, 1, 'Approved', 'amazon', '${NOW}');
    -- a replacement shipped for the porsche 17 days before its reimbursement
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_replacement, created_at)
      VALUES ('REPL-1', '2026-08-08T15:59:07Z', 'Shipped', 'amazon', 'FBA', 1, '${NOW}');
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
      VALUES ('REPL-1', 'porsche', 'porsche', 1, 0, 0, 0, 0, 0, 9900);
    INSERT INTO expenses (date, category, amount, description, recurring, created_at)
      VALUES ('2026-09-01', 'Lost Inventory (Amazon)', 1000, 'Cost of lost unit — reimb 900050 Lost_Warehouse', 'one-time', '${NOW}');
  `);
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('A10: every line of a multi-line reimbursement is kept, and the old bare row is replaced', async () => {
  const { storeReimbursementRows } = await import('../src/lib/sp-api/reimbursementsReport');
  const lines = [row('900001', 'spidey', 4048, 2), row('900001', 'razer', 1800, 1), row('900001', 'mtg', 1583, 1)];
  storeReimbursementRows(db, lines);
  storeReimbursementRows(db, [...lines].reverse()); // report order must not matter
  assert.deepEqual(reimb(), [
    { id: '900001:mtg', amount: 1583 },
    { id: '900001:razer', amount: 1800 },
    { id: '900001:spidey', amount: 4048 },
  ], 'three line rows, no bare row, placeholders swept because each line is now stored');
});

test('A3: pre-order losses get a cost offset; reversed, replaced, post-order and manual ones do not', async () => {
  const { storeReimbursementRows } = await import('../src/lib/sp-api/reimbursementsReport');
  storeReimbursementRows(db, [
    row('900002', 'found', 4000, 2, { approvalDate: '2026-09-02T00:00:00Z' }),
    row('900003', 'found', -2000, -1, { approvalDate: '2026-09-09T00:00:00Z', reason: 'Reimbursement_Reversal', originalReimbursementId: '900002' }),
    row('900004', 'porsche', 7425, 1, { approvalDate: '2026-08-25T08:53:23+00:00', reason: 'Damaged_Warehouse' }),
    row('900005', 'spidey', 3000, 1, { approvalDate: '2026-09-03T00:00:00Z', amazonOrderId: '111-0000000-0000000' }),
    row('900050', 'manual', 1000, 1, { approvalDate: '2026-09-01T00:00:00Z', reason: 'Lost_Warehouse' }),
  ]);
  const { rebuildLostInventoryOffsets } = await import('../src/lib/sp-api/lostInventoryOffsets');
  const r = rebuildLostInventoryOffsets(db);
  const again = rebuildLostInventoryOffsets(db);
  assert.deepEqual(again, r, 'rebuild is idempotent');
  const offsets = (db.prepare(`SELECT amount, description FROM expenses WHERE description LIKE '[auto]%' ORDER BY description`).all() as { amount: number; description: string }[])
    .map(o => `${o.description.split(' ')[2]} ${o.amount}`);
  assert.deepEqual(offsets, [
    '900001:mtg 6000',
    '900001:razer 3599',
    '900001:spidey 7998',
    '900002 2000',        // 2 lost, 1 found again by the reversal → 1 × $20
  ]);
});

test('units recorded as arrived after all get no cost offset', async () => {
  db.prepare(`INSERT INTO lost_inventory_arrived (reimbursement_id, units, note, created_at) VALUES ('900001:spidey', 1, 'sent in the next shipment', '${NOW}')`).run();
  const { rebuildLostInventoryOffsets } = await import('../src/lib/sp-api/lostInventoryOffsets');
  rebuildLostInventoryOffsets(db);
  const spidey = db.prepare(`SELECT amount FROM expenses WHERE description LIKE '[auto] reimbursement 900001:spidey %'`).get() as { amount: number };
  assert.equal(spidey.amount, 3999, '2 lost, 1 arrived → 1 × $39.99');
  db.prepare(`UPDATE lost_inventory_arrived SET units = 2 WHERE reimbursement_id = '900001:spidey'`).run();
  rebuildLostInventoryOffsets(db);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM expenses WHERE description LIKE '[auto] reimbursement 900001:spidey %'`).get() as { n: number }).n, 0);
});
