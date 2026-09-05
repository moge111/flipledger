/**
 * POST /api/list/batches/[id]/preflight
 *
 * Runs pre-flight validation for every item in a draft batch (gating,
 * FNSKU registration, catalog defects, prep classification) and persists the
 * results so the batch UI can badge each item BEFORE send. See
 * src/lib/listing-preflight.ts for the full check list.
 *
 * The frontend calls this on page load and on a slow poll while the batch is
 * draft and any item isn't READY yet. Safe to call repeatedly — checks that
 * already resolved (FNSKU known, restriction OK) are skipped.
 *
 * GET returns the last-persisted results without touching Amazon (cheap).
 */
import { NextRequest, NextResponse } from 'next/server';
import { preflightBatch, type PreflightSummary } from '@/lib/listing-preflight';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }
  try {
    const result = await preflightBatch(batchId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }
  const db = getDb();
  try {
    const items = db.prepare(`
      SELECT id as itemId, sku,
             preflight_status as status,
             fnsku,
             prep_category as prepCategory,
             preflight_detail as detail,
             preflight_checked_at as checkedAt
      FROM listing_batch_items WHERE batch_id = ? ORDER BY id ASC
    `).all(batchId) as any[];
    const summary: PreflightSummary = { ready: 0, pending: 0, gated: 0, catalogIssue: 0, stuck: 0, failed: 0, unpriced: 0 };
    for (const it of items) {
      it.detail = it.detail ? JSON.parse(it.detail) : {};
      switch (it.status) {
        case 'READY': summary.ready++; break;
        case 'GATED': summary.gated++; break;
        case 'CATALOG_ISSUE': summary.catalogIssue++; break;
        case 'STUCK': summary.stuck++; break;
        case 'FAILED': summary.failed++; break;
        case 'UNPRICED': summary.unpriced++; break;
        default: summary.pending++; break;
      }
    }
    return NextResponse.json({ items, summary });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
