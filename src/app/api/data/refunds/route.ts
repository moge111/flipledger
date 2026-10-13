import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/refunds');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();
  const marketplace = marketplaceParam(searchParams);
  // refunds.marketplace can be NULL for old Amazon rows — treat NULL as amazon.
  const MF_R = marketplace ? `AND COALESCE(r.marketplace, 'amazon') = '${marketplace}'` : '';

  // The page sends startDate/endDate from the date-range picker; honor them.
  // Fall back to the legacy ?days= window when absent.
  const startParam = searchParams.get('startDate');
  const endParam = searchParams.get('endDate');
  // Both bounds are marketplace-calendar date strings, matching MKT_DATE().
  const cutoff = startParam || marketDaysAgo(days);
  const cutoffEnd = addDays(endParam || marketToday(), 1);

  try {
    // Pull refunds + the matching v2024 Shipment transaction (if any) so we
    // can classify the cash impact of each refund. A refund of a still-deferred
    // shipment cancels held funds with no cash impact; a refund of an already-
    // released shipment is a real cash deduction.
    //
    // GROUP BY r.id: both the order_items name-resolution join and the ftv2
    // join can match multiple rows per refund — without the GROUP BY the
    // totals double-count fanned-out rows.
    const rows = db.prepare(`
      SELECT
        r.refund_date as refundDate,
        r.order_id as orderId,
        r.asin,
        r.sku,
        COALESCE(p.name, MAX(p2.name), MAX(oi.asin), r.asin) as productName,
        r.quantity,
        r.refund_amount as refundAmount,
        r.reason,
        r.item_returned as itemReturned,
        r.id as refundId,
        -- Claim lifecycle lives in walmart_dispute_candidates (refund_id FK) so
        -- this page and the Walmart Disputes page can never disagree about
        -- what's been filed. Every claim-due refund has a candidate row.
        (SELECT c.id FROM walmart_dispute_candidates c WHERE c.refund_id = r.id) as claimId,
        (SELECT c.status FROM walmart_dispute_candidates c WHERE c.refund_id = r.id) as claimStatus,
        (SELECT c.filed_at FROM walmart_dispute_candidates c WHERE c.refund_id = r.id) as claimFiledAt,
        r.return_order_id as returnOrderId,
        r.customer_order_id as customerOrderId,
        -- Walmart's Item ID for the support case form's "Item ID" field. NOT
        -- our SKU, and NOT recon's "Partner Item Id" (which is the seller SKU).
        -- live_inventory is the better source; products is the fallback.
        COALESCE(
          (SELECT MAX(li2.walmart_item_id) FROM live_inventory li2
            WHERE li2.sku = r.sku AND li2.marketplace = 'walmart' AND li2.walmart_item_id IS NOT NULL),
          (SELECT MAX(p3.walmart_item_id) FROM products p3
            WHERE p3.sku = r.sku AND p3.walmart_item_id IS NOT NULL)
        ) as walmartItemId,
        COALESCE(r.fee_clawback, 0) as feeClawback,
        r.marketplace,
        ftv2.transaction_status as shipmentStatus,
        ftv2.maturity_date as shipmentMaturity,
        ftv2.posted_date as shipmentPostedDate,
        CASE WHEN COALESCE(r.marketplace, 'amazon') != 'walmart' THEN 1
             WHEN EXISTS (
               SELECT 1 FROM financial_events fe2
               WHERE fe2.event_type = 'WalmartRefundEvent'
                 AND fe2.order_id = r.order_id
                 AND json_extract(fe2.raw_data, '$."Amount Type"') = 'Product Price'
             ) THEN 1 ELSE 0 END as settled,
        CASE
          -- RTV = Walmart shipped the unit back to the seller, so nothing is
          -- owed. Sourced from wfs_rtv_units (per-GTIN, from the Services Fees
          -- CSVs). It deliberately does NOT read WFSInventoryRTVFee any more:
          -- since the Aug 2026 recon migration those rows are period-level
          -- roll-ups with a NULL GTIN, so fe3.asin = og.gtin could never
          -- match and this branch was silently dead — every settled return
          -- fell through to 'claim-due'.
          -- rtvCover allocates each returned unit to at most one refund, so
          -- two refunds of the same GTIN with only one RTV clear exactly one.
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               AND rtvc.covered = 1 THEN 'rtv'
          -- Walmart already paid for the loss (lost-return adjustment, WFS
          -- lost-inventory, dispute settlement) — claiming again would be a
          -- duplicate. Previously unchecked, even though the UI told the user
          -- "no reimbursement".
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               AND EXISTS (
                 SELECT 1 FROM reimbursements rb
                 WHERE rb.marketplace = 'walmart'
                   -- LOSS reimbursements only. Commission/funded incentives are
                   -- ordinary income and must never clear a lost-unit claim.
                   AND rb.reason IN ('WFS Refund', 'WFS Lost Inventory',
                                     'LostReturnAdjustment', 'Dispute: Customer Return Reversal')
                   AND date(rb.reimbursement_date)
                       BETWEEN date(r.refund_date, '-3 days') AND date(r.refund_date, '+150 days')
                   AND (
                     rb.reimbursement_id LIKE '%' || r.order_id || '%'
                     OR (rb.sku IS NOT NULL AND rb.sku <> '' AND rb.sku = r.sku COLLATE NOCASE)
                   )
                 -- Recon-sourced WFS Refund roll-ups carry no SKU or order id;
                 -- lost-return payouts are attributed via wfs_lost_returns below.
               ) THEN 'reimbursed'
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart'
               AND EXISTS (SELECT 1 FROM wfs_lost_returns l
                           WHERE l.rma = r.return_order_id OR (l.rma IS NULL AND l.po = r.order_id))
            THEN 'reimbursed'
          -- RESTOCKED requires evidence the unit is actually back: the SKU has
          -- sellable stock right now, or it sold again after the refund. A bare
          -- "settled + no RTV fee" claim overcounts (in-store returns spend
          -- weeks in Walmart's reverse-logistics pipeline, invisible to us).
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               AND (
                 EXISTS (SELECT 1 FROM live_inventory li WHERE li.sku = r.sku AND li.fulfillable_qty > 0)
                 OR EXISTS (
                   SELECT 1 FROM order_items oi2 JOIN orders o2 ON o2.order_id = oi2.order_id
                   WHERE oi2.sku = r.sku AND o2.purchase_date > r.refund_date AND o2.status != 'Cancelled'
                 )
               ) THEN 'restocked'
          -- No evidence anywhere after 60 days: Walmart's own policy says lost
          -- returns are auto-reimbursed within 60 days of the return — past
          -- that with nothing visible, a Seller Support case is warranted.
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               AND julianday('now') - julianday(r.refund_date) >= 60
               THEN 'claim-due'
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               THEN 'in-pipeline'
          ELSE NULL
        END as disposition
      FROM refunds r
      LEFT JOIN orders o ON o.order_id = r.order_id
      LEFT JOIN (
        SELECT order_id, MAX(json_extract(raw_data, '$."Partner GTIN"')) as gtin
        FROM financial_events
        WHERE marketplace = 'walmart'
          AND event_type IN ('WalmartReconEvent', 'WalmartRefundEvent')
          AND order_id IS NOT NULL
        GROUP BY order_id
      ) og ON og.order_id = r.order_id
      -- Allocate RTV'd units to refunds of the same GTIN, oldest refund first.
      -- A refund is covered when its rank among same-GTIN settled WFS refunds
      -- is <= the number of units Walmart shipped back for that GTIN on/after
      -- (refund date - 7d). Without the rank an EXISTS would let one returned
      -- unit clear every refund of that item.
      LEFT JOIN (
        SELECT rr.id AS refund_id,
               CASE WHEN ROW_NUMBER() OVER (PARTITION BY gg.gtin ORDER BY rr.refund_date)
                         <= (SELECT COALESCE(SUM(u.quantity), 0) FROM wfs_rtv_units u
                             WHERE u.gtin = gg.gtin)
                    THEN 1 ELSE 0 END AS covered
        FROM refunds rr
        JOIN orders oo ON oo.order_id = rr.order_id AND oo.fulfillment_channel = 'WFS'
        JOIN (
          SELECT order_id, MAX(json_extract(raw_data, '$."Partner GTIN"')) AS gtin
          FROM financial_events
          WHERE marketplace = 'walmart' AND order_id IS NOT NULL
            AND json_extract(raw_data, '$."Partner GTIN"') IS NOT NULL
          GROUP BY order_id
        ) gg ON gg.order_id = rr.order_id
        WHERE rr.marketplace = 'walmart'
          AND EXISTS (SELECT 1 FROM wfs_rtv_units u2
                      WHERE u2.gtin = gg.gtin AND u2.rtv_date >= date(rr.refund_date, '-7 days'))
      ) rtvc ON rtvc.refund_id = r.id
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN order_items oi ON r.order_id = oi.order_id
      LEFT JOIN products p2 ON oi.asin = p2.asin
      LEFT JOIN (
        SELECT order_id,
          CASE WHEN SUM(CASE WHEN transaction_status = 'DEFERRED' THEN 1 ELSE 0 END) > 0
               THEN 'DEFERRED' ELSE MAX(transaction_status) END as transaction_status,
          MAX(maturity_date) as maturity_date,
          MIN(posted_date) as posted_date
        FROM finances_transactions_v2
        WHERE transaction_type = 'Shipment' AND order_id IS NOT NULL
        GROUP BY order_id
      ) ftv2 ON ftv2.order_id = r.order_id
      WHERE ${MKT_DATE('r.refund_date')} >= ? AND ${MKT_DATE('r.refund_date')} < ? ${MF_R}
      GROUP BY r.id
      ORDER BY r.refund_date DESC
    `).all(cutoff, cutoffEnd) as any[];

    const items = rows.map((row) => {
      // Classify cash impact:
      //   'held-fund'    = refund cancelled held funds — no real cash out
      //   'real'         = refund of already-released/disbursed funds — real cash out
      //   'unknown'      = non-Amazon marketplace, or genuinely ambiguous
      //
      // For Amazon: DDP holds funds ~10 days post-delivery, then releases.
      // If we have v2024 evidence the shipment is currently DEFERRED OR the
      // refund predates the shipment's maturity_date, refund cancels the hold.
      // For old refunds without v2024 evidence: default to 'real' since DDP
      // would have released those funds long before the v2024 sync window.
      let cashImpact: 'held-fund' | 'real' | 'unknown' = 'unknown';
      if (row.marketplace === 'amazon') {
        if (row.shipmentStatus === 'DEFERRED') {
          cashImpact = 'held-fund';
        } else if (row.shipmentMaturity && row.refundDate < row.shipmentMaturity) {
          cashImpact = 'held-fund';
        } else {
          cashImpact = 'real';
        }
      }
      return {
        refundDate: row.refundDate,
        orderId: row.orderId,
        asin: row.asin,
        sku: row.sku,
        productName: row.productName,
        quantity: row.quantity,
        refundAmount: row.refundAmount,
        reason: row.reason,
        itemReturned: !!row.itemReturned,
        // Walmart only. returnOrderId IS the RMA; customerOrderId is the
        // number Seller Center searches on. Both go in a reimbursement case.
        refundId: row.refundId,
        claimId: row.claimId ?? null,
        claimStatus: row.claimStatus || null,
        claimFiledAt: row.claimFiledAt || null,
        returnOrderId: row.returnOrderId || null,
        customerOrderId: row.customerOrderId || null,
        walmartItemId: row.walmartItemId || null,
        feeClawback: row.feeClawback,
        netImpact: row.refundAmount - row.feeClawback,
        marketplace: row.marketplace || 'amazon',
        // Amazon/eBay/PayPal refunds arrive settled; Walmart refunds only count
        // once the recon deduction exists — same gate the P&L uses. ~30% of
        // Walmart return records are ghosts Walmart never charges for.
        settled: !!row.settled,
        // WFS return disposition: 'rtv' = Walmart deemed it unsellable and
        // shipped it back (RTV fee found for the GTIN near the refund date —
        // hard evidence, shown regardless of settlement); 'restocked' = kept
        // by WFS and back in sellable stock (only claimed once settled);
        // 'pending' = return initiated but not yet settled/inspected.
        // Freshness bound by the last Seller Center service-fee CSV import.
        disposition: row.disposition === 'rtv' ? 'rtv'
          : row.settled ? row.disposition
          : row.disposition ? 'pending'
          : null,
        cashImpact,
        shipmentStatus: row.shipmentStatus || null,
        shipmentMaturity: row.shipmentMaturity || null,
      };
    });

    const count = items.length;
    const totalRefundAmount = items.reduce((s, i) => s + i.refundAmount, 0);
    const totalClawback = items.reduce((s, i) => s + i.feeClawback, 0);
    // Net impact counts SETTLED refunds only — matches how the P&L/Dashboard
    // count refunds. Unsettled Walmart records are surfaced separately.
    const totalNetImpact = items.filter(i => i.settled).reduce((s, i) => s + i.netImpact, 0);
    const unsettledWalmartImpact = items.filter(i => !i.settled).reduce((s, i) => s + i.netImpact, 0);
    const unsettledWalmartCount = items.filter(i => !i.settled).length;
    const claimDueCount = items.filter(i => i.disposition === 'claim-due').length;
    const claimDueImpact = items.filter(i => i.disposition === 'claim-due').reduce((s, i) => s + i.refundAmount, 0);

    // Cash-flow split: held-fund refunds (no real cash out) vs realized cash deductions
    const heldFundImpact = items.filter(i => i.cashImpact === 'held-fund').reduce((s, i) => s + i.netImpact, 0);
    const realCashImpact = items.filter(i => i.cashImpact === 'real').reduce((s, i) => s + i.netImpact, 0);
    const unknownImpact = items.filter(i => i.cashImpact === 'unknown').reduce((s, i) => s + i.netImpact, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count,
        totalRefundAmount,
        totalClawback,
        totalNetImpact,
        unsettledWalmartImpact,
        unsettledWalmartCount,
        claimDueCount,
        claimDueImpact,
        heldFundImpact,
        realCashImpact,
        unknownImpact,
      },
    });
  } catch (error) {
    db.close();
    log.error('Refunds API error:', error);
    return NextResponse.json({ error: 'Failed to load refunds data' }, { status: 500 });
  }
}
