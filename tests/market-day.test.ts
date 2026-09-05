/**
 * Marketplace-day bucketing guards.
 *
 * Amazon and Walmart close their sales day at midnight Pacific (1 AM Mountain).
 * FlipLedger used to bucket on the UTC calendar date, which closed the day at
 * 6 PM Mountain, pushing every late-afternoon sale onto the following day — and
 * at each month/year boundary, into the following period. src/lib/market-day.ts
 * fixes that. These tests lock down the three things that can silently break it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { MKT_DATE, MKT_MONTH, marketDate, addDays } from '../src/lib/market-day';

const DB_PATH = path.join(process.cwd(), 'data', 'flipledger.db');
const hasLiveDb = fs.existsSync(DB_PATH);

function bucket(expr: string, value: string): string {
  const db = new Database(':memory:');
  const row = db.prepare(`SELECT ${expr} AS d`).get({}) as { d: string };
  db.close();
  return row.d;
}
function mkt(value: string): string {
  return bucket(MKT_DATE(`'${value}'`), value);
}

test('real UTC instants bucket onto the Pacific marketplace day', () => {
  // 2026-09-01T00:39:31Z is 6:39 PM Mountain on Aug 31 — the exact shape of the
  // bug. Under the old date() it read as September.
  assert.equal(mkt('2026-09-01T00:39:31Z'), '2026-08-31');
  // 11:27 PM Mountain Aug 31 — still Aug 31 on the marketplace calendar.
  assert.equal(mkt('2026-09-01T05:27:00Z'), '2026-08-31');
  // Morning instants are unaffected.
  assert.equal(mkt('2026-08-31T14:11:05.990Z'), '2026-08-31');
});

test('DST is handled: a winter instant crosses the YEAR boundary correctly', () => {
  // 2026-01-01T06:30:00Z is 10:30 PM PST on Dec 31 — belongs to the PRIOR tax
  // year. Getting this wrong misstates the year against Amazon's 1099-K, which
  // is cut on Amazon's own marketplace day.
  assert.equal(mkt('2026-01-01T06:30:00Z'), '2025-12-31');
  // And a summer instant one hour past Pacific midnight rolls forward.
  assert.equal(mkt('2026-07-01T07:30:00Z'), '2026-07-01');
});

test('date-only values are NEVER shifted (the ~14k Walmart recon rows)', () => {
  // Walmart recon reports carry a calendar DATE with no time-of-day; it is
  // stored as midnight UTC. Converting those to Pacific would move every one of
  // them back a day and silently corrupt every Walmart figure in the books.
  assert.equal(mkt('2026-08-31T00:00:00Z'), '2026-08-31');
  assert.equal(mkt('2026-08-31T00:00:00'), '2026-08-31');
  assert.equal(mkt('2026-08-01'), '2026-08-01');
});

test('MKT_MONTH follows MKT_DATE across a month boundary', () => {
  assert.equal(bucket(MKT_MONTH(`'2026-09-01T00:39:31Z'`), ''), '2026-08');
  assert.equal(bucket(MKT_MONTH(`'2026-08-31T00:00:00Z'`), ''), '2026-08');
});

test('marketDate() agrees with the SQL fragment for the same instant', () => {
  // The client picker and the SQL must not drift apart, or "Today" selects a
  // range the queries then bucket differently.
  for (const iso of ['2026-09-01T00:39:31Z', '2026-01-01T06:30:00Z', '2026-07-01T07:30:00Z']) {
    assert.equal(marketDate(new Date(iso)), mkt(iso), `JS and SQL disagree on ${iso}`);
  }
});

test('addDays does calendar math without timezone drift', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('reporting routes never bind an instant against a date bucket', () => {
  // MKT_DATE() yields 'YYYY-MM-DD'. Binding a 'YYYY-MM-DDT00:00:00Z' parameter
  // against it silently drops the whole first day, because lexicographically
  // '2026-01-01' < '2026-01-01T00:00:00Z'. This regressed the profitability
  // route by 18 units before the suite caught it.
  const dir = path.join(process.cwd(), 'src', 'app', 'api', 'data');
  const offenders: string[] = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'route.ts');
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('MKT_DATE')) continue;
    if (/\+ 'T00:00:00Z'/.test(src)) offenders.push(d);
  }
  assert.deepEqual(offenders, [], `routes mixing instant params with date buckets: ${offenders.join(', ')}`);
});

test('live: no stored value can be mistaken for a date-only value', { skip: !hasLiveDb }, () => {
  // The guard keys off `T00:00:00` with no sub-second part. If a genuine event
  // ever posts at exactly midnight UTC *with* milliseconds the partition stops
  // being exact, so assert the ambiguous shape does not exist.
  const db = new Database(DB_PATH, { readonly: true });
  for (const t of ['financial_events', 'fee_details']) {
    const { n } = db.prepare(
      `SELECT COUNT(*) AS n FROM ${t} WHERE posted_date LIKE '%T00:00:00.%'`
    ).get() as { n: number };
    assert.equal(n, 0, `${t} has ${n} rows where the date-only guard is ambiguous`);
  }
  db.close();
});

test('live: Walmart recon rows bucket identically before and after conversion', { skip: !hasLiveDb }, () => {
  const db = new Database(DB_PATH, { readonly: true });
  const { moved } = db.prepare(`
    SELECT COUNT(*) AS moved FROM financial_events
    WHERE posted_date LIKE '%T00:00:00%'
      AND ${MKT_DATE('posted_date')} != date(posted_date)
  `).get() as { moved: number };
  db.close();
  assert.equal(moved, 0, `${moved} date-only rows shifted — the guard in MKT_DATE is broken`);
});

test('live: real Amazon/eBay instants DO move when they fall after Pacific midnight',
  { skip: !hasLiveDb }, () => {
  // The mirror of the test above: proves the conversion is actually applied and
  // this whole file is not passing vacuously.
  const db = new Database(DB_PATH, { readonly: true });
  const { moved } = db.prepare(`
    SELECT COUNT(*) AS moved FROM financial_events
    WHERE posted_date LIKE '%T%' AND posted_date NOT LIKE '%T00:00:00%'
      AND ${MKT_DATE('posted_date')} != date(posted_date)
  `).get() as { moved: number };
  db.close();
  assert.ok(moved > 0, 'no instants moved — conversion is not being applied');
});

test('MKT_WEEK_START buckets Sun..Sat onto that week\'s own Sunday', async () => {
  const { MKT_WEEK_START } = await import('../src/lib/market-day');
  const week = (v: string) => bucket(MKT_WEEK_START(`'${v}'`), v);
  // 2026-08-30 is a Sunday.
  assert.equal(week('2026-08-30'), '2026-08-30', 'Sunday is its own week start');
  assert.equal(week('2026-09-02'), '2026-08-30', 'Wednesday');
  assert.equal(week('2026-09-05'), '2026-08-30', 'Saturday closes the week');
  assert.equal(week('2026-09-06'), '2026-09-06', 'next Sunday opens a new week');
  // A real instant late Sunday evening Mountain is still that Sunday on the marketplace calendar.
  assert.equal(week('2026-09-07T04:30:00Z'), '2026-09-06');
});
