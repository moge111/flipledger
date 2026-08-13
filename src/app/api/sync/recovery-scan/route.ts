/**
 * POST /api/sync/recovery-scan — run the Recovery Hub discrepancy
 * detectors (refund-without-return, FBA fee overcharge). Pure SQL, runs
 * in ms. Also refreshes the existing dispute/claim classifiers so the
 * hub's aggregate numbers are current after one click.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncRecoveryDiscrepancies } from '@/lib/recovery/discrepancies';
import { syncAmazonDisputeCandidates } from '@/lib/sp-api/amazonDisputeCandidates';
import { syncWalmartDisputeCandidates } from '@/lib/walmart-api/disputeCandidates';
import { syncReimbursementReevaluations } from '@/lib/sp-api/reimbursementReevaluations';

export async function POST() {
  try {
    const discrepancies = syncRecoveryDiscrepancies();
    const amazonDisputes = syncAmazonDisputeCandidates();
    const walmartDisputes = syncWalmartDisputeCandidates();
    const reevaluations = syncReimbursementReevaluations();

    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('recovery_scan_last_sync', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = datetime('now')
    `).run();
    db.close();

    return NextResponse.json({ success: true, discrepancies, amazonDisputes, walmartDisputes, reevaluations });
  } catch (err) {
    console.error('[recovery-scan] failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
