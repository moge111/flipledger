/**
 * Live Dashboard = P&L parity check.
 *
 * Runs the real /api/data/dashboard and /api/data/profitloss route handlers
 * (read-only) against the LIVE database for YTD and asserts exact agreement on
 * profit / revenue / COGS / fees for every marketplace slice. This is the
 * invariant CLAUDE.md tracks by hand ("Dashboard = P&L parity holds") — any
 * formula edit that lands in one route but not the other fails here
 * immediately instead of surfacing as a mystery gap weeks later.
 *
 * Totals change as syncs run, but EQUALITY between the two views is
 * date-independent, so this is stable. (If a sync writes between the two
 * calls there is a tiny race window — a failure that vanishes on re-run was
 * that, not a formula bug.)
 *
 * Known deliberate divergence: the P&L includes other_income in totalIncome,
 * the Dashboard does not query it. other_income has 0 rows (removed from the
 * app) — the guard test below fails if that ever changes, so the divergence
 * gets a real decision instead of silent drift.
 *
 * IMPORTANT: this file must NOT import tests/fixtures/golden-db (it would set
 * FLIPLEDGER_DB_PATH). node --test runs each file in its own process, so the
 * golden fixture in the sibling file can't leak into this one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');
const dbExists = fs.existsSync(DB_PATH);

const YTD = { startDate: '2026-01-01', endDate: new Date().toISOString().split('T')[0] };

async function fetchRoute(route: 'profitloss' | 'dashboard', params: Record<string, string>) {
  const mod = await import(`../src/app/api/data/${route}/route`);
  const url = `http://test.local/api/data/${route}?` + new URLSearchParams(params).toString();
  const res: Response = await mod.GET(new Request(url));
  assert.equal(res.status, 200, `${route} route should return 200`);
  return res.json();
}

test('other_income is empty (P&L counts it, Dashboard does not — non-empty would break parity)', { skip: !dbExists }, async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(DB_PATH, { readonly: true });
  const { n } = db.prepare(`SELECT COUNT(*) as n FROM other_income`).get() as { n: number };
  db.close();
  assert.equal(n, 0,
    'other_income has rows now — either add it to the Dashboard revenue query or remove it from the P&L totalIncome, then update this test');
});

test('YTD Dashboard = P&L parity on every marketplace slice (live data)', { skip: !dbExists }, async () => {
  const slices: Array<[string, Record<string, string>]> = [
    ['all', YTD],
    ['amazon', { ...YTD, marketplace: 'amazon' }],
    ['walmart', { ...YTD, marketplace: 'walmart' }],
    ['ebay', { ...YTD, marketplace: 'ebay' }],
  ];
  for (const [label, params] of slices) {
    const p = await fetchRoute('profitloss', params);
    const d = await fetchRoute('dashboard', params);
    assert.equal(d.stats.totalProfit, p.netProfit,
      `${label}: Dashboard profit ${d.stats.totalProfit} != P&L netProfit ${p.netProfit} — the two formulas drifted`);
    assert.equal(d.stats.totalRevenue, p.income.total, `${label}: revenue parity`);
    assert.equal(d.stats.totalCogs, p.expenses.cogs, `${label}: COGS parity`);
    assert.equal(d.stats.totalFees, p.expenses.totalFees, `${label}: fees parity`);
  }
});

test('Cash Flow months equal P&L netProfit month-by-month (live data)', { skip: !dbExists }, async () => {
  // The cashflow route buckets with the same formulas as the P&L — each
  // month's net must equal the P&L netProfit for that exact month range.
  const cf = await (async () => {
    const mod = await import('../src/app/api/data/cashflow/route');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: Response = await mod.GET(new Request('http://test.local/api/data/cashflow?months=12') as any);
    assert.equal(res.status, 200);
    return res.json();
  })();
  const complete = cf.months.filter((m: { partial: boolean }) => !m.partial);
  const recent = complete.slice(-3);
  assert.ok(recent.length > 0, 'need at least one complete month');
  for (const m of recent) {
    const [y, mo] = m.month.split('-').map(Number);
    const startDate = `${m.month}-01`;
    const endDate = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); // last day of month
    const p = await fetchRoute('profitloss', { startDate, endDate });
    assert.equal(m.net, p.netProfit,
      `${m.month}: cashflow net ${m.net} != P&L netProfit ${p.netProfit} — the two formulas drifted`);
    assert.equal(m.cogs, p.expenses.cogs, `${m.month}: COGS drifted`);
    assert.equal(m.orderFees + m.serviceFees, p.expenses.totalFees, `${m.month}: fees drifted`);
    assert.equal(m.refunds, p.refunds.total, `${m.month}: refunds drifted`);
  }
});

test('profitability totals equal raw order_items — no JOIN fan-out in any groupBy (live data)', { skip: !dbExists }, async () => {
  // Regression: the sku branch joined inventory_ledger raw, so every SKU with N
  // buy lots multiplied its units/revenue by N (wm-yoshiegg-55 had 3 lots and
  // reported 3x revenue at a fabricated 538% ROI). Units and revenue are pure
  // order_items sums — no join may change them, whatever we group by.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(DB_PATH, { readonly: true });
  const truth = db.prepare(`
    SELECT SUM(oi.quantity) as units, SUM(oi.total_price) as revenue
    FROM order_items oi
    JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events
          WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe
      ON oi.order_id = fe.order_id
    JOIN orders o ON oi.order_id = o.order_id
    WHERE fe.posted_date >= ? AND fe.posted_date < ?
  `).get(
    `${YTD.startDate}T00:00:00Z`,
    new Date(new Date(YTD.endDate).getTime() + 86400000).toISOString().split('T')[0] + 'T00:00:00Z',
  ) as { units: number; revenue: number };
  db.close();

  const mod = await import('../src/app/api/data/profitability/route');
  for (const groupBy of ['sku', 'asin', 'supplier', 'category']) {
    const url = `http://test.local/api/data/profitability?groupBy=${groupBy}&`
      + new URLSearchParams(YTD).toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: Response = await mod.GET(new Request(url) as any);
    assert.equal(res.status, 200, `${groupBy}: route should return 200`);
    const { totals } = await res.json();
    assert.equal(totals.unitsSold, truth.units,
      `groupBy=${groupBy}: unitsSold ${totals.unitsSold} != raw ${truth.units} — a JOIN is fanning rows out`);
    assert.equal(totals.revenue, truth.revenue,
      `groupBy=${groupBy}: revenue ${totals.revenue} != raw ${truth.revenue} — a JOIN is fanning rows out`);
  }
});

test('profitability "Inventory Value" equals the /inventory page (live data)', { skip: !dbExists }, async () => {
  // Regression: the card used to be `totals.onHand * totals.costPerUnit` —
  // a portfolio-wide unit count (incl. placeholder qty-1000 FIFO headroom lots)
  // cross-multiplied by blended cost-per-unit-SOLD, reporting ~$5M against a
  // real ~$17K. Both views must value the same stock the same way.
  const inv = await (async () => {
    const mod = await import('../src/app/api/data/inventory-overview/route');
    const res: Response = await mod.GET();
    assert.equal(res.status, 200);
    return res.json();
  })();

  const mod = await import('../src/app/api/data/profitability/route');
  const url = 'http://test.local/api/data/profitability?groupBy=sku&' + new URLSearchParams(YTD).toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Response = await mod.GET(new Request(url) as any);
  assert.equal(res.status, 200);
  const { totals } = await res.json();

  assert.equal(totals.inventoryValue, inv.totals.totalCostValue,
    `profitability inventoryValue ${totals.inventoryValue} != /inventory totalCostValue ${inv.totals.totalCostValue}`);
  assert.equal(totals.inventoryUnits, inv.totals.totalUnits,
    `profitability inventoryUnits ${totals.inventoryUnits} != /inventory totalUnits ${inv.totals.totalUnits}`);
  assert.ok(totals.inventoryUnits < 10000,
    `inventoryUnits ${totals.inventoryUnits} looks like placeholder FIFO headroom lots leaked back in`);
});

test('non-MFN shipping credits in income are exactly matched by ShippingChargeback fees', { skip: !dbExists }, async () => {
  // Regression: the P&L excluded ALL non-MFN shipping credits from income on
  // the assumption they were "offset by ShippingChargeback fees" — but the
  // chargeback was still counted as a fee, so every charged-back order was
  // penalised twice. Verified against Amazon's Unified Transaction Report:
  // the credit IS in Amazon's payout total. Counting the credit and the
  // chargeback together nets to zero, which is the correct treatment.
  //
  // The invariant that must hold forever: whatever non-MFN shipping credit the
  // P&L counts as income, an equal ShippingChargeback must sit in fees. If
  // income is counted without the fee we overstate; the reverse understates.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(MIN(x.sc, x.cb)), 0) as counted,
      COALESCE(SUM(x.cb), 0) as chargebacks
    FROM (
      SELECT oi.order_id,
             SUM(oi.shipping_charged) as sc,
             COALESCE((SELECT -SUM(fd.amount) FROM fee_details fd
                       WHERE fd.order_id = oi.order_id
                         AND fd.fee_type = 'ShippingChargeback'), 0) as cb
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events
            WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe
        ON oi.order_id = fe.order_id
      WHERE fe.posted_date >= ? AND o.fulfillment_channel NOT IN ('MFN', 'Seller')
      GROUP BY oi.order_id
    ) x
    WHERE x.sc > 0 AND x.cb > 0
  `).get(`${YTD.startDate}T00:00:00Z`) as { counted: number; chargebacks: number };
  db.close();

  const p = await fetchRoute('profitloss', YTD);
  assert.equal(p.income.fbaShippingCredits, row.counted,
    `P&L counted ${p.income.fbaShippingCredits} of non-MFN shipping credit, chargeback-gated rule says ${row.counted}`);
  assert.equal(p.income.shippingCredits, p.income.mfnShippingCredits + p.income.fbaShippingCredits,
    'shippingCredits must be exactly MFN + charged-back non-MFN');
  assert.ok(row.counted > 0,
    'no charged-back shipping credits found at all — the rule is no longer exercised, re-verify it still applies');
  assert.equal(row.counted, row.chargebacks,
    `counted credit ${row.counted} != chargebacks ${row.chargebacks} — the credit/fee pair no longer cancels`);
});

test('YTD cash vs accrual both compute (no crash) and use integer cents', { skip: !dbExists }, async () => {
  for (const dateBasis of ['posted', 'purchase']) {
    const p = await fetchRoute('profitloss', { ...YTD, dateBasis });
    assert.ok(Number.isInteger(p.netProfit), `${dateBasis}: netProfit must be integer cents, got ${p.netProfit}`);
    assert.ok(Number.isInteger(p.expenses.totalFees), `${dateBasis}: totalFees must be integer cents`);
  }
});
