import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, MKT_MONTH, marketToday } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { ORDER_POSTED_DATE, walmartSettledRefund, chargedBackShippingInner, mfnShippingCreditExpr, mfnShippingCostExpr, ORDER_FEE_ROWS, SERVICE_FEE_ROWS, SIGNED_FEE_TOTAL } from '@/lib/accounting-sql';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/cashflow');

/**
 * GET /api/data/cashflow — monthly operating cash flow + runway inputs.
 *
 * Each month uses the SAME cash-basis formulas as the P&L route (posted-date
 * subquery, -SUM fees, Walmart ghost-refund gate, service fees by own posted
 * date, business expenses all-marketplace), so a month's `net` here equals the
 * P&L netProfit for that month exactly — enforced by tests/golden-cashflow and
 * tests/live-parity.
 *
 * Honesty notes (also shown on the page):
 * - COGS is recognized at SALE time (FIFO). Actual inventory buy timing is not
 *   reliably tracked (inventory_ledger has placeholder/headroom lots), so the
 *   monthly net is a steady-state operating cash flow, not a bank-statement
 *   reconstruction.
 * - Card payments/interest and owner draws are not tracked.
 * - Cash on hand has no bank feed — it's a user-entered figure persisted in
 *   settings (POST below).
 */
const getDb = (readonly = true) => openDb({ readonly });

// Same gate as the P&L: Walmart refunds only count once the seller debit
// settled in recon (WalmartRefundEvent / Product Price).
const WALMART_SETTLED = walmartSettledRefund('r');

interface MonthRow {
  month: string;
  salesIncome: number;
  mfnShippingCredits: number;
  otherIncome: number;
  reimbursements: number;
  cashIn: number;
  cogs: number;
  orderFees: number;
  serviceFees: number;
  refunds: number;
  shippingCosts: number;
  expenses: number;
  cashOut: number;
  net: number;
  partial: boolean;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const monthsBack = Math.min(36, Math.max(3, parseInt(searchParams.get('months') || '12')));
  const db = getDb();

  try {
    // "Now" on the marketplace calendar — the UTC month flips ~6 PM Mountain
    // on the last day of a month, which marked the old month complete and the
    // new one partial hours early.
    const currentMonth = marketToday().slice(0, 7);
    const [curY, curM] = currentMonth.split('-').map(Number);
    const start = new Date(Date.UTC(curY, curM - 1 - (monthsBack - 1), 1));
    const startDate = start.toISOString().slice(0, 10);

    const byMonth = <T extends { m: string }>(rows: T[]) => new Map(rows.map(r => [r.m, r]));

    const sales = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('fe.posted_date')} as m,
        COALESCE(SUM(oi.total_price), 0) as sales,
        COALESCE(SUM(${mfnShippingCreditExpr()}), 0) as mfnShip,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs,
        COALESCE(SUM(${mfnShippingCostExpr()}), 0) as shipCost
      FROM order_items oi
      JOIN ${ORDER_POSTED_DATE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE fe.posted_date >= ?
      GROUP BY m
    `).all(startDate) as { m: string; sales: number; mfnShip: number; cogs: number; shipCost: number }[]);

    // Non-MFN shipping credits that Amazon charges back are income too (the
    // chargeback sits in orderFees, so the pair nets to zero). Mirrors the P&L
    // — see the note in src/app/api/data/profitloss/route.ts.
    const cbShip = byMonth(db.prepare(`
      SELECT x.m, COALESCE(SUM(MIN(x.sc, x.cb)), 0) as cbShip
      FROM (${chargedBackShippingInner(ORDER_POSTED_DATE, 'fe.posted_date >= ?', `${MKT_MONTH('fe.posted_date')} as m, `)}) x
      WHERE x.sc > 0 AND x.cb > 0
      GROUP BY x.m
    `).all(startDate) as { m: string; cbShip: number }[]);

    const orderFees = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('fe.posted_date')} as m, ${SIGNED_FEE_TOTAL} as fees
      FROM fee_details fd
      JOIN ${ORDER_POSTED_DATE} fe ON fd.order_id = fe.order_id
      WHERE ${ORDER_FEE_ROWS} AND fe.posted_date >= ?
      GROUP BY m
    `).all(startDate) as { m: string; fees: number }[]);

    const serviceFees = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('fd.posted_date')} as m, ${SIGNED_FEE_TOTAL} as fees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS} AND ${MKT_DATE('fd.posted_date')} >= ?
      GROUP BY m
    `).all(startDate) as { m: string; fees: number }[]);

    const refunds = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('r.refund_date')} as m, COALESCE(SUM(r.refund_amount), 0) as total
      FROM refunds r
      WHERE r.refund_date >= ? AND ${WALMART_SETTLED}
      GROUP BY m
    `).all(startDate) as { m: string; total: number }[]);

    const reimb = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('reimbursement_date')} as m, COALESCE(SUM(amount), 0) as total
      FROM reimbursements WHERE reimbursement_date >= ? GROUP BY m
    `).all(startDate) as { m: string; total: number }[]);

    const expenses = byMonth(db.prepare(`
      SELECT strftime('%Y-%m', date) as m, COALESCE(SUM(amount), 0) as total
      FROM expenses WHERE date >= ? GROUP BY m
    `).all(startDate) as { m: string; total: number }[]);

    const otherIncome = byMonth(db.prepare(`
      SELECT strftime('%Y-%m', date) as m, COALESCE(SUM(amount), 0) as total
      FROM other_income WHERE date >= ? GROUP BY m
    `).all(startDate) as { m: string; total: number }[]);

    // Cross-year return relief (cogs_reversals) credits COGS in the refund's
    // month — same rule as the P&L, keeping month net = P&L netProfit.
    const cogsRev = byMonth(db.prepare(`
      SELECT ${MKT_MONTH('refund_date')} as m, COALESCE(SUM(amount), 0) as total
      FROM cogs_reversals WHERE refund_date >= ? GROUP BY m
    `).all(startDate) as { m: string; total: number }[]);

    // Densify: one row per month from start to now, zeros where no activity.
    const months: MonthRow[] = [];
    for (let i = 0; i < monthsBack; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const m = d.toISOString().slice(0, 7);
      if (m > currentMonth) break;
      const s = sales.get(m);
      const row: MonthRow = {
        month: m,
        salesIncome: s?.sales || 0,
        mfnShippingCredits: (s?.mfnShip || 0) + (cbShip.get(m)?.cbShip || 0),
        otherIncome: otherIncome.get(m)?.total || 0,
        reimbursements: reimb.get(m)?.total || 0,
        cashIn: 0,
        cogs: (s?.cogs || 0) - (cogsRev.get(m)?.total || 0),
        orderFees: orderFees.get(m)?.fees || 0,
        serviceFees: serviceFees.get(m)?.fees || 0,
        refunds: refunds.get(m)?.total || 0,
        shippingCosts: s?.shipCost || 0,
        expenses: expenses.get(m)?.total || 0,
        cashOut: 0,
        net: 0,
        partial: m === currentMonth,
      };
      row.cashIn = row.salesIncome + row.mfnShippingCredits + row.otherIncome + row.reimbursements;
      row.cashOut = row.cogs + row.orderFees + row.serviceFees + row.refunds + row.shippingCosts + row.expenses;
      row.net = row.cashIn - row.cashOut;
      months.push(row);
    }

    // ---- Expected to post (same queries as the Dashboard in-flight cards) ----
    const pendingData = db.prepare(`
      SELECT COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as revenue
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.status IN ('Pending', 'Unshipped') AND o.marketplace = 'amazon'
    `).get() as { orders: number; revenue: number };

    const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();
    const shippedNotPosted = db.prepare(`
      SELECT COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) as revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN ${ORDER_POSTED_DATE} fe ON fe.order_id = o.order_id
      WHERE o.status IN ('Shipped', 'PartiallyShipped')
        AND fe.order_id IS NULL
        AND o.purchase_date >= ?
        AND o.marketplace = 'amazon'
    `).get(recentCutoff) as { orders: number; revenue: number };

    const aovCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const aov = db.prepare(`
      SELECT COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) as revenue,
        COUNT(DISTINCT o.order_id) as orders
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ? AND o.status IN ('Shipped', 'PartiallyShipped') AND o.marketplace = 'amazon'
    `).get(aovCutoff) as { revenue: number; orders: number };
    const avgOrderValue = aov.orders > 0 ? Math.round(aov.revenue / aov.orders) : 0;
    const pendingEstimate = pendingData.orders * avgOrderValue;

    // What will actually LAND as cash: revenue net of ~13% fees. COGS on these
    // units is already sunk (spent when the inventory was bought), so it does
    // not reduce the incoming payout.
    const FEE_RATE = 0.13;
    const expectedPayout = Math.round((shippedNotPosted.revenue + pendingEstimate) * (1 - FEE_RATE));

    // ---- Cash tied up in inventory (same valuation rules as /inventory) ----
    const liveInv = db.prepare(`
      SELECT COALESCE(SUM(li.total_qty * COALESCE(il_sku.buy_price, il_asin.buy_price, 0)), 0) as value,
        COALESCE(SUM(li.total_qty), 0) as units
      FROM live_inventory li
      LEFT JOIN (
        SELECT sku, buy_price FROM (
          SELECT sku, buy_price, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY id DESC) rn
          FROM inventory_ledger WHERE sku IS NOT NULL AND sku != ''
        ) WHERE rn = 1
      ) il_sku ON il_sku.sku = li.sku
      LEFT JOIN (
        SELECT asin, buy_price FROM (
          SELECT asin, buy_price, ROW_NUMBER() OVER (PARTITION BY asin ORDER BY id DESC) rn
          FROM inventory_ledger WHERE asin IS NOT NULL AND asin != ''
        ) WHERE rn = 1
      ) il_asin ON il_asin.asin = li.asin
      WHERE li.total_qty > 0
    `).get() as { value: number; units: number };

    const localInv = db.prepare(`
      SELECT COALESCE(SUM(il.quantity_remaining * il.buy_price), 0) as value,
        COALESCE(SUM(il.quantity_remaining), 0) as units
      FROM inventory_ledger il
      WHERE il.quantity_remaining > 0 AND il.quantity <= 20 AND il.buy_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM live_inventory li
          WHERE li.sku = il.sku OR (il.asin IS NOT NULL AND il.asin != '' AND li.asin = il.asin)
        )
    `).get() as { value: number; units: number };

    // ---- Fixed monthly costs (active recurring expenses) ----
    const fixedMonthly = (db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM recurring_expenses WHERE active = 1
    `).get() as { total: number }).total;

    // ---- Cash on hand (user-entered, no bank feed) + runway ----
    const getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const cashRaw = (getSetting.get('cashflow_cash_on_hand') as { value: string } | undefined)?.value;
    const cashOnHand = cashRaw != null && cashRaw !== '' ? parseInt(cashRaw) : null;
    const cashUpdatedAt = (getSetting.get('cashflow_cash_updated_at') as { value: string } | undefined)?.value || null;

    const completeMonths = months.filter(m => !m.partial);
    const recent = completeMonths.slice(-3);
    const avgNet3 = recent.length > 0
      ? Math.round(recent.reduce((s, m) => s + m.net, 0) / recent.length)
      : 0;
    const burnRate = avgNet3 < 0 ? -avgNet3 : null;
    const runwayMonths = burnRate && cashOnHand != null
      ? Math.round(((cashOnHand + expectedPayout) / burnRate) * 10) / 10
      : null;

    db.close();

    return NextResponse.json({
      months,
      summary: {
        lastCompleteMonth: completeMonths.length > 0 ? completeMonths[completeMonths.length - 1] : null,
        avgNet3,
        avgNet3Months: recent.map(m => m.month),
        burnRate,
        runwayMonths,
        expectedToPost: {
          pendingOrders: pendingData.orders,
          pendingEstimate,
          shippedOrders: shippedNotPosted.orders,
          shippedRevenue: shippedNotPosted.revenue,
          expectedPayout,
          feeRate: FEE_RATE,
        },
        inventory: {
          atCost: liveInv.value + localInv.value,
          units: liveInv.units + localInv.units,
        },
        fixedMonthly,
        cashOnHand,
        cashUpdatedAt,
      },
    });
  } catch (error) {
    db.close();
    log.error('Cash flow API error:', error);
    return NextResponse.json({ error: 'Failed to load cash flow data' }, { status: 500 });
  }
}

/** POST { cashOnHandCents: number | null } — persist the user-entered cash position. */
export async function POST(request: NextRequest) {
  let body: { cashOnHandCents?: number | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const cents = body.cashOnHandCents;
  if (cents !== null && (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0)) {
    return NextResponse.json({ error: 'cashOnHandCents must be a non-negative integer (cents) or null' }, { status: 400 });
  }

  const db = getDb(false);
  try {
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    if (cents === null) {
      db.prepare(`DELETE FROM settings WHERE key IN ('cashflow_cash_on_hand', 'cashflow_cash_updated_at')`).run();
    } else {
      upsert.run('cashflow_cash_on_hand', String(cents));
      upsert.run('cashflow_cash_updated_at', new Date().toISOString());
    }
    db.close();
    return NextResponse.json({ success: true, cashOnHand: cents });
  } catch (error) {
    db.close();
    log.error('Cash flow POST error:', error);
    return NextResponse.json({ error: 'Failed to save cash position' }, { status: 500 });
  }
}
