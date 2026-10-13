import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, MKT_MONTH_START, MKT_WEEK_START, marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { calculateROI } from '@/lib/calculations';
import {
  orderDateSubquery, ORDER_POSTED_DATE, walmartSettledRefund, chargedBackShippingInner,
  mfnShippingCreditExpr, mfnShippingCostExpr, ORDER_FEE_ROWS, SERVICE_FEE_ROWS, SIGNED_FEE_TOTAL,
} from '@/lib/accounting-sql';

interface SalesAgg { totalRevenue: number; totalOrders: number; totalUnits: number; totalPromos: number; totalShippingCost: number }
type FeesAgg = { totalFees: number };
type CogsAgg = { totalCogs: number };
type RefundAgg = { totalRefunds: number; totalClawbacks: number };
type Total = { total: number };
type ExpenseAgg = { totalExpenses: number };
interface ProductRow { name: string; asin: string; category: string | null; revenue: number; unitsSold: number; cogs: number }
type CategoryTotal = { category: string; total: number };
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/dashboard');

const getDb = () => openDb({ readonly: true });


export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  let startDate = searchParams.get('startDate');
  let endDate = searchParams.get('endDate');
  if (!startDate) {
    const days = parseInt(searchParams.get('days') || '30');
    startDate = marketDaysAgo(days);
  }
  if (!endDate) {
    endDate = marketToday();
  }
  const endDateNext = addDays(endDate, 1);
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const periodMs = endMs - startMs + 86400000;
  const prevStart = new Date(startMs - periodMs).toISOString().split('T')[0];

  // Marketplace filter
  const marketplace = marketplaceParam(searchParams);
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') === 'purchase' ? 'purchase' : 'posted';
  // Same order-date subquery the P&L uses — parity depends on it.
  const FE = orderDateSubquery(dateBasis);
  const IN_RANGE = `${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ?`;

  try {
    // ─── Revenue & units ──────────────────────────────────────────────
    const salesData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price + ${mfnShippingCreditExpr()}), 0) as totalRevenue,
        COUNT(DISTINCT oi.order_id) as totalOrders,
        COALESCE(SUM(oi.quantity), 0) as totalUnits,
        COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as totalPromos,
        COALESCE(SUM(${mfnShippingCostExpr()}), 0) as totalShippingCost
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as SalesAgg;

    const prevSalesData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price + ${mfnShippingCreditExpr()}), 0) as totalRevenue,
        COUNT(DISTINCT oi.order_id) as totalOrders,
        COALESCE(SUM(oi.quantity), 0) as totalUnits,
        COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as totalPromos,
        COALESCE(SUM(${mfnShippingCostExpr()}), 0) as totalShippingCost
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(prevStart, startDate) as SalesAgg;

    // Non-MFN shipping credits are income only when Amazon also charges them
    // back — shared rule, see chargedBackShippingInner in accounting-sql.ts.
    const chargedBackShipping = db.prepare(`
      SELECT COALESCE(SUM(MIN(x.sc, x.cb)), 0) as total
      FROM (${chargedBackShippingInner(FE, `${IN_RANGE} ${MF}`)}) x
      WHERE x.sc > 0 AND x.cb > 0
    `);
    salesData.totalRevenue += (chargedBackShipping.get(startDate, endDateNext) as Total).total;
    prevSalesData.totalRevenue += (chargedBackShipping.get(prevStart, startDate) as Total).total;

    // ─── Order fees ───────────────────────────────────────────────────
    const orderFeeData = db.prepare(`
      SELECT ${SIGNED_FEE_TOTAL} as totalFees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${ORDER_FEE_ROWS}
        AND ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as FeesAgg;

    const serviceFeeData = db.prepare(`
      SELECT ${SIGNED_FEE_TOTAL} as totalFees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ? AND ${MKT_DATE('fd.posted_date')} < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
    `).get(startDate, endDateNext) as FeesAgg;

    const prevOrderFeeData = db.prepare(`
      SELECT ${SIGNED_FEE_TOTAL} as totalFees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${ORDER_FEE_ROWS}
        AND ${IN_RANGE} ${MF}
    `).get(prevStart, startDate) as FeesAgg;

    const prevServiceFeeData = db.prepare(`
      SELECT ${SIGNED_FEE_TOTAL} as totalFees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ? AND ${MKT_DATE('fd.posted_date')} < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
    `).get(prevStart, startDate) as FeesAgg;

    // ─── COGS ─────────────────────────────────────────────────────────
    // Net of cross-year return relief (cogs_reversals, dated by refund_date)
    // — mirrors the P&L exactly so Dashboard = P&L parity holds.
    const cogsReversalQ = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM cogs_reversals
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R}
    `);

    const cogsData = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as totalCogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as CogsAgg;
    cogsData.totalCogs -= (cogsReversalQ.get(startDate, endDateNext) as Total).total;

    const prevCogsData = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as totalCogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(prevStart, startDate) as CogsAgg;
    prevCogsData.totalCogs -= (cogsReversalQ.get(prevStart, startDate) as Total).total;

    // ─── Refunds ──────────────────────────────────────────────────────
    // Walmart refunds only once settled in recon — shared gate with the P&L.
    const SETTLED_FILTER = `AND ${walmartSettledRefund('refunds')}`;
    const refundData = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks
      FROM refunds WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R} ${SETTLED_FILTER}
    `).get(startDate, endDateNext) as RefundAgg;

    const prevRefundData = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks
      FROM refunds WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R} ${SETTLED_FILTER}
    `).get(prevStart, startDate) as RefundAgg;

    // ─── Reimbursements ───────────────────────────────────────────────
    const reimbData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM reimbursements WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ? ${MF_R}
    `).get(startDate, endDateNext) as Total;

    const prevReimbData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM reimbursements WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ? ${MF_R}
    `).get(prevStart, startDate) as Total;

    // ─── Other expenses ───────────────────────────────────────────────
    // Business-wide expenses (insurance, subscriptions, etc.) — only counted
    // in the "All Marketplaces" view, matching the P&L's behavior. Per-
    // marketplace views exclude them because they're not attributable to
    // any single channel.
    const expenseData: ExpenseAgg = marketplace ? { totalExpenses: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as totalExpenses
      FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as ExpenseAgg;
    const prevExpenseData: ExpenseAgg = marketplace ? { totalExpenses: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as totalExpenses
      FROM expenses WHERE date >= ? AND date < ?
    `).get(prevStart, startDate) as ExpenseAgg;

    // ─── Chart data (daily/weekly/monthly depending on range) ─────────
    const rangeDays = Math.ceil((new Date(endDateNext).getTime() - new Date(startDate).getTime()) / 86400000);
    // daily for ≤31 days, weekly for ≤90, monthly for longer
    const chartGrouping = rangeDays <= 31 ? 'daily' : rangeDays <= 90 ? 'weekly' : 'monthly';
    const chartGroupExpr = chartGrouping === 'daily' ? MKT_DATE('fe.posted_date')
      : chartGrouping === 'weekly' ? MKT_WEEK_START('fe.posted_date')
      : MKT_MONTH_START('fe.posted_date');

    // Each bar uses the SAME components as the Total Profit card, each one
    // bucketed on its own date column, so the bars always sum to the card.
    // The chart used to show revenue − COGS − order fees only, which left out
    // service fees, refunds, MFN labels, expenses, reimbursements, shipping
    // credits and COGS relief: 2026 YTD bars were $18K (46%) above the card
    // (review C2).
    const bucket = (col: string) => chartGrouping === 'daily' ? MKT_DATE(col)
      : chartGrouping === 'weekly' ? MKT_WEEK_START(col)
      : MKT_MONTH_START(col);
    const buckets = new Map<string, { revenue: number; profit: number }>();
    const addTo = (rows: { b: string | null; revenue?: number; profit?: number }[]) => {
      for (const r of rows) {
        if (!r.b) continue;
        const cur = buckets.get(r.b) || { revenue: 0, profit: 0 };
        cur.revenue += r.revenue || 0;
        cur.profit += r.profit || 0;
        buckets.set(r.b, cur);
      }
    };
    const R = [startDate, endDateNext];
    // Sales, MFN shipping credits, COGS and MFN label costs
    addTo(db.prepare(`
      SELECT ${bucket('fe.posted_date')} as b,
        SUM(oi.total_price + ${mfnShippingCreditExpr()}) as revenue,
        SUM(oi.total_price + ${mfnShippingCreditExpr()} - oi.cogs_per_unit * oi.quantity - ${mfnShippingCostExpr()}) as profit
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
      GROUP BY b
    `).all(...R) as { b: string; revenue: number; profit: number }[]);
    // Non-MFN shipping credits that Amazon charged back (shared rule)
    addTo((db.prepare(`
      SELECT x.b as b, SUM(MIN(x.sc, x.cb)) as amt
      FROM (${chargedBackShippingInner(FE, `${IN_RANGE} ${MF}`, `${bucket('fe.posted_date')} as b, `)}) x
      WHERE x.sc > 0 AND x.cb > 0
      GROUP BY x.b
    `).all(...R) as { b: string; amt: number }[]).map(r => ({ b: r.b, revenue: r.amt, profit: r.amt })));
    // Order fees
    addTo((db.prepare(`
      SELECT ${bucket('fe.posted_date')} as b, ${SIGNED_FEE_TOTAL} as fees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${ORDER_FEE_ROWS} AND ${IN_RANGE} ${MF}
      GROUP BY b
    `).all(...R) as { b: string; fees: number }[]).map(r => ({ b: r.b, profit: -r.fees })));
    // Service fees, on their own posted date
    addTo((db.prepare(`
      SELECT ${bucket('fd.posted_date')} as b, ${SIGNED_FEE_TOTAL} as fees
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ? AND ${MKT_DATE('fd.posted_date')} < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
      GROUP BY b
    `).all(...R) as { b: string; fees: number }[]).map(r => ({ b: r.b, profit: -r.fees })));
    // Cross-year COGS relief, on the refund date
    addTo((db.prepare(`
      SELECT ${bucket('refund_date')} as b, SUM(amount) as amt FROM cogs_reversals
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R}
      GROUP BY b
    `).all(...R) as { b: string; amt: number }[]).map(r => ({ b: r.b, profit: r.amt })));
    // Refunds (Walmart only once settled), on the refund date
    addTo((db.prepare(`
      SELECT ${bucket('refund_date')} as b, SUM(refund_amount) as amt FROM refunds
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R} ${SETTLED_FILTER}
      GROUP BY b
    `).all(...R) as { b: string; amt: number }[]).map(r => ({ b: r.b, profit: -r.amt })));
    // Reimbursements
    addTo((db.prepare(`
      SELECT ${bucket('reimbursement_date')} as b, SUM(amount) as amt FROM reimbursements
      WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ? ${MF_R}
      GROUP BY b
    `).all(...R) as { b: string; amt: number }[]).map(r => ({ b: r.b, profit: r.amt })));
    // Business expenses: All-Marketplaces view only, like the card
    if (!marketplace) {
      addTo((db.prepare(`
        SELECT ${bucket('date')} as b, SUM(amount) as amt FROM expenses
        WHERE date >= ? AND date < ?
        GROUP BY b
      `).all(...R) as { b: string; amt: number }[]).map(r => ({ b: r.b, profit: -r.amt })));
    }

    const chartData = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, revenue: v.revenue, profit: v.profit, grouping: chartGrouping }));

    // ─── Top/Bottom products ──────────────────────────────────────────
    const topProducts = db.prepare(`
      SELECT COALESCE(p.name, p2.name, oi.asin) as name, oi.asin, COALESCE(p.category, p2.category) as category,
        SUM(oi.total_price) as revenue, SUM(oi.quantity) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin
      WHERE ${IN_RANGE} ${MF}
      GROUP BY oi.asin
      ORDER BY (SUM(oi.total_price) - COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0)) DESC
      LIMIT 5
    `).all(startDate, endDateNext) as ProductRow[];

    const worstProducts = db.prepare(`
      SELECT COALESCE(p.name, p2.name, oi.asin) as name, oi.asin, COALESCE(p.category, p2.category) as category,
        SUM(oi.total_price) as revenue, SUM(oi.quantity) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN products p2 ON oi.sku = p2.asin
      WHERE ${IN_RANGE} ${MF}
        AND oi.cogs_per_unit > 0
      GROUP BY oi.asin
      ORDER BY (SUM(oi.total_price) - COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0)) ASC
      LIMIT 5
    `).all(startDate, endDateNext) as ProductRow[];

    // ─── Expense breakdown ────────────────────────────────────────────
    const orderFeeBreakdown = db.prepare(`
      SELECT COALESCE(fd.fee_category, 'Other') as category, -SUM(fd.amount) as total
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${ORDER_FEE_ROWS}
        AND ${IN_RANGE} ${MF}
      GROUP BY fd.fee_category
    `).all(startDate, endDateNext) as CategoryTotal[];

    const serviceFeeBreakdown = db.prepare(`
      SELECT COALESCE(fd.fee_category, 'Other') as category, -SUM(fd.amount) as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ? AND ${MKT_DATE('fd.posted_date')} < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
      GROUP BY fd.fee_category
    `).all(startDate, endDateNext) as CategoryTotal[];

    const categoryMap: Record<string, number> = {};
    for (const row of [...orderFeeBreakdown, ...serviceFeeBreakdown]) {
      categoryMap[row.category] = (categoryMap[row.category] || 0) + row.total;
    }

    const expenseBreakdown = [
      { category: 'Cost of Goods Sold', total: Math.abs(cogsData.totalCogs) },
      ...Object.entries(categoryMap).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
      ...(expenseData.totalExpenses > 0 ? [{ category: 'Other Expenses', total: Math.abs(expenseData.totalExpenses) }] : []),
    ];

    // ─── Inventory value (from live_inventory — real FBA/WFS stock counts) ──
    const invValue = db.prepare(`
      SELECT
        COALESCE(SUM(li.fulfillable_qty * COALESCE(il.buy_price, 0)), 0) as totalValue,
        COALESCE(SUM(li.fulfillable_qty + li.inbound_qty), 0) as totalUnits
      FROM live_inventory li
      LEFT JOIN (
        SELECT sku, buy_price FROM inventory_ledger
        WHERE id IN (SELECT MAX(id) FROM inventory_ledger GROUP BY sku)
      ) il ON li.sku = il.sku
    `).get() as { totalValue: number; totalUnits: number };

    // ─── Calculate totals ─────────────────────────────────────────────
    const totalRevenue = salesData.totalRevenue;
    const totalCogs = cogsData.totalCogs;
    const allFees = orderFeeData.totalFees + serviceFeeData.totalFees;
    const promos = salesData.totalPromos;
    const shippingCost = salesData.totalShippingCost;
    // Clawbacks are already netted into allFees via fee_details (Amazon posts
    // the returned referral fee as a positive Commission line). Subtracting
    // (totalRefunds - totalClawbacks) would credit the clawback a second time.
    const netRefunds = refundData.totalRefunds;
    // Mirror P&L formula exactly so Dashboard and P&L always agree:
    //   netProfit = revenue - cogs - fees - shipping - otherExpenses - refunds + reimbursements
    // otherExpenses (insurance, subscriptions, etc.) is only nonzero in the
    // All-Marketplaces view (gated above).
    const totalProfit = totalRevenue - totalCogs - allFees - shippingCost - expenseData.totalExpenses - netRefunds + reimbData.total;

    const prevRevenue = prevSalesData.totalRevenue;
    const prevCogs = prevCogsData.totalCogs;
    const prevAllFees = prevOrderFeeData.totalFees + prevServiceFeeData.totalFees;
    const prevPromos = prevSalesData.totalPromos;
    const prevShippingCost = prevSalesData.totalShippingCost;
    const prevNetRefunds = prevRefundData.totalRefunds;
    const prevProfit = prevRevenue - prevCogs - prevAllFees - prevShippingCost - prevExpenseData.totalExpenses - prevNetRefunds + prevReimbData.total;

    const roi = calculateROI(totalProfit, totalCogs);
    const prevRoi = calculateROI(prevProfit, prevCogs);

    // ─── In-flight: orders not yet recognized in P&L (regardless of dateBasis) ──
    // pending = customer placed but not shipped (Pending/Unshipped)
    // shipped = shipped but Financial Events ShipmentEvent hasn't posted yet (cash-basis lag)
    const pendingMF = marketplace ? `AND o.marketplace = '${marketplace}'` : `AND o.marketplace = 'amazon'`;
    const pendingData = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.total_price + COALESCE(oi.shipping_charged, 0)), 0) as revenue
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.status IN ('Pending', 'Unshipped') ${pendingMF}
    `).get() as { orders: number; revenue: number };

    // Limit to last 14 days — older shipped-no-event orders are stuck anomalies, not actionable.
    // Amazon's Delivery Date Policy holds funds ~7-10 days from ship (≈ delivery + 7-day cushion).
    // Prefer Amazon's actual maturity_date from Finances v2024 when available.
    const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString();
    const DDP_DAYS = 10;
    const shippedNotPostedData = db.prepare(`
      SELECT
        COUNT(DISTINCT o.order_id) as orders,
        COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) as revenue,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs,
        -- Earliest/latest release: use ftv2.maturity_date if available, else ship_date + DDP_DAYS
        MIN(COALESCE(
          ftv2.maturity_date,
          datetime(COALESCE(o.shipped_at, o.purchase_date), '+' || ? || ' days')
        )) as earliestRelease,
        MAX(COALESCE(
          ftv2.maturity_date,
          datetime(COALESCE(o.shipped_at, o.purchase_date), '+' || ? || ' days')
        )) as latestRelease
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN ${ORDER_POSTED_DATE} fe ON fe.order_id = o.order_id
      LEFT JOIN (
        SELECT order_id, MAX(maturity_date) as maturity_date FROM finances_transactions_v2
        WHERE transaction_type = 'Shipment' AND order_id IS NOT NULL
        GROUP BY order_id
      ) ftv2 ON ftv2.order_id = o.order_id
      WHERE o.status IN ('Shipped', 'PartiallyShipped')
        AND fe.order_id IS NULL
        AND o.purchase_date >= ?
        ${pendingMF}
    `).get(DDP_DAYS, DDP_DAYS, recentCutoff) as { orders: number; revenue: number; cogs: number; earliestRelease: string | null; latestRelease: string | null };

    const earliestRelease = shippedNotPostedData.earliestRelease || null;
    const latestRelease = shippedNotPostedData.latestRelease || null;

    // Trailing 30d Amazon AOV — used to estimate pending order revenue (Amazon doesn't
    // return order_items or OrderTotal for Pending status until buyer payment clears)
    const aovCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const aovData = db.prepare(`
      SELECT
        COALESCE(SUM(oi.price_per_unit * oi.quantity + COALESCE(oi.shipping_charged, 0)), 0) AS revenue,
        COUNT(DISTINCT o.order_id) AS orders
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.purchase_date >= ?
        AND o.status IN ('Shipped', 'PartiallyShipped')
        ${pendingMF}
    `).get(aovCutoff) as { revenue: number; orders: number };
    const avgOrderValueCents = aovData.orders > 0 ? Math.round(aovData.revenue / aovData.orders) : 0;
    const pendingEstimateCents = pendingData.orders * avgOrderValueCents;

    // Projected profit on the shipped-not-posted cohort: revenue - cogs - estimated fees @ 13% - estimated MFN ship
    // Historical Amazon all-in fee rate is ~12.6%, round to 13% for forecast conservatism.
    const shippedNotPostedFees = Math.round(shippedNotPostedData.revenue * 0.13);
    const shippedNotPostedProfit = shippedNotPostedData.revenue - shippedNotPostedData.cogs - shippedNotPostedFees;

    db.close();

    return NextResponse.json({
      stats: {
        totalRevenue, totalProfit,
        totalUnits: salesData.totalUnits, totalOrders: salesData.totalOrders,
        totalCogs, totalFees: allFees, roi,
        serviceFees: serviceFeeData.totalFees,
        prevRevenue, prevProfit, prevUnits: prevSalesData.totalUnits, prevRoi,
      },
      inFlight: {
        pending: {
          orders: pendingData.orders,
          revenueReported: pendingData.revenue,
          revenueEstimate: pendingEstimateCents,
          avgOrderValue: avgOrderValueCents,
        },
        shippedNotPosted: {
          orders: shippedNotPostedData.orders,
          revenue: shippedNotPostedData.revenue,
          cogs: shippedNotPostedData.cogs,
          projectedProfit: shippedNotPostedProfit,
          earliestRelease,
          latestRelease,
        },
      },
      dailyRevenue: chartData,
      topProducts, worstProducts,
      expenseBreakdown,
      inventoryValue: invValue,
    });
  } catch (error) {
    db.close();
    log.error('Dashboard API error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard data' }, { status: 500 });
  }
}
