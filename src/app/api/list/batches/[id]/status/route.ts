/**
 * GET /api/list/batches/[id]/status
 *
 * Polls Amazon for the current state of a batch that has been sent.
 *   - For each item with listing_status = PROCESSING, call GET /listings to
 *     check if it's gone ACTIVE.
 *   - If the batch has an inbound_operation_id and plan_status != SUCCESS,
 *     call GET /operations/{id} to check the plan state.
 *   - When both all listings are ACTIVE and the operation is SUCCESS,
 *     transition the batch to 'ready'.
 *
 * The actual reconciliation logic lives in src/lib/listing-reconcile.ts and
 * is shared with the auto-sync sweep (which finishes batches whose tab was
 * closed mid-send — the browser only polls while this page is open).
 *
 * Called by the frontend on a ~5s interval while the batch is in 'sending'
 * or 'ready' state. Cheap for draft batches (DB-only, no SP-API calls).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { getInboundPlan } from '@/lib/sp-api/inboundPlansV2';
import { reconcileSendingBatch } from '@/lib/listing-reconcile';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
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
}

// Return the same batch/items shape as GET /api/list/batches/[id] so the
// frontend can safely replace its state with this response. (If we return a
// subset, fields like `createdAt` go undefined and the header renders as
// "Created Invalid Date".)
function loadBatchAndItems(batchId: number): { batch: any; items: any[] } | null {
  const db = getDb();
  try {
    const batch = db.prepare(`
      SELECT
        id, name, status, channel, marketplace,
        inbound_plan_id as inboundPlanId,
        inbound_operation_id as inboundOperationId,
        plan_status as planStatus,
        send_error as sendError,
        sent_at as sentAt,
        ship_from_name as shipFromName,
        ship_from_address_line1 as shipFromAddressLine1,
        ship_from_city as shipFromCity,
        ship_from_state as shipFromState,
        ship_from_postal_code as shipFromPostalCode,
        ship_from_country_code as shipFromCountryCode,
        ship_from_phone as shipFromPhone,
        packing_operation_id as packingOperationId,
        packing_option_id as packingOptionId,
        packing_group_id as packingGroupId,
        packing_status as packingStatus,
        packing_confirmed_at as packingConfirmedAt,
        packing_error as packingError,
        placement_operation_id as placementOperationId,
        placement_option_id as placementOptionId,
        placement_status as placementStatus,
        placement_fee_cents as placementFeeCents,
        placement_confirmed_at as placementConfirmedAt,
        placement_error as placementError,
        notes,
        created_at as createdAt,
        updated_at as updatedAt
      FROM listing_batches WHERE id = ?
    `).get(batchId) as any;

    if (!batch) return null;

    const items = db.prepare(`
      SELECT
        id, batch_id as batchId, asin, sku, msku,
        product_name as productName, image_url as imageUrl,
        condition, quantity,
        list_price_cents as listPriceCents,
        buy_price_cents as buyPriceCents,
        supplier, purchase_date as purchaseDate,
        estimated_fee_cents as estimatedFeeCents,
        estimated_ship_cents as estimatedShipCents,
        listing_status as listingStatus,
        listing_submission_id as listingSubmissionId,
        listing_error as listingError,
        listing_updated_at as listingUpdatedAt,
        labels_printed_at as labelsPrintedAt,
        created_at as createdAt
      FROM listing_batch_items WHERE batch_id = ?
      ORDER BY id ASC
    `).all(batchId) as any[];

    return { batch, items };
  } finally {
    db.close();
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  try {
    let loaded = loadBatchAndItems(batchId);
    if (!loaded) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    // If the batch isn't in an active state, just return what we have.
    if (loaded.batch.status !== 'sending') {
      return NextResponse.json({ batch: loaded.batch, items: loaded.items });
    }

    // The batch is in 'sending' — reconcile against Amazon, then reload so
    // the response reflects any transitions.
    await reconcileSendingBatch(batchId);
    loaded = loadBatchAndItems(batchId);
    if (!loaded) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    const { batch, items } = loaded;

    // Optionally fetch a fresh inbound plan snapshot for display
    let inboundPlan: any = null;
    if (batch.inboundPlanId && batch.planStatus === 'SUCCESS') {
      const db = getDb();
      const creds = getAmazonCredentials(db);
      db.close();
      if (creds) {
        try {
          inboundPlan = await getInboundPlan(creds, batch.inboundPlanId);
        } catch (err) {
          console.warn(`[batch status] getInboundPlan failed:`, err);
        }
      }
    }

    return NextResponse.json({
      batch,
      items,
      operationStatus: batch.planStatus,
      inboundPlan,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
