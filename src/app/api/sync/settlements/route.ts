/**
 * On-demand settlement report sync. Downloads available V2 settlement reports
 * (~90 days back) and populates the `settlements` table (period + payout) plus
 * the service-fee / reserve / shipping-cost extraction the parser already does.
 *
 *   POST  — run the sync now. Optional body { startDate } (defaults to 95 days ago).
 */
import { NextRequest, NextResponse } from 'next/server';
import { syncSettlementReports } from '@/lib/sp-api/reports';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';

function getCredentials(): SPAPICredentials {
  const db = openDb({ readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '',
    clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '',
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const startDate = body.startDate || new Date(Date.now() - 95 * 86400000).toISOString();

  const creds = getCredentials();
  if (!creds.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }

  try {
    const result = await syncSettlementReports(creds, startDate);
    const db = openDb({ readonly: true });
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM settlements`).get() as { c: number }).c;
    db.close();
    return NextResponse.json({ ...result, settlementsInDb: count });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
