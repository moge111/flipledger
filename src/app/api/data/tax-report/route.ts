import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, MKT_MONTH } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { walmartSettledRefund, SELLER_SHIPPED_CHANNELS, ORDER_FEE_ROWS, SERVICE_FEE_ROWS, SIGNED_FEE_TOTAL } from '@/lib/accounting-sql';

type Total = { total: number };
interface IncomeAgg { productSales: number; shippingIncome: number; grossReceipts: number; orderCount: number; unitsSold: number }
interface RefundAgg { totalRefunds: number; totalClawbacks: number; refundCount: number }
interface FeeRow { category: string; feeType: string; total: number; count: number }
interface MonthIncome { month: string; productSales: number; shippingIncome: number; orderCount: number; unitsSold: number }
interface ExpenseRow { category: string; total: number; count: number }
interface TaxStateRow { state: string; taxCollected: number; facilitatorTax: number; total: number; orderCount: number }
interface RefundMonth { month: string; count: number; totalRefunded: number; feeClawbacks: number; netCost: number }
interface MarketplaceRow { marketplace: string; productSales: number; shippingIncome: number; grossReceipts: number; orderCount: number; unitsSold: number; cogs: number }
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/tax-report');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear() - 1));
  const marketplace = marketplaceParam(searchParams); // future: filter by marketplace

  const db = getDb();
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;

  // Tax Report uses purchase_date (transaction date) to match the 1099-K.
  // The IRS sees the 1099-K, so our tax numbers must reconcile against it.
  // This differs from the dashboard which uses posted_date (cash basis) for operations.

  // Optional marketplace filter
  const mktFilter = marketplace ? 'AND o.marketplace = ?' : '';
  const mktParams = marketplace ? [marketplace] : [];

  // Shipping charged to the buyer that belongs in gross receipts.
  //
  // This page reconciles to the 1099-K, whose gross is BEFORE deductions — so
  // a shipping credit belongs here whenever it reached the account, even if
  // something else claws it back. Three settlement patterns, verified against
  // Amazon's Unified Transaction Report and the raw ShipmentEvent payloads:
  //   MFN/Seller  — always yours (you set the rate and keep it).
  //   Non-MFN + ShippingChargeback — credit and chargeback are both in
  //     Amazon's payout total; the chargeback is deducted under fees below.
  //   Non-MFN + an equal, offsetting promotional rebate (Amazon Global export
  //     orders) — the rebate is deducted under promotionalRebates below.
  // Excluded: Walmart WFS (no shipping credit line exists in recon at all —
  //   Walmart keeps the customer's shipping fee) and any non-MFN credit with
  //   no offset on either side.
  //
  // NOTE — this deliberately differs from the P&L rule, which admits only the
  // charged-back case. The P&L does not deduct promotional rebates at all
  // (product discounts are already baked into total_price), so counting an
  // export credit there would have no matching offset. Same economics, two
  // presentations. See src/app/api/data/profitloss/route.ts.
  const SHIP_INCOME = `CASE
    WHEN o.fulfillment_channel IN ${SELLER_SHIPPED_CHANNELS} THEN COALESCE(oi.shipping_charged, 0)
    WHEN COALESCE(oi.shipping_charged, 0) > 0 AND EXISTS (
      SELECT 1 FROM fee_details fd
      WHERE fd.order_id = oi.order_id AND fd.fee_type = 'ShippingChargeback'
    ) THEN COALESCE(oi.shipping_charged, 0)
    WHEN COALESCE(oi.shipping_charged, 0) > 0
     AND -COALESCE(oi.promotional_rebate, 0) = COALESCE(oi.shipping_charged, 0)
      THEN COALESCE(oi.shipping_charged, 0)
    ELSE 0
  END`;

  try {
    // ═══ INCOME ═══════════════════════════════════════════════════════

    // Gross receipts (product sales + shipping credits)
    const income = db.prepare(`
      SELECT
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(${SHIP_INCOME}), 0) as shippingIncome,
        COALESCE(SUM(oi.total_price + ${SHIP_INCOME}), 0) as grossReceipts,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as IncomeAgg;

    // Walmart refunds only count once Walmart actually deducted the seller
    // (recon WalmartRefundEvent / Product Price). ~30% of Walmart returns are
    // ghosts Walmart never charges — deducting them understates income.
    // Same gate the P&L and Dashboard use.
    const WMT_SETTLED = `AND ${walmartSettledRefund('refunds', true)}`;

    // Returns and allowances (refunds)
    const refundTotals = db.prepare(`
      SELECT
        COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks,
        COUNT(*) as refundCount
      FROM refunds
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${WMT_SETTLED}
    `).get(startDate, endDate) as RefundAgg;

    // Other income (reimbursements + other_income table)
    const reimbursements = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
      FROM reimbursements
      WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ?
    `).get(startDate, endDate) as { total: number; count: number };

    const otherIncomeData = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM other_income
      WHERE date >= ? AND date < ?
    `).get(startDate, endDate) as Total;

    // ═══ INCOME BY MONTH ═════════════════════════════════════════════

    const incomeByMonth = db.prepare(`
      SELECT
        ${MKT_MONTH('o.purchase_date')} as month,
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(${SHIP_INCOME}), 0) as shippingIncome,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
      GROUP BY ${MKT_MONTH('o.purchase_date')}
      ORDER BY month
    `).all(startDate, endDate, ...mktParams) as MonthIncome[];

    // ═══ COGS (FIFO) ═════════════════════════════════════════════════

    // Cost of goods sold (from pre-calculated FIFO cogs_per_unit), net of
    // cross-year return relief: an item sold in a PRIOR year keeps its COGS in
    // that (filed) year; the return credits COGS in THIS year via
    // cogs_reversals, dated at the refund.
    const cogsSold = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as Total;
    const cogsReversalsYear = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM cogs_reversals
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${marketplace ? 'AND marketplace = ?' : ''}
    `).get(startDate, endDate, ...mktParams) as Total;
    cogsSold.total -= cogsReversalsYear.total;

    // Inbound shipping to FBA
    const inboundShipping = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total
      FROM inbound_shipments
      WHERE date_shipped >= ? AND date_shipped < ?
    `).get(startDate, endDate) as Total;

    // Beginning/ending inventory and purchases are intentionally NOT derived
    // from inventory_ledger: lots include FIFO "headroom" quantities that were
    // never real purchases (the documented +100 bumps), and quantity_remaining
    // reflects today's state, not the year boundary. Summing them produced
    // $19M phantom inventory figures that contradicted the FIFO COGS on the
    // same page. FIFO per-sale COGS (line 8) is the authoritative number.

    // ═══ AMAZON FEES ═════════════════════════════════════════════════

    // Order-linked fees (by order purchase date)
    const orderFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type as feeType,
        ${SIGNED_FEE_TOTAL} as total,
        COUNT(*) as count
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
      GROUP BY fd.fee_category, fd.fee_type
      ORDER BY fd.fee_category, total DESC
    `).all(startDate, endDate, ...mktParams) as FeeRow[];

    // Service fees (by effective_date for proper month allocation)
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type as feeType,
        ${SIGNED_FEE_TOTAL} as total,
        COUNT(*) as count
      FROM fee_details fd
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ?
        AND ${MKT_DATE('fd.posted_date')} < ?
      GROUP BY fd.fee_category, fd.fee_type
      ORDER BY fee_category, total DESC
    `).all(startDate, endDate) as FeeRow[];

    // Combine and build hierarchy
    const allFees = [...orderFees, ...serviceFees];
    const feeSummary: Record<string, number> = {};
    for (const fee of allFees) {
      feeSummary[fee.category] = (feeSummary[fee.category] || 0) + fee.total;
    }
    const totalAmazonFees = Object.values(feeSummary).reduce((s, v) => s + v, 0);

    // Promotional rebates — ONLY the export-order rebates that offset a
    // shipping credit. SHIP_INCOME counts that credit in gross receipts, so
    // the pair must be deducted here or net income is overstated. The two
    // rules are a matched pair: change one, change both.
    //
    // Ordinary product-discount promos are NOT deducted: order_items.total_price
    // already reflects the post-promo price the buyer paid, so deducting the
    // rebate again double-counted the discount (Sept 4, 2026 fix; ~$18/yr).
    const promos = db.prepare(`
      SELECT COALESCE(SUM(ABS(COALESCE(oi.promotional_rebate, 0))), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
        AND o.fulfillment_channel NOT IN ('MFN', 'Seller')
        AND COALESCE(oi.shipping_charged, 0) > 0
        AND -COALESCE(oi.promotional_rebate, 0) = COALESCE(oi.shipping_charged, 0)
    `).get(startDate, endDate, ...mktParams) as Total;

    // MFN shipping costs
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ? ${mktFilter}
    `).get(startDate, endDate, ...mktParams) as Total;

    // ═══ OTHER EXPENSES ══════════════════════════════════════════════

    const otherExpenses = db.prepare(`
      SELECT
        category,
        COALESCE(SUM(amount), 0) as total,
        COUNT(*) as count
      FROM expenses
      WHERE date >= ? AND date < ?
      GROUP BY category
      ORDER BY total DESC
    `).all(startDate, endDate) as ExpenseRow[];

    const totalOtherExpenses = otherExpenses.reduce((s, e) => s + e.total, 0);

    // ═══ SALES TAX BY STATE ══════════════════════════════════════════

    const salesTaxByState = db.prepare(`
      SELECT
        state,
        COALESCE(SUM(tax_collected), 0) as taxCollected,
        COALESCE(SUM(marketplace_facilitator_tax), 0) as facilitatorTax,
        COALESCE(SUM(tax_collected), 0) as total,
        COUNT(*) as orderCount
      FROM sales_tax
      WHERE ${MKT_DATE('posted_date')} >= ? AND ${MKT_DATE('posted_date')} < ?
      GROUP BY state
      ORDER BY total DESC
    `).all(startDate, endDate) as TaxStateRow[];

    const totalTaxCollected = salesTaxByState.reduce((s, r) => s + r.taxCollected, 0);

    // ═══ REFUNDS BY MONTH ════════════════════════════════════════════

    const refundsByMonth = db.prepare(`
      SELECT
        ${MKT_MONTH('refund_date')} as month,
        COUNT(*) as count,
        COALESCE(SUM(refund_amount), 0) as totalRefunded,
        COALESCE(SUM(fee_clawback), 0) as feeClawbacks,
        COALESCE(SUM(refund_amount - fee_clawback), 0) as netCost
      FROM refunds
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${WMT_SETTLED}
      GROUP BY ${MKT_MONTH('refund_date')}
      ORDER BY month
    `).all(startDate, endDate) as RefundMonth[];

    // ═══ PER-MARKETPLACE BREAKDOWN ═════════════════════════════════
    const marketplaceBreakdown = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(oi.total_price), 0) as productSales,
        COALESCE(SUM(${SHIP_INCOME}), 0) as shippingIncome,
        COALESCE(SUM(oi.total_price + ${SHIP_INCOME}), 0) as grossReceipts,
        COUNT(DISTINCT o.order_id) as orderCount,
        COALESCE(SUM(oi.quantity), 0) as unitsSold,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ?
      GROUP BY o.marketplace
      ORDER BY grossReceipts DESC
    `).all(startDate, endDate) as MarketplaceRow[];

    // Net each marketplace's COGS of its cross-year return relief (same rule
    // as the aggregate cogsSold above).
    const reversalsByMarketplace = db.prepare(`
      SELECT marketplace, COALESCE(SUM(amount), 0) as total FROM cogs_reversals
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? GROUP BY marketplace
    `).all(startDate, endDate) as { marketplace: string; total: number }[];
    for (const rev of reversalsByMarketplace) {
      const row = marketplaceBreakdown.find((m) => m.marketplace === rev.marketplace);
      if (row) row.cogs -= rev.total;
    }

    // Fees per marketplace (order-linked)
    const feesByMarketplace = db.prepare(`
      SELECT
        o.marketplace,
        ${SIGNED_FEE_TOTAL} as totalFees
      FROM fee_details fd
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ?
        AND ${ORDER_FEE_ROWS}
      GROUP BY o.marketplace
    `).all(startDate, endDate) as { marketplace: string; totalFees: number }[];

    const feeMap: Record<string, number> = {};
    for (const f of feesByMarketplace) feeMap[f.marketplace] = f.totalFees;

    // Refunds per marketplace
    const refundsByMarketplace = db.prepare(`
      SELECT
        marketplace,
        COALESCE(SUM(refund_amount), 0) as totalRefunds,
        COALESCE(SUM(fee_clawback), 0) as totalClawbacks,
        COUNT(*) as refundCount
      FROM refunds
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${WMT_SETTLED}
      GROUP BY marketplace
    `).all(startDate, endDate) as { marketplace: string; totalRefunds: number; totalClawbacks: number; refundCount: number }[];

    const refundMap: Record<string, { refunds: number; clawbacks: number }> = {};
    for (const r of refundsByMarketplace) refundMap[r.marketplace] = { refunds: r.totalRefunds, clawbacks: r.totalClawbacks };

    // Shipping costs per marketplace
    const shippingByMarketplace = db.prepare(`
      SELECT
        o.marketplace,
        COALESCE(SUM(COALESCE(oi.shipping_cost, 0)), 0) as shippingCosts
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${MKT_DATE('o.purchase_date')} >= ? AND ${MKT_DATE('o.purchase_date')} < ?
      GROUP BY o.marketplace
    `).all(startDate, endDate) as { marketplace: string; shippingCosts: number }[];

    const shipMap: Record<string, number> = {};
    for (const s of shippingByMarketplace) shipMap[s.marketplace] = s.shippingCosts;

    const perMarketplace = marketplaceBreakdown.map((m) => ({
      marketplace: m.marketplace,
      grossReceipts: m.grossReceipts,
      productSales: m.productSales,
      shippingIncome: m.shippingIncome,
      cogs: m.cogs,
      fees: feeMap[m.marketplace] || 0,
      refunds: refundMap[m.marketplace]?.refunds || 0,
      clawbacks: refundMap[m.marketplace]?.clawbacks || 0,
      shippingCosts: shipMap[m.marketplace] || 0,
      orders: m.orderCount,
      units: m.unitsSold,
    }));

    // ═══ SCHEDULE C CALCULATION ══════════════════════════════════════
    // Schedule C Line 1 = gross receipts WITHOUT sales tax (tax is pass-through)
    const line1_grossReceipts = income.grossReceipts;
    const line2_returnsAllowances = refundTotals.totalRefunds;
    const line3_netReceipts = line1_grossReceipts - line2_returnsAllowances;
    const line4_cogs = cogsSold.total;
    const line5_grossProfit = line3_netReceipts - line4_cogs;
    // Fee clawbacks are NOT added here: they're positive rows in fee_details
    // and already net against the fee deduction now that fees are signed
    // (-SUM). Adding them again double-counted the credit as income.
    const line6_otherIncome = reimbursements.total + otherIncomeData.total;
    const line7_grossIncome = line5_grossProfit + line6_otherIncome;

    // Deductions (Lines 8-27 on Schedule C)
    const deductions = {
      amazonFees: totalAmazonFees,
      promotionalRebates: promos.total,
      shippingCosts: shippingCosts.total,
      otherExpenses: totalOtherExpenses,
      inboundShipping: inboundShipping.total,
    };
    const totalDeductions = Object.values(deductions).reduce((s, v) => s + v, 0);

    const line31_netProfit = line7_grossIncome - totalDeductions;

    db.close();

    return NextResponse.json({
      year,
      scheduleC: {
        line1_grossReceipts,
        line2_returnsAllowances,
        line3_netReceipts,
        line4_cogs,
        line5_grossProfit,
        line6_otherIncome,
        line7_grossIncome,
        deductions,
        totalDeductions,
        line31_netProfit,
      },
      incomeByMonth,
      cogs: {
        inboundShipping: inboundShipping.total,
        costOfGoodsSold: cogsSold.total,
        note: 'COGS is computed per-sale via FIFO lot consumption. Beginning/ending inventory balances are not tracked at year boundaries (ledger lots include non-purchase FIFO headroom), so Schedule A lines 1/2/7 are not derivable from this data.',
      },
      perMarketplace,
      amazonFees: allFees,
      amazonFeeSummary: Object.entries(feeSummary).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
      otherExpenses,
      salesTaxByState,
      totalTaxCollected,
      refundsByMonth,
      reimbursements: { total: reimbursements.total, count: reimbursements.count },
      promos: promos.total,
      shippingCosts: shippingCosts.total,
      summary: {
        totalRevenue: income.grossReceipts,
        totalOrders: income.orderCount,
        totalUnits: income.unitsSold,
        totalRefunds: refundTotals.totalRefunds,
        refundCount: refundTotals.refundCount,
      },
    });
  } catch (error) {
    db.close();
    log.error('Tax Report API error:', error);
    return NextResponse.json({ error: 'Failed to load tax report data' }, { status: 500 });
  }
}
