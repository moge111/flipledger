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
import Database from 'better-sqlite3';
import path from 'path';
import {
  generateTransportationOptions,
  listTransportationOptions,
  confirmTransportationOptions,
  getInboundOperation,
  getInboundPlan,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!batchId) return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });

  const batch = loadBatch(batchId);
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.channel !== 'FBA') return NextResponse.json({ error: 'Transportation booking is only for FBA batches' }, { status: 400 });
  if (!batch.inbound_plan_id || !batch.placement_option_id) {
    return NextResponse.json({ error: 'Batch has no inbound plan / placement yet' }, { status: 400 });
  }

  const creds = getCredentials();

  try {
    // First read existing options
    let options = await listTransportationOptions(creds, batch.inbound_plan_id, batch.placement_option_id);

    // If empty and generation hasn't been kicked off, generate now
    if (options.length === 0) {
      // Resolve shipmentIds: read plan, grab shipments
      const plan = await getInboundPlan(creds, batch.inbound_plan_id);
      const shipments = (plan as { shipments?: Array<{ shipmentId: string }> })?.shipments || [];
      if (shipments.length === 0) {
        return NextResponse.json({ error: 'No shipments on plan yet — placement may not be confirmed' }, { status: 400 });
      }

      // Default contact info from settings (DealsDudes ship-from)
      const db = getDb();
      const settingsRows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      db.close();
      const settings: Record<string, string> = {};
      for (const r of settingsRows) settings[r.key] = r.value;

      const contactInformation = {
        name: settings.listing_ship_from_name || 'DealsDudes',
        phoneNumber: settings.listing_ship_from_phone || '8013196522',
        email: settings.listing_ship_from_email || 'parkermorgan99@gmail.com',
      };

      // Ready to ship tomorrow at noon UTC (gives buffer to actually pack)
      const readyToShipDate = new Date(Date.now() + 86400000).toISOString();

      const genResult = await generateTransportationOptions(creds, batch.inbound_plan_id, {
        placementOptionId: batch.placement_option_id,
        shipmentConfigurations: shipments.map((s) => ({
          shipmentId: s.shipmentId,
          contactInformation,
          readyToShipDate,
        })),
      });
      const opResult = await waitForOp(creds, genResult.operationId);
      if (!opResult.success) {
        return NextResponse.json({ error: `Generation failed: ${opResult.error}` }, { status: 500 });
      }

      // Re-list now that generation completed
      options = await listTransportationOptions(creds, batch.inbound_plan_id, batch.placement_option_id);
    }

    return NextResponse.json({
      transportationStatus: batch.transportation_status,
      transportationOptionId: batch.transportation_option_id,
      transportationCarrier: batch.transportation_carrier,
      transportationShippingMode: batch.transportation_shipping_mode,
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
    const selected = allOptions.filter((o) => optionIds.includes(o.transportationOptionId));
    if (selected.length === 0) {
      return NextResponse.json({ error: 'None of the provided IDs matched current options' }, { status: 400 });
    }

    const confirmResult = await confirmTransportationOptions(creds, batch.inbound_plan_id, optionIds);
    const opResult = await waitForOp(creds, confirmResult.operationId);
    if (!opResult.success) {
      const db = getDb();
      db.prepare(`UPDATE listing_batches SET transportation_status = 'FAILED', transportation_error = ? WHERE id = ?`)
        .run(opResult.error || 'unknown', batchId);
      db.close();
      return NextResponse.json({ error: `Confirmation failed: ${opResult.error}` }, { status: 500 });
    }

    // Persist the chosen carrier on the batch
    const db = getDb();
    db.prepare(`
      UPDATE listing_batches SET
        transportation_status = 'CONFIRMED',
        transportation_option_id = ?,
        transportation_carrier = ?,
        transportation_shipping_mode = ?,
        transportation_confirmed_at = ?,
        transportation_error = NULL
      WHERE id = ?
    `).run(
      selected[0].transportationOptionId,
      selected[0].carrier?.name || selected[0].shippingSolution,
      selected[0].shippingMode,
      new Date().toISOString(),
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
