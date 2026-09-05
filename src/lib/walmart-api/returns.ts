/**
 * Walmart Marketplace Returns API client.
 */

import { walmartApiRequest } from './auth';
import type { WalmartCredentials } from './types';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null) return 0;
  return Math.round(Number(amount) * 100);
}

export async function syncWalmartReturns(
  credentials: WalmartCredentials,
  startDate: string,
  endDate?: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    let nextCursor: string | undefined;

    do {
      const params: Record<string, string> = {
        returnCreationStartDate: startDate,
        returnCreationEndDate: endDate || new Date().toISOString(),
        limit: '200',
      };

      let response: any;
      try {
        const endpoint = nextCursor ? `/returns${nextCursor.substring(nextCursor.indexOf('?'))}` : '/returns';
        response = await walmartApiRequest(credentials, nextCursor ? endpoint : '/returns', nextCursor ? undefined : params);
      } catch (err: any) {
        errors.push(`Returns fetch error: ${err.message}`);
        break;
      }

      const returns = response?.returnOrders || [];
      if (!Array.isArray(returns) || returns.length === 0) break;

      const now = new Date().toISOString();

      for (const ret of returns) {
        try {
          const returnOrderId = ret.returnOrderId;
          // Walmart's docs: returnOrderId IS the RMA number. customerOrderId
          // is what Seller Center's order search and the support case form
          // key on. Both are needed to file a WFS reimbursement case.
          const customerOrderId = ret.customerOrderId || null;
          const returnDate = ret.returnOrderDate || now;
          const totalRefund = toCents(ret.totalRefundAmount?.currencyAmount);
          const lines = ret.returnOrderLines || [];

          for (const line of lines) {
            const purchaseOrderId = line.purchaseOrderId || returnOrderId;
            const sku = line.item?.sku || '';
            // Walmart reports the RETURNED quantity on the line and prices
            // every charge PER UNIT (chargePerUnit / unitPrice). Hardcoding 1
            // understated every multi-unit return by (qty - 1) units — e.g.
            // return 175544407242882867 stored 1 x $440 for a 2-unit,
            // $880 return. Cross-check: chargePerUnit x quantity must equal
            // the line's own chargeTotals.lineSubTotal.
            const quantity =
              Number(line.quantity?.measurementValue) ||
              Number(line.refundedQty) ||
              1;
            const reason = line.returnReason || line.returnDescription || 'CUSTOMER_RETURN';

            // Get refund amount from charges or totalRefundAmount
            let refundAmount = 0;
            const charges = line.charges || [];
            for (const charge of charges) {
              if (charge.chargeCategory === 'PRODUCT') {
                refundAmount += toCents(charge.chargePerUnit?.currencyAmount) * quantity;
              }
            }
            // Fallback to total if per-line not available
            if (refundAmount === 0 && lines.length === 1) {
              refundAmount = totalRefund;
            }

            // Correct rows we already stored for THIS return line. Keyed on
            // (order_id, sku, return_order_id) — verified unique across every
            // stamped row, so this can never touch a different return. Without
            // it the content-dedup below sees a changed amount as a brand-new
            // refund and inserts a SECOND row (double-counting the return).
            //   quantity: always trusted from the API — it was hardcoded to 1.
            //   refund_amount: only when the refund has NOT settled in recon.
            //     Once settled, recon's Product Price figure is the cash
            //     truth (what Walmart actually deducted) and must win.
            if (returnOrderId) {
              db.prepare(`
                UPDATE refunds
                   SET quantity = ?,
                       refund_amount = CASE
                         WHEN refund_amount = 0 OR NOT EXISTS (
                           SELECT 1 FROM financial_events fe
                           WHERE fe.event_type = 'WalmartRefundEvent'
                             AND fe.order_id = refunds.order_id
                             AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
                         ) THEN ?
                         ELSE refund_amount
                       END
                 WHERE order_id = ? AND COALESCE(sku, '') = ?
                   AND return_order_id = ? AND marketplace = 'walmart'
              `).run(quantity, refundAmount, purchaseOrderId, sku, returnOrderId);
            }

            // Content-based dedup: Walmart re-dates the same return across
            // syncs (returnOrderDate shifts hours-to-days), so the unique
            // index (order_id, asin, refund_date) sees each re-date as a new
            // refund. Recon settlements confirmed every (order, sku, amount)
            // group with >1 row was a duplicate — Walmart deducted only once.
            // Skip the insert when a row for this order+sku already exists
            // with the same amount, or with amount 0 (the pre-recon
            // placeholder this sync's amount will eventually update).
            db.prepare(`
              INSERT INTO refunds (order_id, refund_date, asin, sku, quantity, refund_amount, reason, item_returned, fee_clawback, marketplace, return_order_id, customer_order_id, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, 'walmart', ?, ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM refunds
                WHERE order_id = ? AND COALESCE(sku, '') = ? AND marketplace = 'walmart'
                  AND (
                    -- Already have THIS return line: the UPDATE above has
                    -- already reconciled it, so never insert a second row.
                    -- Needed because a settled refund legitimately diverges
                    -- from the API figure (recon's deduction is the cash
                    -- truth and wins), which the amount match below would
                    -- otherwise read as a brand-new refund.
                    return_order_id = ?
                    OR refund_amount = ? OR refund_amount = 0 OR ? = 0
                  )
              )
            `).run(purchaseOrderId, returnDate, sku, sku, quantity, refundAmount, reason, returnOrderId, customerOrderId, now,
                   purchaseOrderId, sku, returnOrderId, refundAmount, refundAmount);

            // Backfill the identifiers on rows that already existed. The
            // dedup above skips the insert for every return we've already
            // seen, so without this UPDATE no historical refund would ever
            // get its RMA. Targets a single row (the one whose refund_date is
            // closest to this return) so two genuinely distinct returns on
            // the same order+sku can't both be stamped with one RMA.
            db.prepare(`
              UPDATE refunds SET return_order_id = ?, customer_order_id = ?
              WHERE id = (
                SELECT id FROM refunds
                WHERE order_id = ? AND COALESCE(sku, '') = ? AND marketplace = 'walmart'
                  AND return_order_id IS NULL
                ORDER BY ABS(julianday(refund_date) - julianday(?))
                LIMIT 1
              )
            `).run(returnOrderId, customerOrderId, purchaseOrderId, sku, returnDate);

            recordsFetched++;
          }
        } catch (err: any) {
          errors.push(`Return ${ret.returnOrderId || 'unknown'}: ${err.message}`);
        }
      }

      nextCursor = response?.meta?.nextCursor;
    } while (nextCursor);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}
