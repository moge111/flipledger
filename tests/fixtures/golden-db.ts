/**
 * Golden fixture DB for accounting regression tests.
 *
 * Builds a small, fully hand-computed dataset in a temp SQLite file and points
 * FLIPLEDGER_DB_PATH at it, so the REAL P&L / Dashboard route handlers run
 * against controlled data. Every expected number in golden-pnl.test.ts is
 * derived by hand from this seed — if a query formula drifts (sign bugs,
 * fan-out joins, ghost refunds, clawback double-counts), the goldens break.
 *
 * Schema comes from the production initializeDatabase() (no duplication), plus
 * the schema-drift DDL that exists on the live DB via historical ALTERs but
 * not yet in initializeDatabase (order_items.cogs_per_unit /
 * promotional_rebate, live_inventory).
 *
 * The fixture deliberately exercises the historical bug patterns:
 *  - positive clawback fee row (sign convention: -SUM, not SUM(ABS))
 *  - cross-month order (purchase Jan, ShipmentEvent posts Feb → cash vs accrual)
 *  - settled Walmart refund (has WalmartRefundEvent) vs GHOST refund (none)
 *  - service fee with no order_id, marketplace-scoped via financial_events
 *  - business-wide expense (All-Marketplaces view only)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface GoldenDb {
  dbPath: string;
  cleanup: () => void;
}

export async function buildGoldenDb(): Promise<GoldenDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-golden-'));
  const dbPath = path.join(dir, 'golden.db');
  process.env.FLIPLEDGER_DB_PATH = dbPath;

  // Import AFTER setting the env var — db.ts opens its Database at module load.
  const { initializeDatabase } = await import('../../src/lib/db');
  initializeDatabase();

  const db = new Database(dbPath);
  applySchemaDrift(db);
  seed(db);
  db.close();

  return {
    dbPath,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, best-effort */ }
    },
  };
}

/** Columns/tables present on the live DB (manual ALTERs) but not in initializeDatabase(). */
function applySchemaDrift(db: Database.Database) {
  const orderItemCols = (db.prepare(`PRAGMA table_info(order_items)`).all() as { name: string }[]).map(c => c.name);
  if (!orderItemCols.includes('promotional_rebate')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN promotional_rebate INTEGER DEFAULT 0`);
  }
  if (!orderItemCols.includes('cogs_per_unit')) {
    db.exec(`ALTER TABLE order_items ADD COLUMN cogs_per_unit INTEGER DEFAULT 0`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      fulfillable_qty INTEGER NOT NULL DEFAULT 0,
      inbound_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0,
      unfulfillable_qty INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER GENERATED ALWAYS AS (fulfillable_qty + inbound_qty + reserved_qty + unfulfillable_qty) STORED,
      product_name TEXT,
      last_updated TEXT NOT NULL,
      inbound_working INTEGER DEFAULT 0,
      inbound_shipped INTEGER DEFAULT 0,
      inbound_receiving INTEGER DEFAULT 0,
      reserved_customer_order INTEGER DEFAULT 0,
      reserved_fc_transfer INTEGER DEFAULT 0,
      reserved_fc_processing INTEGER DEFAULT 0,
      list_price INTEGER DEFAULT 0,
      walmart_item_id TEXT,
      UNIQUE(asin, sku, marketplace)
    );
  `);
}

function seed(db: Database.Database) {
  const NOW = '2026-03-01T00:00:00Z';

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, created_at)
    VALUES (?, ?, 'Shipped', ?, ?, '${NOW}')
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, promotional_rebate, cogs_per_unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '${NOW}')
  `);
  const insertFee = db.prepare(`
    INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRefund = db.prepare(`
    INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${NOW}')
  `);

  // ───── Amazon order A1 — FBA, posts Jan 7 ─────
  // 2 units × $25.00 = $50.00 revenue, COGS $10.00/unit.
  // Fees: Commission −$7.50, FBA fulfillment −$6.00, plus a POSITIVE +$3.75
  // clawback (posted with the Feb refund, but order-fee queries key fees to the
  // ORDER's posted date, so it nets into January: fees = 750+600−375 = $9.75).
  insertOrder.run('GOLD-AMZ-A1', '2026-01-05T10:00:00Z', 'amazon', 'FBA');
  insertItem.run('GOLD-AMZ-A1', 'B0GOLD0001', 'amz-gold1-10', 2, 2500, 5000, 0, 0, 1000);
  const a1Ship = insertEvent.run('ShipmentEvent', '2026-01-07T08:00:00Z', 'GOLD-AMZ-A1', 'B0GOLD0001', 'amz-gold1-10', 'amazon', 5000, null).lastInsertRowid;
  insertFee.run(a1Ship, 'GOLD-AMZ-A1', 'B0GOLD0001', 'Commission', 'Selling Fees', -750, '2026-01-07T08:00:00Z');
  insertFee.run(a1Ship, 'GOLD-AMZ-A1', 'B0GOLD0001', 'FBAPerUnitFulfillmentFee', 'FBA Fees', -600, '2026-01-07T08:00:00Z');
  // Refund of 1 unit on Feb 3 (+ referral-fee clawback as a positive Commission line)
  const a1Refund = insertEvent.run('RefundEvent', '2026-02-03T12:00:00Z', 'GOLD-AMZ-A1', 'B0GOLD0001', 'amz-gold1-10', 'amazon', -2500, null).lastInsertRowid;
  insertFee.run(a1Refund, 'GOLD-AMZ-A1', 'B0GOLD0001', 'Commission', 'Selling Fees', 375, '2026-02-03T12:00:00Z');
  insertRefund.run('GOLD-AMZ-A1', '2026-02-03T12:00:00Z', 'B0GOLD0001', 'amz-gold1-10', 1, 2500, 'UNWANTED_ITEM', 1, 375, 'amazon');

  // ───── Amazon order A2 — MFN, purchased Jan 20, ShipmentEvent posts Feb 2 ─────
  // Cross-month: cash basis puts it in Feb, accrual in Jan.
  // $80.00 revenue + $5.00 MFN shipping credit (income), $8.42 out-of-pocket ship.
  insertOrder.run('GOLD-AMZ-A2', '2026-01-20T15:00:00Z', 'amazon', 'MFN');
  insertItem.run('GOLD-AMZ-A2', 'B0GOLD0002', 'amz-gold2-30', 1, 8000, 8000, 500, 842, 3000);
  const a2Ship = insertEvent.run('ShipmentEvent', '2026-02-02T09:00:00Z', 'GOLD-AMZ-A2', 'B0GOLD0002', 'amz-gold2-30', 'amazon', 8500, null).lastInsertRowid;
  insertFee.run(a2Ship, 'GOLD-AMZ-A2', 'B0GOLD0002', 'Commission', 'Selling Fees', -1200, '2026-02-02T09:00:00Z');

  // ───── Walmart order W1 — WFS, posts Jan 12, refund SETTLES in recon Feb 5 ─────
  insertOrder.run('GOLD-WMT-W1', '2026-01-10T11:00:00Z', 'walmart', 'WFS');
  insertItem.run('GOLD-WMT-W1', '100001', 'wm-gold3-99', 1, 14000, 14000, 0, 0, 9900);
  const w1Ship = insertEvent.run('ShipmentEvent', '2026-01-12T07:00:00Z', 'GOLD-WMT-W1', '100001', 'wm-gold3-99', 'walmart', 14000, null).lastInsertRowid;
  insertFee.run(w1Ship, 'GOLD-WMT-W1', '100001', 'WalmartReferralFee', 'Referral Fees', -1120, '2026-01-12T07:00:00Z');
  insertFee.run(w1Ship, 'GOLD-WMT-W1', '100001', 'WFSFulfillmentFee', 'WFS Fees', -345, '2026-01-12T07:00:00Z');
  // Partial refund $70.00, WITH a WalmartRefundEvent (Product Price) → counted in P&L
  insertRefund.run('GOLD-WMT-W1', '2026-02-05T10:00:00Z', '100001', 'wm-gold3-99', 1, 7000, 'DAMAGED', 1, 0, 'walmart');
  insertEvent.run('WalmartRefundEvent', '2026-02-05T10:00:00Z', 'GOLD-WMT-W1', '100001', 'wm-gold3-99', 'walmart', -7000, JSON.stringify({ 'Amount Type': 'Product Price' }));

  // ───── Walmart order W2 — WFS, posts Jan 20, GHOST refund (never settled) ─────
  // The Feb 10 refund has NO WalmartRefundEvent → must be EXCLUDED from P&L and
  // Dashboard refund totals (the ghost-refund gate).
  insertOrder.run('GOLD-WMT-W2', '2026-01-18T09:00:00Z', 'walmart', 'WFS');
  insertItem.run('GOLD-WMT-W2', '100002', 'wm-gold4-15', 2, 2000, 4000, 0, 0, 750);
  const w2Ship = insertEvent.run('ShipmentEvent', '2026-01-20T14:00:00Z', 'GOLD-WMT-W2', '100002', 'wm-gold4-15', 'walmart', 4000, null).lastInsertRowid;
  insertFee.run(w2Ship, 'GOLD-WMT-W2', '100002', 'WalmartReferralFee', 'Referral Fees', -300, '2026-01-20T14:00:00Z');
  insertRefund.run('GOLD-WMT-W2', '2026-02-10T16:00:00Z', '100002', 'wm-gold4-15', 2, 4000, 'NO_LONGER_WANTED', 0, 0, 'walmart');

  // ───── Amazon service fee — Subscription $39.99, no order_id, posts Jan 15 ─────
  const svcEvent = insertEvent.run('ServiceFeeEvent', '2026-01-15T00:00:00Z', null, null, null, 'amazon', -3999, null).lastInsertRowid;
  insertFee.run(svcEvent, null, null, 'Subscription', 'Other Fees', -3999, '2026-01-15T00:00:00Z');

  // ───── Walmart-funded incentive reimbursement, Jan 25 ─────
  db.prepare(`
    INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, marketplace, created_at)
    VALUES ('WMT-FUNDED-GOLD-1', '2026-01-25T10:00:00Z', '100001', 'wm-gold3-99', 'Walmart Funded Incentive', 1700, 1, 'walmart', '${NOW}')
  `).run();

  // ───── Business-wide expense (Insurance $100.00, Jan 31) — All-Marketplaces view only ─────
  db.prepare(`
    INSERT INTO expenses (date, category, amount, description, created_at)
    VALUES ('2026-01-31', 'Insurance', 10000, 'Golden fixture insurance', '${NOW}')
  `).run();

  // ───── Inventory (dashboard inventory-value card): 5 fulfillable × $10.00 ─────
  db.prepare(`
    INSERT INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, product_name, last_updated)
    VALUES ('B0GOLD0001', 'amz-gold1-10', 'amazon', 5, 2, 'Golden Widget', '${NOW}')
  `).run();
  db.prepare(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, date_purchased, created_at)
    VALUES ('B0GOLD0001', 'amz-gold1-10', 1000, 10, 8, '2026-01-02', '${NOW}')
  `).run();

  // Products (name resolution paths)
  const insertProduct = db.prepare(`
    INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at) VALUES (?, ?, ?, ?, '${NOW}', '${NOW}')
  `);
  insertProduct.run('B0GOLD0001', 'amz-gold1-10', 'Golden Widget', 'amazon');
  insertProduct.run('B0GOLD0002', 'amz-gold2-30', 'Golden Headphones', 'amazon');
  insertProduct.run('100001', 'wm-gold3-99', 'Golden Fitness Tracker', 'walmart');
  insertProduct.run('100002', 'wm-gold4-15', 'Golden Board Game', 'walmart');
}
