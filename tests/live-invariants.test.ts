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
  // May 19, 2026 bug: the Amazon fee estimator (sentinel financial_event_id = 0)
  // created fake Commission/FBA fees on Walmart orders awaiting recon. Since
  // Sept 27 Walmart has its own estimates — only those types are allowed.
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details fd
    JOIN orders o ON fd.order_id = o.order_id
    WHERE fd.financial_event_id = 0 AND o.marketplace != 'amazon'
      AND NOT (o.marketplace = 'walmart'
               AND fd.fee_type IN ('WalmartReferralFeeEstimate', 'WFSFulfillmentFeeEstimate'))
  `);
  assert.equal(n, 0, `${n} estimator fee rows on non-Amazon orders — the marketplace filter in fee-estimator.ts regressed`);
});

test('Walmart fee estimates never sit beside real recon fees', { skip: !dbExists }, () => {
  // An estimate left on an order whose real fees have settled double-counts
  // that order's fees. refreshWalmartFeeEstimates rebuilds after every recon.
  const n = count(`
    SELECT COUNT(DISTINCT fd.order_id) as n FROM fee_details fd
    WHERE fd.fee_type IN ('WalmartReferralFeeEstimate', 'WFSFulfillmentFeeEstimate')
      AND EXISTS (SELECT 1 FROM fee_details r WHERE r.order_id = fd.order_id
                  AND r.fee_type NOT IN ('WalmartReferralFeeEstimate', 'WFSFulfillmentFeeEstimate'))
  `);
  assert.equal(n, 0, `${n} Walmart orders carry both estimated and real fees`);
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

// ── WFS service fees now come from the recon report (Aug 23, 2026) ──────────
// These rows have no Purchase Order #, no Transaction Key and no GTIN, so they
// cannot be deduped by identity. Idempotency comes from scoped replacement:
// each row is tagged with its source reportDate and a re-sync deletes that
// report's prior rows first. These invariants guard that contract.

test('no retired CSV-sourced WFS service-fee rows remain', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  const events = db!.prepare(
    `SELECT COUNT(*) n FROM financial_events WHERE event_type = 'WalmartServiceFee'`,
  ).get() as { n: number };
  const reimb = db!.prepare(
    `SELECT COUNT(*) n FROM reimbursements WHERE reimbursement_id LIKE 'WFS-SVC-%'`,
  ).get() as { n: number };
  db.close();
  // The retired Seller-Center CSV importer wrote a SEPARATE event_type, so
  // nothing reconciles it against the recon-sourced rows — both present = double count.
  assert.equal(events.n, 0, `${events.n} retired WalmartServiceFee events — CSV importer was re-run; these double-count the recon-sourced rows`);
  assert.equal(reimb.n, 0, `${reimb.n} retired WFS-SVC-* reimbursements — same double-count risk`);
});

test('WFS recon service fees: one row per (fee_type, day), never order-scoped', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  const dupes = db!.prepare(`
    SELECT fd.fee_type, date(fd.posted_date) d, COUNT(*) n
    FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'WalmartReconServiceFee'
    GROUP BY 1, 2 HAVING COUNT(*) > 1
  `).all() as { fee_type: string; d: string; n: number }[];
  // idx_fee_details_unique is day-level, so rows are aggregated per (type, day)
  // before insert. More than one row per pair means a report was applied twice.
  assert.equal(dupes.length, 0,
    `duplicated WFS service fee rows: ${dupes.map((x) => `${x.fee_type}@${x.d}x${x.n}`).join(', ')}`);

  const onOrders = db!.prepare(`
    SELECT COUNT(*) n FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'WalmartReconServiceFee' AND fd.order_id IS NOT NULL AND fd.order_id <> ''
  `).get() as { n: number };
  db.close();
  // They are period roll-ups; attaching one to an order would double-charge that order
  // and break the P&L service-fee query (which keys on order_id IS NULL).
  assert.equal(onOrders.n, 0, `${onOrders.n} WFS service fees wrongly attached to an order`);
});

test('WFS service-fee rows are not also captured by the normal recon path', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  const leaked = db!.prepare(`
    SELECT COUNT(*) n FROM financial_events
    WHERE event_type IN ('WalmartReconEvent','WalmartRefundEvent','WalmartIncentive','WalmartDisputeSettlement')
      AND json_extract(raw_data, '$."Transaction Description"') IN
          ('WFS StorageFee','WFS InboundTransportationFee','WFS RC_InventoryRTVFee',
           'WFS InventoryRemovalOrder','WFS Refund','WFS LostInventory')
  `).get() as { n: number };
  db.close();
  assert.equal(leaked.n, 0, `${leaked.n} WFS service rows captured by BOTH the roll-up path and the normal recon path`);
});

test('no legacy WMT-INC-* reimbursements shadowing WMT-INCENTIVE-* rows', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  // WMT-INC-{rowid} is a dead id scheme from an older recon parser. Every one of
  // its rows duplicated a WMT-INCENTIVE-{order}-{sku} row (verified: per-group
  // counts matched the true per-order count exactly). $774.73 removed Aug 23, 2026.
  const shadows = db!.prepare(`
    SELECT COUNT(*) n FROM reimbursements a
    WHERE a.reimbursement_id LIKE 'WMT-INC-%'
      AND EXISTS (SELECT 1 FROM reimbursements b
                  WHERE b.reimbursement_id LIKE 'WMT-INCENTIVE-%'
                    AND b.sku = a.sku AND date(b.reimbursement_date) = date(a.reimbursement_date)
                    AND b.amount = a.amount)
  `).get() as { n: number };
  db.close();
  assert.equal(shadows.n, 0, `${shadows.n} legacy WMT-INC-* rows duplicating commission incentives`);
});

// ─────────────────────────────────────────────────────────────────────────────
// eBay transaction-report import (Aug 25, 2026). eBay's Finances API 404s for
// this account, so shipping labels + promoted-listing/insertion fees arrive only
// via the manual Seller Hub "Transaction report" CSV. These lock the two bugs
// caught during the build and the two structural assumptions the import relies on.
// ─────────────────────────────────────────────────────────────────────────────

test('no negative shipping_cost — a voided label must never book as income', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  // A voided/refunded shipping label arrives as a POSITIVE Net amount in eBay's
  // report. The first cut of the importer ran Math.abs() over it and booked the
  // credit as an extra $6.79 of cost. Negating instead means a void nets back out
  // of its own order — but if voids ever exceed purchases the result must clamp
  // at 0, because P&L subtracts shipping_cost and a negative would read as income.
  const neg = db!.prepare(`SELECT COUNT(*) n FROM order_items WHERE shipping_cost < 0`).get() as { n: number };
  db.close();
  assert.equal(neg.n, 0, `${neg.n} order_items have a negative shipping_cost`);
});

test('eBay transaction-report fees stay order-less so the P&L service-fee query sees them', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  // The P&L picks these up via its serviceFees query, which requires
  // (fd.order_id IS NULL OR '') and scopes by financial_events.marketplace.
  // Attaching an order_id would silently drop them from every marketplace view.
  const scoped = db!.prepare(`
    SELECT COUNT(*) n FROM fee_details fd
    JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'EbayTransactionReportFee'
      AND fd.order_id IS NOT NULL AND fd.order_id <> ''
  `).get() as { n: number };
  const mk = db!.prepare(`
    SELECT COUNT(*) n FROM financial_events
    WHERE event_type = 'EbayTransactionReportFee' AND marketplace <> 'ebay'
  `).get() as { n: number };
  db.close();
  assert.equal(scoped.n, 0, `${scoped.n} eBay transaction-report fees are order-scoped`);
    assert.equal(mk.n, 0, `${mk.n} eBay transaction-report events are not marketplace='ebay'`);
});

test('eBay transaction-report fees are aggregated one row per (fee_type, day)', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  // idx_fee_details_unique is DAY-level, so 228 insertion fees at the same price
  // on the same day would silently collapse to one on insert. The importer
  // pre-aggregates per (fee_type, day) to dodge that; if a second row for the
  // same key ever appears, the aggregation broke and amounts are being lost.
  const dup = db!.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT fd.fee_type, date(fd.posted_date) d, COUNT(*) c
      FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
      WHERE fe.event_type = 'EbayTransactionReportFee'
      GROUP BY fd.fee_type, date(fd.posted_date) HAVING c > 1
    )
  `).get() as { n: number };
  db.close();
  assert.equal(dup.n, 0, `${dup.n} (fee_type, day) groups have more than one row`);
});

test('eBay transaction-report events all have a fee_details child', { skip: !dbExists }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  // The importer inserts the event then INSERT OR IGNOREs the child; if the
  // child is ignored it deletes the event rather than leave an orphan (the
  // ServiceFeeEvent orphan flood of July 6, 2026 came from skipping that).
  const childless = db!.prepare(`
    SELECT COUNT(*) n FROM financial_events fe
    WHERE fe.event_type = 'EbayTransactionReportFee'
      AND NOT EXISTS (SELECT 1 FROM fee_details fd WHERE fd.financial_event_id = fe.id)
  `).get() as { n: number };
  db.close();
  assert.equal(childless.n, 0, `${childless.n} childless EbayTransactionReportFee events`);
});

// ---------------------------------------------------------------------------
// WFS return disposition (Aug 2026). The RTV evidence check used to read
// fee_details.WFSInventoryRTVFee joined on financial_events.asin = <order GTIN>.
// After the recon migration every such row is a period-level roll-up with a
// NULL asin, so the join could never match and the check was silently dead —
// 17 of 19 "never returned to you" claims were units already back in hand.
// These lock the replacement (wfs_rtv_units) in place.
test('WFS RTV attribution does not depend on financial_events.asin', { skip: !dbExists }, () => {
  const rtvFees = db!.prepare(`
    SELECT COUNT(*) n, SUM(fe.asin IS NULL OR fe.asin = '') nullAsin
    FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fd.fee_type = 'WFSInventoryRTVFee'`).get() as any;
  if (rtvFees.n === 0) return;
  // If the fee rows carry no GTIN, per-unit attribution MUST come from
  // wfs_rtv_units or the detector is blind.
  if (rtvFees.nullAsin === rtvFees.n) {
    const units = db!.prepare(`SELECT COUNT(*) n FROM wfs_rtv_units`).get() as any;
    assert.ok(units.n > 0,
      'All WFSInventoryRTVFee rows have a NULL GTIN and wfs_rtv_units is empty — ' +
      'RTV detection is blind and every settled WFS return will look lost. ' +
      'Run POST /api/sync/import-wfs-rtv.');
  }
});

test('one RTV unit clears at most one refund of the same GTIN', { skip: !dbExists }, () => {
  if ((db!.prepare(`SELECT COUNT(*) n FROM wfs_rtv_units`).get() as any).n === 0) return;
  const over = db!.prepare(`
    SELECT gg.gtin, COUNT(*) covered,
           (SELECT COALESCE(SUM(u.quantity),0) FROM wfs_rtv_units u WHERE u.gtin = gg.gtin) units
    FROM refunds rr
    JOIN orders oo ON oo.order_id = rr.order_id AND oo.fulfillment_channel = 'WFS'
    JOIN (SELECT order_id, MAX(json_extract(raw_data,'$."Partner GTIN"')) gtin
          FROM financial_events WHERE marketplace='walmart' AND order_id IS NOT NULL
            AND json_extract(raw_data,'$."Partner GTIN"') IS NOT NULL
          GROUP BY order_id) gg ON gg.order_id = rr.order_id
    WHERE rr.marketplace='walmart'
      AND EXISTS (SELECT 1 FROM wfs_rtv_units u WHERE u.gtin = gg.gtin
                  AND u.rtv_date >= date(rr.refund_date,'-7 days'))
    GROUP BY gg.gtin HAVING covered > units`).all() as any[];
  // Grouping tells us how many refunds COULD claim each GTIN's units; the
  // allocation must never mark more refunds 'rtv' than units actually returned.
  for (const row of over) {
    assert.ok(row.covered > row.units,
      `sanity: GTIN ${row.gtin} has ${row.covered} candidate refunds vs ${row.units} units`);
  }
  assert.ok(true);
});

test('wfs_rtv_units is disposition-only — never a financial row', { skip: !dbExists }, () => {
  const cols = (db!.prepare(`PRAGMA table_info(wfs_rtv_units)`).all() as any[]).map(c => c.name);
  assert.ok(!cols.includes('financial_event_id'),
    'wfs_rtv_units must not link to financial_events — it exists precisely so RTV ' +
    'attribution can be imported from CSV without double-counting the recon fee roll-ups.');
  const dupes = db!.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT gtin, rtv_date, COALESCE(wfs_reference_id,'') r, COUNT(*) c
      FROM wfs_rtv_units GROUP BY 1,2,3 HAVING c > 1)`).get() as any;
  assert.equal(dupes.n, 0, 'duplicate RTV units — the import is not idempotent');
});

test('walmart refund quantity is never silently hardcoded to 1', { skip: !dbExists }, () => {
  // returns.ts once did `const quantity = 1`, so every multi-unit Walmart
  // return was understated by (qty - 1) units: return 175544407242882867
  // stored 1 x $440 for a 2-unit, $880 return. Walmart prices return charges
  // PER UNIT (chargePerUnit / unitPrice), so the hardcode understated the
  // refund amount by the same factor. Guard: a refund whose amount is an
  // exact 1/N share of its order line's total, on a line of N > 1 units,
  // while claiming quantity 1, is that bug's fingerprint.
  const suspects = db!.prepare(`
    SELECT r.order_id, r.quantity AS rq, oi.quantity AS oq,
           r.refund_amount, oi.total_price
    FROM refunds r
    JOIN order_items oi
      ON oi.order_id = r.order_id
     AND (r.sku = oi.sku OR r.asin = oi.asin)
    WHERE r.marketplace = 'walmart'
      AND r.quantity = 1
      AND oi.quantity > 1
      AND r.refund_amount > 0
      AND oi.total_price > 0
      -- exact per-unit share of a multi-unit line, to the cent
      AND r.refund_amount = oi.total_price / oi.quantity
  `).all() as any[];
  assert.equal(suspects.length, 0,
    `Walmart refunds recording exactly one unit's price on a multi-unit line — ` +
    `check returns.ts reads line.quantity.measurementValue, not a hardcoded 1: ` +
    suspects.map(s => `${s.order_id} (${s.rq} of ${s.oq})`).join(', '));
});

test('no settled Walmart refund is understated vs its recon deduction', { skip: !dbExists }, () => {
  // Recon's Product Price line is the cash truth (what Walmart actually
  // deducted). A stored refund materially BELOW it means the refunds row was
  // built from bad line data and P&L is under-counting the refund.
  const under = db!.prepare(`
    WITH po AS (
      SELECT r.order_id, SUM(r.refund_amount) stored,
        (SELECT ABS(SUM(fe.total_amount)) FROM financial_events fe
          WHERE fe.order_id = r.order_id
            AND fe.event_type = 'WalmartRefundEvent'
            AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price') settled
      FROM refunds r WHERE r.marketplace = 'walmart' GROUP BY r.order_id)
    SELECT order_id, stored, settled FROM po
    WHERE settled IS NOT NULL AND settled > stored + 50
  `).all() as any[];
  assert.equal(under.length, 0,
    `settled Walmart refunds below their recon deduction: ` +
    under.map(u => `${u.order_id} ($${(u.stored/100).toFixed(2)} vs $${(u.settled/100).toFixed(2)})`).join(', '));
});

test('walmart dispute candidates stay in sync with their refund row', { skip: !dbExists }, () => {
  // The upsert originally refreshed only eligibility/window/product_name, so
  // anything derived from the refunds row was written once at insert and
  // never again. When order 119124132800655's refund was corrected from
  // $440 to $880, the claim page kept showing $440 — the number that would
  // have gone on the Seller Center claim. A refund's amount, reason, date
  // and SKU are all mutable upstream (re-synced return line, recon
  // settlement overwriting a placeholder), so they must be refreshed.
  const drift = db!.prepare(`
    SELECT c.order_id, c.refund_amount_cents AS claim, r.refund_amount AS truth,
           c.return_reason AS c_reason, r.reason AS r_reason
    FROM walmart_dispute_candidates c
    JOIN refunds r ON r.id = c.refund_id
    WHERE c.refund_amount_cents != r.refund_amount
       OR COALESCE(c.return_reason, '') != COALESCE(r.reason, '')
       OR date(c.refund_date) != date(r.refund_date)
  `).all() as any[];
  assert.equal(drift.length, 0,
    `dispute candidates disagree with their refunds row — the claim page would ` +
    `show a stale figure: ` +
    drift.map(d => `${d.order_id} ($${(d.claim/100).toFixed(2)} vs $${(d.truth/100).toFixed(2)})`).join(', '));
});

test('no Walmart dispute candidate is eligible past its own claim window', { skip: !dbExists }, () => {
  // The lost-in-pipeline rule had only a lower bound (age >= 90 days) and no
  // upper bound, so a return stayed labelled 'eligible' indefinitely. Parker
  // filed 6 claims 60-105 days past their deadline (one 239 days old) and
  // Walmart denied every one — they state "no appeals", so a dead claim
  // burns a filing slot for nothing. An eligible claim must be actionable.
  const dead = db!.prepare(`
    SELECT order_id, refund_amount_cents, dispute_window_until,
           CAST(julianday('now') - julianday(dispute_window_until) AS INT) AS days_past
    FROM walmart_dispute_candidates
    WHERE eligibility = 'eligible'
      AND status IN ('pending', 'filed')
      AND date(dispute_window_until) < date('now')
  `).all() as any[];
  assert.equal(dead.length, 0,
    `claims presented as actionable whose window has closed: ` +
    dead.map(d => `${d.order_id} ($${(d.refund_amount_cents/100).toFixed(2)}, ${d.days_past}d past)`).join(', '));
});

test('every settled Walmart funded-incentive reversal is booked against income', { skip: !dbExists }, () => {
  // Sept 21 2026: recon captured "Total Walmart Funded Savings" on the SALE as
  // income but dropped the negative Refund-side row, so a returned unit kept
  // its incentive forever ($268.47 across 25 returns).
  const missing = db!.prepare(`
    SELECT fe.order_id, fe.total_amount
    FROM financial_events fe
    WHERE fe.event_type = 'WalmartRefundEvent'
      AND fe.total_amount < 0
      AND json_extract(fe.raw_data, '$."Amount Type"') = 'Total Walmart Funded Savings'
      AND NOT EXISTS (
        SELECT 1 FROM reimbursements r
        WHERE r.reimbursement_id = 'WMT-FUNDED-REV-' || json_extract(fe.raw_data, '$."Transaction Key"')
          AND r.amount = fe.total_amount
      )
  `).all() as any[];
  assert.equal(missing.length, 0,
    `funded-incentive reversals not booked: ` + missing.map(m => `${m.order_id} (${m.total_amount})`).join(', '));
});

test('Walmart "Commission Saving" is never booked as income', { skip: !dbExists }, () => {
  // Sept 21 2026: the saving is a descriptive column on the commission row —
  // the charged commission is already at the reduced rate and recon deposits
  // equal the sum of the Amount column. Booking it double-counted $912.75.
  const reimb = db!.prepare(`SELECT COUNT(*) n FROM reimbursements WHERE reimbursement_id LIKE 'WMT-INCENTIVE-%' OR reason LIKE 'Commission Incentive%'`).get() as any;
  const events = db!.prepare(`SELECT COUNT(*) n FROM financial_events WHERE event_type = 'WalmartIncentive' AND json_extract(raw_data, '$.incentiveProgram') IS NOT NULL`).get() as any;
  assert.equal(reimb.n, 0, `${reimb.n} commission-saving reimbursements booked as income`);
  assert.equal(events.n, 0, `${events.n} synthetic commission-saving incentive events`);
});

test('Amazon service fees since the v2024 cutover equal Amazon\'s v2024 ledger, month by month', { skip: !dbExists }, () => {
  // Sept 22 2026 (review A1): three writers booked the same service fees and
  // none could tell a repeat from a new fee — $646.32 of 2026 fees counted
  // twice. From the cutover the rows are a projection of
  // finances_transactions_v2, so the books must equal Amazon's ledger exactly.
  const cutover = '2026-04-12T00:00:00Z';
  const mkt = (col: string) => `strftime('%Y-%m', date(${col}, 'localtime', '-1 hour'))`;
  const ledger = new Map((db!.prepare(`
    SELECT ${mkt('posted_date')} m, SUM(total_amount_cents) c FROM finances_transactions_v2
    WHERE transaction_type = 'ServiceFee' AND posted_date >= ? GROUP BY 1
  `).all(cutover) as { m: string; c: number }[]).map(r => [r.m, r.c]));
  const books = new Map((db!.prepare(`
    SELECT ${mkt('fd.posted_date')} m, SUM(fd.amount) c
    FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'AmazonV2024ServiceFee' GROUP BY 1
  `).all() as { m: string; c: number }[]).map(r => [r.m, r.c]));
  const months = [...new Set([...ledger.keys(), ...books.keys()])].sort();
  const diffs = months.filter(m => (ledger.get(m) || 0) !== (books.get(m) || 0))
    .map(m => `${m}: books ${books.get(m) || 0} vs ledger ${ledger.get(m) || 0}`);
  assert.deepEqual(diffs, [], 'service fees drifted from the v2024 ledger');
});

test('no legacy-source Amazon service fees inside the v2024 window', { skip: !dbExists }, () => {
  // ServiceFeeEvent, settlement placement/storage/removal lines and the
  // transaction-report import all duplicated v2024 fees after the cutover.
  const rows = db!.prepare(`
    SELECT fe.event_type, fd.fee_type, COUNT(*) n
    FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.marketplace = 'amazon' AND (fd.order_id IS NULL OR fd.order_id = '')
      AND fd.posted_date >= '2026-04-12'
      AND (fe.event_type IN ('ServiceFeeEvent', 'TransactionReportServiceFee', 'TransactionReportInventoryFee')
        OR (fe.event_type = 'SettlementServiceFee'
            AND fd.fee_type NOT IN ('Adjustment', 'FeeAdjustment', 'COMPENSATED_CLAWBACK', 'Shippinglabelpurchaseforreturn')))
    GROUP BY 1, 2
  `).all() as { event_type: string; fee_type: string; n: number }[];
  assert.deepEqual(rows, [], `legacy service-fee rows after the cutover: ${JSON.stringify(rows)}`);
});

test('no settled Walmart return that never came back has zeroed or reversed COGS', { skip: !dbExists }, () => {
  // Sept 22 2026 (review A2): every Walmart refund carries item_returned=1, so
  // FIFO erased COGS on units Walmart lost (LostReturnAdjustment) or that were
  // lost in transit — ~$730. Those sales must keep their cost.
  const rows = db!.prepare(`
    SELECT oi.order_id, oi.sku FROM order_items oi
    JOIN refunds r ON r.order_id = oi.order_id AND r.marketplace = 'walmart'
    WHERE (oi.cogs_per_unit = 0 OR EXISTS (SELECT 1 FROM cogs_reversals cr WHERE cr.order_item_id = oi.id))
      AND (r.reason IN ('LOST_IN_TRANSIT', 'LOST_AFTER_DELIVERY')
           OR EXISTS (SELECT 1 FROM wfs_lost_returns l WHERE l.rma = r.return_order_id OR (l.rma IS NULL AND l.po = r.order_id)))
      AND EXISTS (SELECT 1 FROM financial_events fe WHERE fe.event_type = 'WalmartRefundEvent' AND fe.order_id = r.order_id
                  AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price')
      AND EXISTS (SELECT 1 FROM inventory_ledger il WHERE (il.sku = oi.sku OR il.asin = oi.asin) AND il.buy_price > 0)
  `).all() as { order_id: string; sku: string }[];
  assert.deepEqual(rows, [], `lost Walmart returns with erased COGS: ${rows.map(r => `${r.order_id}/${r.sku}`).join(', ')}`);
});

test('no open Walmart claim on a return Walmart already paid for', { skip: !dbExists }, () => {
  // Sept 22 2026 (review D2): 4 lost-return claims filed Aug 29 were denied
  // because Walmart had already paid LostReturnAdjustments on them.
  const rows = db!.prepare(`
    SELECT c.order_id FROM walmart_dispute_candidates c JOIN refunds r ON r.id = c.refund_id
    WHERE c.status = 'pending' AND c.eligibility IN ('eligible', 'maybe')
      AND EXISTS (SELECT 1 FROM wfs_lost_returns l WHERE l.rma = r.return_order_id OR (l.rma IS NULL AND l.po = r.order_id))
  `).all() as { order_id: string }[];
  assert.deepEqual(rows, [], `claims open on already-paid returns: ${rows.map(r => r.order_id).join(', ')}`);
});

test('no Walmart funded-incentive reversal is stored twice as events', { skip: !dbExists }, () => {
  // Sept 23 2026 (review A12): the reversal was written both as the
  // WalmartRefundEvent funded-savings line AND as a negative WalmartIncentive,
  // so the order lookup Net subtracted it twice (-$268.47 over 25 orders).
  const n = count(`
    SELECT COUNT(*) as n FROM financial_events fe
    WHERE fe.event_type = 'WalmartIncentive' AND fe.total_amount < 0
      AND json_extract(fe.raw_data, '$."Transaction Type"') = 'Refund'
  `);
  assert.equal(n, 0, `${n} duplicate funded-incentive reversal events`);
});

test('no Amazon reimbursement clawback is booked as a fee', { skip: !dbExists }, () => {
  // Sept 23 2026 (review A5): settlement COMPENSATED_CLAWBACK rows fell through
  // to the fee path on top of the canonical Reimbursement_Reversal ($87.75).
  const n = count(`
    SELECT COUNT(*) as n FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = 'SettlementServiceFee'
      AND (fd.fee_type = 'COMPENSATED_CLAWBACK'
        OR EXISTS (SELECT 1 FROM reimbursements r WHERE r.marketplace = 'amazon'
                     AND r.amount = fd.amount AND date(r.reimbursement_date) = date(fd.posted_date)))
  `);
  assert.equal(n, 0, `${n} settlement fee rows duplicate a reimbursement`);
});

test('Amazon reimbursements equal Amazon\'s v2024 ledger, month by month', { skip: !dbExists }, () => {
  // Sept 23 2026 (review A10): multi-line reimbursements lost every line but
  // the last ($266.02), and a settlement + ADJ placeholder pair double-counted
  // $40.48. Both show up here. A fresh reimbursement can mismatch for up to a
  // day while its ADJ/SETTLEMENT placeholder or report row catches up.
  const mkt = (col: string) => `strftime('%Y-%m', date(${col}, 'localtime', '-1 hour'))`;
  const ledger = new Map((db!.prepare(`
    SELECT ${mkt('posted_date')} m, SUM(total_amount_cents) c FROM finances_transactions_v2
    WHERE transaction_type = 'FBAInventoryReimbursement' AND posted_date >= '2026-04-12' GROUP BY 1
  `).all() as { m: string; c: number }[]).map(r => [r.m, r.c]));
  const books = new Map((db!.prepare(`
    SELECT ${mkt('reimbursement_date')} m, SUM(amount) c FROM reimbursements
    WHERE marketplace = 'amazon' AND reimbursement_date >= '2026-04-12' GROUP BY 1
  `).all() as { m: string; c: number }[]).map(r => [r.m, r.c]));
  const diffs = [...new Set([...ledger.keys(), ...books.keys()])].sort()
    .filter(m => (ledger.get(m) || 0) !== (books.get(m) || 0))
    .map(m => `${m}: books ${books.get(m) || 0} vs ledger ${ledger.get(m) || 0}`);
  assert.deepEqual(diffs, [], 'Amazon reimbursements drifted from the v2024 ledger');
});

test('every Amazon MCF shipment is paired with the sale it fulfilled', { skip: !dbExists }, () => {
  // Sept 23 2026 (review A4): an unpaired MCF line keeps its COGS on top of
  // the sale's own, so its cost may be counted twice. Pair it (mcf.ts) or
  // record the pair in mcf_fulfillments by hand.
  const rows = db!.prepare(`
    SELECT order_id FROM orders WHERE fulfillment_channel = 'MCF'
      AND order_id NOT IN (SELECT mcf_order_id FROM mcf_fulfillments)
  `).all() as { order_id: string }[];
  assert.deepEqual(rows, [], `unpaired MCF shipments: ${rows.map(r => r.order_id).join(', ')}`);
});

test('per-line refund attribution sums to each order settled refunds (review C3)', { skip: !dbExists }, async () => {
  // Per-order views subtract lineSettledRefundExpr from profit: SKU-matched
  // refunds on their line, SKU-less ones split by revenue. Within an order the
  // lines must add back to exactly the settled refunds — more means a refund
  // was attributed twice, less means one was dropped. (A refund can exceed the
  // sale price legitimately: refunded shipping or gift wrap.)
  const { lineSettledRefundExpr, walmartSettledRefund } = await import('../src/lib/accounting-sql');
  const rows = db!.prepare(`
    WITH lines AS (
      SELECT oi.order_id, SUM(${lineSettledRefundExpr()}) AS attributed
      FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM refunds) GROUP BY oi.order_id
    ),
    truth AS (
      SELECT r.order_id, SUM(r.refund_amount) AS settled FROM refunds r
      WHERE ${walmartSettledRefund('r', true)}
        AND (EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = r.order_id AND x.sku = r.sku)
             OR (SELECT SUM(x.total_price) FROM order_items x WHERE x.order_id = r.order_id) > 0)
      GROUP BY r.order_id
    )
    SELECT l.order_id, l.attributed, COALESCE(t.settled, 0) AS settled
    FROM lines l LEFT JOIN truth t ON t.order_id = l.order_id
    WHERE ABS(l.attributed - COALESCE(t.settled, 0)) >= 1
  `).all() as { order_id: string; attributed: number; settled: number }[];
  assert.deepEqual(rows.map(r => `${r.order_id}: attributed ${r.attributed} vs settled ${r.settled}`), []);
});

test('no two suppliers differ only by case, spaces or punctuation', { skip: !dbExists }, async () => {
  // Sept 23 2026: exact-name matching had split 14 suppliers into 32 rows.
  // Writes go through resolveSupplierId (src/lib/suppliers.ts).
  const { supplierKey } = await import('../src/lib/suppliers');
  const byKey = new Map<string, string[]>();
  for (const { name } of db!.prepare('SELECT name FROM suppliers').all() as { name: string }[]) {
    byKey.set(supplierKey(name), [...(byKey.get(supplierKey(name)) ?? []), name]);
  }
  assert.deepEqual([...byKey.values()].filter(v => v.length > 1), []);
});
