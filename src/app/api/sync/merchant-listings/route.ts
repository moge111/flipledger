/**
 * POST /api/sync/merchant-listings
 *
 * Requests GET_FLAT_FILE_OPEN_LISTINGS_DATA, polls until ready, parses the
 * TSV, and upserts every row into merchant_listings. Read-only from Amazon's
 * perspective — no listing updates, no quantity writes.
 *
 * Returns immediately with an error if SP-API credentials are not configured.
 * Safe to run repeatedly; upsert is idempotent on (asin, sku, marketplace).
 */
import { NextResponse } from 'next/server';
import path from 'path';
import { syncMerchantListings } from '@/lib/sp-api/merchantListings';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/sync/merchant-listings');

function getCredentials(): SPAPICredentials | null {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = openDb({ readonly: true });
    db.pragma('journal_mode = WAL');
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    db.close();
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
    return {
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      refreshToken: s.refreshToken,
      marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
    };
  } catch {
    return null;
  }
}

function setLastSyncTime(value: string) {
  const db = openDb();
  db.pragma('journal_mode = WAL');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('merchant_listings_last_sync', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(value);
  db.close();
}

export async function POST() {
  const creds = getCredentials();
  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  try {
    const result = await syncMerchantListings(creds);
    setLastSyncTime(new Date().toISOString());
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    log.error('Error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
