/**
 * Self-healing post-sync sweep for the ServiceFeeEvent rolling-date
 * duplication bug.
 *
 * Amazon's Financial Events API returns pending/un-settled service fees
 * (subscription, storage, inbound transportation, inbound convenience,
 * etc.) with a `PostedDate` that rolls forward to "today" on every sync.
 * The insert-time dedup in `processServiceFeeEvent` is now month-scoped
 * (correct) — but a stale dev-server module cache, an in-flight worker
 * holding the old closure, or a race during a code reload can let the
 * old day-scoped behavior re-insert dupes before the new code is live.
 *
 * This sweep runs at the end of every Amazon sync and collapses any
 * duplicates that snuck in: per (fee_type, amount, COALESCE(asin,''),
 * calendar-month) keep the earliest row, delete the rest from
 * fee_details, and drop the now-orphaned ServiceFeeEvent
 * `financial_events` rows.
 *
 * Idempotent — running it when there are no dupes is a no-op.
 */
import Database from 'better-sqlite3';
import path from 'path';

export interface DedupServiceFeesResult {
  feeDetailsDeleted: number;
  eventsDeleted: number;
  dollarsRemoved: number;
}

export function dedupServiceFees(): DedupServiceFeesResult {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    const result: DedupServiceFeesResult = {
      feeDetailsDeleted: 0,
      eventsDeleted: 0,
      dollarsRemoved: 0,
    };

    const tx = db.transaction(() => {
      // Find dupe fee_details rows. Per group: keep earliest posted_date,
      // tiebreak on lowest id. Scoped to 2026+ to protect filed/reconciled
      // years (the bug started with the daily auto-sync ~Apr 2026).
      // Scope STRICTLY to fee_details whose parent event is a ServiceFeeEvent.
      // The rolling-date bug only exists for that source — sweeping all
      // order-less fees would silently delete genuine same-amount fees from
      // the authoritative TransactionReport import and Walmart WFS service
      // fees (e.g. two identical placement fees for two shipments in one
      // month).
      const dupes = db
        .prepare(
          `SELECT id, financial_event_id, amount FROM (
             SELECT fd.id, fd.financial_event_id, fd.amount,
               ROW_NUMBER() OVER (
                 PARTITION BY fd.fee_type, fd.amount, COALESCE(fd.asin,''),
                              strftime('%Y-%m', fd.posted_date)
                 ORDER BY fd.posted_date ASC, fd.id ASC
               ) AS rn
             FROM fee_details fd
             JOIN financial_events fe ON fe.id = fd.financial_event_id
               AND fe.event_type = 'ServiceFeeEvent'
             WHERE (fd.order_id IS NULL OR fd.order_id = '')
               AND fd.posted_date >= '2026-01-01'
           ) WHERE rn > 1`
        )
        .all() as { id: number; financial_event_id: number | null; amount: number }[];

      if (dupes.length === 0) return;

      const delFee = db.prepare('DELETE FROM fee_details WHERE id = ?');
      const eventIds = new Set<number>();
      for (const d of dupes) {
        delFee.run(d.id);
        result.feeDetailsDeleted++;
        result.dollarsRemoved += d.amount;
        if (d.financial_event_id) eventIds.add(d.financial_event_id);
      }

      // Drop orphaned ServiceFeeEvent financial_events
      const delEvent = db.prepare(
        `DELETE FROM financial_events
         WHERE id = ? AND event_type = 'ServiceFeeEvent'
           AND NOT EXISTS (SELECT 1 FROM fee_details WHERE financial_event_id = ?)`
      );
      for (const eid of eventIds) {
        result.eventsDeleted += delEvent.run(eid, eid).changes;
      }
    });

    tx();
    return result;
  } finally {
    db.close();
  }
}
