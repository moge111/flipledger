/**
 * POST /api/sync/replacements-report
 *
 * Pulls Amazon's FBA Replacements report and stamps the replacement flag,
 * original order id and reason code onto matching orders. Takes 30-120s
 * (async report generation). Idempotent.
 *
 * Body (optional): { "startDate": ISO, "endDate": ISO } — defaults to the
 * last 400 days so a first run backfills history.
 */
import { NextRequest, NextResponse } from 'next/server';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { syncReplacementsReport } from '@/lib/sp-api/replacementsReport';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';

function getAmazonCredentials(): SPAPICredentials | null {
  const db = openDb({ readonly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      refreshToken: settings.refreshToken,
      marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
    };
  } finally {
    db.close();
  }
}

function finishLog(logId: number, status: 'done' | 'failed', records: number, error: string | null) {
  const db = openDb();
  try {
    db.prepare('UPDATE sync_log SET status = ?, completed_at = ?, records_fetched = ?, error = ? WHERE id = ?')
      .run(status, new Date().toISOString(), records, error, logId);
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const endDate: string = body.endDate || new Date().toISOString();
  const startDate: string = body.startDate || new Date(Date.now() - 400 * 86400000).toISOString();

  const creds = getAmazonCredentials();
  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  const db = openDb();
  const logId = Number(db.prepare(`INSERT INTO sync_log (sync_type, started_at, status) VALUES ('replacements-report', ?, 'running')`)
    .run(new Date().toISOString()).lastInsertRowid);
  db.close();

  clearTokenCache();
  try {
    const result = await syncReplacementsReport(creds, startDate, endDate);
    finishLog(logId, 'done', result.reportRows, null);
    return NextResponse.json({ success: true, startDate, endDate, ...result });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    finishLog(logId, 'failed', 0, errorMsg);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
