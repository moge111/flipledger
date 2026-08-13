/**
 * Live-DB invariant checks — read-only assertions against data/flipledger.db.
 *
 * These encode the data-hygiene rules from CLAUDE.md that past silent-drift
 * bugs violated (orphan events, dedup-index drops, rolling-date service-fee
 * duplication, ghost refunds, phantom estimator fees). They run against the
 * REAL database, so a regression in any sync/dedup path shows up on the next
 * `npm test` instead of weeks later as a drifting P&L.
 *
 * All queries are read-only. The whole file skips when the live DB is absent
 * (fresh clone / CI). If a check fails right after a sync started, re-run once
 * the sync completes — a few checks can see transient mid-sync state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');
const dbExists = fs.existsSync(DB_PATH);
const db = dbExists ? new Database(DB_PATH, { readonly: true }) : null;

function count(sql: string): number {
  return (db!.prepare(sql).get() as { n: number }).n;
}

test('live DB present', { skip: !dbExists && 'no live DB (fresh clone/CI) — skipping live invariants' }, () => {
  assert.ok(db);
});

test('no orphan fee_details (parent financial_event must exist)', { skip: !dbExists }, () => {
  // financial_event_id 0 = fee-estimator sentinel, -1 = settlement-report
  // sentinel (real, deliberately event-less). Anything else must join.
  // Orphans are invisible to the P&L service-fee queries (the join fails), so
  // they either represent lost real fees or leftover children of deleted
  // duplicate events — both are bugs in whichever sync/import path ran last.
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details
    WHERE financial_event_id NOT IN (0, -1)
      AND financial_event_id NOT IN (SELECT id FROM financial_events)
  `);
  assert.equal(n, 0, `${n} orphan fee_details rows — an import/dedup path deleted parent events without their children (or vice versa)`);
});

test('no orphan ServiceFeeEvent financial_events (event without fee_details child)', { skip: !dbExists }, () => {
  // The July 2026 orphan flood (18K rows) was this pattern: concurrent syncs
  // corrupted the batch tracker → event inserted, fee_details blocked by the
  // unique index. dedupServiceFees pass 3 sweeps these every sync; transient
  // singles can appear mid-sync but must not persist.
  const n = count(`
    SELECT COUNT(*) as n FROM financial_events fe
    WHERE fe.event_type = 'ServiceFeeEvent'
      AND NOT EXISTS (SELECT 1 FROM fee_details fd WHERE fd.financial_event_id = fe.id)
  `);
  assert.equal(n, 0, `${n} orphaned ServiceFeeEvent rows — if a sync is mid-run, re-test after it completes; otherwise the orphan sweep regressed`);
});

test('no orphan SettlementServiceFee events (settlement parser vs import fight)', { skip: !dbExists }, () => {
  // July 6-12 2026: import-transactions replaced settlement fees, the
  // settlement re-sync re-inserted the events but their fee_details children
  // were blocked by the day-level unique index → orphan events, and every
  // later re-sync crashed the whole report on the raw INSERT. The parser now
  // uses INSERT OR IGNORE + a cross-source pre-check; orphans must not return.
  const n = count(`
    SELECT COUNT(*) as n FROM financial_events fe
    WHERE fe.event_type = 'SettlementServiceFee'
      AND NOT EXISTS (SELECT 1 FROM fee_details fd WHERE fd.financial_event_id = fe.id)
  `);
  assert.equal(n, 0, `${n} orphaned SettlementServiceFee rows — settlement parser re-inserted events whose fees another source already owns`);
});

test('no SettlementServiceFee duplicating a transaction-report/live-API fee', { skip: !dbExists }, () => {
  // Same July 2026 incident, the data-drift half: $496 of Apr-Jul fees were
  // counted twice (settlement copy + TransactionReport*/ServiceFeeEvent copy).
  // Sources use different fee_type names and dates skew 0-4 days, so the
  // duplicate signature is: same amount, both order-less, both amazon, within
  // 5 days. Genuine same-amount repeats beyond 5 days apart are fine.
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details fd
    JOIN financial_events fe ON fe.id = fd.financial_event_id AND fe.event_type = 'SettlementServiceFee'
    WHERE (fd.order_id IS NULL OR fd.order_id = '')
      AND EXISTS (
        SELECT 1 FROM fee_details other
        JOIN financial_events oe ON oe.id = other.financial_event_id
        WHERE other.id != fd.id
          AND oe.event_type != 'SettlementServiceFee'
          AND oe.marketplace = 'amazon'
          AND (other.order_id IS NULL OR other.order_id = '')
          AND other.amount = fd.amount
          AND abs(julianday(date(other.posted_date)) - julianday(date(fd.posted_date))) <= 5
      )
  `);
  assert.equal(n, 0, `${n} settlement service fees duplicate a transaction-report/live-API fee — the settlement parser's cross-source pre-check regressed`);
});

test('dedup unique indexes exist with the right shape', { skip: !dbExists }, () => {
  const indexes = db!.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index'`).all() as { name: string; sql: string | null }[];
  const byName = new Map(indexes.map(i => [i.name, i.sql || '']));

  const required = [
    'idx_financial_events_unique',
    'idx_fee_details_unique',
    'idx_refunds_unique',
    'idx_reimbursements_unique',
    'idx_sales_tax_unique',
    'idx_order_items_unique',
  ];
  for (const name of required) {
    assert.ok(byName.has(name), `unique index ${name} is missing — the dedup guarantees in CLAUDE.md depend on it`);
  }
  // The financial_events index MUST include total_amount (May 1, 2026 fix:
  // without it, distinct same-day recon line items silently collapse).
  assert.match(byName.get('idx_financial_events_unique')!, /total_amount/,
    'idx_financial_events_unique lost the total_amount column — distinct same-key line items would silently drop');
  // The refunds / financial_events indexes must COALESCE nullable columns
  // (SQLite treats NULL != NULL, which caused the 5,873-duplicate flood).
  assert.match(byName.get('idx_financial_events_unique')!, /COALESCE/i);
  assert.match(byName.get('idx_refunds_unique')!, /COALESCE/i);
});

test('no phantom estimator fees on non-Amazon orders', { skip: !dbExists }, () => {
  // May 19, 2026 bug: the fee estimator (sentinel financial_event_id = 0)
  // created fake Commission/FBA fees on Walmart orders awaiting recon.
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details fd
    JOIN orders o ON fd.order_id = o.order_id
    WHERE fd.financial_event_id = 0 AND o.marketplace != 'amazon'
  `);
  assert.equal(n, 0, `${n} estimator fee rows on non-Amazon orders — the marketplace filter in fee-estimator.ts regressed`);
});

test('no Walmart refund content-duplicates', { skip: !dbExists }, () => {
  // June 9, 2026 bug: Walmart re-dates returnOrderDate across syncs, so the
  // same return re-inserted under new refund_dates (one $45 deduction had SIX
  // rows). Content dedup on (order_id, sku, amount) must hold.
  const n = count(`
    SELECT COUNT(*) as n FROM (
      SELECT order_id FROM refunds
      WHERE marketplace = 'walmart'
      GROUP BY order_id, COALESCE(sku, ''), refund_amount
      HAVING COUNT(*) > 1
    )
  `);
  assert.equal(n, 0, `${n} Walmart refund content-dup groups — the returns.ts content-dedup regressed`);
});

test('no sales_tax Unknown-state shadow duplicates', { skip: !dbExists }, () => {
  // June 9, 2026 bug: financial-events inserted tax with state='Unknown',
  // orders sync renamed it, next re-sync re-inserted a fresh 'Unknown' —
  // double-counting the Sales Tax page and erroring every hourly sync.
  const n = count(`
    SELECT COUNT(*) as n FROM sales_tax st
    WHERE st.state = 'Unknown'
      AND EXISTS (
        SELECT 1 FROM sales_tax s2
        WHERE s2.order_id = st.order_id
          AND s2.posted_date = st.posted_date
          AND s2.state != 'Unknown'
      )
  `);
  assert.equal(n, 0, `${n} Unknown-state sales_tax rows shadowing a real-state row — both writers' guards regressed`);
});

test('service fees: max one per (type, amount, asin, month) — rolling-date dedup holds (2026+)', { skip: !dbExists }, () => {
  // May 14, 2026 bug: Amazon re-dates pending service fees to "today" on every
  // sync; day-scoped dedup re-inserted them daily (April overstated $941).
  // The fix collapses ServiceFeeEvent-linked fees to one per calendar month.
  const n = count(`
    SELECT COUNT(*) as n FROM (
      SELECT fd.fee_type FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE fe.event_type = 'ServiceFeeEvent'
        AND fd.posted_date >= '2026-01-01'
      GROUP BY fd.fee_type, fd.amount, COALESCE(fd.asin, ''), strftime('%Y-%m', fd.posted_date)
      HAVING COUNT(*) > 1
    )
  `);
  assert.equal(n, 0, `${n} month-duplicated service-fee groups — the rolling-date dedup (finances.ts / dedupServiceFees.ts) regressed`);
});

test('one-off inbound fees: no same-amount copies within 60 days (cross-month dedup, 2026+)', { skip: !dbExists }, () => {
  // July 6, 2026 bug: pending FBAInbound fees crossing a MONTH boundary
  // escaped month-scoped dedup (batch 21's $47.63 was booked 3×). The fix
  // dedups the one-off types over a trailing 60-day window (chain-anchored:
  // surviving copies of the same key are always ≥60 days apart).
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details a
    JOIN fee_details b
      ON a.id < b.id
      AND a.fee_type = b.fee_type
      AND a.amount = b.amount
      AND COALESCE(a.asin, '') = COALESCE(b.asin, '')
      AND ABS(julianday(a.posted_date) - julianday(b.posted_date)) < 60
    WHERE a.fee_type IN ('FBAInboundTransportationFee', 'FBAInboundConvenienceFee')
      AND (a.order_id IS NULL OR a.order_id = '')
      AND (b.order_id IS NULL OR b.order_id = '')
      AND a.posted_date >= '2026-01-01'
      AND a.financial_event_id IN (SELECT id FROM financial_events WHERE event_type = 'ServiceFeeEvent')
      AND b.financial_event_id IN (SELECT id FROM financial_events WHERE event_type = 'ServiceFeeEvent')
  `);
  assert.equal(n, 0, `${n} one-off inbound fee pairs within 60 days — the cross-month window dedup regressed`);
});

test('no duplicate reimbursement placeholders shadowing canonical rows', { skip: !dbExists }, () => {
  // May 1, 2026 bug: ADJ-*/SETTLEMENT-* placeholder rows coexisted with the
  // canonical numeric reimbursement for the same (day, amount, sku/asin),
  // triplicating income. dedupAmazonReimbursements sweeps these every sync.
  const n = count(`
    SELECT COUNT(*) as n FROM reimbursements dup
    WHERE (dup.reimbursement_id LIKE 'ADJ-%' OR dup.reimbursement_id LIKE 'SETTLEMENT-%')
      AND EXISTS (
        SELECT 1 FROM reimbursements canon
        WHERE canon.reimbursement_id NOT LIKE 'ADJ-%'
          AND canon.reimbursement_id NOT LIKE 'SETTLEMENT-%'
          AND canon.reimbursement_id NOT LIKE 'WMT-%'
          AND canon.reimbursement_id NOT LIKE 'WFS-%'
          AND canon.id != dup.id
          AND date(canon.reimbursement_date) = date(dup.reimbursement_date)
          AND canon.amount = dup.amount
          AND (
            (COALESCE(dup.sku, '') != '' AND canon.sku = dup.sku)
            OR (COALESCE(dup.asin, '') != '' AND canon.asin = dup.asin)
            OR (COALESCE(dup.sku, '') = '' AND COALESCE(dup.asin, '') = '')
          )
      )
  `);
  assert.equal(n, 0, `${n} placeholder reimbursements shadowing canonical rows — dedupAmazonReimbursements regressed`);
});
