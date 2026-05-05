import { NextRequest, NextResponse } from 'next/server';
import { setPrepDetails, getInboundOperation } from '@/lib/sp-api/inboundPlansV2';
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
 * POST /api/sync/prep-fix
 * Body: { mskus: string[], category?: string, types?: string[] }
 *
 * Sets prep classification for one or more MSKUs at the catalog level.
 * Defaults to NONE / ITEM_NO_PREP (correct for ~95% of retail-arbitrage
 * goods in original retail packaging).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const mskus: string[] = Array.isArray(body.mskus) ? body.mskus : [];
  const category: string = body.category || 'NONE';
  const types: string[] = Array.isArray(body.types) && body.types.length > 0
    ? body.types
    : ['ITEM_NO_PREP'];

  if (mskus.length === 0) {
    return NextResponse.json({ error: 'mskus array required' }, { status: 400 });
  }

  const credentials = getCredentials();
  if (!credentials.refreshToken) {
    return NextResponse.json({ error: 'Missing SP-API credentials' }, { status: 400 });
  }

  try {
    const prepResult = await setPrepDetails(
      credentials,
      mskus.map((msku) => ({ msku, prepCategory: category, prepTypes: types }))
    );

    // Poll until SUCCESS / FAILED, max ~60s
    const POLL_MS = 3000;
    const MAX_ATTEMPTS = 20;
    let finalStatus: string | null = null;
    let problems: any[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const op = await getInboundOperation(credentials, prepResult.operationId);
      finalStatus = op.operationStatus;
      problems = op.operationProblems || [];
      if (op.operationStatus === 'SUCCESS' || op.operationStatus === 'FAILED') break;
    }

    return NextResponse.json({
      operationId: prepResult.operationId,
      status: finalStatus,
      problems,
      mskus,
      category,
      types,
      note: finalStatus === 'SUCCESS'
        ? 'Prep classification set. Wait ~60-90s for it to propagate to the Inbound Plans service before retrying batch send.'
        : 'Operation did not finish or failed — check problems.',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
