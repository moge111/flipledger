/**
 * POST /api/list/batches/[id]/wfs/setup                 → check Walmart on every pending SKU setup
 * POST /api/list/batches/[id]/wfs/setup {retryItemId}   → resubmit a FAILED setup's feed
 *
 * The batch page calls this every 30 s while a setup is pending; the auto-sync
 * tick advances pending setups too (lib/wfs-item-setup.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import type { SetupState } from '@/lib/walmart-api/itemSetup';
import { walmartErrorMessage } from '@/lib/walmart-api/wfsInbound';
import { loadWfsBatch, WALMART_CHANNELS } from '@/lib/wfs-batch';
import { advancePendingSetups, retrySetup } from '@/lib/wfs-item-setup';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const body = await req.json().catch(() => ({}));
  {
    const db = openDb({ readonly: true });
    try {
      const found = loadWfsBatch(db, batchId, WALMART_CHANNELS);
      if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    } finally {
      db.close();
    }
  }

  if (body.retryItemId) {
    const creds = getWalmartCredentials();
    if (!creds) return NextResponse.json({ error: 'Walmart API credentials are not set.' }, { status: 400 });
    const db = openDb();
    try {
      const row = db.prepare("SELECT id, walmart_setup FROM listing_batch_items WHERE id = ? AND batch_id = ? AND walmart_setup_status = 'FAILED'")
        .get(Number(body.retryItemId), batchId) as { id: number; walmart_setup: string } | undefined;
      if (!row) return NextResponse.json({ error: 'No failed setup on that item.' }, { status: 404 });
      let next: SetupState;
      try {
        next = await retrySetup(creds, JSON.parse(row.walmart_setup) as SetupState);
      } catch (err) {
        return NextResponse.json({ error: `Walmart didn't accept the retry: ${walmartErrorMessage(err)}` }, { status: 502 });
      }
      db.prepare('UPDATE listing_batch_items SET walmart_setup_status = ?, walmart_setup = ? WHERE id = ?').run(next.status, JSON.stringify(next), row.id);
      return NextResponse.json({ success: true, status: next.status });
    } finally {
      db.close();
    }
  }

  const result = await advancePendingSetups(batchId);
  return NextResponse.json({ success: true, ...result });
}
