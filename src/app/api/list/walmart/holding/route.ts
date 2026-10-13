/**
 * "Walmart stock to send": one standing draft WFS batch for units bought for
 * WFS but not in a shipment yet. Adding a product there creates its Walmart SKU
 * and records the cost lot right away, so the SKU is ready when the units move
 * into a real WFS batch (POST /api/list/batches/[id]/wfs/move).
 *
 * GET  → { id | null, items }   (items with units still waiting)
 * POST → { id }                 (creates the list on first use)
 */
import { NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { getOrCreateHoldingBatch, holdingItems } from '@/lib/wfs-batch';

export async function GET() {
  const db = openDb({ readonly: true });
  try {
    const row = db.prepare("SELECT id FROM listing_batches WHERE is_holding = 1 AND channel = 'WFS' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    return NextResponse.json({ id: row?.id ?? null, items: row ? holdingItems(db) : [] });
  } finally {
    db.close();
  }
}

export async function POST() {
  const db = openDb();
  try {
    return NextResponse.json({ id: getOrCreateHoldingBatch(db) });
  } finally {
    db.close();
  }
}
