/**
 * Golden regression tests for /api/data/cashflow.
 *
 * Runs the real cashflow route handler against the golden fixture and asserts
 * that each month's components and net match the hand-computed P&L goldens
 * (a cashflow month MUST equal the P&L net profit for that month — same
 * formulas, different grouping). Also exercises the cash-on-hand POST
 * round-trip and the runway summary fields.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

let golden: GoldenDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cashflowMod: any;

before(async () => {
  golden = await buildGoldenDb();
  cashflowMod = await import('../src/app/api/data/cashflow/route');
});

after(() => golden?.cleanup());

async function getCashflow(monthsBack: number) {
  const res: Response = await cashflowMod.GET(new Request(`http://test.local/api/data/cashflow?months=${monthsBack}`));
  assert.equal(res.status, 200);
  return res.json();
}

// The fixture lives in Jan/Feb 2026; the window is relative to today, so make
// it wide enough to always include both months.
const WINDOW = 24;

test('Jan 2026 matches the P&L golden exactly', async () => {
  const data = await getCashflow(WINDOW);
  const jan = data.months.find((m: { month: string }) => m.month === '2026-01');
  assert.ok(jan, 'Jan 2026 must be in the window');
  assert.equal(jan.salesIncome, 23000);
  assert.equal(jan.mfnShippingCredits, 0);
  assert.equal(jan.reimbursements, 1700);
  assert.equal(jan.cashIn, 24700);
  assert.equal(jan.cogs, 13400);
  assert.equal(jan.orderFees, 2740);
  assert.equal(jan.serviceFees, 3999);
  assert.equal(jan.refunds, 0);
  assert.equal(jan.expenses, 10000);
  assert.equal(jan.cashOut, 30139);
  assert.equal(jan.net, -5439, 'Jan net must equal the P&L golden netProfit');
});

test('Feb 2026 matches the P&L golden exactly (ghost refund excluded)', async () => {
  const data = await getCashflow(WINDOW);
  const feb = data.months.find((m: { month: string }) => m.month === '2026-02');
  assert.ok(feb, 'Feb 2026 must be in the window');
  assert.equal(feb.salesIncome, 8000);
  assert.equal(feb.mfnShippingCredits, 500);
  assert.equal(feb.cashIn, 8500);
  assert.equal(feb.cogs, 3000);
  assert.equal(feb.orderFees, 1200);
  assert.equal(feb.serviceFees, 0);
  // 2500 Amazon + 7000 settled Walmart; the 4000 GHOST Walmart refund excluded
  assert.equal(feb.refunds, 9500);
  assert.equal(feb.shippingCosts, 842);
  assert.equal(feb.cashOut, 14542);
  assert.equal(feb.net, -6042, 'Feb net must equal the P&L golden netProfit');
});

test('months are densified (zero months present), current month flagged partial', async () => {
  const data = await getCashflow(WINDOW);
  const mar = data.months.find((m: { month: string }) => m.month === '2026-03');
  assert.ok(mar, 'zero-activity months must still appear');
  assert.equal(mar.net, 0);
  const last = data.months[data.months.length - 1];
  assert.equal(last.partial, true, 'the current month must be flagged partial');
  const complete = data.months.filter((m: { partial: boolean }) => !m.partial);
  assert.ok(!complete.some((m: { partial: boolean }) => m.partial));
});

test('inventory-at-cost card uses live_inventory total_qty × latest lot cost', async () => {
  const data = await getCashflow(WINDOW);
  // Fixture: live_inventory 5 fulfillable + 2 inbound = 7 total_qty × $10.00,
  // no qualifying local lots (the one ledger lot's SKU is in live_inventory).
  assert.equal(data.summary.inventory.atCost, 7000);
  assert.equal(data.summary.inventory.units, 7);
});

test('cash-on-hand POST round-trip and runway math', async () => {
  // Fixture's recent complete months are all zeros → avgNet3 = 0 → not
  // burning → runway is null regardless of cash.
  let res: Response = await cashflowMod.POST(new Request('http://test.local/api/data/cashflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashOnHandCents: 4624499 }),
  }));
  assert.equal(res.status, 200);

  let data = await getCashflow(WINDOW);
  assert.equal(data.summary.cashOnHand, 4624499);
  assert.ok(data.summary.cashUpdatedAt);
  assert.equal(data.summary.burnRate, null);
  assert.equal(data.summary.runwayMonths, null);

  // Clearing removes the setting
  res = await cashflowMod.POST(new Request('http://test.local/api/data/cashflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashOnHandCents: null }),
  }));
  assert.equal(res.status, 200);
  data = await getCashflow(WINDOW);
  assert.equal(data.summary.cashOnHand, null);

  // Validation: non-integer rejected
  res = await cashflowMod.POST(new Request('http://test.local/api/data/cashflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cashOnHandCents: 12.5 }),
  }));
  assert.equal(res.status, 400);
});
