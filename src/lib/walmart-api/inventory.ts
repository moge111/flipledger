/**
 * Walmart Marketplace Inventory API client.
 * Pulls WFS inventory + inbound shipments.
 */

import { walmartApiRequest } from './auth';
import type { WalmartCredentials } from './types';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

export async function syncWalmartInventory(
  credentials: WalmartCredentials,
): Promise<{ itemsProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let itemsProcessed = 0;
  const now = new Date().toISOString();
  // Walmart's inventory feed can show a shipment's units on hand days before the
  // shipment record reports them received (seen: wm-mahjong-49.70, 55 on hand
  // since Sep 20 while shipment 2112722WFB still said receivedQty 0).
  const onHandBySku = new Map<string, { onHand: number; firstInStock: string | null }>();

  try {
    // ─── Part 1: WFS on-hand inventory ─────────────────────────────
    let offset = 0;
    do {
      let response: any;
      try {
        response = await walmartApiRequest(credentials, '/fulfillment/inventory', { limit: '50', offset: String(offset) });
      } catch (err: any) {
        errors.push(`WFS inventory error: ${err.message}`);
        break;
      }

      const items = response?.payload?.inventory || [];
      const totalCount = response?.headers?.totalCount || 0;
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        try {
          const sku = item.sku || '';
          const node = item.shipNodes?.[0] || {};
          const availToSell = node.availToSellQty || 0;
          const onHand = node.onHandQty || 0;
          const reserved = Math.max(0, onHand - availToSell);
          onHandBySku.set(sku, { onHand, firstInStock: node.firstInStockDate || null });

          db.prepare(`
            INSERT INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, product_name, last_updated)
            VALUES (?, ?, 'walmart', ?, 0, ?, 0, ?, ?)
            ON CONFLICT(asin, sku, marketplace) DO UPDATE SET
              fulfillable_qty = excluded.fulfillable_qty,
              reserved_qty = excluded.reserved_qty,
              product_name = COALESCE(excluded.product_name, live_inventory.product_name),
              last_updated = excluded.last_updated
          `).run(sku, sku, availToSell, reserved, null, now);
          itemsProcessed++;
        } catch (err: any) {
          errors.push(`WFS item ${item.sku}: ${err.message}`);
        }
      }

      offset += items.length;
      if (offset >= totalCount) break;
    } while (true);

    // ─── Part 2: Inbound shipments (in transit to WFS) ─────────────
    // Reset inbound counts before re-syncing
    db.prepare("UPDATE live_inventory SET inbound_qty = 0 WHERE marketplace = 'walmart'").run();

    // Units that reached WFS after a shipment was created, for a SKU that had no
    // stock before it: on hand now + sold since first in stock. Those units came
    // from open shipments, so they are received even if the shipment record lags.
    // Only applied when no CLOSED shipment ever carried the SKU: otherwise stock
    // and sales can come from that shipment, and Walmart's receivedQty is kept.
    const soldSince = db.prepare(`SELECT COALESCE(SUM(oi.quantity),0) AS q FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.marketplace = 'walmart' AND oi.sku = ? AND o.purchase_date >= ?`);
    const hadClosedShipment = db.prepare(`SELECT 1 FROM inbound_shipment_items i
      JOIN inbound_shipments s ON s.shipment_id = i.shipment_id AND s.marketplace = 'walmart'
      WHERE i.sku = ? AND s.status = 'CLOSED' LIMIT 1`);
    const receivedBudget = new Map<string, number>();
    const unreportedReceipts = (sku: string, shipCreated: string | null): number => {
      const stock = onHandBySku.get(sku);
      if (!stock?.firstInStock || !shipCreated || stock.firstInStock < shipCreated) return 0;
      if (hadClosedShipment.get(sku)) return 0;
      if (!receivedBudget.has(sku)) {
        receivedBudget.set(sku, stock.onHand + (soldSince.get(sku, stock.firstInStock) as any).q);
      }
      return receivedBudget.get(sku)!;
    };

    // Walmart's API only returns AWAITING_DELIVERY and CLOSED — every other
    // status (RECEIVING, IN_TRANSIT, etc.) returns an empty body. CLOSED is
    // included so the Inbound Shipping page reflects received shipments; only
    // non-CLOSED shipments contribute to live_inventory.inbound_qty.
    for (const status of ['AWAITING_DELIVERY', 'RECEIVING', 'IN_TRANSIT', 'CLOSED']) {
      let shipOffset = 0;
      do {
        let shipResponse: any;
        try {
          shipResponse = await walmartApiRequest(credentials, '/fulfillment/inbound-shipments', { limit: '50', offset: String(shipOffset), status });
        } catch { break; }

        const shipments = shipResponse?.payload || [];
        if (shipments.length === 0) break;

        for (const shipment of shipments) {
          try {
            const sid = shipment.shipmentId;
            if (!sid) continue;
            const isClosed = shipment.status === 'CLOSED';
            const carrier = shipment.carrierName || null;
            const tracking = Array.isArray(shipment.trackingNo) ? shipment.trackingNo.join(',') : (shipment.trackingNo || null);
            const totalUnits = shipment.shipmentUnits || 0;
            const dateShipped = shipment.createdDate || now;

            const existingShip = db.prepare("SELECT id, status FROM inbound_shipments WHERE shipment_id = ? AND marketplace = 'walmart'").get(sid) as any;
            if (existingShip) {
              db.prepare('UPDATE inbound_shipments SET status = ?, total_units = ?, carrier = COALESCE(?, carrier), tracking = COALESCE(?, tracking) WHERE id = ?')
                .run(shipment.status || existingShip.status, totalUnits, carrier, tracking, existingShip.id);
            } else {
              db.prepare("INSERT INTO inbound_shipments (shipment_id, date_shipped, carrier, tracking, boxes, cost, total_units, status, marketplace, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'walmart', ?)")
                .run(sid, dateShipped, carrier, tracking, totalUnits, shipment.status || 'UNKNOWN', now);
            }

            // Item fetch is skipped for CLOSED shipments we already have items
            // for — otherwise every hourly sync would re-fetch ~100 shipments.
            const storedItemCount = (db.prepare('SELECT COUNT(*) AS c FROM inbound_shipment_items WHERE shipment_id = ?').get(sid) as any).c;
            const needItems = !isClosed || !existingShip || existingShip.status !== shipment.status || storedItemCount === 0;
            if (!needItems) continue;

            const itemsRes = await walmartApiRequest(credentials, '/fulfillment/inbound-shipment-items', { shipmentId: sid, limit: '500' });
            const shipItems = itemsRes?.payload || [];
            db.prepare('DELETE FROM inbound_shipment_items WHERE shipment_id = ?').run(sid);
            for (const item of shipItems) {
              const sku = item.sku;
              if (!sku) continue;
              db.prepare('INSERT INTO inbound_shipment_items (shipment_id, asin, sku, quantity) VALUES (?, ?, ?, ?)')
                .run(sid, item.gtin || sku, sku, item.itemQty || 0);

              if (isClosed) continue;
              const pending = (item.itemQty || 0) - (item.receivedQty || 0);
              const alreadyOnHand = Math.min(pending, unreportedReceipts(sku, shipment.createdDate || null));
              if (alreadyOnHand > 0) receivedBudget.set(sku, receivedBudget.get(sku)! - alreadyOnHand);
              const inboundQty = pending - alreadyOnHand;
              if (inboundQty <= 0) continue;

              const existing = db.prepare("SELECT id FROM live_inventory WHERE sku = ? AND marketplace = 'walmart'").get(sku) as any;
              if (existing) {
                db.prepare('UPDATE live_inventory SET inbound_qty = inbound_qty + ?, last_updated = ? WHERE id = ?').run(inboundQty, now, existing.id);
              } else {
                db.prepare("INSERT OR IGNORE INTO live_inventory (asin, sku, marketplace, fulfillable_qty, inbound_qty, reserved_qty, unfulfillable_qty, product_name, last_updated) VALUES (?, ?, 'walmart', 0, ?, 0, 0, ?, ?)").run(sku, sku, inboundQty, item.itemDesc || '', now);
              }
              itemsProcessed++;
            }
          } catch (err: any) {
            errors.push(`Inbound shipment ${shipment.shipmentId}: ${err.message}`);
          }
        }

        shipOffset += shipments.length;
        if (shipments.length < 50) break;
      } while (true);
    }
    // ─── Part 3: product names ─────────────────────────────────────
    // The WFS inventory feed carries no names, so unsold Walmart SKUs were nameless everywhere
    // (Inventory, Products, the Stock Pipeline matcher). The items catalog has them.
    try {
      const names = await fetchWalmartItemNames(credentials);
      const setName = db.prepare(`UPDATE live_inventory SET product_name=? WHERE marketplace='walmart' AND sku=?
        AND IFNULL(product_name, '') <> ?`);
      db.transaction(() => { for (const [sku, name] of names) setName.run(name, sku, name); })();
    } catch (err: any) {
      errors.push(`Walmart item names: ${err.message}`);
    }
  } finally {
    db.close();
  }

  return { itemsProcessed, errors };
}

/** sku → productName for every item on the Walmart account (GET /v3/items, offset paging). */
export async function fetchWalmartItemNames(credentials: WalmartCredentials): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const limit = 50;
  for (let offset = 0; offset < 5000; offset += limit) {
    const r = await walmartApiRequest(credentials, '/items', { limit: String(limit), offset: String(offset) });
    const page = (r?.ItemResponse ?? []) as { sku?: string; productName?: string }[];
    for (const it of page) if (it.sku && it.productName?.trim()) names.set(it.sku, it.productName.trim());
    if (page.length < limit || offset + limit >= (r?.totalItems ?? 0)) break;
  }
  return names;
}
