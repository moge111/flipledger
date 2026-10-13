import { NextRequest, NextResponse } from 'next/server';
import { MKT_DATE, marketToday, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/transactions');

const getDb = () => openDb({ readonly: true });

// Same date subqueries as the Dashboard/P&L so the feed reconciles with the
// stat cards exactly (cash basis = MIN ShipmentEvent posted_date per order).
const FE_POSTED = `(SELECT order_id, MIN(posted_date) as posted_date FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL GROUP BY order_id)`;
const FE_PURCHASE = `(SELECT order_id, purchase_date as posted_date FROM orders)`;

export interface TransactionRow {
  time: string;
  type: 'sale' | 'refund' | 'fee' | 'reimbursement';
  marketplace: string;
  title: string;
  subtitle: string;
  orderId: string | null;
  amount: number; // signed cents: what this transaction did to the marketplace balance
  profit?: number; // sales only: amount − COGS − MFN label cost (same rule as the Dashboard)
  cogs?: number;
  shippingCost?: number;
  deferred?: boolean;
  releaseDate?: string | null;
  settled?: boolean; // Walmart refunds: whether the deduction actually settled in recon
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  const startDate = searchParams.get('startDate') || marketToday();
  const endDate = searchParams.get('endDate') || startDate;
  const endDateNext = addDays(endDate, 1);

  const marketplace = marketplaceParam(searchParams);
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';
  const dateBasis = searchParams.get('dateBasis') || 'posted';
  const FE = dateBasis === 'purchase' ? FE_PURCHASE : FE_POSTED;

  try {
    const transactions: TransactionRow[] = [];

    // ─── Sales: one row per order that posted in the window ────────────
    const sales = db.prepare(`
      SELECT
        o.order_id,
        o.marketplace,
        fe.posted_date as time,
        SUM(oi.total_price + CASE WHEN o.fulfillment_channel IN ('MFN', 'Seller') THEN COALESCE(oi.shipping_charged, 0) ELSE 0 END) as revenue,
        SUM(oi.quantity) as qty,
        SUM(COALESCE(oi.cogs_per_unit, 0) * oi.quantity) as cogs,
        SUM(CASE WHEN o.fulfillment_channel IN ('MFN', 'Seller') THEN COALESCE(oi.shipping_cost, 0) ELSE 0 END) as shippingCost,
        COUNT(DISTINCT COALESCE(oi.sku, oi.asin)) as skuCount,
        MAX(COALESCE(p.name, p_sku.name, li.product_name, oi.sku, oi.asin)) as productName
      FROM order_items oi
      JOIN ${FE} fe ON oi.order_id = fe.order_id
      JOIN orders o ON oi.order_id = o.order_id
      LEFT JOIN products p ON p.asin = oi.asin
      LEFT JOIN products p_sku ON p_sku.asin = oi.sku
      LEFT JOIN live_inventory li ON li.sku = oi.sku
      WHERE ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ? ${MF}
      GROUP BY o.order_id
    `).all(startDate, endDateNext) as any[];

    const orderFees = db.prepare(`
      SELECT fd.order_id, -SUM(fd.amount) as fees
      FROM fee_details fd
      JOIN ${FE} fe ON fd.order_id = fe.order_id
      JOIN orders o ON fd.order_id = o.order_id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND ${MKT_DATE('fe.posted_date')} >= ? AND ${MKT_DATE('fe.posted_date')} < ? ${MF}
      GROUP BY fd.order_id
    `).all(startDate, endDateNext) as any[];
    const feesByOrder = new Map(orderFees.map(f => [f.order_id, f.fees]));

    // Amazon DD7 status per order from the v2024 Finances ledger
    const dd7 = db.prepare(`
      SELECT order_id, transaction_status, maturity_date
      FROM finances_transactions_v2
      WHERE transaction_type = 'Shipment' AND order_id IS NOT NULL
    `).all() as any[];
    const dd7ByOrder = new Map(dd7.map(t => [t.order_id, t]));

    for (const s of sales) {
      const fees = feesByOrder.get(s.order_id) || 0;
      const t = dd7ByOrder.get(s.order_id);
      const cogs = s.cogs || 0;
      const shippingCost = s.shippingCost || 0;
      const subtitleParts = [`$${(s.revenue / 100).toFixed(2)} revenue`];
      if (fees > 0) subtitleParts.push(`$${(fees / 100).toFixed(2)} fees`);
      if (cogs > 0) subtitleParts.push(`$${(cogs / 100).toFixed(2)} COGS`);
      if (shippingCost > 0) subtitleParts.push(`$${(shippingCost / 100).toFixed(2)} ship`);
      transactions.push({
        time: s.time,
        type: 'sale',
        marketplace: s.marketplace,
        title: s.skuCount > 1 ? `${s.productName} +${s.skuCount - 1} more` : s.productName,
        subtitle: `${s.qty} unit${s.qty !== 1 ? 's' : ''} · ${subtitleParts.join(' − ')}`,
        orderId: s.order_id,
        amount: s.revenue - fees,
        profit: s.revenue - fees - cogs - shippingCost,
        cogs,
        shippingCost,
        deferred: t?.transaction_status === 'DEFERRED',
        releaseDate: t?.maturity_date || null,
      });
    }

    // ─── Refunds (all shown; Walmart rows carry a settled flag — the same
    //     recon gate the Dashboard/P&L use to decide P&L inclusion) ──────
    const refunds = db.prepare(`
      SELECT r.refund_date as time, r.order_id, r.marketplace, r.refund_amount, r.reason,
        COALESCE(p_oi.name, p.name, p_sku.name, r.sku, r.asin) as productName,
        CASE WHEN r.marketplace != 'walmart' OR EXISTS (
          SELECT 1 FROM financial_events fe
          WHERE fe.event_type = 'WalmartRefundEvent'
            AND fe.order_id = r.order_id
            AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
        ) THEN 1 ELSE 0 END as settled
      FROM refunds r
      LEFT JOIN (SELECT order_id, MIN(asin) as asin FROM order_items GROUP BY order_id) oi ON oi.order_id = r.order_id
      LEFT JOIN products p_oi ON p_oi.asin = oi.asin
      LEFT JOIN products p ON p.asin = r.asin
      LEFT JOIN products p_sku ON p_sku.asin = r.sku
      WHERE ${MKT_DATE('r.refund_date')} >= ? AND ${MKT_DATE('r.refund_date')} < ? ${MF_R.replace(/marketplace/g, 'r.marketplace')}
    `).all(startDate, endDateNext) as any[];

    for (const r of refunds) {
      transactions.push({
        time: r.time,
        type: 'refund',
        marketplace: r.marketplace || 'amazon',
        title: r.productName || 'Refund',
        subtitle: (r.reason || '').replace(/_/g, ' ').toLowerCase(),
        orderId: r.order_id,
        amount: -r.refund_amount,
        settled: !!r.settled,
      });
    }

    // ─── Service fees (order-less: storage, subscription, inbound UPS…) ─
    const serviceFees = db.prepare(`
      SELECT fd.posted_date as time, fd.fee_type, fd.fee_category, fd.amount, fe.marketplace
      FROM fee_details fd
      JOIN financial_events fe ON fd.financial_event_id = fe.id
      WHERE (fd.order_id IS NULL OR fd.order_id = '')
        AND ${MKT_DATE('fd.posted_date')} >= ? AND ${MKT_DATE('fd.posted_date')} < ?
        ${marketplace ? "AND fe.marketplace = '" + marketplace + "'" : ''}
    `).all(startDate, endDateNext) as any[];

    for (const f of serviceFees) {
      transactions.push({
        time: f.time,
        type: 'fee',
        marketplace: f.marketplace || 'amazon',
        title: f.fee_type.replace(/([a-z])([A-Z])/g, '$1 $2'),
        subtitle: f.fee_category || 'Service fee',
        orderId: null,
        amount: f.amount, // stored signed (charges negative, credits positive)
      });
    }

    // ─── Reimbursements ─────────────────────────────────────────────────
    const reimbs = db.prepare(`
      SELECT reimbursement_date as time, reimbursement_id, reason, amount, marketplace,
        COALESCE(asin, sku, '') as ref
      FROM reimbursements
      WHERE ${MKT_DATE('reimbursement_date')} >= ? AND ${MKT_DATE('reimbursement_date')} < ? ${MF_R}
    `).all(startDate, endDateNext) as any[];

    for (const r of reimbs) {
      transactions.push({
        time: r.time,
        type: 'reimbursement',
        marketplace: r.marketplace || 'amazon',
        title: (r.reason || 'Reimbursement').replace(/_/g, ' '),
        subtitle: r.ref ? `${r.ref}` : 'Marketplace reimbursement',
        orderId: null,
        amount: r.amount,
      });
    }

    transactions.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    const sum = (type: string) => transactions.filter(t => t.type === type).reduce((s, t) => s + t.amount, 0);
    const salesProfit = transactions.filter(t => t.type === 'sale').reduce((s, t) => s + (t.profit ?? t.amount), 0);
    // Net excludes unsettled Walmart refunds — same rule as the P&L.
    const net = transactions
      .filter(t => !(t.type === 'refund' && t.settled === false))
      .reduce((s, t) => s + t.amount, 0);

    return NextResponse.json({
      transactions,
      summary: {
        count: transactions.length,
        salesNet: sum('sale'),
        salesProfit,
        refunds: sum('refund'),
        fees: sum('fee'),
        reimbursements: sum('reimbursement'),
        net,
      },
    });
  } catch (error) {
    log.error('Transactions API error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    db.close();
  }
}
