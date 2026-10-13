import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { lineSettledRefundExpr } from '@/lib/accounting-sql';
import { replacementReasonLabel } from '@/lib/sp-api/replacementsReport';
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/fba-sales');

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

  const endDateNext = addDays(endDate, 1);

  try {
    // Fulfilled Sales: FBA (Amazon) + WFS (Walmart)
    const rows = db.prepare(`
      SELECT
        o.purchase_date as date,
        o.order_id as orderId,
        oi.asin,
        oi.sku,
        COALESCE(p.name, oi.asin) as productName,
        oi.quantity,
        oi.total_price as salePrice,
        -- Settled refunds against this line (review C3).
        CAST(ROUND(${lineSettledRefundExpr()}) AS INTEGER) as refunded,
        COALESCE(oi.cogs_per_unit, 0) as buyCostPerUnit,
        CASE WHEN ot.order_total > 0
          THEN CAST(COALESCE(fd.totalFees, 0) * oi.total_price * 1.0 / ot.order_total AS INTEGER)
          ELSE COALESCE(fd.totalFees, 0)
        END as fees,
        o.is_estimated as isEstimated,
        COALESCE(o.is_replacement, 0) as isReplacement,
        o.replaced_order_id as replacedOrderId,
        o.replacement_reason_code as replacementReasonCode
      FROM orders o
      JOIN order_items oi ON o.order_id = oi.order_id
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fep ON o.order_id = fep.order_id
      LEFT JOIN products p ON oi.asin = p.asin
      LEFT JOIN (
        SELECT order_id, -SUM(amount) as totalFees FROM fee_details WHERE order_id IS NOT NULL AND order_id != '' GROUP BY order_id
      ) fd ON o.order_id = fd.order_id
      LEFT JOIN (
        SELECT order_id, SUM(total_price) as order_total FROM order_items GROUP BY order_id
      ) ot ON o.order_id = ot.order_id
      WHERE o.fulfillment_channel = 'FBA'
        AND ${MKT_DATE('fep.posted_date')} >= ? AND ${MKT_DATE('fep.posted_date')} < ?
      ORDER BY o.purchase_date DESC, fep.posted_date DESC
    `).all(startDate, endDateNext) as any[];

    const items = rows.map((row) => {
      const buyCost = row.buyCostPerUnit * row.quantity;
      const refunded = row.refunded || 0;
      const profit = row.salePrice - buyCost - row.fees - refunded;
      const profitPercent = row.salePrice > 0 ? (profit / row.salePrice) * 100 : 0;
      const roiPercent = buyCost > 0 ? (profit / buyCost) * 100 : 0;
      return {
        date: row.date,
        orderId: row.orderId,
        asin: row.asin,
        sku: row.sku,
        productName: row.productName,
        quantity: row.quantity,
        salePrice: row.salePrice,
        refunded,
        buyCost,
        fees: row.fees,
        profit,
        profitPercent,
        roiPercent,
        isEstimated: !!row.isEstimated,
        // Amazon's own flag; the $0-price check covers orders synced before it was captured.
        isReplacement: row.isReplacement === 1 || row.salePrice === 0,
        replacedOrderId: row.replacedOrderId || null,
        replacementReason: replacementReasonLabel(row.replacementReasonCode),
      };
    });

    const totalSales = items.reduce((s, i) => s + i.salePrice, 0);
    const totalRefunded = items.reduce((s, i) => s + i.refunded, 0);
    const totalFees = items.reduce((s, i) => s + i.fees, 0);
    const totalProfit = items.reduce((s, i) => s + i.profit, 0);
    const totalBuyCost = items.reduce((s, i) => s + i.buyCost, 0);
    const count = items.length;
    // Portfolio ROI: total profit / total cost. More accurate than averaging
    // per-row roiPercent (which over-weights cheap items with extreme ROIs).
    const portfolioRoi = totalBuyCost > 0 ? (totalProfit / totalBuyCost) * 100 : 0;

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count,
        totalSales,
        totalRefunded,
        totalFees,
        totalProfit,
        totalBuyCost,
      },
      averages: {
        avgOrderPrice: count > 0 ? totalSales / count : 0,
        avgFees: count > 0 ? totalFees / count : 0,
        avgProfit: count > 0 ? totalProfit / count : 0,
        avgRoi: portfolioRoi,
      },
    });
  } catch (error) {
    db.close();
    log.error('FBA Sales API error:', error);
    return NextResponse.json({ error: 'Failed to load FBA sales data' }, { status: 500 });
  }
}
