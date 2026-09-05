import { NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/inventory-overview');

/**
 * GET /api/data/inventory-overview — unified "where is my inventory" view.
 * Combines live_inventory (Amazon FBA + Walmart WFS, with per-stage breakdown)
 * with local/unsynced stock estimated from inventory_ledger lots (eBay cards,
 * un-shipped stock). Values everything at cost (latest lot buy_price) plus an
 * estimated resale value from list_price / historical avg sale price.
 */
const getDb = () => openDb({ readonly: true });

export interface StageBreakdown {
  fulfillable: number;
  inboundWorking: number;
  inboundShipped: number;
  inboundReceiving: number;
  reservedCustomerOrder: number;
  reservedFcTransfer: number;
  reservedFcProcessing: number;
  unfulfillable: number;
  local: number;
}

export async function GET() {
  const db = getDb();

  try {
    // ---- Marketplace inventory (Amazon FBA + Walmart WFS) ----
    const liveRows = db.prepare(`
      SELECT
        li.asin,
        li.sku,
        li.marketplace,
        COALESCE(p.name, li.product_name, li.asin) as productName,
        p.image_url as imageUrl,
        li.walmart_item_id as walmartItemId,
        li.fulfillable_qty as fulfillable,
        COALESCE(li.inbound_working, 0) as inboundWorking,
        COALESCE(li.inbound_shipped, 0) as inboundShipped,
        COALESCE(li.inbound_receiving, 0) as inboundReceiving,
        -- Walmart inbound has no sub-stage detail from the API: report the
        -- lump under inboundShipped ("in transit") when sub-stages are all 0.
        li.inbound_qty as inboundTotal,
        COALESCE(li.reserved_customer_order, 0) as reservedCustomerOrder,
        COALESCE(li.reserved_fc_transfer, 0) as reservedFcTransfer,
        COALESCE(li.reserved_fc_processing, 0) as reservedFcProcessing,
        li.reserved_qty as reservedTotal,
        li.unfulfillable_qty as unfulfillable,
        li.total_qty as totalQty,
        COALESCE(li.list_price, 0) as customListPrice,
        COALESCE(il_sku.buy_price, il_asin.buy_price, 0) as cogsPerUnit,
        li.last_updated as lastUpdated
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
      LEFT JOIN products p ON li.asin = p.asin
      WHERE li.total_qty > 0
      GROUP BY li.asin, li.sku, li.marketplace
    `).all() as any[];

    // ---- Local / unsynced stock (eBay cards, on-hand not sent anywhere) ----
    // Estimated from inventory_ledger remaining on real (small) lots for SKUs
    // that live_inventory doesn't track. Placeholder headroom lots (qty > 20)
    // are excluded — they exist for FIFO coverage, not as physical stock.
    const localRows = db.prepare(`
      SELECT
        il.sku,
        il.asin,
        COALESCE(p.name, p2.name, li_name.product_name, il.sku) as productName,
        COALESCE(p.image_url, p2.image_url) as imageUrl,
        SUM(il.quantity_remaining) as localQty,
        -- weighted average cost across this SKU's open lots
        CAST(SUM(il.quantity_remaining * il.buy_price) / SUM(il.quantity_remaining) AS INTEGER) as cogsPerUnit,
        MAX(il.date_purchased) as lastUpdated
      FROM inventory_ledger il
      LEFT JOIN products p ON p.asin = il.asin
      LEFT JOIN products p2 ON p2.asin = il.sku AND p.asin IS NULL
      LEFT JOIN (
        SELECT sku, product_name FROM live_inventory GROUP BY sku
      ) li_name ON li_name.sku = il.sku
      WHERE il.quantity_remaining > 0
        AND il.quantity <= 20
        AND il.buy_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM live_inventory li
          WHERE li.sku = il.sku OR (il.asin IS NOT NULL AND il.asin != '' AND li.asin = il.asin)
        )
      GROUP BY il.sku
      HAVING localQty > 0
    `).all() as any[];

    // ---- Avg sale price per ASIN/SKU for resale estimates ----
    const avgData = db.prepare(`
      SELECT asin, sku, AVG(price_per_unit) as avgPrice
      FROM order_items
      WHERE price_per_unit > 0
      GROUP BY asin
    `).all() as any[];
    const priceByAsin: Record<string, number> = {};
    const priceBySku: Record<string, number> = {};
    for (const r of avgData) {
      if (r.asin) priceByAsin[r.asin] = Math.round(r.avgPrice);
      if (r.sku) priceBySku[r.sku] = Math.round(r.avgPrice);
    }

    const items = [];

    for (const r of liveRows) {
      // Walmart's API returns only a lump inbound number — surface it as
      // "shipped/in transit" when no Amazon-style sub-stage detail exists.
      const subStageSum = r.inboundWorking + r.inboundShipped + r.inboundReceiving;
      const inboundShipped = subStageSum === 0 && r.inboundTotal > 0 ? r.inboundTotal : r.inboundShipped;
      // Same for reserved: Walmart reports a lump.
      const reservedSubSum = r.reservedCustomerOrder + r.reservedFcTransfer + r.reservedFcProcessing;
      const reservedCustomerOrder = reservedSubSum === 0 && r.reservedTotal > 0 ? r.reservedTotal : r.reservedCustomerOrder;

      const stages: StageBreakdown = {
        fulfillable: r.fulfillable,
        inboundWorking: r.inboundWorking,
        inboundShipped,
        inboundReceiving: r.inboundReceiving,
        reservedCustomerOrder,
        reservedFcTransfer: r.reservedFcTransfer,
        reservedFcProcessing: r.reservedFcProcessing,
        unfulfillable: r.unfulfillable,
        local: 0,
      };
      const totalQty = r.totalQty;
      const listPrice = r.customListPrice || priceByAsin[r.asin] || priceBySku[r.sku] || 0;
      items.push({
        key: `${r.marketplace}:${r.sku || r.asin}`,
        asin: r.asin,
        sku: r.sku,
        marketplace: r.marketplace,
        location: r.marketplace === 'amazon' ? 'Amazon FBA' : 'Walmart WFS',
        productName: r.productName,
        imageUrl: r.imageUrl || null,
        walmartItemId: r.walmartItemId || null,
        stages,
        totalQty,
        cogsPerUnit: r.cogsPerUnit,
        totalCostValue: r.cogsPerUnit * totalQty,
        listPrice,
        estResaleValue: listPrice * totalQty,
        lastUpdated: r.lastUpdated,
      });
    }

    for (const r of localRows) {
      const stages: StageBreakdown = {
        fulfillable: 0, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0,
        reservedCustomerOrder: 0, reservedFcTransfer: 0, reservedFcProcessing: 0,
        unfulfillable: 0, local: r.localQty,
      };
      const listPrice = priceBySku[r.sku] || (r.asin ? priceByAsin[r.asin] : 0) || 0;
      items.push({
        key: `local:${r.sku}`,
        asin: r.asin || null,
        sku: r.sku,
        marketplace: 'local',
        location: 'On hand (local)',
        productName: r.productName,
        imageUrl: r.imageUrl || null,
        walmartItemId: null,
        stages,
        totalQty: r.localQty,
        cogsPerUnit: r.cogsPerUnit,
        totalCostValue: r.cogsPerUnit * r.localQty,
        listPrice,
        estResaleValue: listPrice * r.localQty,
        lastUpdated: r.lastUpdated,
      });
    }

    items.sort((a, b) => b.totalCostValue - a.totalCostValue);

    // ---- Totals ----
    const stageKeys: (keyof StageBreakdown)[] = [
      'fulfillable', 'inboundWorking', 'inboundShipped', 'inboundReceiving',
      'reservedCustomerOrder', 'reservedFcTransfer', 'reservedFcProcessing',
      'unfulfillable', 'local',
    ];
    const stageTotals: Record<string, { units: number; value: number }> = {};
    for (const k of stageKeys) stageTotals[k] = { units: 0, value: 0 };
    const locationTotals: Record<string, { units: number; value: number; skus: number }> = {};

    for (const it of items) {
      for (const k of stageKeys) {
        stageTotals[k].units += it.stages[k];
        stageTotals[k].value += it.stages[k] * it.cogsPerUnit;
      }
      if (!locationTotals[it.location]) locationTotals[it.location] = { units: 0, value: 0, skus: 0 };
      locationTotals[it.location].units += it.totalQty;
      locationTotals[it.location].value += it.totalCostValue;
      locationTotals[it.location].skus += 1;
    }

    const totalUnits = items.reduce((s, i) => s + i.totalQty, 0);
    const totalCostValue = items.reduce((s, i) => s + i.totalCostValue, 0);
    const totalEstResale = items.reduce((s, i) => s + i.estResaleValue, 0);
    const missingCogs = items.filter((i) => i.cogsPerUnit === 0).length;

    return NextResponse.json({
      items,
      totals: {
        totalUnits,
        totalCostValue,
        totalEstResale,
        skuCount: items.length,
        missingCogs,
        stageTotals,
        locationTotals,
      },
    });
  } catch (error) {
    log.error('Inventory Overview API error:', error);
    return NextResponse.json({ error: 'Failed to load inventory overview' }, { status: 500 });
  } finally {
    db.close();
  }
}
