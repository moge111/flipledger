/**
 * GET  /api/data/batch-results[?batchId=N]  results for every sent batch (or one)
 * POST /api/data/batch-results?batchId=N    refresh that FBA batch's received counts from Amazon
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { computeBatchResults, syncBatchReceipts } from '@/lib/batch-results';
import type { SPAPICredentials } from '@/lib/sp-api/types';

export async function GET(request: NextRequest) {
  const id = new URL(request.url).searchParams.get('batchId');
  const db = openDb({ readonly: true });
  try {
    return NextResponse.json({ batches: computeBatchResults(db, id ? Number(id) : undefined) });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const batchId = Number(new URL(request.url).searchParams.get('batchId'));
  if (!Number.isInteger(batchId)) return NextResponse.json({ error: 'batchId required' }, { status: 400 });
  const db = openDb();
  try {
    const s: Record<string, string> = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) s[r.key] = r.value;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    const creds: SPAPICredentials = { clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken, marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER' };
    return NextResponse.json({ lines: await syncBatchReceipts(db, creds, batchId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
