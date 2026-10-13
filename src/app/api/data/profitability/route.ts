import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';
import { lineSettledRefundExpr, lineSettledRefundRowsExpr } from '@/lib/accounting-sql';

const log = createLogger('api/data/profitability');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const groupBy = searchParams.get('groupBy') || 'asin';

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

  const endDateNext = addDays(endDate, 1);

  try {
    // ONE group-key expression for every aggregate on this page. The rows used
    // to be keyed on COALESCE(s.name,'Unknown') / COALESCE(p.category,
    // 'Uncategorized') while the fee and COGS maps were keyed on the raw
    // column, so the "Unknown" bucket looked up NULL and got $0 fees and $0
    // COGS: 2026 Supplier profit showed $131,928 against a true $56,430
    // (review C1, Sept 2026). Rows, fees, COGS and refunds now come from a
    // single line-level query, so they cannot disagree on the key.
    const supplierByAsin = `LEFT JOIN (SELECT asin, MIN(supplier_id) as supplier_id FROM inventory_ledger GROUP BY asin) il_a ON oi.asin = il_a.asin
          LEFT JOIN suppliers s ON il_a.supplier_id = s.id`;
    let keyExpr: string;
    let selectCols: string;
    let joinClause: string;

    switch (groupBy) {
      case 'sku':
        keyExpr = 'oi.sku';
        selectCols = `p.name as productName, oi.asin, p.category, s.name as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin
          LEFT JOIN (SELECT sku, MIN(supplier_id) as supplier_id FROM inventory_ledger GROUP BY sku) il_s ON oi.sku = il_s.sku
          LEFT JOIN suppliers s ON il_s.supplier_id = s.id`;
        break;
      case 'category':
        keyExpr = `COALESCE(p.category, 'Uncategorized')`;
        selectCols = `'' as productName, '' as asin, '' as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin`;
        break;
      case 'supplier':
        keyExpr = `COALESCE(s.name, 'Unknown')`;
        selectCols = `'' as productName, '' as asin, p.category`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin
          ${supplierByAsin}`;
        break;
      default: // asin
        keyExpr = 'oi.asin';
        selectCols = `p.name as productName, oi.asin, p.category, s.name as supplierName`;
        joinClause = `LEFT JOIN products p ON oi.asin = p.asin
          ${supplierByAsin}`;
        break;
    }

    // Order fees are distributed to lines by revenue share (per-order
    // subqueries, so joining them never fans out a line).
    const rows = db.prepare(`
      SELECT
        ${keyExpr} as groupKey,
        ${selectCols},
        COUNT(DISTINCT o.order_id) as orders,
        SUM(oi.quantity) as unitsSold,
        SUM(oi.total_price) as revenue,
        COALESCE(SUM(oi.shipping_charged), 0) as shippingCharged,
        COALESCE(SUM(oi.shipping_cost), 0) as shippingCost,
        COALESCE(SUM(oi.cogs_per_unit * oi.quantity), 0) as cogs,
        COALESCE(SUM(order_fees.total_fee * oi.total_price * 1.0 / order_totals.order_revenue), 0) as orderFees,
        COALESCE(SUM(${lineSettledRefundExpr()}), 0) as refunded,
        SUM(${lineSettledRefundRowsExpr('COUNT(*)')}) as refundCount,
        SUM(${lineSettledRefundRowsExpr('SUM(r.quantity)')}) as refundUnits
      FROM order_items oi
      JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN (
        SELECT order_id, -SUM(amount) as total_fee
        FROM fee_details WHERE order_id IS NOT NULL AND order_id != ''
        GROUP BY order_id
      ) order_fees ON oi.order_id = order_fees.order_id
      LEFT JOIN (
        SELECT order_id, SUM(total_price) as order_revenue
        FROM order_items GROUP BY order_id HAVING SUM(total_price) > 0
      ) order_totals ON oi.order_id = order_totals.order_id
      ${joinClause}
      WHERE ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ? ${MF}
      GROUP BY ${keyExpr}
      ORDER BY SUM(oi.total_price) DESC
    `).all(startDate, endDateNext) as any[];

    // Per-ASIN storage fees (a monthly snapshot from the storage fee report).
    // Each ASIN's fee is counted once and split across the groups that sold
    // it by units, so the page total is the same in every groupBy mode. (It
    // used to be looked up by row.asin, which is blank in category/supplier
    // mode, and was added once per SKU when several SKUs share an ASIN.)
    const storageByGroup = new Map<string, number>();
    const hasStorageFees = db.prepare('SELECT COUNT(*) as cnt FROM storage_fees_per_asin').get() as any;
    if (hasStorageFees?.cnt > 0) {
      const unitsByGroupAsin = db.prepare(`
        SELECT ${keyExpr} as groupKey, oi.asin as asin, SUM(oi.quantity) as units, sf.monthly_fee as fee
        FROM order_items oi
        JOIN (SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id) fe ON oi.order_id = fe.order_id
        JOIN orders o ON oi.order_id = o.order_id
        JOIN storage_fees_per_asin sf ON sf.asin = oi.asin
        ${joinClause}
        WHERE ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ? ${MF}
        GROUP BY ${keyExpr}, oi.asin
      `).all(startDate, endDateNext) as any[];
      const unitsByAsin = new Map<string, number>();
      for (const u of unitsByGroupAsin) unitsByAsin.set(u.asin, (unitsByAsin.get(u.asin) || 0) + u.units);
      for (const u of unitsByGroupAsin) {
        const share = u.fee * u.units / (unitsByAsin.get(u.asin) || 1);
        storageByGroup.set(u.groupKey, (storageByGroup.get(u.groupKey) || 0) + share);
      }
    }

    // Get on-hand inventory + its value at cost per group.
    //
    // Units come from live_inventory (real FBA/WFS counts), NOT from
    // inventory_ledger.quantity_remaining — the ledger carries placeholder
    // headroom lots (qty 1000) that exist for FIFO coverage, not as physical
    // stock, and summing them reports ~195K phantom units. Same valuation
    // rules as /api/data/inventory-overview: marketplace stock at the latest
    // lot's buy_price, plus local/unsynced stock (small real lots for SKUs
    // live_inventory doesn't track, e.g. eBay cards) at their weighted cost.
    const onHandGroupKey = groupBy === 'sku' ? 'stock.sku' : groupBy === 'category' ? `COALESCE(p.category, 'Uncategorized')` : groupBy === 'supplier' ? `COALESCE(s.name, 'Unknown')` : 'stock.asin';
    const liveMktFilter = marketplace ? `AND li.marketplace = '${marketplace}'` : '';
    const localMktFilter = marketplace ? `AND COALESCE(p_loc.marketplace, 'amazon') = '${marketplace}'` : '';
    const onHandByGroup = db.prepare(`
      WITH latest_lot_sku AS (
        SELECT sku, buy_price, supplier_id FROM (
          SELECT sku, buy_price, supplier_id, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY id DESC) rn
          FROM inventory_ledger WHERE sku IS NOT NULL AND sku != ''
        ) WHERE rn = 1
      ),
      latest_lot_asin AS (
        SELECT asin, buy_price, supplier_id FROM (
          SELECT asin, buy_price, supplier_id, ROW_NUMBER() OVER (PARTITION BY asin ORDER BY id DESC) rn
          FROM inventory_ledger WHERE asin IS NOT NULL AND asin != ''
        ) WHERE rn = 1
      ),
      stock AS (
        SELECT li.sku as sku, li.asin as asin, li.total_qty as qty,
               COALESCE(ls.buy_price, la.buy_price, 0) as unitCost,
               COALESCE(ls.supplier_id, la.supplier_id) as supplier_id
        FROM live_inventory li
        LEFT JOIN latest_lot_sku ls ON ls.sku = li.sku
        LEFT JOIN latest_lot_asin la ON la.asin = li.asin
        WHERE li.total_qty > 0 ${liveMktFilter}
        UNION ALL
        SELECT il.sku, il.asin, SUM(il.quantity_remaining),
               CAST(SUM(il.quantity_remaining * il.buy_price) / SUM(il.quantity_remaining) AS INTEGER),
               MIN(il.supplier_id)
        FROM inventory_ledger il
        LEFT JOIN products p_loc ON p_loc.asin = il.asin OR p_loc.asin = il.sku
        WHERE il.quantity_remaining > 0
          AND il.buy_price > 0
          AND NOT EXISTS (
            SELECT 1 FROM live_inventory li
            WHERE li.total_qty > 0 AND (li.sku = il.sku OR (il.asin IS NOT NULL AND il.asin != '' AND li.asin = il.asin))
          )
          ${localMktFilter}
        GROUP BY il.sku
      )
      SELECT
        ${onHandGroupKey} as groupKey,
        SUM(stock.qty) as onHand,
        SUM(stock.qty * stock.unitCost) as inventoryValue
      FROM stock
      ${groupBy === 'category' ? 'LEFT JOIN products p ON p.asin = stock.asin' : ''}
      ${groupBy === 'supplier' ? 'LEFT JOIN suppliers s ON s.id = stock.supplier_id' : ''}
      GROUP BY ${onHandGroupKey}
    `).all() as any[];

    const onHandMap = new Map(onHandByGroup.map((h: any) => [h.groupKey, { onHand: h.onHand, value: h.inventoryValue }]));

    // Build result rows
    const result = rows.map((row: any) => {
      const fees = row.orderFees + (storageByGroup.get(row.groupKey) || 0);
      const cogs = row.cogs;
      const refunds = { count: row.refundCount || 0, units: row.refundUnits || 0 };
      const onHand = onHandMap.get(row.groupKey) || { onHand: 0, value: 0 };
      const shippingCost = row.shippingCost || 0;
      const shippingCharged = row.shippingCharged || 0;
      // Settled refunds on these sales (review C3): a returned unit already
      // has $0 COGS, so without this it showed as near-100% margin.
      const refunded = row.refunded || 0;
      const profit = row.revenue + shippingCharged - cogs - fees - shippingCost - refunded;
      const roi = cogs > 0 ? (profit / cogs) * 100 : 0;
      const margin = row.revenue > 0 ? (profit / row.revenue) * 100 : 0;

      return {
        groupKey: row.groupKey || 'Unknown',
        productName: row.productName || '',
        asin: row.asin || '',
        category: row.category || '',
        supplierName: row.supplierName || '',
        orders: row.orders,
        unitsSold: row.unitsSold,
        unitsPerOrder: row.orders > 0 ? row.unitsSold / row.orders : 0,
        refunds: refunds.count,
        unitsPerRefund: refunds.count > 0 ? refunds.units / refunds.count : 0,
        revenue: row.revenue,
        fees,
        cogs,
        shippingCost,
        refunded,
        costPerUnit: row.unitsSold > 0 ? cogs / row.unitsSold : 0,
        profit,
        roi,
        margin,
        onHand: onHand.onHand,
        inventoryValue: onHand.value,
        shippingCharged: row.shippingCharged,
      };
    });

    // Totals
    const totals = result.reduce((acc: any, r: any) => {
      acc.orders += r.orders;
      acc.unitsSold += r.unitsSold;
      acc.revenue += r.revenue;
      acc.fees += r.fees;
      acc.cogs += r.cogs;
      acc.shippingCost += r.shippingCost;
      acc.refunded += r.refunded;
      acc.profit += r.profit;
      acc.refunds += r.refunds;
      acc.onHand += r.onHand;
      return acc;
    }, { orders: 0, unitsSold: 0, revenue: 0, fees: 0, cogs: 0, shippingCost: 0, refunded: 0, profit: 0, refunds: 0, onHand: 0 });

    // Inventory value is a point-in-time snapshot of everything on hand, so it
    // is the grand total across all stock — NOT the sum of the visible rows,
    // which only cover SKUs that sold inside the selected date range.
    totals.inventoryValue = onHandByGroup.reduce((sum: number, h: any) => sum + (h.inventoryValue || 0), 0);
    totals.inventoryUnits = onHandByGroup.reduce((sum: number, h: any) => sum + (h.onHand || 0), 0);

    totals.roi = totals.cogs > 0 ? (totals.profit / totals.cogs) * 100 : 0;
    totals.margin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;
    totals.costPerUnit = totals.unitsSold > 0 ? totals.cogs / totals.unitsSold : 0;

    db.close();

    return NextResponse.json({ rows: result, totals });
  } catch (error) {
    db.close();
    log.error('Profitability API error:', error);
    return NextResponse.json({ error: 'Failed to load profitability data' }, { status: 500 });
  }
}
