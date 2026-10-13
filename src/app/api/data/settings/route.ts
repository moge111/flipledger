import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

// Credentials are never sent to the browser. GET returns a mask (with the last
// 4 characters so the user can tell which key is stored); POST ignores any value
// that is still the mask, so saving a form that round-trips it keeps the real key.
const SECRET_KEYS = new Set([
  'clientSecret',
  'refreshToken',
  'walmart_client_secret',
  'ebay_client_secret',
  'ebay_refresh_token',
  'anthropic_api_key',
]);
const MASK_PREFIX = '••••••••';

function maskSecret(value: string): string {
  if (!value) return '';
  return MASK_PREFIX + value.slice(-4);
}

export async function GET() {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = SECRET_KEYS.has(row.key) ? maskSecret(row.value) : row.value;
    }
    db.close();
    return NextResponse.json({ settings });
  } catch {
    db.close();
    return NextResponse.json({ settings: {} });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const saveSettings = db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'string') continue;
      if (SECRET_KEYS.has(key) && value.startsWith(MASK_PREFIX)) continue;
      upsert.run(key, value);
    }
  });

  try {
    saveSettings();
    db.close();
    return NextResponse.json({ success: true });
  } catch (err) {
    db.close();
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
