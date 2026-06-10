/**
 * Per-settlement reconciliation.
 *
 * For each Amazon settlement (a real disbursement, from the V2 settlement
 * report) in the date range, returns the authoritative payout total plus the
 * order activity attributed to that settlement: sales, fees, service fees,
 * refunds, reimbursements, COGS, units, orders — and a book net profit.
 *
 * Attribution: Amazon runs overlapping settlement groups (a near-daily
 * disbursement chain PLUS occasional long-span reserve-release settlements
 * that cover the same dates with a tiny net). A naive date-range match would
 * double-count those days. Instead each day's activity is assigned to the
 * TIGHTEST settlement window that contains it — so the daily settlements get
 * their orders and the long reserve settlements correctly net ~nothing. Every
 * dollar is counted exactly once.
 *
 * "Did my bank deposit match my books?" — payout is Amazon's number; the
 * components are ours. netProfit = sales + fees + serviceFees - refunds
 * + reimbursements - COGS (fees/serviceFees are stored negative).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  return db;
}

const FE_POSTED = `(
  SELECT order_id, MIN(posted_date) AS posted_date
  FROM financial_events
  WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
  GROUP BY order_id
)`;

interface Settlement {
  settlement_id: string; start_date: string; end_date: string;
  deposit_date: string; total_amount_cents: number; currency: string;
}

interface Bucket {
  salesCents: number; orderFeesCents: number; serviceFeesCents: number;
  refundsCents: number; reimbursementsCents: number; cogsCents: number;
  units: number; orders: number;
}
const emptyBucket = (): Bucket => ({
  salesCents: 0, orderFeesCents: 0, serviceFeesCents: 0,
  refundsCents: 0, reimbursementsCents: 0, cogsCents: 0, units: 0, orders: 0,
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || '2026-01-01';
  const endDate = searchParams.get('endDate') || new Date().toISOString().split('T')[0];

  const db = getDb();
  try {
    const settlements = db.prepare(`
      SELECT settlement_id, start_date, end_date, deposit_date, total_amount_cents, currency
      FROM settlements
      WHERE marketplace = 'amazon'
        AND COALESCE(deposit_date, end_date) >= ?
        AND COALESCE(deposit_date, end_date) <= ?
      ORDER BY COALESCE(deposit_date, end_date) DESC
    `).all(startDate, endDate) as Settlement[];

    if (settlements.length === 0) {
      return NextResponse.json({
        summary: { settlementCount: 0, totalPayoutCents: 0, totalCogsCents: 0, totalNetProfitCents: 0, totalUnits: 0 },
        settlements: [],
      });
    }

    // Overall window the settlements span — pull per-day activity once across it.
    const minStart = settlements.reduce((m, s) => (s.start_date < m ? s.start_date : m), settlements[0].start_date);
    const maxEnd = settlements.reduce((m, s) => (s.end_date > m ? s.end_date : m), settlements[0].end_date);

    // Per-day aggregates (cheap GROUP BY date), then bucketed in JS to the
    // tightest containing settlement.
    const salesByDay = db.prepare(`
      SELECT date(fe.posted_date) AS d,
             COALESCE(SUM(oi.total_price),0) AS sales,
             COALESCE(SUM(oi.cogs_per_unit*oi.quantity),0) AS cogs,
             COALESCE(SUM(oi.quantity),0) AS units,
             COUNT(DISTINCT oi.order_id) AS orders
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      JOIN ${FE_POSTED} fe ON oi.order_id = fe.order_id
      WHERE o.marketplace='amazon' AND date(fe.posted_date) >= ? AND date(fe.posted_date) <= ?
      GROUP BY date(fe.posted_date)
    `).all(minStart, maxEnd) as Array<{ d: string; sales: number; cogs: number; units: number; orders: number }>;

    const orderFeesByDay = db.prepare(`
      SELECT date(fd.posted_date) AS d, COALESCE(SUM(fd.amount),0) AS amt
      FROM fee_details fd JOIN orders o ON fd.order_id = o.order_id
      WHERE o.marketplace='amazon' AND fd.order_id IS NOT NULL AND fd.order_id != ''
        AND date(fd.posted_date) >= ? AND date(fd.posted_date) <= ?
      GROUP BY date(fd.posted_date)
    `).all(minStart, maxEnd) as Array<{ d: string; amt: number }>;

    // fee_details has no marketplace column — gate via the parent financial
    // event so Walmart WFS service fees don't contaminate Amazon settlements.
    const serviceFeesByDay = db.prepare(`
      SELECT date(fd.posted_date) AS d, COALESCE(SUM(fd.amount),0) AS amt
      FROM fee_details fd
      JOIN financial_events fe ON fe.id = fd.financial_event_id AND fe.marketplace = 'amazon'
      WHERE (fd.order_id IS NULL OR fd.order_id='') AND date(fd.posted_date) >= ? AND date(fd.posted_date) <= ?
      GROUP BY date(fd.posted_date)
    `).all(minStart, maxEnd) as Array<{ d: string; amt: number }>;

    const refundsByDay = db.prepare(`
      SELECT date(refund_date) AS d, COALESCE(SUM(refund_amount),0) AS amt
      FROM refunds WHERE marketplace='amazon' AND date(refund_date) >= ? AND date(refund_date) <= ?
      GROUP BY date(refund_date)
    `).all(minStart, maxEnd) as Array<{ d: string; amt: number }>;

    const reimbByDay = db.prepare(`
      SELECT date(reimbursement_date) AS d, COALESCE(SUM(amount),0) AS amt
      FROM reimbursements WHERE marketplace='amazon' AND date(reimbursement_date) >= ? AND date(reimbursement_date) <= ?
      GROUP BY date(reimbursement_date)
    `).all(minStart, maxEnd) as Array<{ d: string; amt: number }>;

    // Tightest settlement (smallest span) whose [start,end] contains the day.
    const spanDays = (s: Settlement) =>
      (new Date(s.end_date).getTime() - new Date(s.start_date).getTime()) / 86400000;
    const tightestFor = (day: string): string | null => {
      let best: Settlement | null = null;
      for (const s of settlements) {
        if (day >= s.start_date && day <= s.end_date) {
          if (!best || spanDays(s) < spanDays(best)) best = s;
        }
      }
      return best ? best.settlement_id : null;
    };

    const buckets = new Map<string, Bucket>();
    for (const s of settlements) buckets.set(s.settlement_id, emptyBucket());

    const add = (day: string, fn: (b: Bucket) => void) => {
      const sid = tightestFor(day);
      if (sid) fn(buckets.get(sid)!);
    };
    for (const r of salesByDay) add(r.d, (b) => { b.salesCents += r.sales; b.cogsCents += r.cogs; b.units += r.units; b.orders += r.orders; });
    for (const r of orderFeesByDay) add(r.d, (b) => { b.orderFeesCents += r.amt; });
    for (const r of serviceFeesByDay) add(r.d, (b) => { b.serviceFeesCents += r.amt; });
    for (const r of refundsByDay) add(r.d, (b) => { b.refundsCents += r.amt; });
    for (const r of reimbByDay) add(r.d, (b) => { b.reimbursementsCents += r.amt; });

    const rows = settlements.map((s) => {
      const b = buckets.get(s.settlement_id)!;
      const netProfit = b.salesCents + b.orderFeesCents + b.serviceFeesCents - b.refundsCents + b.reimbursementsCents - b.cogsCents;
      const bookActivity = b.salesCents + b.orderFeesCents + b.serviceFeesCents - b.refundsCents + b.reimbursementsCents;
      return {
        settlementId: s.settlement_id,
        startDate: s.start_date, endDate: s.end_date, depositDate: s.deposit_date,
        currency: s.currency || 'USD',
        payoutCents: s.total_amount_cents,
        salesCents: b.salesCents, orderFeesCents: b.orderFeesCents, serviceFeesCents: b.serviceFeesCents,
        refundsCents: b.refundsCents, reimbursementsCents: b.reimbursementsCents, cogsCents: b.cogsCents,
        units: b.units, orders: b.orders,
        netProfitCents: netProfit,
        reconDeltaCents: s.total_amount_cents - bookActivity,
      };
    });

    const summary = {
      settlementCount: rows.length,
      totalPayoutCents: rows.reduce((s, r) => s + r.payoutCents, 0),
      totalCogsCents: rows.reduce((s, r) => s + r.cogsCents, 0),
      totalNetProfitCents: rows.reduce((s, r) => s + r.netProfitCents, 0),
      totalUnits: rows.reduce((s, r) => s + r.units, 0),
    };

    return NextResponse.json({ summary, settlements: rows });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
