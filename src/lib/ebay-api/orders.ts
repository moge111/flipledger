/**
 * eBay Fulfillment API client.
 * Pulls orders and line items, stores in shared orders/order_items tables.
 */

import { ebayApiRequest } from './auth';
import type { EbayCredentials, EbayOrder } from './types';
import Database from 'better-sqlite3';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('ebay-api/orders');

const FULFILLMENT_API = 'https://api.ebay.com/sell/fulfillment/v1';

const getDb = () => openDb();

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null || amount === '') return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Sync eBay orders for a given date range.
 * Uses offset-based pagination.
 */
export async function syncEbayOrders(
  credentials: EbayCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    let offset = 0;
    const limit = 200;

    // eBay filter uses bracket range syntax. lastmodifieddate (not
    // creationdate) so refunds/cancellations on OLDER orders re-enter the
    // rolling sync window — a refund 3 weeks after purchase would never be
    // seen again under a creationdate filter with a 14-day lookback. New
    // orders still match (creation sets lastmodifieddate), and re-processing
    // an order touched for other reasons is idempotent.
    const endDateStr = endDate || new Date().toISOString();
    const filter = `lastmodifieddate:[${startDate}..${endDateStr}]`;

    do {
      let response: any;
      try {
        // Request full order details including fees
        response = await ebayApiRequest(
          credentials,
          `${FULFILLMENT_API}/order`,
          { filter, limit: String(limit), offset: String(offset), fieldGroups: 'TAX_BREAKDOWN' },
        );
      } catch (err: any) {
        errors.push(`Orders fetch error: ${err.message}`);
        break;
      }

      const orders: EbayOrder[] = response?.orders || [];
      if (orders.length === 0) break;

      for (const order of orders) {
        try {
          processEbayOrder(db, order);
          recordsFetched++;
        } catch (err: any) {
          errors.push(`Order ${order.orderId || 'unknown'}: ${err.message}`);
        }
      }

      // Check if there are more pages
      const total = response?.total || 0;
      offset += limit;
      if (offset >= total) break;
    } while (true);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

function processEbayOrder(db: Database.Database, order: EbayOrder) {
  const orderId = order.orderId;
  if (!orderId) return;

  const orderDate = order.creationDate || new Date().toISOString();
  const now = new Date().toISOString();

  // Cancelled orders: skip — and if this order was synced as live BEFORE the
  // cancellation, reverse it. A bare early-return left phantom revenue
  // (ShipmentEvent + order_items) on the books forever.
  if (order.cancelStatus?.cancelState === 'CANCELED' ||
      order.orderFulfillmentStatus === 'NOT_STARTED' && order.orderPaymentStatus === 'FAILED') {
    const existing = db.prepare('SELECT status FROM orders WHERE order_id = ?').get(orderId) as { status?: string } | undefined;
    if (existing && existing.status !== 'Cancelled') {
      db.prepare('DELETE FROM fee_details WHERE order_id = ?').run(orderId);
      db.prepare("DELETE FROM financial_events WHERE order_id = ? AND marketplace = 'ebay'").run(orderId);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
      db.prepare("DELETE FROM sales_tax WHERE order_id = ? AND marketplace = 'ebay'").run(orderId);
      db.prepare("DELETE FROM refunds WHERE order_id = ? AND marketplace = 'ebay'").run(orderId);
      db.prepare("UPDATE orders SET status = 'Cancelled' WHERE order_id = ?").run(orderId);
      log.info(`Order ${orderId} cancelled after sync — revenue/fee records reversed`);
    }
    return;
  }

  // Always MFN (self-fulfilled)
  const fulfillmentChannel = 'MFN';

  // Real fulfillment status so the MFN Orders ship queue can surface open eBay
  // orders. FULFILLED → Shipped; NOT_STARTED / IN_PROGRESS → Unshipped.
  const orderStatus = order.orderFulfillmentStatus === 'FULFILLED' ? 'Shipped' : 'Unshipped';

  // Get buyer's state for sales tax
  const shippingAddr = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress;
  const state = shippingAddr?.stateOrProvince || 'Unknown';

  // Insert/update order
  db.prepare(`
    INSERT INTO orders (order_id, purchase_date, status, marketplace, fulfillment_channel, is_estimated, created_at)
    VALUES (?, ?, ?, 'ebay', ?, 1, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      status = CASE WHEN excluded.status != status THEN excluded.status ELSE status END
  `).run(orderId, orderDate, orderStatus, fulfillmentChannel, now);

  // Extract order-level fee data from Fulfillment API (no Finances API needed)
  const totalMarketplaceFee = toCents((order as any).totalMarketplaceFee?.value);
  const totalFeeBasis = toCents((order as any).totalFeeBasisAmount?.value);

  const lineItems = order.lineItems || [];

  for (const item of lineItems) {
    const sku = item.sku || item.legacyItemId || '';
    const ebayItemId = item.legacyItemId || '';
    const title = item.title || '';
    const quantity = item.quantity || 1;
    const productPrice = toCents(item.lineItemCost?.value);
    const shippingCharge = toCents(item.deliveryCost?.shippingCost?.value);
    const pricePerUnit = quantity > 0 ? Math.round(productPrice / quantity) : productPrice;

    // Tax from line item
    let taxAmount = 0;
    if (item.taxes) {
      for (const tax of item.taxes) {
        taxAmount += toCents(tax.amount?.value);
      }
    }
    // Also check ebayCollectAndRemitTaxes
    const ebayTaxes = (item as any).ebayCollectAndRemitTaxes || [];
    for (const tax of ebayTaxes) {
      taxAmount += toCents(tax.amount?.value);
    }

    // Insert order item
    db.prepare(`
      INSERT OR IGNORE INTO order_items (order_id, asin, sku, quantity, price_per_unit, total_price, shipping_charged, shipping_cost, cogs_per_unit, promotional_rebate)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `).run(orderId, ebayItemId, sku, quantity, pricePerUnit, productPrice, shippingCharge);

    // Insert product
    if (sku || ebayItemId) {
      const productKey = sku || ebayItemId;
      db.prepare(`
        INSERT OR IGNORE INTO products (asin, sku, name, marketplace, created_at, updated_at)
        VALUES (?, ?, ?, 'ebay', ?, ?)
      `).run(productKey, sku, title, now, now);

      // Update name if existing is empty
      db.prepare(`
        UPDATE products SET name = ?, updated_at = ?
        WHERE asin = ? AND (name IS NULL OR name = '' OR name = asin)
      `).run(title, now, productKey);
    }

    // Insert financial event (for posted_date subquery to work)
    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('ShipmentEvent', ?, ?, ?, ?, 'ebay', ?, '{}', ?)
    `).run(orderDate, orderId, ebayItemId, sku, productPrice, now);

    // Sales tax
    if (taxAmount > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO sales_tax (order_id, state, tax_collected, marketplace_facilitator_tax, posted_date, marketplace)
        VALUES (?, ?, ?, ?, ?, 'ebay')
      `).run(orderId, state, taxAmount, taxAmount, orderDate);
    }
  }

  // Insert marketplace fee as fee_detail (order-level, not per-item)
  if (totalMarketplaceFee > 0) {
    // Create a financial event for the fee
    const feeResult = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('EbayFeeEvent', ?, ?, ?, ?, 'ebay', ?, '{}', ?)
    `).run(orderDate, orderId, '', '', -totalMarketplaceFee, now);

    if (feeResult.changes > 0) {
      const eventId = Number(feeResult.lastInsertRowid);
      db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, ?, ?, 'EbayFinalValueFee', 'eBay Selling Fees', ?, ?)
      `).run(eventId, orderId, '', -totalMarketplaceFee, orderDate);
    }

    // Mark order as reconciled (we have real fees)
    db.prepare(`UPDATE orders SET is_estimated = 0 WHERE order_id = ?`).run(orderId);
  }

  // Refunds — the Fulfillment API exposes order-level refunds in
  // paymentSummary.refunds (no Finances API approval needed). Amounts are
  // order-level, so product identifiers are only attached for single-line-item
  // orders; multi-item refunds get NULL identifiers (counted in refund totals,
  // but FIFO deliberately won't zero COGS without a product match).
  const refunds = (order as any).paymentSummary?.refunds || [];
  if (refunds.length > 0) {
    const singleItem = lineItems.length === 1 ? lineItems[0] : null;
    const singleItemTotal = singleItem ? toCents(singleItem.lineItemCost?.value) : 0;
    for (const refund of refunds) {
      // Only settled refunds — PENDING can still fail, FAILED never happened.
      if (refund.refundStatus && refund.refundStatus !== 'REFUNDED') continue;
      const amountCents = toCents(refund.amount?.value);
      if (amountCents <= 0) continue;
      const refundDate = refund.refundDate || now;
      // Full refund of a single-item order → the unit comes back (or the sale
      // is fully reversed), so item_returned=1 lets FIFO return its COGS.
      // Partial/goodwill refunds keep COGS — the buyer kept the item.
      const isFullRefund = singleItem !== null && amountCents >= singleItemTotal;
      // Content-based dedup on (order, amount): eBay can re-send the same
      // refund across syncs; a second DISTINCT refund on one order would have
      // a different amount (same lesson as the Walmart returns re-dating bug).
      db.prepare(`
        INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 'EBAY_REFUND', ?, 0, 'ebay', ?
        WHERE NOT EXISTS (
          SELECT 1 FROM refunds WHERE order_id = ? AND refund_amount = ? AND marketplace = 'ebay'
        )
      `).run(
        orderId, refundDate,
        singleItem ? (singleItem.legacyItemId || null) : null,
        singleItem ? (singleItem.sku || singleItem.legacyItemId || null) : null,
        isFullRefund ? (singleItem?.quantity || 1) : 1,
        amountCents,
        isFullRefund ? 1 : 0,
        now, orderId, amountCents
      );
    }
  }
}
