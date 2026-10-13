/**
 * Restock watch: products selling fast, at a good return, with little stock left.
 *
 * Grouped by product, not SKU: Amazon gets a new MSKU per buy price
 * (amz-Foo-19.99, amz-Foo-17.49), and velocity belongs to the product. The key
 * is the ASIN for Amazon and the SKU elsewhere (Walmart keeps one SKU per
 * product; eBay's ASIN column holds a per-listing item id).
 *
 * Velocity = units sold (not cancelled, not MCF) in the last `windowDays`.
 * ROI = profit ÷ COGS over the last 90 days on the Sales-page basis (fees
 * pro-rated, cost, MFN label, settled refunds). Stock = fulfillable + inbound
 * on the marketplace (inbound is already on its way) + on hand: what is left
 * in the cost lots of SKUs the marketplace doesn't track (MFN stock at home),
 * skipping the old quantity-1000 placeholder lots.
 */
import type Database from 'better-sqlite3';
import { lineSettledRefundExpr, mfnShippingCreditExpr, mfnShippingCostExpr } from './accounting-sql';
import { marketDaysAgo } from './market-day';

export interface RestockOptions { windowDays: number; minUnits: number; minRoi: number; maxCoverDays: number; targetCoverDays: number }
export const RESTOCK_DEFAULTS: RestockOptions = { windowDays: 30, minUnits: 3, minRoi: 25, maxCoverDays: 7, targetCoverDays: 30 };

export interface RestockRow {
  key: string; marketplace: string; asin: string | null; skus: string[]; productName: string | null;
  unitsWindow: number; units90: number; perDay: number;
  fulfillable: number; inbound: number; onHand: number; daysOfCover: number;
  avgPrice: number; profitPerUnit: number; roi: number;
  lastBuyPrice: number | null; lastBuyDate: string | null; supplier: string | null;
  reorderQty: number; lastSale: string;
}

const KEY = `CASE WHEN o.marketplace = 'amazon' AND oi.asin LIKE 'B0%' THEN oi.asin ELSE oi.sku END`;

export function computeRestock(db: Database.Database, opts: Partial<RestockOptions> = {}): RestockRow[] {
  const o = { ...RESTOCK_DEFAULTS, ...opts };
  const since90 = marketDaysAgo(90);
  const sinceWindow = marketDaysAgo(o.windowDays);

  const sales = db.prepare(`
    SELECT ${KEY} AS key, o.marketplace, MAX(CASE WHEN oi.asin LIKE 'B0%' THEN oi.asin END) AS asin,
      GROUP_CONCAT(DISTINCT oi.sku) AS skus,
      SUM(CASE WHEN date(o.purchase_date) >= ? THEN oi.quantity ELSE 0 END) AS unitsWindow,
      SUM(oi.quantity) AS units90,
      SUM(oi.total_price) AS revenue,
      SUM(COALESCE(oi.cogs_per_unit, 0) * oi.quantity) AS cogs,
      SUM(oi.total_price + ${mfnShippingCreditExpr()}
        - COALESCE(ofees.total_fee * oi.total_price * 1.0 / NULLIF(ot.order_total, 0), 0)
        - COALESCE(oi.cogs_per_unit, 0) * oi.quantity
        - ${mfnShippingCostExpr()}
        - ${lineSettledRefundExpr()}) AS profit,
      MAX(o.purchase_date) AS lastSale
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN (SELECT order_id, -SUM(amount) AS total_fee FROM fee_details WHERE order_id IS NOT NULL AND order_id != '' GROUP BY order_id) ofees
      ON ofees.order_id = oi.order_id
    LEFT JOIN (SELECT order_id, SUM(total_price) AS order_total FROM order_items GROUP BY order_id) ot ON ot.order_id = oi.order_id
    WHERE date(o.purchase_date) >= ?
      AND o.status NOT IN ('Canceled', 'Cancelled')
      AND COALESCE(o.fulfillment_channel, '') != 'MCF'
      AND oi.total_price > 0
    GROUP BY ${KEY}, o.marketplace
    HAVING unitsWindow >= ?
  `).all(sinceWindow, since90, o.minUnits) as {
    key: string; marketplace: string; asin: string | null; skus: string; unitsWindow: number; units90: number;
    revenue: number; cogs: number; profit: number; lastSale: string;
  }[];

  const stock = db.prepare(`
    SELECT COALESCE(SUM(fulfillable_qty), 0) AS fulfillable, COALESCE(SUM(inbound_qty), 0) AS inbound
    FROM live_inventory
    WHERE marketplace = ? AND (sku IN (SELECT value FROM json_each(?)) OR (? IS NOT NULL AND asin = ?))
  `);
  const onHand = db.prepare(`
    SELECT COALESCE(SUM(il.quantity_remaining), 0) AS n FROM inventory_ledger il
    WHERE il.sku IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM live_inventory li WHERE li.sku = il.sku AND li.total_qty > 0)
  `);
  const lastLot = db.prepare(`
    SELECT il.buy_price, il.date_purchased, s.name AS supplier FROM inventory_ledger il
    LEFT JOIN suppliers s ON s.id = il.supplier_id
    WHERE il.buy_price > 0 AND (il.sku IN (SELECT value FROM json_each(?)) OR (? IS NOT NULL AND il.asin = ?))
    ORDER BY il.date_purchased DESC, il.id DESC LIMIT 1
  `);
  const name = db.prepare(`SELECT name FROM products WHERE asin = ? OR sku = ? LIMIT 1`);

  const rows: RestockRow[] = [];
  for (const s of sales) {
    if (s.cogs <= 0) continue; // no cost basis, so no ROI to judge
    const roi = (s.profit / s.cogs) * 100;
    if (roi < o.minRoi) continue;
    const skus = s.skus.split(',');
    const st = stock.get(s.marketplace, JSON.stringify(skus), s.asin, s.asin) as { fulfillable: number; inbound: number };
    const local = (onHand.get(JSON.stringify(skus)) as { n: number }).n;
    const have = st.fulfillable + st.inbound + local;
    const perDay = s.unitsWindow / o.windowDays;
    const daysOfCover = have / perDay;
    if (daysOfCover >= o.maxCoverDays) continue;
    const lot = lastLot.get(JSON.stringify(skus), s.asin, s.asin) as { buy_price: number; date_purchased: string; supplier: string | null } | undefined;
    const n = name.get(s.asin ?? s.key, skus[0]) as { name: string } | undefined;
    rows.push({
      key: s.key, marketplace: s.marketplace, asin: s.asin, skus, productName: n?.name ?? null,
      unitsWindow: s.unitsWindow, units90: s.units90, perDay,
      fulfillable: st.fulfillable, inbound: st.inbound, onHand: local, daysOfCover,
      avgPrice: Math.round(s.revenue / s.units90), profitPerUnit: Math.round(s.profit / s.units90), roi,
      lastBuyPrice: lot?.buy_price ?? null, lastBuyDate: lot?.date_purchased?.slice(0, 10) ?? null, supplier: lot?.supplier ?? null,
      reorderQty: Math.max(0, Math.ceil(perDay * o.targetCoverDays - have)),
      lastSale: s.lastSale,
    });
  }
  return rows.sort((a, b) => a.daysOfCover - b.daysOfCover || b.unitsWindow - a.unitsWindow);
}
