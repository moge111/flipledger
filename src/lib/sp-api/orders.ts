/**
 * SP-API Orders API client.
 * Pulls order details and enriches existing order data with
 * fulfillment channel, status, and shipping address (for sales tax state).
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('sp-api/orders');

const getDb = () => openDb();

/**
 * Sync orders from SP-API.
 * Fetches orders created after startDate and updates existing records
 * or creates new ones.
 */
export async function syncOrders(
  credentials: SPAPICredentials,
  startDate: string,
  endDate?: string
): Promise<{ ordersProcessed: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let ordersProcessed = 0;
  let nextToken: string | undefined;
  const orderIdsToFetchItems: string[] = [];

  try {
    do {
      const params: Record<string, string> = {
        MarketplaceIds: credentials.marketplaceId,
      };

      if (nextToken) {
        params.NextToken = nextToken;
      } else {
        params.CreatedAfter = startDate;
        if (endDate) params.CreatedBefore = endDate;
        params.OrderStatuses = 'Pending,Unshipped,PartiallyShipped,Shipped,Canceled';
      }

      const response = await spApiRequest(credentials, '/orders/v0/orders', params, 8);
      const payload = response.payload;
      if (!payload) break;

      const orders = payload.Orders || [];
      const now = new Date().toISOString();

      for (const order of orders) {
        try {
          const orderId = order.AmazonOrderId;
          const purchaseDate = order.PurchaseDate;
          const status = order.OrderStatus;
          const channel = order.FulfillmentChannel === 'AFN' ? 'FBA' : 'MFN';

          // Canceled orders: mark and reverse any previously-synced line items so
          // they don't linger as phantom accrual revenue / consumed FIFO COGS.
          // Canceled-before-ship orders have no financial events, so those are
          // untouched. (Mirrors the eBay cancellation reversal.)
          if (status === 'Canceled') {
            db.prepare(`
              INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
              VALUES (?, ?, 'Canceled', 'amazon', ?, 0, ?)
              ON CONFLICT(order_id) DO UPDATE SET status = 'Canceled'
            `).run(orderId, purchaseDate, channel, now);
            const removed = db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
            db.prepare('DELETE FROM sales_tax WHERE order_id = ?').run(orderId);
            if (removed.changes > 0) {
              log.info(`${orderId} canceled after sync — ${removed.changes} line item(s) reversed`);
            }
            ordersProcessed++;
            continue;
          }
          const isEstimated = (order.OrderStatus === 'Pending' || order.OrderStatus === 'Unshipped') ? 1 : 0;
          // shipped_at: when status is Shipped or PartiallyShipped, LastUpdateDate is when it shipped.
          // Don't overwrite a previously-recorded shipped_at on subsequent syncs (keep first-seen ship time).
          const shippedAt = (status === 'Shipped' || status === 'PartiallyShipped') ? (order.LastUpdateDate || null) : null;

          // Replacement orders ship a second unit free. Amazon flags them and
          // names the order being replaced; the reason arrives later via the
          // FBA Replacements report (replacementsReport.ts).
          const isReplacement = order.IsReplacementOrder === true || order.IsReplacementOrder === 'true' ? 1 : 0;
          const replacedOrderId: string | null = order.ReplacedOrderId || null;

          // Upsert order. Preserve shipped_at once set: COALESCE keeps existing value if not null.
          // Replacement fields only ever ratchet on — the report may have set
          // them for an order this API call no longer flags.
          db.prepare(`
            INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, shipped_at, is_replacement, replaced_order_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(order_id) DO UPDATE SET
              purchase_date = excluded.purchase_date,
              status = excluded.status,
              fulfillment_channel = excluded.fulfillment_channel,
              is_estimated = excluded.is_estimated,
              shipped_at = COALESCE(orders.shipped_at, excluded.shipped_at),
              is_replacement = MAX(COALESCE(orders.is_replacement, 0), excluded.is_replacement),
              replaced_order_id = COALESCE(excluded.replaced_order_id, orders.replaced_order_id)
          `).run(orderId, purchaseDate, status, 'amazon', channel, isEstimated, shippedAt, isReplacement, replacedOrderId, now);

          // Update sales tax state from shipping address. Delete any 'Unknown'
          // row already shadowed by a real-state row for the same posted_date
          // first — otherwise the rename collides with the unique index
          // (order_id, state, posted_date) and errors the whole order.
          const shipState = order.ShippingAddress?.StateOrRegion;
          if (shipState) {
            db.prepare(`
              DELETE FROM sales_tax WHERE order_id = ? AND state = 'Unknown'
                AND EXISTS (
                  SELECT 1 FROM sales_tax s
                  WHERE s.order_id = sales_tax.order_id
                    AND s.posted_date = sales_tax.posted_date
                    AND s.state != 'Unknown'
                )
            `).run(orderId);
            db.prepare(`
              UPDATE sales_tax SET state = ? WHERE order_id = ? AND state = 'Unknown'
            `).run(shipState, orderId);
          }

          // For Pending orders, Amazon won't return item details
          // but OrderTotal is available — use it as a single order_item
          if (status === 'Pending' && order.OrderTotal?.Amount) {
            const totalCents = Math.round(parseFloat(order.OrderTotal.Amount) * 100);
            db.prepare(`
              INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(order_id, asin, sku) DO UPDATE SET
                total_price = excluded.total_price
            `).run(orderId, 'PENDING', 'PENDING', 1, totalCents, totalCents, 0);
          }

          ordersProcessed++;
          // Track orders that need items fetched
          orderIdsToFetchItems.push(orderId);
        } catch (err) {
          errors.push(`Order ${order.AmazonOrderId}: ${err}`);
        }
      }

      nextToken = payload.NextToken;
    } while (nextToken);

    // Fetch order items for orders that either:
    // 1. Have no items at all, or
    // 2. Have only a PENDING placeholder (order shipped since last sync)
    const missingItems = db.prepare(`
      SELECT o.order_id, o.status FROM orders o
      LEFT JOIN order_items oi ON o.order_id = oi.order_id AND oi.asin != 'PENDING'
      WHERE o.order_id IN (${orderIdsToFetchItems.map(() => '?').join(',')})
      AND oi.order_id IS NULL
      AND o.status != 'Pending'
    `).all(...orderIdsToFetchItems) as { order_id: string; status: string }[];

    log.info(`Fetching items for ${missingItems.length} orders missing price data (of ${orderIdsToFetchItems.length} total)`);

    for (const { order_id: oid } of missingItems) {
      try {
        const itemsResponse = await spApiRequest(
          credentials,
          `/orders/v0/orders/${oid}/orderItems`
        );
        const orderItems = itemsResponse.payload?.OrderItems || [];
        const now = new Date().toISOString();

        if (orderItems.length > 0) {
          // Remove PENDING placeholder if it exists
          db.prepare('DELETE FROM order_items WHERE order_id = ? AND asin = ?').run(oid, 'PENDING');
        }

        for (const oi of orderItems) {
          const asin = oi.ASIN;
          const oiSku = oi.SellerSKU;
          const qty = oi.QuantityOrdered || 1;
          const itemPrice = Math.round((oi.ItemPrice?.Amount || 0) * 100);
          const shippingPrice = Math.round((oi.ShippingPrice?.Amount || 0) * 100);

          if (itemPrice > 0) {
            db.prepare(`
              INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(order_id, asin, sku) DO UPDATE SET
                quantity = excluded.quantity,
                price_per_unit = excluded.price_per_unit,
                total_price = excluded.total_price,
                shipping_charged = excluded.shipping_charged
            `).run(oid, asin, oiSku, qty, qty > 0 ? Math.round(itemPrice / qty) : itemPrice, itemPrice, shippingPrice);
          }

          if (asin) {
            db.prepare(`
              INSERT INTO products (asin, sku, name, marketplace, created_at, updated_at)
              VALUES (?, ?, ?, 'amazon', ?, ?)
              ON CONFLICT(asin) DO UPDATE SET
                name = COALESCE(excluded.name, products.name),
                sku = COALESCE(excluded.sku, products.sku),
                updated_at = excluded.updated_at
            `).run(asin, oiSku, oi.Title || null, now, now);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (itemErr) {
        errors.push(`OrderItems ${oid}: ${itemErr}`);
      }
    }
  } finally {
    db.close();
  }

  return { ordersProcessed, errors };
}

/**
 * Fetch order items for a specific order.
 * Used to enrich order data with item-level details.
 */
export async function fetchOrderItems(
  credentials: SPAPICredentials,
  orderId: string
): Promise<any[]> {
  const response = await spApiRequest(
    credentials,
    `/orders/v0/orders/${orderId}/orderItems`
  );
  return response.payload?.OrderItems || [];
}
