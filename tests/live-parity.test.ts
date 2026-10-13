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
import { MKT_DATE, addDays } from '../src/lib/market-day';

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

test('Dashboard chart buckets sum to the Total Revenue / Total Profit cards (live data)', { skip: !dbExists }, async () => {
  // Review C2 (Sept 23 2026): the chart used to be sales minus order fees
  // only, so its bars disagreed with the cards on the same page. Every
  // grouping (monthly / weekly / daily) must now sum to the cards exactly.
  const ranges: Array<[string, string, string]> = [
    ['monthly', YTD.startDate, YTD.endDate],
    ['weekly', addDays(YTD.endDate, -50), YTD.endDate],
    ['daily', addDays(YTD.endDate, -20), YTD.endDate],
  ];
  for (const [grouping, startDate, endDate] of ranges) {
    for (const m of ['', 'amazon', 'walmart', 'ebay']) {
      const d = await fetchRoute('dashboard', { startDate, endDate, ...(m ? { marketplace: m } : {}) });
      const rows = d.dailyRevenue as { revenue: number; profit: number; grouping: string }[];
      const label = `${grouping} ${m || 'all'}`;
      if (rows.length) assert.equal(rows[0].grouping, grouping, `${label}: grouping`);
      assert.equal(rows.reduce((a, r) => a + r.revenue, 0), d.stats.totalRevenue, `${label}: chart revenue != card`);
      assert.equal(rows.reduce((a, r) => a + r.profit, 0), d.stats.totalProfit, `${label}: chart profit != card`);
    }
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
    WHERE ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ?
  `).get(
    YTD.startDate,
    addDays(YTD.endDate, 1),
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

test('profitability fees, COGS, refunds and profit are identical in every groupBy (live data)', { skip: !dbExists }, async () => {
  // Review C1 (Sept 2026): rows were keyed on COALESCE(s.name,'Unknown') /
  // COALESCE(p.category,'Uncategorized') while the fee and COGS maps used the
  // raw column, so the Unknown bucket got $0 fees and $0 COGS (2026 Supplier
  // profit 2.3x too high; Category showed revenue as profit). Regrouping the
  // same sales can never change a total.
  const mod = await import('../src/app/api/data/profitability/route');
  for (const marketplace of ['', 'amazon', 'walmart', 'ebay']) {
    const totals: Record<string, Record<string, number>> = {};
    for (const groupBy of ['sku', 'asin', 'supplier', 'category']) {
      const url = `http://test.local/api/data/profitability?groupBy=${groupBy}&`
        + new URLSearchParams({ ...YTD, ...(marketplace ? { marketplace } : {}) }).toString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: Response = await mod.GET(new Request(url) as any);
      assert.equal(res.status, 200);
      totals[groupBy] = (await res.json()).totals;
    }
    for (const groupBy of ['asin', 'supplier', 'category']) {
      for (const k of ['fees', 'cogs', 'profit', 'refunds']) {
        assert.ok(Math.abs(totals[groupBy][k] - totals.sku[k]) < 0.5,
          `${marketplace || 'all'} ${groupBy}.${k} ${totals[groupBy][k]} != sku.${k} ${totals.sku[k]}`);
      }
    }
  }
});

test('profitability "Refunded" equals the settled refunds on the orders it covers (live data)', { skip: !dbExists }, async () => {
  // Review C3: per-line attribution (SKU match, else split by revenue) must
  // neither drop nor duplicate a refund. Truth = every settled refund on an
  // order posted in range that the attribution can place (a SKU match, or an
  // order with product revenue to split across).
  const { walmartSettledRefund } = await import('../src/lib/accounting-sql');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(DB_PATH, { readonly: true });
  const truth = (db.prepare(`
    SELECT COALESCE(SUM(r.refund_amount), 0) AS c FROM refunds r
    JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events
          WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON r.order_id = fe.order_id
    WHERE ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ?
      AND ${walmartSettledRefund('r', true)}
      AND (EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = r.order_id AND x.sku = r.sku)
           OR (SELECT SUM(x.total_price) FROM order_items x WHERE x.order_id = r.order_id) > 0)
  `).get(YTD.startDate, addDays(YTD.endDate, 1)) as { c: number }).c;
  db.close();
  const mod = await import('../src/app/api/data/profitability/route');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Response = await mod.GET(new Request('http://test.local/api/data/profitability?groupBy=sku&' + new URLSearchParams(YTD)) as any);
  const { totals } = await res.json();
  assert.ok(truth > 0, 'expected some settled refunds YTD');
  assert.ok(Math.abs(totals.refunded - truth) < 1, `profitability refunded ${totals.refunded} != settled refunds ${truth}`);
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

test('salesDetail rows reconcile to the header income lines (live data)', { skip: !dbExists }, async () => {
  // The per-order rows must account for exactly the same money the header does.
  // Before Aug 29 2026 the rows dropped the shipping credit while still
  // subtracting the label cost and the ShippingHB referral fee charged on that
  // shipping income, so a buyer-paid-expedited order displayed as a large loss.
  // A short trailing window keeps the row set under salesDetail's LIMIT 500.
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400000);
  const win = { startDate: start.toISOString().split('T')[0], endDate: end.toISOString().split('T')[0] };

  for (const params of [win, { ...win, marketplace: 'amazon' }]) {
    const d = await fetchRoute('profitloss', params);
    const rows: Array<Record<string, number>> = d.salesDetail;
    if (rows.length === 0) continue;
    assert.ok(rows.length < 500, 'window too large — salesDetail hit its LIMIT, pick a shorter one');

    const sum = (k: string) => rows.reduce((s, r) => s + r[k], 0);
    assert.equal(sum('product_revenue'), d.income.sales,
      'salesDetail product revenue must equal the header sales line');
    assert.equal(sum('shippingCredit'), d.income.shippingCredits,
      'salesDetail shipping credits must equal the header shippingCredits line');

    for (const r of rows) {
      assert.equal(r.revenue, r.product_revenue + r.shippingCredit, `${r.order_id}: revenue composition`);
      assert.equal(r.net_profit, r.revenue - r.cogs + r.fees - r.shippingCost, `${r.order_id}: net_profit composition`);
      assert.ok(r.shippingCredit >= 0, `${r.order_id}: shipping credit must never be negative`);
    }
  }
});

test('YTD cash vs accrual both compute (no crash) and use integer cents', { skip: !dbExists }, async () => {
  for (const dateBasis of ['posted', 'purchase']) {
    const p = await fetchRoute('profitloss', { ...YTD, dateBasis });
    assert.ok(Number.isInteger(p.netProfit), `${dateBasis}: netProfit must be integer cents, got ${p.netProfit}`);
    assert.ok(Number.isInteger(p.expenses.totalFees), `${dateBasis}: totalFees must be integer cents`);
  }
});
