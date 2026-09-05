/**
 * Walmart Marketplace Orders API client.
 * Pulls orders and line items, stores in the same orders/order_items tables as Amazon.
 */

import { walmartApiRequest } from './auth';
import type {WalmartCredentials, WalmartOrder } from './types';
import Database from 'better-sqlite3';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('walmart-api/orders');

const getDb = () => openDb();

/** Convert dollar amount to integer cents */
function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null) return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Sync Walmart orders for a given date range.
 * Auto-chunks into 14-day windows to avoid the Walmart pagination bug
 * where nextCursor loops infinitely for >200 WFS orders in a single range.
 */
export async function syncWalmartOrders(
  credentials: WalmartCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  // Split into 14-day chunks to avoid Walmart pagination bug
  const CHUNK_DAYS = 14;
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate || new Date().toISOString()).getTime();
  const chunks: { start: string; end: string }[] = [];

  let current = startMs;
  while (current < endMs) {
    const chunkEnd = Math.min(current + CHUNK_DAYS * 86400000, endMs);
    chunks.push({
      start: new Date(current).toISOString(),
      end: new Date(chunkEnd).toISOString(),
    });
    current = chunkEnd;
  }

  log.info(`Splitting into ${chunks.length} chunks of ${CHUNK_DAYS} days`);

  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      log.info(`Chunk ${ci + 1}/${chunks.length}: ${chunk.start.split('T')[0]} → ${chunk.end.split('T')[0]}`);

      // Must sync both Seller Fulfilled and WFS orders separately
      for (const shipNodeType of ['SellerFulfilled', 'WFSFulfilled']) {
        let nextCursor: string | undefined;
        let iterations = 0;
        const MAX_ITERATIONS = 50; // safety valve — 50 pages × 200 = 10,000 orders max per chunk

        do {
          iterations++;
          if (iterations > MAX_ITERATIONS) {
            errors.push(`Pagination loop exceeded ${MAX_ITERATIONS} iterations for ${shipNodeType} chunk ${ci + 1}`);
            break;
          }

          const params: Record<string, string> = {
            createdStartDate: chunk.start,
            createdEndDate: chunk.end,
            limit: '200',
            shipNodeType,
          };
          if (nextCursor) params.nextCursor = nextCursor;

          let response: any;
          try {
            response = await walmartApiRequest(credentials, '/orders', params);
          } catch (err: any) {
            errors.push(`Orders fetch error (${shipNodeType}): ${err.message}`);
            break;
          }

          const orderList = response?.list?.elements?.order || response?.elements?.order || [];
          if (!Array.isArray(orderList) || orderList.length === 0) break;

          for (const order of orderList) {
            try {
              processWalmartOrder(db, order);
              recordsFetched++;
            } catch (err: any) {
              errors.push(`Order ${order.purchaseOrderId || 'unknown'}: ${err.message}`);
            }
          }

          const newCursor = response?.list?.meta?.nextCursor || response?.meta?.nextCursor;
          // Detect cursor loop — if same cursor comes back, bail
          if (newCursor && newCursor === nextCursor) {
            log.warn(`Cursor loop detected for ${shipNodeType} chunk ${ci + 1}, breaking`);
            break;
          }
          nextCursor = newCursor;
        } while (nextCursor);
      }
    }
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

// Exported for tests (tests/golden-walmart-cancel.test.ts) — takes an explicit
// db handle so it can run against a fixture database.
export function processWalmartOrder(db: Database.Database, order: WalmartOrder) {
  const orderId = order.purchaseOrderId;
  if (!orderId) return;

  // Walmart returns dates as Unix timestamps in ms or ISO strings
  let orderDate = order.orderDate || new Date().toISOString();
  if (typeof orderDate === 'number' || /^\d+$/.test(String(orderDate))) {
    orderDate = new Date(Number(orderDate)).toISOString();
  }
  const now = new Date().toISOString();

  const orderLines = order.orderLines?.orderLine || [];
  if (orderLines.length === 0) return;

  // ---- Cancellation-aware line analysis ----
  // Walmart cancels at the LINE-STATUS level: one line can be Cancelled while
  // another ships, and a single line can carry multiple statuses each with a
  // statusQuantity (e.g. 2 Shipped + 1 Cancelled of qty 3). Verified against
  // the live API (July 2026): a cancelled line still carries its FULL
  // ItemPrice charge, so cancelled quantity must be excluded here — it can
  // never be derived from the charges. The old code skipped the WHOLE order
  // when any line was cancelled (understated revenue) and never reversed an
  // order cancelled after it synced (phantom revenue).
  interface SurvivingSku {
    qty: number;
    productPrice: number;
    shippingCharge: number;
    productTax: number;
    shippingTax: number;
    productName: string;
  }
  const bySku = new Map<string, SurvivingSku>();

  for (const line of orderLines) {
    const lineQty = parseInt(line.orderLineQuantity?.amount || line.quantity?.amount || '1') || 1;
    const statuses = line.orderLineStatuses?.orderLineStatus || [];
    let cancelledQty = 0;
    for (const s of statuses) {
      if (s.status === 'Cancelled') {
        const q = parseInt(s.statusQuantity?.amount || '');
        cancelledQty += Number.isFinite(q) && q > 0 ? q : lineQty; // no quantity → whole line
      }
    }
    const survivingQty = Math.max(0, lineQty - Math.min(cancelledQty, lineQty));
    if (survivingQty === 0) continue;

    const charges = line.charges?.charge || [];
    let productPrice = 0;
    let shippingCharge = 0;
    let productTax = 0;
    let shippingTax = 0;
    for (const charge of charges) {
      const amount = toCents(charge.chargeAmount?.amount);
      const taxAmount = toCents(charge.tax?.taxAmount?.amount);
      if (charge.chargeType === 'PRODUCT') {
        productPrice += amount;
        productTax += taxAmount;
      } else if (charge.chargeType === 'SHIPPING') {
        shippingCharge += amount;
        shippingTax += taxAmount;
      }
    }
    // Charges are line totals for the ORIGINAL quantity — pro-rate down to the
    // surviving units on a partial-quantity cancellation. Recon settles the
    // exact figures later; this keeps order revenue in the right ballpark.
    if (survivingQty < lineQty) {
      const ratio = survivingQty / lineQty;
      productPrice = Math.round(productPrice * ratio);
      shippingCharge = Math.round(shippingCharge * ratio);
      productTax = Math.round(productTax * ratio);
      shippingTax = Math.round(shippingTax * ratio);
    }

    const sku = line.item?.sku || '';
    const prev = bySku.get(sku);
    if (prev) {
      prev.qty += survivingQty;
      prev.productPrice += productPrice;
      prev.shippingCharge += shippingCharge;
      prev.productTax += productTax;
      prev.shippingTax += shippingTax;
    } else {
      bySku.set(sku, {
        qty: survivingQty,
        productPrice,
        shippingCharge,
        productTax,
        shippingTax,
        productName: line.item?.productName || '',
      });
    }
  }

  // ---- Fully cancelled: reverse if it synced as live before the cancellation ----
  if (bySku.size === 0) {
    const existing = db.prepare('SELECT status FROM orders WHERE order_id = ?').get(orderId) as { status?: string } | undefined;
    if (existing && existing.status !== 'Cancelled') {
      db.prepare(`DELETE FROM financial_events WHERE order_id = ? AND marketplace = 'walmart' AND event_type = 'ShipmentEvent'`).run(orderId);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
      db.prepare(`DELETE FROM sales_tax WHERE order_id = ? AND marketplace = 'walmart'`).run(orderId);
      db.prepare(`UPDATE orders SET status = 'Cancelled' WHERE order_id = ?`).run(orderId);
      log.info(`Order ${orderId} cancelled after sync — revenue records reversed`);
    }
    // Recon-sourced rows (fee_details, WalmartRefundEvent, incentives) are real
    // settlement data and are deliberately NOT deleted — with the ShipmentEvent
    // gone they no longer date into the P&L anyway. COGS self-corrects on the
    // next full FIFO recalc (every auto-sync cycle).
    return;
  }

  // Determine fulfillment channel — check shipNode or fulfillment option
  let fulfillmentChannel = 'Seller';
  if ((order as any).shipNode?.type === 'WFSFulfilled') {
    fulfillmentChannel = 'WFS';
  } else {
    for (const line of orderLines) {
      if (line.fulfillment?.fulfillmentOption?.toLowerCase().includes('wfs') ||
          line.fulfillment?.fulfillmentOption?.toLowerCase().includes('warehouse') ||
          line.fulfillment?.fulfillmentOption?.toLowerCase().includes('s2h')) {
        fulfillmentChannel = 'WFS';
        break;
      }
    }
  }

  // Insert/update order. excluded.status is 'Shipped', so an order that was
  // reversed as Cancelled and later shows surviving lines flips back to live.
  db.prepare(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
    VALUES (?, ?, 'Shipped', 'walmart', ?, 1, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      status = CASE WHEN excluded.status != status THEN excluded.status ELSE status END,
      fulfillment_channel = excluded.fulfillment_channel
  `).run(orderId, orderDate, fulfillmentChannel, now);

  // ---- Write surviving lines (aggregated per SKU) ----
  for (const [sku, l] of bySku) {
    const pricePerUnit = l.qty > 0 ? Math.round(l.productPrice / l.qty) : l.productPrice;

    // Upsert so a post-sync partial cancellation shrinks the stored quantity/
    // revenue instead of being ignored. cogs_per_unit is NOT touched here —
    // the full FIFO recalc that runs every auto-sync cycle re-costs the row.
    db.prepare(`
      INSERT INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, cogs_per_unit, promotional_rebate)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      ON CONFLICT(order_id, asin, sku) DO UPDATE SET
        quantity = excluded.quantity,
        price_per_unit = excluded.price_per_unit,
        total_price = excluded.total_price,
        shipping_charged = excluded.shipping_charged
    `).run(orderId, sku, sku, l.qty, pricePerUnit, l.productPrice, l.shippingCharge);

    // Insert product if not exists
    if (sku) {
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, name, marketplace, created_at, updated_at)
        VALUES (?, ?, ?, 'walmart', ?, ?)
      `).run(sku, sku, l.productName, now, now);

      // Update name if we have it and the existing one is just the SKU
      db.prepare(`
        UPDATE products SET name = ?, updated_at = ?
        WHERE asin = ? AND (name IS NULL OR name = '' OR name = asin)
      `).run(l.productName, now, sku);
    }

    // Financial event so the posted_date subquery works (same as Amazon
    // ShipmentEvents). If the row exists with a stale amount (partial
    // cancellation after sync), update it in place — INSERT OR IGNORE would
    // add a second event because total_amount is part of the unique index.
    const existingEvent = db.prepare(`
      SELECT id, total_amount FROM financial_events
      WHERE order_id = ? AND COALESCE(sku, '') = ? AND event_type = 'ShipmentEvent' AND marketplace = 'walmart'
    `).get(orderId, sku) as { id: number; total_amount: number } | undefined;
    if (existingEvent) {
      if (existingEvent.total_amount !== l.productPrice) {
        db.prepare(`UPDATE financial_events SET total_amount = ? WHERE id = ?`).run(l.productPrice, existingEvent.id);
      }
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES ('ShipmentEvent', ?, ?, ?, ?, 'walmart', ?, '{}', ?)
      `).run(orderDate, orderId, sku, sku, l.productPrice, now);
    }

    // Insert sales tax
    if (l.productTax > 0 || l.shippingTax > 0) {
      const state = order.shippingInfo?.postalAddress?.state || 'Unknown';
      const totalTax = l.productTax + l.shippingTax;
      db.prepare(`
        INSERT OR IGNORE INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date, marketplace)
        VALUES (?, ?, ?, ?, ?, 'walmart')
      `).run(orderId, state, totalTax, totalTax, orderDate);
    }
  }

  // ---- Remove rows for lines cancelled AFTER a previous sync ----
  // (order previously stored with more lines than now survive)
  const skus = [...bySku.keys()];
  const ph = skus.map(() => '?').join(',');
  db.prepare(`DELETE FROM order_items WHERE order_id = ? AND COALESCE(sku, '') NOT IN (${ph})`).run(orderId, ...skus);
  db.prepare(`
    DELETE FROM financial_events
    WHERE order_id = ? AND marketplace = 'walmart' AND event_type = 'ShipmentEvent' AND COALESCE(sku, '') NOT IN (${ph})
  `).run(orderId, ...skus);
}
