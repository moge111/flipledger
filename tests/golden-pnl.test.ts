/**
 * Golden-dataset regression tests for the accounting engine.
 *
 * Runs the REAL /api/data/profitloss and /api/data/dashboard route handlers
 * against the hand-computed fixture in fixtures/golden-db.ts and asserts exact
 * integer-cent figures per marketplace and month, plus Dashboard = P&L parity.
 *
 * Every expected value below is derived by hand from the fixture seed. If any
 * of these break, an accounting formula changed — do NOT update the goldens
 * without re-deriving them by hand and understanding why.
 *
 * Regression coverage for the historical bug classes:
 *  - SUM(ABS) fee sign bug: the +$3.75 clawback must REDUCE Jan Amazon fees
 *  - ghost Walmart refunds: unsettled refund must be EXCLUDED
 *  - clawback double-count: netProfit must NOT add refund clawback back
 *  - cash vs accrual date basis: cross-month order lands in the right month
 *  - fan-out joins: salesDetail row count and revenue sum stay exact
 *  - Dashboard vs P&L formula drift: exact parity on every slice
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pnlGET: (req: any) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dashGET: (req: any) => Promise<Response>;

before(async () => {
  golden = await buildGoldenDb(); // sets FLIPLEDGER_DB_PATH for this process
  pnlGET = (await import('../src/app/api/data/profitloss/route')).GET;
  dashGET = (await import('../src/app/api/data/dashboard/route')).GET;
});

after(() => golden?.cleanup());

const JAN = { startDate: '2026-01-01', endDate: '2026-01-31' };
const FEB = { startDate: '2026-02-01', endDate: '2026-02-28' };

async function pnl(params: Record<string, string>) {
  const url = 'http://test.local/api/data/profitloss?' + new URLSearchParams(params).toString();
  const res = await pnlGET(new Request(url));
  assert.equal(res.status, 200, 'P&L route should return 200');
  return res.json();
}

async function dashboard(params: Record<string, string>) {
  const url = 'http://test.local/api/data/dashboard?' + new URLSearchParams(params).toString();
  const res = await dashGET(new Request(url));
  assert.equal(res.status, 200, 'Dashboard route should return 200');
  return res.json();
}

// ─────────────────────────── January, cash basis ───────────────────────────

test('Jan Amazon (cash): fees use -SUM so the clawback credit reduces them', async () => {
  const d = await pnl({ ...JAN, marketplace: 'amazon' });
  assert.equal(d.income.sales, 5000);
  assert.equal(d.income.shippingCredits, 0);
  assert.equal(d.income.total, 5000);
  assert.equal(d.expenses.cogs, 2000);
  // Order fees 750 + 600 − 375 clawback = 975. A SUM(ABS) regression would
  // report 1725 here (and totalFees 5724).
  assert.equal(d.expenses.totalFees, 975 + 3999);
  assert.equal(d.expenses.shippingCosts, 0);
  assert.equal(d.refunds.total, 0); // refund is dated Feb 3
  assert.equal(d.reimbursements, 0);
  assert.equal(d.netProfit, 5000 - (2000 + 4974) /* = -1974 */);
});

test('Jan Amazon (cash): service fee is marketplace-scoped and month-dated', async () => {
  const d = await pnl({ ...JAN, marketplace: 'amazon' });
  const otherFees = d.expenses.feeHierarchy['Other Fees'];
  assert.ok(otherFees, 'Subscription service fee should appear under Other Fees');
  assert.equal(otherFees.total, 3999);
  // And it must NOT leak into the Walmart view
  const w = await pnl({ ...JAN, marketplace: 'walmart' });
  assert.equal(w.expenses.feeHierarchy['Other Fees'], undefined);
});

test('Jan Walmart (cash): revenue, fees, reimbursement', async () => {
  const d = await pnl({ ...JAN, marketplace: 'walmart' });
  assert.equal(d.income.sales, 18000);
  assert.equal(d.expenses.cogs, 11400);
  assert.equal(d.expenses.totalFees, 1765);
  assert.equal(d.reimbursements, 1700);
  assert.equal(d.refunds.total, 0);
  assert.equal(d.netProfit, 18000 - (11400 + 1765) + 1700 /* = 6535 */);
});

test('Jan All Marketplaces (cash): business expenses only in the All view', async () => {
  const d = await pnl(JAN);
  assert.equal(d.income.total, 23000);
  assert.equal(d.expenses.cogs, 13400);
  assert.equal(d.expenses.totalFees, 2740 + 3999);
  assert.equal(d.expenses.otherExpenses, 10000); // insurance — All view only
  assert.equal(d.netProfit, 23000 - (13400 + 6739 + 10000) + 1700 /* = -5439 */);

  // Per-marketplace views must exclude the business-wide expense
  const a = await pnl({ ...JAN, marketplace: 'amazon' });
  assert.equal(a.expenses.otherExpenses, 0);
});

test('Jan All (cash): salesDetail has no fan-out — 3 rows summing to total sales', async () => {
  const d = await pnl(JAN);
  assert.equal(d.salesDetail.length, 3); // A1, W1, W2 — A2 posts in Feb
  const revenueSum = d.salesDetail.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0);
  assert.equal(revenueSum, 23000);
});

// ─────────────────────────── February, cash basis ──────────────────────────

test('Feb Amazon (cash): cross-month order lands here; clawback not double-counted', async () => {
  const d = await pnl({ ...FEB, marketplace: 'amazon' });
  assert.equal(d.income.sales, 8000); // A2 posted Feb 2
  assert.equal(d.income.shippingCredits, 500); // MFN shipping credit is income
  assert.equal(d.income.total, 8500);
  assert.equal(d.expenses.cogs, 3000);
  assert.equal(d.expenses.totalFees, 1200); // A1's fees (incl. clawback) key to Jan
  assert.equal(d.expenses.shippingCosts, 842); // MFN out-of-pocket shipping
  assert.equal(d.refunds.total, 2500);
  // netProfit must NOT add refunds.clawback back (it's already netted into
  // fees via the positive Commission line — adding it again was the May 14 bug,
  // which would report 1333 here instead of 958).
  assert.equal(d.refunds.clawback, 375);
  assert.equal(d.netProfit, 8500 - (3000 + 1200 + 842) - 2500 /* = 958 */);
});

test('Feb Walmart (cash): ghost refund excluded, settled refund counted', async () => {
  const d = await pnl({ ...FEB, marketplace: 'walmart' });
  // W1's $70.00 refund settled (WalmartRefundEvent exists) → counted.
  // W2's $40.00 refund is a ghost (no recon settlement) → excluded.
  assert.equal(d.refunds.total, 7000, 'ghost Walmart refund must not be counted');
  assert.equal(d.netProfit, -7000);
  // refundDetail must show only the settled refund
  assert.equal(d.refundDetail.length, 1);
  assert.equal(d.refundDetail[0].order_id, 'GOLD-WMT-W1');
});

test('Feb All Marketplaces (cash)', async () => {
  const d = await pnl(FEB);
  assert.equal(d.income.total, 8500);
  assert.equal(d.expenses.otherExpenses, 0); // Jan 31 expense not in Feb
  assert.equal(d.refunds.total, 9500);
  assert.equal(d.netProfit, 8500 - (3000 + 1200 + 842) - 9500 /* = -6042 */);
});

// ─────────────────────────── Accrual basis ─────────────────────────────────

test('Jan Amazon (accrual): cross-month order pulls into purchase month', async () => {
  const d = await pnl({ ...JAN, marketplace: 'amazon', dateBasis: 'purchase' });
  assert.equal(d.income.sales, 13000); // A1 + A2 both purchased in Jan
  assert.equal(d.income.shippingCredits, 500);
  assert.equal(d.expenses.cogs, 5000);
  assert.equal(d.expenses.totalFees, 2175 + 3999); // order fees by purchase date; service fees keep own date
  assert.equal(d.expenses.shippingCosts, 842);
  assert.equal(d.refunds.total, 0); // refunds always use refund_date
  assert.equal(d.netProfit, 13500 - (5000 + 6174 + 842) /* = 1484 */);
});

test('Feb Amazon (accrual): only the refund remains', async () => {
  const d = await pnl({ ...FEB, marketplace: 'amazon', dateBasis: 'purchase' });
  assert.equal(d.income.total, 0);
  assert.equal(d.refunds.total, 2500);
  assert.equal(d.netProfit, -2500);
});

// ─────────────────────── Dashboard = P&L parity ─────────────────────────────

test('Dashboard equals P&L on every period × marketplace slice', async () => {
  const slices: Array<[string, Record<string, string>]> = [
    ['Jan all', JAN],
    ['Jan amazon', { ...JAN, marketplace: 'amazon' }],
    ['Jan walmart', { ...JAN, marketplace: 'walmart' }],
    ['Feb all', FEB],
    ['Feb amazon', { ...FEB, marketplace: 'amazon' }],
    ['Feb walmart', { ...FEB, marketplace: 'walmart' }],
  ];
  for (const [label, params] of slices) {
    const [p, dash] = [await pnl(params), await dashboard(params)];
    assert.equal(dash.stats.totalProfit, p.netProfit, `${label}: profit parity`);
    assert.equal(dash.stats.totalRevenue, p.income.total, `${label}: revenue parity`);
    assert.equal(dash.stats.totalCogs, p.expenses.cogs, `${label}: COGS parity`);
    assert.equal(dash.stats.totalFees, p.expenses.totalFees, `${label}: fees parity`);
  }
});

test('Dashboard golden spot-checks (units, inventory value)', async () => {
  const d = await dashboard(JAN);
  assert.equal(d.stats.totalUnits, 5); // A1×2 + W1×1 + W2×2
  assert.equal(d.stats.totalOrders, 3);
  assert.equal(d.inventoryValue.totalValue, 5000); // 5 fulfillable × $10.00 buy price
  assert.equal(d.inventoryValue.totalUnits, 7); // fulfillable 5 + inbound 2
});
