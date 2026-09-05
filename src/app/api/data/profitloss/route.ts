import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { calculateMargin } from '@/lib/calculations';
import {
  orderDateSubquery, walmartSettledRefund, chargedBackShippingInner,
  mfnShippingCostExpr, SELLER_SHIPPED_CHANNELS, ORDER_FEE_ROWS, SERVICE_FEE_ROWS, SIGNED_FEE_TOTAL,
} from '@/lib/accounting-sql';

type Total = { total: number };
type FeeRow = { category: string; fee_type: string; total: number };
type CategoryTotal = { category: string; total: number };
interface SalesDetailRow {
  order_id: string; marketplace: string; fulfillment_channel: string; product_name: string;
  asin: string; sku: string; quantity: number; revenue: number; product_revenue: number;
  shippingCredit: number; cogs: number; fees: number; shippingCost: number; net_profit: number;
  posted_date: string; purchase_date: string;
}
interface RefundDetailRow {
  order_id: string; marketplace: string; product_name: string; asin: string; sku: string;
  quantity: number; refund_amount: number; fee_clawback: number; reason: string; refund_date: string;
}
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/profitloss');

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
  const marketplace = marketplaceParam(searchParams);
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') === 'purchase' ? 'purchase' : 'posted';
  // Cash basis (settlement posted_date) or accrual (purchase_date) — shared with the Dashboard.
  const DATE_SUB = orderDateSubquery(dateBasis);
  const IN_RANGE = `${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ?`;

  const endDateNext = addDays(endDate, 1);

  try {
    // Income (by posted_date — cash basis)
    const salesIncome = db.prepare(`
      SELECT COALESCE(SUM(oi.total_price), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as Total;

    // MFN shipping credits (income — seller charges buyer for shipping)
    const mfnShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(oi.shipping_charged), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE ${IN_RANGE} ${MF} AND o.fulfillment_channel IN ${SELLER_SHIPPED_CHANNELS}
    `).get(startDate, endDateNext) as Total;

    // FBA/WFS shipping credits — income ONLY when Amazon also charges it back.
    // The three settlement patterns and why this gate is exact are documented
    // on chargedBackShippingInner in src/lib/accounting-sql.ts.
    const fbaShippingCredits = db.prepare(`
      SELECT COALESCE(SUM(MIN(x.sc, x.cb)), 0) as total
      FROM (${chargedBackShippingInner(DATE_SUB, `${IN_RANGE} ${MF}`)}) x
      WHERE x.sc > 0 AND x.cb > 0
    `).get(startDate, endDateNext) as Total;

    const shippingCredits = { total: mfnShippingCredits.total + fbaShippingCredits.total };

    // Promotional rebates (negative — reduces income)
    const promoRebates = db.prepare(`
      SELECT COALESCE(SUM(oi.promotional_rebate), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as Total;

    const otherIncomeTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM other_income WHERE date >= ? AND date < ? ${MF_R}
    `).get(startDate, endDateNext) as Total;

    // COGS (FIFO)
    const cogsGross = db.prepare(`
      SELECT COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as total
      FROM order_items oi
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as Total;

    // Cross-year return relief: an item sold in a prior year and returned in
    // this period keeps its COGS in the sale year (filed-year integrity) and
    // credits COGS here, dated at the refund (always refund_date, matching how
    // refunds themselves are dated on either basis).
    const cogsReversals = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM cogs_reversals
      WHERE ${MKT_DATE('refund_date')} >= ? AND ${MKT_DATE('refund_date')} < ? ${MF_R}
    `).get(startDate, endDateNext) as Total;

    const cogsTotal = { total: cogsGross.total - cogsReversals.total };

    // Order-linked fees (by order's posted_date)
    // Use -SUM(amount) instead of SUM(ABS(amount)) so that positive clawbacks reduce the fee total
    const orderFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        ${SIGNED_FEE_TOTAL} as total
      FROM fee_details fd
      JOIN ${DATE_SUB} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE ${ORDER_FEE_ROWS}
        AND ${IN_RANGE} ${MF}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(startDate, endDateNext) as FeeRow[];

    // Non-order fees (service fees like storage, inbound shipping, subscriptions)
    // These are marketplace-specific — filter by marketplace when one is selected
    const serviceFeeFilter = marketplace ? `AND fe.marketplace = '${marketplace}'` : '';
    const serviceFees = db.prepare(`
      SELECT
        COALESCE(fd.fee_category, 'Other Fees') as category,
        fd.fee_type,
        ${SIGNED_FEE_TOTAL} as total
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE ${SERVICE_FEE_ROWS}
        AND ${MKT_DATE('fd.posted_date')} >= ?
        AND ${MKT_DATE('fd.posted_date')} < ?
        ${serviceFeeFilter}
      GROUP BY fd.fee_category, fd.fee_type
    `).all(startDate, endDateNext) as FeeRow[];

    const feesByCategory = [...orderFees, ...serviceFees]
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || b.total - a.total);

    // Other expenses — only include when viewing All Marketplaces (they're business-wide, not marketplace-specific)
    const expensesByCategory: CategoryTotal[] = marketplace ? [] : db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) as total
      FROM expenses WHERE date >= ? AND date < ?
      GROUP BY category ORDER BY total DESC
    `).all(startDate, endDateNext) as CategoryTotal[];

    const totalExpenses: Total = marketplace ? { total: 0 } : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date < ?
    `).get(startDate, endDateNext) as Total;

    // Shipping costs (MFN labels only — see mfnShippingCostExpr)
    const shippingCosts = db.prepare(`
      SELECT COALESCE(SUM(${mfnShippingCostExpr()}), 0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
      WHERE ${IN_RANGE} ${MF}
    `).get(startDate, endDateNext) as Total;

    // Refunds — Walmart refunds only count once settled in recon (see
    // walmartSettledRefund); other marketplaces arrive settled.
    const refundTotal = db.prepare(`
      SELECT COALESCE(SUM(refund_amount), 0) as total, COALESCE(SUM(fee_clawback), 0) as clawback
      FROM refunds r
      WHERE ${MKT_DATE('r.refund_date')} >= ? AND ${MKT_DATE('r.refund_date')} < ? ${marketplace ? `AND r.marketplace = '${marketplace}'` : ''}
        AND ${walmartSettledRefund('r')}
    `).get(startDate, endDateNext) as { total: number; clawback: number };

    // Reimbursements
    const reimbTotal = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM reimbursements WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ? ${MF_R}
    `).get(startDate, endDateNext) as Total;

    // Sales tax
    const taxTotal = db.prepare(`
      SELECT COALESCE(SUM(tax_collected), 0) as collected, COALESCE(SUM(marketplace_facilitator_tax), 0) as facilitator
      FROM sales_tax WHERE ${MKT_DATE('posted_date')} >= ? AND ${MKT_DATE('posted_date')} < ? ${MF_R}
    `).get(startDate, endDateNext) as { collected: number; facilitator: number };

    // Group fees into hierarchy
    const feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }> = {};
    for (const fee of feesByCategory) {
      if (!feeHierarchy[fee.category]) {
        feeHierarchy[fee.category] = { total: 0, children: [] };
      }
      feeHierarchy[fee.category].total += fee.total;
      feeHierarchy[fee.category].children.push({ name: fee.fee_type, amount: fee.total });
    }

    const totalIncome = salesIncome.total + shippingCredits.total + otherIncomeTotal.total;
    const totalFees = Object.values(feeHierarchy).reduce((sum, cat) => sum + cat.total, 0);
    const totalAllExpenses = cogsTotal.total + totalFees + shippingCosts.total + totalExpenses.total;
    // NOTE: refund clawbacks (referral fees Amazon returns on a refund) are
    // NOT added back here — Amazon posts the clawback as a positive Commission
    // line in fee_details, so it's already netted into totalFees. Adding
    // refundTotal.clawback again would double-count it.
    const netProfit = totalIncome - totalAllExpenses - refundTotal.total + reimbTotal.total;

    // Sales detail — individual products sold in the period.
    //
    // Order-level fees are PRO-RATED across line items by revenue share (same
    // rule as the FBA/WFS sales pages) — attaching the full order fee to every
    // line of a multi-item order double-counts it for anyone summing the rows.
    // GROUP BY oi.id guards against the products join matching on both asin
    // and sku.
    //
    // Revenue INCLUDES the shipping credit, under the exact same rule the
    // income totals above use: the full charge for MFN/Seller orders, and for
    // non-MFN only the portion Amazon charges back (see the fbaShippingCredits
    // comment). Without it a row subtracted both the label cost AND the
    // ShippingHB referral fee levied on shipping income while dropping the
    // income itself — an expedited-shipping order read as a large loss when it
    // was profitable, and the rows could not reconcile to the header totals.
    // The order-level credit is attributed to each line by its share of the
    // order's shipping_charged, so the rows still sum to the header figure.
    const salesDetail = db.prepare(`
      WITH ord AS (
        SELECT oi2.order_id,
               SUM(oi2.total_price) as order_total,
               SUM(COALESCE(oi2.shipping_charged, 0)) as order_ship_charged,
               MAX(CASE WHEN o2.fulfillment_channel IN ('MFN', 'Seller') THEN 1 ELSE 0 END) as is_mfn
        FROM order_items oi2
        JOIN orders o2 ON o2.order_id = oi2.order_id
        GROUP BY oi2.order_id
      ),
      cbk AS (
        SELECT order_id, -SUM(amount) as chargeback
        FROM fee_details
        WHERE fee_type = 'ShippingChargeback' AND order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ),
      ofees AS (
        SELECT order_id, SUM(amount) as total_fees
        FROM fee_details
        WHERE order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ),
      base AS (
        SELECT
          oi.id as line_id,
          oi.order_id,
          o.marketplace,
          o.fulfillment_channel,
          COALESCE(MAX(p.name), oi.asin) as product_name,
          oi.asin,
          oi.sku,
          oi.quantity,
          oi.total_price as product_revenue,
          oi.cogs_per_unit * oi.quantity as cogs,
          CASE WHEN COALESCE(ord.order_total, 0) > 0
            THEN CAST(COALESCE(ofees.total_fees, 0) * oi.total_price * 1.0 / ord.order_total AS INTEGER)
            ELSE COALESCE(ofees.total_fees, 0)
          END as fees,
          COALESCE(oi.shipping_cost, 0) as shippingCost,
          CASE WHEN COALESCE(ord.order_ship_charged, 0) > 0
            THEN CAST(
              (CASE WHEN ord.is_mfn = 1 THEN ord.order_ship_charged
                    ELSE MIN(ord.order_ship_charged, COALESCE(cbk.chargeback, 0)) END)
              * COALESCE(oi.shipping_charged, 0) * 1.0 / ord.order_ship_charged AS INTEGER)
            ELSE 0
          END as shippingCredit,
          fe.posted_date,
          o.purchase_date
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.order_id
        JOIN ${DATE_SUB} fe ON oi.order_id = fe.order_id
        LEFT JOIN products p ON p.asin IN (oi.asin, oi.sku)
        LEFT JOIN ofees ON oi.order_id = ofees.order_id
        LEFT JOIN ord ON oi.order_id = ord.order_id
        LEFT JOIN cbk ON oi.order_id = cbk.order_id
        WHERE ${IN_RANGE} ${MF}
        GROUP BY oi.id
      )
      SELECT
        order_id,
        marketplace,
        fulfillment_channel,
        product_name,
        asin,
        sku,
        quantity,
        product_revenue + shippingCredit as revenue,
        product_revenue,
        shippingCredit,
        cogs,
        fees,
        shippingCost,
        product_revenue + shippingCredit - cogs + fees - shippingCost as net_profit,
        posted_date,
        purchase_date
      FROM base
      ORDER BY posted_date DESC
      LIMIT 500
    `).all(startDate, endDateNext) as SalesDetailRow[];

    // Refund detail for the period.
    //
    // Amazon refunds often arrive with an EMPTY asin and the numeric MSKU in
    // r.sku (e.g. "1070389709"). The products table is keyed by real ASIN
    // (B0…), so direct r.asin → products.asin and r.sku → products.asin joins
    // both fail. The fix: go through order_items (which has the real ASIN + a
    // products.name-compatible row) via r.order_id. We also try the historic
    // fallbacks (r.asin → products.asin, r.sku → products.asin or sku) to
    // handle marketplaces where refunds.asin is actually populated (Walmart,
    // eBay historical).
    const refundDetail = db.prepare(`
      SELECT
        r.order_id,
        r.marketplace,
        COALESCE(
          p_via_oi.name,   -- real ASIN resolved through order_items
          p.name,          -- refunds.asin → products.asin
          p2.name,         -- refunds.sku → products.asin (legacy)
          p3.name,         -- refunds.sku → products.sku (Walmart/eBay path)
          oi.asin,         -- if we got a real ASIN from order_items but no products row, display it
          NULLIF(r.asin, ''),
          r.sku
        ) as product_name,
        COALESCE(NULLIF(r.asin, ''), oi.asin) as asin,
        r.sku,
        r.quantity,
        r.refund_amount,
        r.fee_clawback,
        r.reason,
        r.refund_date
      FROM refunds r
      LEFT JOIN order_items oi
        ON oi.order_id = r.order_id
        AND (
          oi.sku = r.sku
          OR oi.asin = r.asin
          OR (NULLIF(r.asin, '') IS NULL AND NULLIF(r.sku, '') IS NOT NULL)
        )
      LEFT JOIN products p_via_oi ON p_via_oi.asin = oi.asin
      LEFT JOIN products p  ON p.asin = r.asin AND r.asin != ''
      LEFT JOIN products p2 ON p2.asin = r.sku
      LEFT JOIN products p3 ON p3.sku  = r.sku
      WHERE ${MKT_DATE('r.refund_date')} >= ? AND ${MKT_DATE('r.refund_date')} < ? ${marketplace ? `AND r.marketplace = '${marketplace}'` : ''}
        AND ${walmartSettledRefund('r')}
      GROUP BY r.id
      ORDER BY r.refund_date DESC
      LIMIT 200
    `).all(startDate, endDateNext) as RefundDetailRow[];

    db.close();

    return NextResponse.json({
      income: {
        sales: salesIncome.total,
        shippingCredits: shippingCredits.total,
        mfnShippingCredits: mfnShippingCredits.total,
        fbaShippingCredits: fbaShippingCredits.total,
        promoRebates: promoRebates.total,
        otherIncome: otherIncomeTotal.total,
        total: totalIncome,
      },
      expenses: {
        cogs: cogsTotal.total,
        cogsReversals: cogsReversals.total,
        feeHierarchy,
        shippingCosts: shippingCosts.total,
        otherExpenses: totalExpenses.total,
        otherExpensesByCategory: expensesByCategory,
        totalFees,
        total: totalAllExpenses,
      },
      refunds: {
        total: refundTotal.total,
        clawback: refundTotal.clawback,
        net: refundTotal.total - refundTotal.clawback,
      },
      reimbursements: reimbTotal.total,
      salesTax: {
        collected: taxTotal.collected,
        facilitator: taxTotal.facilitator,
      },
      netProfit,
      margin: calculateMargin(netProfit, totalIncome),
      dateBasis,
      salesDetail,
      refundDetail,
    });
  } catch (error) {
    db.close();
    log.error('P&L API error:', error);
    return NextResponse.json({ error: 'Failed to load P&L data' }, { status: 500 });
  }
}
