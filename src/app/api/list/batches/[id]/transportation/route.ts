/**
 * Transportation / carrier booking for a confirmed-placement FBA batch.
 *
 *   GET    — return current options (generates them on first call if empty)
 *   POST   — confirm a chosen transportationOptionId(s)
 *
 * Lifecycle:
 *   batch.status = 'shipping' AND placement_status = 'SUCCESS'
 *     → carrier picking is the next action
 *   After confirmation:
 *     → transportation_status = 'CONFIRMED'
 *     → Seller generates own carrier labels via UPS/USPS/etc. tools
 *       (or fetches Partnered labels via the existing labels endpoint)
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveShipFromContact } from '@/lib/listing-ship-from';
import {
  generateTransportationOptions,
  listTransportationOptions,
  confirmTransportationOptions,
  getInboundOperation,
  getInboundPlan,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { expandCarrierChoice } from '@/lib/listing-send-policy';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

function getCredentials(): SPAPICredentials {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    clientId: s.clientId || '',
    clientSecret: s.clientSecret || '',
    refreshToken: s.refreshToken || '',
    marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
  };
}

interface Batch {
  id: number;
  status: string;
  channel: string;
  inbound_plan_id: string | null;
  placement_option_id: string | null;
  placement_status: string | null;
  transportation_status: string | null;
  transportation_option_id: string | null;
  transportation_carrier: string | null;
  transportation_shipping_mode: string | null;
}

function loadBatch(batchId: number): Batch | null {
  const db = getDb();
  try {
    return db.prepare(`SELECT id, status, channel, inbound_plan_id, placement_option_id, placement_status,
      transportation_status, transportation_option_id, transportation_carrier, transportation_shipping_mode
      FROM listing_batches WHERE id = ?`).get(batchId) as Batch | null;
  } finally {
    db.close();
  }
}

async function waitForOp(creds: SPAPICredentials, opId: string, maxMs = 90_000): Promise<{ success: boolean; error?: string }> {
  const POLL_MS = 3000;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const op = await getInboundOperation(creds, opId);
    if (op.operationStatus === 'SUCCESS') return { success: true };
    if (op.operationStatus === 'FAILED') return { success: false, error: JSON.stringify(op.operationProblems) };
  }
  return { success: false, error: 'operation timed out' };
}

const isPartnered = (o: { shippingSolution?: string }) =>
  String(o.shippingSolution || '').includes('PARTNERED');

// Every shipment in the placement must have at least one Amazon-Partnered
// option before we stop regenerating. With a multi-shipment placement Amazon
// prices each shipment's Partnered (UPS) rate lazily and independently, so an
// early "any shipment has Partnered" check would stop while a later shipment
// still had none — and then confirm fails because you must pick a carrier for
// EVERY shipment. July 8, 2026.
const allShipmentsHavePartnered = (opts: { shipmentId: string; shippingSolution?: string }[], shipmentIds: string[]) =>
  shipmentIds.length > 0 && shipmentIds.every((sid) => opts.some((o) => o.shipmentId === sid && isPartnered(o)));

const allShipmentsHaveAnyOption = (opts: { shipmentId: string }[], shipmentIds: string[]) =>
  shipmentIds.length > 0 && shipmentIds.every((sid) => opts.some((o) => o.shipmentId === sid));

// Fire one generateTransportationOptions call (minimal body) and wait for it.
// The minimal body is deliberate: adding readyToShipWindow.end, pallets, or
// freightInformation makes Amazon suppress the Amazon-Partnered (UPS) option.
// Returns the placement's shipment IDs so callers can check coverage.
async function generateOnce(creds: SPAPICredentials, inboundPlanId: string, placementOptionId: string): Promise<string[]> {
  const plan = await getInboundPlan(creds, inboundPlanId);
  const shipments = (plan as { shipments?: Array<{ shipmentId: string }> })?.shipments || [];
  if (shipments.length === 0) throw new Error('No shipments on plan yet — placement may not be confirmed');

  const db = getDb();
  const settingsRows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  db.close();
  const settings: Record<string, string> = {};
  for (const r of settingsRows) settings[r.key] = r.value;

  const contactInformation = resolveShipFromContact(settings);
  // Ready to ship tomorrow (gives buffer to actually pack)
  const readyToShipDate = new Date(Date.now() + 86400000).toISOString();

  const gen = await generateTransportationOptions(creds, inboundPlanId, {
    placementOptionId,
    shipmentConfigurations: shipments.map((s) => ({ shipmentId: s.shipmentId, contactInformation, readyToShipDate })),
  });
  const op = await waitForOp(creds, gen.operationId);
  if (!op.success) throw new Error(`Generation failed: ${op.error}`);
  return shipments.map((s) => s.shipmentId);
}

// Max generate attempts when chasing the lazily-computed Partnered rate.
// Bumped from 4 — a multi-shipment placement needs more rounds for every
// shipment's Partnered rate to materialize.
const MAX_GEN_TRIES = 8;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!batchId) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  const forceRegenerate = request.nextUrl.searchParams.get('regenerate') === '1';

  const batch = loadBatch(batchId);
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.channel !== 'FBA') return NextResponse.json({ error: 'Transportation booking is only for FBA batches' }, { status: 400 });
  if (!batch.inbound_plan_id || !batch.placement_option_id) {
    return NextResponse.json({ error: 'Batch has no inbound plan / placement yet' }, { status: 400 });
  }

  const creds = getCredentials();

  try {
    let options = await listTransportationOptions(creds, batch.inbound_plan_id, batch.placement_option_id);
    let shipmentIds: string[] = [...new Set(options.map((o) => o.shipmentId))];

    // Generate when there's nothing yet, or when the caller forces a refresh —
    // but never after a carrier has been confirmed (that would invalidate it).
    //
    // Amazon computes the Amazon-Partnered (UPS) rate lazily and PER SHIPMENT
    // after placement confirmation, so early generations can come back with a
    // Partnered rate for only some shipments. Keep regenerating until EVERY
    // shipment has a Partnered option (or, failing that, at least one option),
    // so the user isn't stranded — and so confirm (which needs a carrier for
    // every shipment) can succeed.
    const alreadyConfirmed = batch.transportation_status === 'CONFIRMED';
    if (!alreadyConfirmed && (options.length === 0 || forceRegenerate || !allShipmentsHavePartnered(options, shipmentIds))) {
      for (let i = 0; i < MAX_GEN_TRIES; i++) {
        shipmentIds = await generateOnce(creds, batch.inbound_plan_id, batch.placement_option_id);
        options = await listTransportationOptions(creds, batch.inbound_plan_id, batch.placement_option_id);
        if (allShipmentsHavePartnered(options, shipmentIds)) break;
      }
    }

    return NextResponse.json({
      transportationStatus: batch.transportation_status,
      transportationOptionId: batch.transportation_option_id,
      transportationCarrier: batch.transportation_carrier,
      transportationShippingMode: batch.transportation_shipping_mode,
      shipmentCount: shipmentIds.length,
      allShipmentsHavePartnered: allShipmentsHavePartnered(options, shipmentIds),
      allShipmentsCovered: allShipmentsHaveAnyOption(options, shipmentIds),
      options,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!batchId) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const optionIds: string[] = Array.isArray(body.transportationOptionIds)
    ? body.transportationOptionIds
    : (body.transportationOptionId ? [body.transportationOptionId] : []);

  if (optionIds.length === 0) {
    return NextResponse.json({ error: 'transportationOptionId(s) required' }, { status: 400 });
  }

  const batch = loadBatch(batchId);
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.channel !== 'FBA') return NextResponse.json({ error: 'Transportation booking is only for FBA batches' }, { status: 400 });
  if (!batch.inbound_plan_id || !batch.placement_option_id) {
    return NextResponse.json({ error: 'Batch has no inbound plan / placement yet' }, { status: 400 });
  }

  const creds = getCredentials();
  try {
    // Look up the option(s) so we can store carrier name + shipping mode after confirmation
    const allOptions = await listTransportationOptions(creds, batch.inbound_plan_id, batch.placement_option_id);
    const picked = allOptions.filter((o) => optionIds.includes(o.transportationOptionId));
    if (picked.length === 0) {
      return NextResponse.json({ error: 'None of the provided IDs matched current options' }, { status: 400 });
    }

    // Amazon requires a transportation option confirmed for EVERY shipment in
    // the placement. Expand the user's ONE carrier choice to all shipments —
    // logic lives in listing-send-policy.ts (unit-tested). July 8, 2026 fix.
    const choice = picked[0];
    const { selected, missing, shipmentIds } = expandCarrierChoice(picked, allOptions);
    if (missing.length > 0) {
      const label = choice.carrier?.name || choice.shippingSolution || 'that carrier';
      return NextResponse.json({
        error: `${label} isn't available for all ${shipmentIds.length} shipments in this placement (missing on ${missing.length}). Click Refresh to regenerate rates, then pick a carrier offered for every shipment.`,
      }, { status: 400 });
    }

    // Build the {shipmentId, transportationOptionId} pairs Amazon's API requires
    const selections = selected.map((o) => ({
      shipmentId: o.shipmentId,
      transportationOptionId: o.transportationOptionId,
    }));
    const confirmResult = await confirmTransportationOptions(creds, batch.inbound_plan_id, selections);
    const opResult = await waitForOp(creds, confirmResult.operationId);
    if (!opResult.success) {
      const db = getDb();
      db.prepare(`UPDATE listing_batches SET transportation_status = 'FAILED', transportation_error = ? WHERE id = ?`)
        .run(opResult.error || 'unknown', batchId);
      db.close();
      return NextResponse.json({ error: `Confirmation failed: ${opResult.error}` }, { status: 500 });
    }

    // Persist the chosen carrier on the batch. Cost = sum of the selected
    // options' quotes (Partnered options carry quotes; own-carrier has none).
    const costCents = selected.reduce((sum, o) =>
      typeof o.quote?.cost?.amount === 'number' ? sum + Math.round(o.quote.cost.amount * 100) : sum, 0);
    const anyQuoted = selected.some((o) => typeof o.quote?.cost?.amount === 'number');
    const db = getDb();
    db.prepare(`
      UPDATE listing_batches SET
        transportation_status = 'CONFIRMED',
        transportation_option_id = ?,
        transportation_carrier = ?,
        transportation_shipping_mode = ?,
        transportation_confirmed_at = ?,
        transportation_cost_cents = ?,
        transportation_error = NULL
      WHERE id = ?
    `).run(
      selected[0].transportationOptionId,
      selected[0].carrier?.name || selected[0].shippingSolution,
      selected[0].shippingMode,
      new Date().toISOString(),
      anyQuoted ? costCents : null,
      batchId
    );
    db.close();

    return NextResponse.json({
      success: true,
      carrier: selected[0].carrier?.name || selected[0].shippingSolution,
      shippingMode: selected[0].shippingMode,
      shippingSolution: selected[0].shippingSolution,
    });
  } catch (err) {
    const db = getDb();
    db.prepare(`UPDATE listing_batches SET transportation_status = 'FAILED', transportation_error = ? WHERE id = ?`)
      .run(String(err), batchId);
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
