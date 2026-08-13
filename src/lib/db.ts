import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

// FLIPLEDGER_DB_PATH is set by the test suite to point at a fixture DB.
const DB_PATH = process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');

// Ensure the data dir exists before opening the DB. A fresh clone has no data/.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Create tables if they don't exist
export function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      records_fetched INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      name TEXT,
      category TEXT,
      image_url TEXT,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      purchase_date TEXT NOT NULL,
      status TEXT NOT NULL,
      marketplace TEXT DEFAULT 'amazon',
      fulfillment_channel TEXT NOT NULL,
      is_estimated INTEGER DEFAULT 1,
      shipped_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_shipped_at ON orders(shipped_at);

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      price_per_unit INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      shipping_charged INTEGER DEFAULT 0,
      shipping_cost INTEGER DEFAULT 0
    );
    -- Load-bearing: the Walmart order sync upserts via ON CONFLICT(order_id, asin, sku).
    -- The live DB has this from a manual migration; fresh installs need it here.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique ON order_items(order_id, asin, sku);

    CREATE TABLE IF NOT EXISTS financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      marketplace TEXT DEFAULT 'amazon',
      total_amount INTEGER NOT NULL,
      raw_data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fee_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      asin TEXT,
      fee_type TEXT NOT NULL,
      fee_category TEXT,
      amount INTEGER NOT NULL,
      posted_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      supplier_id INTEGER,
      date_purchased TEXT NOT NULL,
      notes TEXT,
      -- Set to 1 for SKUs with deliberately $0 cost basis (e.g. self-pulled
      -- trading cards, gifts). Suppresses the "MISSING COGS" warning on
      -- the Products page while preserving $0 COGS in FIFO / P&L.
      intentional_zero_cogs INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER DEFAULT 1,
      refund_amount INTEGER NOT NULL,
      reason TEXT,
      item_returned INTEGER DEFAULT 0,
      fee_clawback INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    -- Cross-period COGS reversals, managed entirely by the FIFO engine.
    -- When an item sells in one year and is returned (item_returned=1, full
    -- qty, Walmart settlement-gated) in a LATER year, the sale keeps its
    -- original COGS (protects the filed year) and the relief is booked here,
    -- dated at the refund. P&L/Dashboard/Cashflow/Tax subtract these in the
    -- refund's period. Same-year returns keep the zero-at-sale behavior and
    -- never appear here.
    CREATE TABLE IF NOT EXISTS cogs_reversals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL UNIQUE,
      order_id TEXT NOT NULL,
      sku TEXT,
      asin TEXT,
      quantity INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      refund_date TEXT NOT NULL,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cogs_reversals_date ON cogs_reversals(refund_date);

    CREATE TABLE IF NOT EXISTS reimbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_id TEXT,
      reimbursement_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      reason TEXT,
      amount INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      status TEXT DEFAULT 'Approved',
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS removals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      removal_order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      removal_type TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'Pending',
      date_requested TEXT NOT NULL,
      date_completed TEXT,
      fee INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      date_shipped TEXT NOT NULL,
      carrier TEXT,
      tracking TEXT,
      boxes INTEGER DEFAULT 1,
      weight REAL,
      cost INTEGER NOT NULL,
      total_units INTEGER NOT NULL,
      status TEXT DEFAULT 'In Transit',
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_shipment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      recurring TEXT DEFAULT 'one-time',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      active INTEGER DEFAULT 1,
      start_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS other_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      income_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_tax (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      state TEXT NOT NULL,
      tax_collected INTEGER NOT NULL,
      marketplace_facilitator_tax INTEGER DEFAULT 0,
      posted_date TEXT NOT NULL,
      marketplace TEXT DEFAULT 'amazon'
    );

    -- Amazon reimbursement re-evaluation candidates. For each reimbursement
    -- Amazon already paid, we compare the paid amount to (avg sale price ×
    -- qty). When Amazon paid significantly less, the seller can file a
    -- "Submit a reimbursement claim dispute" case to ask Amazon to
    -- re-evaluate. This is the dispute path that requires a reimbursement_id.
    CREATE TABLE IF NOT EXISTS amazon_reimbursement_reevaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_id TEXT NOT NULL,
      reimbursement_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      quantity INTEGER NOT NULL,
      paid_cents INTEGER NOT NULL,
      expected_cents INTEGER NOT NULL,
      gap_cents INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_reeval_unique
      ON amazon_reimbursement_reevaluations(reimbursement_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_reeval_status
      ON amazon_reimbursement_reevaluations(status);

    -- Amazon dispute candidates (SAFE-T claims). Same pattern as Walmart's
    -- table — computed from refunds + reimbursements, no extra API call.
    -- Surfaces customer refunds where the seller can dispute via SAFE-T
    -- (e.g., customer returned wrong item, claimed never-arrived despite
    -- delivery confirmation). 90-day filing window from refund date.
    CREATE TABLE IF NOT EXISTS amazon_dispute_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      return_reason TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      refund_amount_cents INTEGER NOT NULL,
      fulfillment_channel TEXT,
      eligibility TEXT NOT NULL,
      eligibility_reasons TEXT,
      dispute_window_until TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_dispute_unique
      ON amazon_dispute_candidates(refund_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_dispute_status
      ON amazon_dispute_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_amazon_dispute_window
      ON amazon_dispute_candidates(dispute_window_until);

    -- Walmart dispute candidates. Computed from the refunds table, NOT
    -- from a separate API report. For each Walmart refund, we determine
    -- whether the seller can dispute Walmart's auto-refund decision
    -- (typically only for WFS-fulfilled orders within 30 days of refund).
    CREATE TABLE IF NOT EXISTS walmart_dispute_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      return_reason TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      refund_amount_cents INTEGER NOT NULL,
      fulfillment_channel TEXT,                  -- WFS, Seller, or null
      eligibility TEXT NOT NULL,                 -- eligible | maybe | not_eligible
      eligibility_reasons TEXT,                  -- JSON array of tag strings
      dispute_window_until TEXT,                 -- refund_date + 30 days
      status TEXT NOT NULL DEFAULT 'pending',    -- pending | filed | received | dismissed | expired
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_walmart_dispute_unique
      ON walmart_dispute_candidates(refund_id);
    CREATE INDEX IF NOT EXISTS idx_walmart_dispute_status
      ON walmart_dispute_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_walmart_dispute_window
      ON walmart_dispute_candidates(dispute_window_until);

    -- Reimbursement candidates from the FBA Inventory Adjustments report.
    -- Each row is a negative-quantity adjustment (lost/damaged/missing in
    -- warehouse) that hasn't been reimbursed yet. Surfaces dollars Amazon
    -- owes us that we can file claims for in Seller Central.
    CREATE TABLE IF NOT EXISTS reimbursement_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      fnsku TEXT,
      product_name TEXT,
      fulfillment_center_id TEXT,
      reason TEXT NOT NULL,
      disposition TEXT,
      quantity INTEGER NOT NULL,            -- negative = loss, positive = found
      estimated_value_cents INTEGER,        -- abs(quantity) × buy_price (best estimate)
      eligible_until TEXT,                  -- 60 days from adjustment_date (Amazon's claim window)
      status TEXT NOT NULL DEFAULT 'pending', -- pending, matched, filed, received, expired, dismissed
      matched_reimbursement_id INTEGER,     -- FK to reimbursements.id when we detect a match
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reimbursement_candidates_unique
      ON reimbursement_candidates(adjustment_date, COALESCE(fnsku,''), COALESCE(asin,''), reason, quantity);
    CREATE INDEX IF NOT EXISTS idx_reimbursement_candidates_status
      ON reimbursement_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_reimbursement_candidates_eligible
      ON reimbursement_candidates(eligible_until);

    -- Recovery Hub discrepancy candidates. New detector types that don't
    -- fit the four existing recovery tables:
    --   'refund_no_return'  — FBA refund issued, customer never sent the
    --     item back (no FBA customer-returns report row after 45+ days),
    --     and Amazon never reimbursed. Claimable days 45-105 after refund
    --     per Amazon's FBA reimbursement policy.
    --   'fee_overcharge'    — per-unit FBA fulfillment fee for an ASIN
    --     jumped vs its own baseline (likely cubiscan remeasurement).
    --     Recoverable via a remeasurement request + fee reimbursement case.
    -- One table for all new detector types; ref_key is unique per type.
    CREATE TABLE IF NOT EXISTS recovery_discrepancies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discrepancy_type TEXT NOT NULL,
      ref_key TEXT NOT NULL,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      event_date TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      estimated_value_cents INTEGER NOT NULL,
      eligibility TEXT NOT NULL,                 -- eligible | waiting | not_eligible
      eligibility_reasons TEXT,                  -- JSON array of tag strings
      eligible_from TEXT,                        -- claims accepted starting this date
      window_until TEXT,                         -- claim window closes this date
      detail TEXT,                               -- JSON evidence blob per type
      status TEXT NOT NULL DEFAULT 'pending',    -- pending | filed | received | dismissed | expired
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_discrepancies_unique
      ON recovery_discrepancies(discrepancy_type, ref_key);
    CREATE INDEX IF NOT EXISTS idx_recovery_discrepancies_status
      ON recovery_discrepancies(status);
    CREATE INDEX IF NOT EXISTS idx_recovery_discrepancies_window
      ON recovery_discrepancies(window_until);

    -- Best-Sellers-Rank snapshots from Catalog API. One row per
    -- (asin, captured_date) — daily granularity is enough.
    CREATE TABLE IF NOT EXISTS reserve_balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      posted_date TEXT NOT NULL,
      current_reserve_cents INTEGER NOT NULL DEFAULT 0,
      previous_reserve_cents INTEGER NOT NULL DEFAULT 0,
      settlement_id TEXT,
      raw_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_balance_unique
      ON reserve_balance_history(marketplace, posted_date, current_reserve_cents);
    CREATE INDEX IF NOT EXISTS idx_reserve_balance_date
      ON reserve_balance_history(posted_date);

    -- Settlement headers from the V2 settlement report. One row per Amazon
    -- disbursement: the authoritative period + payout total ("what hit the
    -- bank"). Populated from the settlement summary row (blank order-id, a
    -- populated total-amount). The per-settlement reconciliation view
    -- attributes order revenue/fees/COGS to each settlement by its date window.
    CREATE TABLE IF NOT EXISTS settlements (
      settlement_id TEXT PRIMARY KEY,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      start_date TEXT,
      end_date TEXT,
      deposit_date TEXT,
      total_amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_deposit ON settlements(deposit_date);
    CREATE INDEX IF NOT EXISTS idx_settlements_end ON settlements(end_date);

    -- Per-transaction state from SP-API Finances v2024-06-19. Critical for
    -- DD7 (Delivery Date Policy) cash-flow timing. transaction_status =
    -- DEFERRED → funds held until maturity_date. RELEASED → already
    -- available (and on Express Payments, already disbursed).
    -- DEFERRED_RELEASED → was held, now released.
    CREATE TABLE IF NOT EXISTS finances_transactions_v2 (
      transaction_id TEXT PRIMARY KEY,
      transaction_type TEXT NOT NULL,
      transaction_status TEXT NOT NULL,
      deferral_reason TEXT,
      posted_date TEXT NOT NULL,
      maturity_date TEXT,
      total_amount_cents INTEGER NOT NULL DEFAULT 0,
      marketplace_id TEXT,
      order_id TEXT,
      shipment_id TEXT,
      settlement_id TEXT,
      financial_event_group_id TEXT,
      description TEXT,
      raw_data TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ftv2_order_id ON finances_transactions_v2(order_id);
    CREATE INDEX IF NOT EXISTS idx_ftv2_status_maturity ON finances_transactions_v2(transaction_status, maturity_date);
    CREATE INDEX IF NOT EXISTS idx_ftv2_posted_date ON finances_transactions_v2(posted_date);

    CREATE TABLE IF NOT EXISTS sales_rank_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      category TEXT,
      rank INTEGER,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      captured_date TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_rank_unique ON sales_rank_history(asin, marketplace, captured_date);
    CREATE INDEX IF NOT EXISTS idx_sales_rank_asin ON sales_rank_history(asin);
    CREATE INDEX IF NOT EXISTS idx_sales_rank_captured ON sales_rank_history(captured_date);

    CREATE INDEX IF NOT EXISTS idx_orders_purchase_date ON orders(purchase_date);
    CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(fulfillment_channel);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_asin ON order_items(asin);
    CREATE INDEX IF NOT EXISTS idx_financial_events_posted ON financial_events(posted_date);
    CREATE INDEX IF NOT EXISTS idx_financial_events_order ON financial_events(order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_events_unique ON financial_events(
      event_type, COALESCE(order_id,''), COALESCE(asin,''), COALESCE(sku,''), posted_date, total_amount
    );
    CREATE INDEX IF NOT EXISTS idx_fee_details_event ON fee_details(financial_event_id);
    CREATE INDEX IF NOT EXISTS idx_fee_details_order ON fee_details(order_id);
    CREATE INDEX IF NOT EXISTS idx_fee_details_type ON fee_details(fee_type);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_asin ON inventory_ledger(asin);
    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
    CREATE INDEX IF NOT EXISTS idx_reimbursements_date ON reimbursements(reimbursement_date);
    CREATE INDEX IF NOT EXISTS idx_removals_date ON removals(date_requested);
    CREATE INDEX IF NOT EXISTS idx_sales_tax_date ON sales_tax(posted_date);
    CREATE INDEX IF NOT EXISTS idx_sales_tax_state ON sales_tax(state);
    CREATE INDEX IF NOT EXISTS idx_products_asin ON products(asin);

    -- Listing tool: user-created batches (separate from synced inbound_shipments)
    CREATE TABLE IF NOT EXISTS listing_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      channel TEXT NOT NULL DEFAULT 'FBA',
      ship_from_name TEXT,
      ship_from_address_line1 TEXT,
      ship_from_city TEXT,
      ship_from_state TEXT,
      ship_from_postal_code TEXT,
      ship_from_country_code TEXT DEFAULT 'US',
      ship_from_phone TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      inbound_plan_id TEXT,
      inbound_operation_id TEXT,
      plan_status TEXT,
      send_error TEXT,
      sent_at TEXT,
      -- Phase 3: Packing (what's in each box) ───────────────────────────
      packing_operation_id TEXT,
      packing_option_id TEXT,
      packing_group_id TEXT,
      packing_status TEXT,            -- IN_PROGRESS | SUCCESS | FAILED
      packing_confirmed_at TEXT,
      packing_error TEXT,
      -- Phase 3: Placement (which FCs get the boxes) ────────────────────
      placement_operation_id TEXT,
      placement_option_id TEXT,
      placement_status TEXT,          -- IN_PROGRESS | SUCCESS | FAILED
      placement_fee_cents INTEGER,    -- fee for the chosen placement option
      placement_confirmed_at TEXT,
      placement_error TEXT,
      -- Phase 4: Transportation (carrier booking) ────────────────────────
      transportation_status TEXT,             -- CONFIRMED | FAILED | (null = not yet booked)
      transportation_option_id TEXT,
      transportation_carrier TEXT,            -- e.g. "United States Postal Service"
      transportation_shipping_mode TEXT,      -- GROUND_SMALL_PARCEL | FREIGHT_LTL | etc.
      transportation_confirmed_at TEXT,
      transportation_cost_cents INTEGER,      -- summed Partnered quote at confirmation
      transportation_error TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      msku TEXT,
      product_name TEXT,
      image_url TEXT,
      condition TEXT NOT NULL DEFAULT 'NewItem',
      quantity INTEGER NOT NULL DEFAULT 1,
      list_price_cents INTEGER NOT NULL DEFAULT 0,
      buy_price_cents INTEGER NOT NULL DEFAULT 0,
      supplier TEXT,
      purchase_date TEXT,
      estimated_fee_cents INTEGER DEFAULT 0,
      estimated_ship_cents INTEGER DEFAULT 0,
      listing_status TEXT,
      listing_submission_id TEXT,
      listing_error TEXT,
      listing_updated_at TEXT,
      labels_printed_at TEXT,  -- when the user marks this SKU as physically labeled
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_items_batch ON listing_batch_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_listing_batches_status ON listing_batches(status);

    -- Phase 3: Boxes the seller has actually packed for an FBA batch.
    -- The user enters dimensions/weight here and assigns items to each box.
    -- This is what gets sent to setPackingInformation on the SP-API.
    -- packing_group_id: Amazon's pack group this box belongs to (Amazon may
    -- split a batch into multiple groups for bulky/oversize items, each
    -- group ships separately). Optional for single-group batches.
    CREATE TABLE IF NOT EXISTS listing_batch_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      box_index INTEGER NOT NULL,   -- 1-based display order within group
      length_in REAL,
      width_in REAL,
      height_in REAL,
      weight_lb REAL,
      packing_group_id TEXT,         -- Amazon's pack group ID (pgXXX)
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_boxes_batch ON listing_batch_boxes(batch_id);

    -- Pack groups Amazon assigns when generatePackingOptions runs. For diverse
    -- inventory (mix of bulky + standard), Amazon splits items into multiple
    -- groups, each group ships as its own shipment to potentially a different
    -- FC. The seller boxes each group separately.
    CREATE TABLE IF NOT EXISTS listing_batch_pack_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      packing_group_id TEXT NOT NULL,            -- Amazon's group identifier
      group_index INTEGER NOT NULL,              -- display order (0, 1, 2, ...)
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE,
      UNIQUE(batch_id, packing_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pack_groups_batch ON listing_batch_pack_groups(batch_id);

    -- Which batch items belong to which pack group, with quantities. Sourced
    -- from Amazon's listPackingGroupItems response.
    CREATE TABLE IF NOT EXISTS listing_batch_pack_group_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_group_id INTEGER NOT NULL,            -- FK to listing_batch_pack_groups.id
      item_id INTEGER NOT NULL,                  -- FK to listing_batch_items.id
      quantity INTEGER NOT NULL,
      FOREIGN KEY (pack_group_id) REFERENCES listing_batch_pack_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES listing_batch_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pack_group_items_group ON listing_batch_pack_group_items(pack_group_id);

    -- Phase 3: Which items are packed in which box. Many-to-many between
    -- listing_batch_items and listing_batch_boxes with a quantity field so
    -- an item's quantity can be split across multiple boxes if needed.
    CREATE TABLE IF NOT EXISTS listing_batch_box_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (box_id) REFERENCES listing_batch_boxes(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES listing_batch_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_box_items_box ON listing_batch_box_items(box_id);
    CREATE INDEX IF NOT EXISTS idx_listing_batch_box_items_item ON listing_batch_box_items(item_id);

    -- Fee estimates cache (Phase 1 listing tool): stores SP-API fees estimate results per ASIN.
    -- Scales linearly with price on lookup; TTL of 24h enforced in code.
    CREATE TABLE IF NOT EXISTS fee_estimates_cache (
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      list_price_cents INTEGER NOT NULL,
      fee_cents INTEGER NOT NULL,
      referral_fee_cents INTEGER DEFAULT 0,
      fba_fee_cents INTEGER DEFAULT 0,
      estimated_at TEXT NOT NULL,
      PRIMARY KEY (asin, marketplace)
    );

    -- Populated on demand by /api/sync/storage-fees and /api/sync/inbound-items,
    -- but created here too: the profitability route reads storage_fees_per_asin
    -- unconditionally, so a fresh install would otherwise fail with
    -- "no such table" before those syncs have ever run.
    CREATE TABLE IF NOT EXISTS storage_fees_per_asin (
      asin TEXT PRIMARY KEY,
      monthly_fee INTEGER NOT NULL,
      size_tier TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_cost_per_sku (
      sku TEXT NOT NULL,
      asin TEXT,
      shipment_id TEXT NOT NULL,
      inbound_cost_per_unit INTEGER NOT NULL,
      units INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (sku, shipment_id)
    );

    -- Live marketplace stock levels (Amazon FBA + Walmart WFS).
    -- Distinct from inventory_ledger, which tracks COGS lots: this is the
    -- current on-hand/inbound/reserved snapshot pulled from the marketplace
    -- APIs, and is what the Inventory pages and valuation read.
    -- total_qty is generated so callers never have to sum the buckets.
    CREATE TABLE IF NOT EXISTS live_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      fulfillable_qty INTEGER NOT NULL DEFAULT 0,
      inbound_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0,
      unfulfillable_qty INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER GENERATED ALWAYS AS (
        fulfillable_qty + inbound_qty + reserved_qty + unfulfillable_qty
      ) STORED,
      product_name TEXT,
      last_updated TEXT NOT NULL,
      -- Amazon breaks inbound/reserved into sub-stages; Walmart reports lumps
      -- only, so these stay 0 for WFS rows.
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

    CREATE INDEX IF NOT EXISTS idx_live_inventory_marketplace ON live_inventory(marketplace);
    CREATE INDEX IF NOT EXISTS idx_live_inventory_sku ON live_inventory(sku);

    -- MFN / merchant-fulfilled subsystem (ported from Huffdowg27 fork) --
    CREATE TABLE IF NOT EXISTS mfn_push_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pushed_at TEXT NOT NULL,
      sku TEXT NOT NULL,
      asin TEXT,
      il_id INTEGER,
      proposed_qty INTEGER,
      proposed_price_cents INTEGER,
      proposed_shipping_template TEXT,
      sp_api_status TEXT,
      sp_api_submission_id TEXT,
      sp_api_issues TEXT,
      error_message TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mfn_push_log_sku ON mfn_push_log(sku);
    CREATE INDEX IF NOT EXISTS idx_mfn_push_log_pushed_at ON mfn_push_log(pushed_at);

    CREATE TABLE IF NOT EXISTS merchant_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      status TEXT,
      quantity INTEGER,
      product_name TEXT,
      condition TEXT,
      list_price_cents INTEGER,
      last_synced TEXT NOT NULL,
      sync_report_id TEXT,
      UNIQUE(asin, sku, marketplace)
    );
    CREATE INDEX IF NOT EXISTS idx_merchant_listings_sku ON merchant_listings(sku);
    CREATE INDEX IF NOT EXISTS idx_merchant_listings_status ON merchant_listings(status);
  `);

  // MFN subsystem column migrations (idempotent — ignore duplicate-column errors)
  for (const stmt of [
    "ALTER TABLE inventory_ledger ADD COLUMN bin_location TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN condition TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN quantity_received INTEGER",
    "ALTER TABLE inventory_ledger ADD COLUMN received_at TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN inspected_at TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN receive_notes TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN list_price_cents INTEGER",
    "ALTER TABLE inventory_ledger ADD COLUMN merchant_shipping_group_name TEXT",
    "ALTER TABLE inventory_ledger ADD COLUMN batch_id INTEGER",
    "ALTER TABLE listing_batch_items ADD COLUMN listing_mode TEXT DEFAULT 'CREATE_NEW'",
    "ALTER TABLE listing_batch_items ADD COLUMN fnsku TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN fulfillment_channel TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN listing_source TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN amazon_inventory_status TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN inventory_ledger_id INTEGER",
    // Pre-flight validation (July 2026 hardening): checked at add time so
    // gating / catalog defects / FNSKU registration surface BEFORE send.
    "ALTER TABLE listing_batch_items ADD COLUMN inbound_ready INTEGER DEFAULT 0",
    "ALTER TABLE listing_batch_items ADD COLUMN prep_category TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN preflight_status TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN preflight_detail TEXT",
    "ALTER TABLE listing_batch_items ADD COLUMN preflight_checked_at TEXT",
    "ALTER TABLE listing_batches ADD COLUMN closed_at TEXT",
    "ALTER TABLE orders ADD COLUMN order_total INTEGER DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN order_total_currency TEXT",
    "ALTER TABLE products ADD COLUMN catalog_last_enriched TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN listing_id TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN fulfillment_channel TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN item_condition TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN item_name TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN open_date TEXT",
    "ALTER TABLE merchant_listings ADD COLUMN source_report_type TEXT",
    "CREATE INDEX IF NOT EXISTS idx_inventory_ledger_batch ON inventory_ledger(batch_id)",
  ]) {
    try { sqlite.exec(stmt); } catch { /* already applied */ }
  }
}
