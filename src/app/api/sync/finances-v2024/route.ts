import { NextRequest, NextResponse } from 'next/server';
import { syncFinancesV2024Transactions } from '@/lib/sp-api/financesV2024';
import Database from 'better-sqlite3';
import path from 'path';

function getCredentials() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return {
    clientId: settings.clientId || '',
    clientSecret: settings.clientSecret || '',
    refreshToken: settings.refreshToken || '',
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

/**
 * Manual / on-demand sync trigger.
 * POST body (optional): { postedAfter?: ISO, postedBefore?: ISO }
 *   Default window: last 30 days.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const creds = getCredentials();
  if (!creds.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }
  try {
    const result = await syncFinancesV2024Transactions(creds, body.postedAfter, body.postedBefore);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export async function GET() {
  return POST(new NextRequest('http://localhost/?', { method: 'POST' }));
}
