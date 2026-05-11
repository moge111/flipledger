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
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    // Pull refunds + the matching v2024 Shipment transaction (if any) so we
    // can classify the cash impact of each refund. A refund of a still-deferred
    // shipment cancels held funds with no cash impact; a refund of an already-
    // released shipment is a real cash deduction.
    const rows = db.prepare(`
      SELECT
        r.refund_date as refundDate,
        r.order_id as orderId,
        r.asin,
        r.sku,
        COALESCE(p.name, p2.name, oi.asin, r.asin) as productName,
        r.quantity,
        r.refund_amount as refundAmount,
        r.reason,
        r.item_returned as itemReturned,
        COALESCE(r.fee_clawback, 0) as feeClawback,
        r.marketplace,
        ftv2.transaction_status as shipmentStatus,
        ftv2.maturity_date as shipmentMaturity,
        ftv2.posted_date as shipmentPostedDate
      FROM refunds r
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN order_items oi ON r.order_id = oi.order_id
      LEFT JOIN products p2 ON oi.asin = p2.asin
      LEFT JOIN (
        SELECT order_id, transaction_status, maturity_date, posted_date
        FROM finances_transactions_v2
        WHERE transaction_type = 'Shipment' AND order_id IS NOT NULL
      ) ftv2 ON ftv2.order_id = r.order_id
      WHERE r.refund_date >= ?
      ORDER BY r.refund_date DESC
    `).all(cutoff) as any[];

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
        cashImpact,
        shipmentStatus: row.shipmentStatus || null,
        shipmentMaturity: row.shipmentMaturity || null,
      };
    });

    const count = items.length;
    const totalRefundAmount = items.reduce((s, i) => s + i.refundAmount, 0);
    const totalClawback = items.reduce((s, i) => s + i.feeClawback, 0);
    const totalNetImpact = items.reduce((s, i) => s + i.netImpact, 0);

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
