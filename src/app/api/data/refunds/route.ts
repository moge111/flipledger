import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();
  const marketplace = searchParams.get('marketplace');
  // refunds.marketplace can be NULL for old Amazon rows — treat NULL as amazon.
  const MF_R = marketplace ? `AND COALESCE(r.marketplace, 'amazon') = '${marketplace}'` : '';

  // The page sends startDate/endDate from the date-range picker; honor them.
  // Fall back to the legacy ?days= window when absent.
  const startParam = searchParams.get('startDate');
  const endParam = searchParams.get('endDate');
  const cutoff = startParam || new Date(Date.now() - days * 86400000).toISOString();
  const cutoffEnd = endParam
    ? new Date(new Date(endParam + 'T00:00:00Z').getTime() + 86400000).toISOString()
    : new Date(Date.now() + 86400000).toISOString();

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
          WHEN COALESCE(r.marketplace, 'amazon') = 'walmart' AND o.fulfillment_channel = 'WFS'
               AND og.gtin IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM fee_details fd2
                 JOIN financial_events fe3 ON fe3.id = fd2.financial_event_id
                 WHERE fd2.fee_type = 'WFSInventoryRTVFee'
                   AND fe3.asin = og.gtin
                   AND date(fe3.posted_date) >= date(r.refund_date, '-14 days')
               ) THEN 'rtv'
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
      WHERE r.refund_date >= ? AND r.refund_date < ? ${MF_R}
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
    console.error('Refunds API error:', error);
    return NextResponse.json({ error: 'Failed to load refunds data' }, { status: 500 });
  }
}
