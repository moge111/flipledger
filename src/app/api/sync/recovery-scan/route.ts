/**
 * POST /api/sync/recovery-scan — run the Recovery Hub discrepancy
 * detectors (refund-without-return, FBA fee overcharge). Pure SQL, runs
 * in ms. Also refreshes the existing dispute/claim classifiers so the
 * hub's aggregate numbers are current after one click.
 */
import { NextResponse } from 'next/server';
import { syncRecoveryDiscrepancies } from '@/lib/recovery/discrepancies';
import { syncAmazonDisputeCandidates } from '@/lib/sp-api/amazonDisputeCandidates';
import { syncWalmartDisputeCandidates } from '@/lib/walmart-api/disputeCandidates';
import { syncReimbursementReevaluations } from '@/lib/sp-api/reimbursementReevaluations';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/sync/recovery-scan');

export async function POST() {
  try {
    const discrepancies = syncRecoveryDiscrepancies();
    const amazonDisputes = syncAmazonDisputeCandidates();
    const walmartDisputes = syncWalmartDisputeCandidates();
    const reevaluations = syncReimbursementReevaluations();

    const db = openDb();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('recovery_scan_last_sync', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = datetime('now')
    `).run();
    db.close();

    return NextResponse.json({ success: true, discrepancies, amazonDisputes, walmartDisputes, reevaluations });
  } catch (err) {
    log.error('failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
