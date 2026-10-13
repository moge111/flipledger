/**
 * Free-replacement returns (Oct 11, 2026).
 *
 * When Amazon sends a free replacement instead of refunding, a unit can come
 * back to the FC SELLABLE with no refund attached (Topps NBA 111-3925624: the
 * buyer said it never arrived, got a replacement, and the original was
 * returned to inventory). FIFO only knew about returns through refunds, so the
 * unit's cost stayed charged on both orders, and the Recovery Hub offered a
 * claim for a replacement that cost nothing.
 *
 * Guards locked here:
 *  - every customer-returns report row is stored, refund or not (idempotent)
 *  - FIFO credits a no-refund SELLABLE return on a replacement pair
 *  - a damaged return keeps its COGS
 *  - an ordinary return whose refund hasn't synced yet keeps its COGS
 *  - the replacement detector sees the no-refund return and doesn't use up a
 *    reimbursement another replacement of the same SKU needs
 *  - a warehouse-damage reimbursement near a replacement gets its cost offset
 *    once a unit of that pair came back sellable (LEGO Porsche), and still
 *    none when nothing came back
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
let db: Database.Database;

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const NOW = new Date().toISOString();

function addOrder(id: string, sku: string, ageDays: number, opts: { replaces?: string; price?: number } = {}) {
  db.prepare(`INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, shipped_at, is_replacement, replaced_order_id, created_at)
              VALUES (?, ?, 'Shipped', 'amazon', 'FBA', ?, ?, ?, ?)`)
    .run(id, daysAgo(ageDays), daysAgo(ageDays), opts.replaces ? 1 : 0, opts.replaces ?? null, NOW);
  // replacement line items land via financial events with the SKU in the asin column
  db.prepare(`INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, cogs_per_unit)
              VALUES (?, ?, ?, 1, ?, ?, 0, 0)`)
    .run(id, opts.replaces ? sku : `B0${sku}`.slice(0, 10), sku, opts.price ?? 11000, opts.price ?? 11000);
}

function addLot(sku: string, qty: number, price: number) {
  db.prepare(`INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`B0${sku}`.slice(0, 10), sku, price, qty, qty, daysAgo(120).slice(0, 10), NOW);
}

const reportRow = (date: string, order: string, sku: string, disposition: string, reason: string, lpn = '') =>
  [date, order, sku, `B0${sku}`.slice(0, 10), 'X0TEST', 'Test product', '1', 'LGB7', disposition, reason, 'Unit returned to inventory', lpn, ''].join('\t');

const cogs = (order: string) =>
  (db.prepare('SELECT cogs_per_unit as c FROM order_items WHERE order_id = ?').get(order) as { c: number }).c;

before(async () => {
  golden = await buildGoldenDb(); // sets FLIPLEDGER_DB_PATH
  db = new Database(golden.dbPath);

  // NEVER_ARRIVED: original came back sellable, no refund, replacement kept
  addLot('sku-nba', 5, 4834);
  addOrder('ORIG-NBA', 'sku-nba', 30);
  addOrder('REPL-NBA', 'sku-nba', 20, { replaces: 'ORIG-NBA', price: 0 });

  // Viper: original refunded and came back damaged, replacement came back sellable
  addLot('sku-viper', 5, 2671);
  addOrder('ORIG-VIPER', 'sku-viper', 50);
  addOrder('REPL-VIPER', 'sku-viper', 40, { replaces: 'ORIG-VIPER', price: 0 });
  db.prepare(`INSERT INTO refunds (order_id, asin, sku, refund_date, refund_amount, fee_clawback, reason, item_returned, quantity, marketplace, created_at)
              VALUES ('ORIG-VIPER', '', 'sku-viper', ?, 5500, 0, 'CUSTOMER_RETURN', 0, 1, 'amazon', ?)`).run(daysAgo(30), NOW);

  // Ordinary order, returned sellable, refund not synced yet
  addLot('sku-plain', 5, 1500);
  addOrder('PLAIN-1', 'sku-plain', 10);

  // Two replacements of one SKU and one reimbursement: the pair that got a
  // unit back must leave the reimbursement for the other one.
  addLot('sku-twin', 5, 2000);
  addOrder('ORIG-TWIN-A', 'sku-twin', 100);
  addOrder('REPL-TWIN-A', 'sku-twin', 90, { replaces: 'ORIG-TWIN-A', price: 0 });
  addOrder('ORIG-TWIN-B', 'sku-twin', 95);
  addOrder('REPL-TWIN-B', 'sku-twin', 85, { replaces: 'ORIG-TWIN-B', price: 0 });
  db.prepare(`INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, marketplace, created_at)
              VALUES ('9100000001', ?, '', 'sku-twin', 'CustomerServiceIssue', 2000, 1, 'amazon', ?)`).run(daysAgo(80), NOW);

  // Warehouse damage near a replacement. sku-viper's pair got a unit back;
  // sku-dmg's pair did not.
  addLot('sku-dmg', 5, 3000);
  addOrder('ORIG-DMG', 'sku-dmg', 40);
  addOrder('REPL-DMG', 'sku-dmg', 30, { replaces: 'ORIG-DMG', price: 0 });
  const damage = db.prepare(`INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, marketplace, created_at)
              VALUES (?, ?, '', ?, 'Damaged_Warehouse', ?, 1, 'amazon', ?)`);
  damage.run('9200000001', daysAgo(20), 'sku-viper', 2145, NOW);
  damage.run('9200000002', daysAgo(20), 'sku-dmg', 2400, NOW);

  const header = 'return-date\torder-id\tsku\tasin\tfnsku\tproduct-name\tquantity\tfulfillment-center-id\tdetailed-disposition\treason\tstatus\tlicense-plate-number\tcustomer-comments';
  const tsv = [
    header,
    reportRow(daysAgo(15), 'ORIG-NBA', 'sku-nba', 'SELLABLE', 'NEVER_ARRIVED'),
    reportRow(daysAgo(29), 'ORIG-VIPER', 'sku-viper', 'CUSTOMER_DAMAGED', 'NOT_AS_DESCRIBED', 'LPN1'),
    reportRow(daysAgo(31), 'REPL-VIPER', 'sku-viper', 'SELLABLE', 'NOT_AS_DESCRIBED', 'LPN2'),
    reportRow(daysAgo(5), 'PLAIN-1', 'sku-plain', 'SELLABLE', 'UNWANTED_ITEM', 'LPN3'),
    reportRow(daysAgo(88), 'ORIG-TWIN-A', 'sku-twin', 'SELLABLE', 'DEFECTIVE', 'LPN4'),
  ].join('\n');

  const { parseCustomerReturnsReport, applyCustomerReturnRows } = await import('../src/lib/sp-api/customerReturns');
  const rows = parseCustomerReturnsReport(tsv);
  applyCustomerReturnRows(db, rows);
  applyCustomerReturnRows(db, rows); // re-sync must not duplicate

  const { recalculateFIFO } = await import('../src/lib/fifo');
  for (const sku of ['sku-nba', 'sku-viper', 'sku-plain', 'sku-twin']) {
    assert.deepEqual(recalculateFIFO({ sku }).errors, []);
  }
});

after(() => {
  db?.close();
  golden?.cleanup();
});

test('stores every report row once, refund or not, and still updates the matching refund', () => {
  const stored = db.prepare('SELECT COUNT(*) as n FROM fba_customer_returns').get() as { n: number };
  assert.equal(stored.n, 5);
  const refund = db.prepare(`SELECT reason, item_returned as r FROM refunds WHERE order_id = 'ORIG-VIPER'`).get() as { reason: string; r: number };
  assert.deepEqual(refund, { reason: 'NOT_AS_DESCRIBED', r: 0 });
});

test('a no-refund sellable return on a replacement pair puts the unit back', () => {
  assert.equal(cogs('ORIG-NBA'), 0);
  assert.equal(cogs('REPL-NBA'), 4834);
  const lot = db.prepare(`SELECT quantity_remaining as q FROM inventory_ledger WHERE sku = 'sku-nba'`).get() as { q: number };
  assert.equal(lot.q, 4, 'two units shipped, one came back');
});

test('the damaged original keeps its cost; the sellable replacement does not', () => {
  assert.equal(cogs('ORIG-VIPER'), 2671);
  assert.equal(cogs('REPL-VIPER'), 0);
});

test('an ordinary return whose refund has not synced yet keeps its cost', () => {
  assert.equal(cogs('PLAIN-1'), 1500);
});

test('the replacement detector sees the no-refund return and leaves the reimbursement for the other pair', async () => {
  const { syncRecoveryDiscrepancies } = await import('../src/lib/recovery/discrepancies');
  syncRecoveryDiscrepancies();
  const row = (id: string) => db.prepare(
    `SELECT eligibility, eligibility_reasons as reasons FROM recovery_discrepancies
     WHERE discrepancy_type = 'replacement_no_return' AND ref_key = ?`
  ).get(`repl-${id}`) as { eligibility: string; reasons: string };

  assert.equal(row('REPL-NBA').eligibility, 'not_eligible');
  assert.match(row('REPL-NBA').reasons, /came back to Amazon sellable/);
  assert.equal(row('REPL-VIPER').eligibility, 'not_eligible');
  assert.match(row('REPL-TWIN-A').reasons, /came back to Amazon sellable/);
  assert.match(row('REPL-TWIN-B').reasons, /already reimbursed/);
});

test('warehouse damage near a replacement is written off once a unit of the pair came back', async () => {
  const { rebuildLostInventoryOffsets } = await import('../src/lib/sp-api/lostInventoryOffsets');
  rebuildLostInventoryOffsets(db);
  const offset = (rid: string) => db.prepare(
    `SELECT amount FROM expenses WHERE description LIKE ?`
  ).get(`[auto] reimbursement ${rid}%`) as { amount: number } | undefined;

  assert.equal(offset('9200000001')?.amount, 2671, 'Viper pair got a unit back: the damaged unit is a real loss');
  assert.equal(offset('9200000002'), undefined, 'nothing came back: the replacement still carries the cost');
});
