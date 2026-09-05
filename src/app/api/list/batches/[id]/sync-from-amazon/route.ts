/**
 * POST /api/list/batches/[id]/sync-from-amazon
 *
 * Reconciles FlipLedger's batch state with whatever Amazon currently has.
 * Used when the user finished the workflow (boxing → packing → placement →
 * shipments) in Seller Central instead of FlipLedger — typically because
 * setPackingInformation 403'd and the user had to detour.
 *
 * What we do:
 *   1. GET the inbound plan from Amazon
 *   2. listShipments — if any exist, the plan is past placement
 *   3. Update batch.status / packing_status / placement_status to match
 *
 * After this runs, the existing /shipments and /labels endpoints will work
 * because the batch is now in 'shipping' status.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { getInboundPlan, listShipments } from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('api/list/batches/[id]/sync-from-amazon');

const getDb = () => openDb();

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

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string;
  let localPackingFailed = false;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId,
             packing_status as packingStatus, packing_error as packingError
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null; packingStatus: string | null; packingError: string | null } | undefined;
    if (!batch) {
      db.close();
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      db.close();
      return NextResponse.json({ error: 'Sync only applies to FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      db.close();
      return NextResponse.json({ error: 'Batch has no inbound plan to sync from' }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    localPackingFailed = batch.packingStatus === 'FAILED' || !!batch.packingError;
  } catch (e) {
    db.close();
    throw e;
  }

  if (!creds) {
    db.close();
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  let plan: {
    status?: string;
    placementOptions?: Array<{ status?: string }>;
    packingOptions?: Array<{ status?: string }>;
    shipments?: Array<{ shipmentId?: string; status?: string }>;
  };
  try {
    plan = await getInboundPlan(creds, inboundPlanId);
  } catch (err) {
    db.close();
    return NextResponse.json({ error: `getInboundPlan failed: ${err}` }, { status: 500 });
  }

  // Two sources of truth for shipments — the plan has a short list, the
  // separate listShipments endpoint has full detail. Prefer the separate
  // endpoint, fall back to the plan's embedded array.
  let shipments: Array<{ shipmentId?: string; status?: string }> = [];
  try {
    shipments = await listShipments(creds, inboundPlanId);
  } catch (err) {
    log.warn(`listShipments failed: ${err}`);
  }
  if (shipments.length === 0 && plan.shipments && plan.shipments.length > 0) {
    shipments = plan.shipments;
  }

  // Amazon v2024 uses "ACCEPTED" (not "CONFIRMED") once the seller picks an
  // option and the workflow advances to the next stage. Treat both as "done."
  const isDone = (s?: string) => s === 'CONFIRMED' || s === 'ACCEPTED';
  const confirmedPlacement = (plan.placementOptions || []).some((p) => isDone(p.status));
  const confirmedPacking = (plan.packingOptions || []).some((p) => isDone(p.status));

  let newStatus: string | null = null;
  let newPackingStatus: string | null = null;
  let newPlacementStatus: string | null = null;
  let warning: string | null = null;

  if (shipments.length > 0) {
    newStatus = 'shipping';
    newPackingStatus = 'SUCCESS';
    newPlacementStatus = 'SUCCESS';
  } else if (confirmedPlacement) {
    newStatus = 'shipping';
    newPackingStatus = 'SUCCESS';
    newPlacementStatus = 'SUCCESS';
  } else if (confirmedPacking && !localPackingFailed) {
    newStatus = 'placement';
    newPackingStatus = 'SUCCESS';
  } else if (confirmedPacking && localPackingFailed) {
    // The packing OPTION is accepted on Amazon, but FlipLedger recorded a
    // box-level setPackingInformation failure and there's no placement or
    // shipment yet. Confirming the option without box details is the LTL-lock
    // trap (June 8) — don't paper over it with a SUCCESS.
    warning =
      'Amazon shows the packing option accepted, but FlipLedger recorded a box-detail (setPackingInformation) failure ' +
      'and Amazon has no placement/shipments yet. The plan may be stuck in skip-packing/LTL mode — verify box details in ' +
      'Seller Central (or Cancel & Edit and re-send) before treating packing as done.';
  }

  if (newStatus) {
    db.prepare(`
      UPDATE listing_batches
      SET status = ?,
          packing_status = COALESCE(?, packing_status),
          placement_status = COALESCE(?, placement_status),
          packing_error = NULL,
          placement_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newStatus, newPackingStatus, newPlacementStatus, batchId);
  }

  db.close();

  return NextResponse.json({
    success: true,
    planStatus: plan.status,
    confirmedPacking,
    confirmedPlacement,
    shipmentCount: shipments.length,
    shipmentIds: shipments.map((s) => s.shipmentId).filter(Boolean),
    newStatus,
    newPackingStatus,
    newPlacementStatus,
    warning,
    message: newStatus
      ? `Batch synced — now in '${newStatus}' status with ${shipments.length} shipment(s).`
      : warning || 'Plan is still pre-packing on Amazon\'s side; nothing to update.',
    rawPlan: plan,
    rawShipments: shipments,
  });
}
