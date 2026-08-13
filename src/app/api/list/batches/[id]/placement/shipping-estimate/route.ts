/**
 * GET /api/list/batches/[id]/placement/shipping-estimate?placementOptionId=X
 *
 * Shipping cost estimate for ONE (possibly unconfirmed) placement option, so
 * the placement cards can show "placement fee + shipping = total" BEFORE the
 * seller commits. Amazon allows generating transportation options against any
 * offered placementOptionId — each PlacementOption carries its own
 * shipmentIds, so no confirmation is needed.
 *
 * Returns the Amazon Partnered carrier total across the option's shipments
 * (own-carrier options carry no quote — the seller brings their own rate).
 * The Partnered rate is computed lazily by Amazon, so this endpoint retries
 * generation a few times; if the rate still hasn't materialized it returns
 * partial data with complete=false and the frontend shows what it has.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { resolveShipFromContact } from '@/lib/listing-ship-from';
import {
  generateTransportationOptions,
  listTransportationOptions,
  listPlacementOptions,
  getInboundOperation,
  type TransportationOption,
} from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

async function waitForOp(creds: SPAPICredentials, opId: string, maxMs = 90_000): Promise<{ success: boolean; error?: string }> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const op = await getInboundOperation(creds, opId);
    if (op.operationStatus === 'SUCCESS') return { success: true };
    if (op.operationStatus === 'FAILED') return { success: false, error: JSON.stringify(op.operationProblems) };
  }
  return { success: false, error: 'operation timed out' };
}

const hasPartneredQuote = (opts: TransportationOption[], shipmentIds: string[]) =>
  shipmentIds.every((sid) =>
    opts.some(
      (o) =>
        o.shipmentId === sid &&
        String(o.shippingSolution || '').includes('PARTNERED') &&
        typeof o.quote?.cost?.amount === 'number'
    )
  );

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }
  const placementOptionId = request.nextUrl.searchParams.get('placementOptionId');
  if (!placementOptionId) {
    return NextResponse.json({ error: 'placementOptionId is required' }, { status: 400 });
  }

  const db = getDb();
  let inboundPlanId: string;
  let creds: SPAPICredentials;
  let contactInformation: { name: string; phoneNumber: string; email: string };
  try {
    const batch = db.prepare(
      `SELECT channel, inbound_plan_id as inboundPlanId FROM listing_batches WHERE id = ?`
    ).get(batchId) as { channel: string; inboundPlanId: string | null } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.channel !== 'FBA') return NextResponse.json({ error: 'FBA batches only' }, { status: 400 });
    if (!batch.inboundPlanId) return NextResponse.json({ error: 'Batch has no inbound plan' }, { status: 400 });
    inboundPlanId = batch.inboundPlanId;

    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;
    if (!s.clientId || !s.clientSecret || !s.refreshToken) {
      return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
    }
    creds = {
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      refreshToken: s.refreshToken,
      marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER',
    };
    contactInformation = resolveShipFromContact(s);
  } finally {
    db.close();
  }

  clearTokenCache();

  try {
    // Resolve the option's shipmentIds (works for OFFERED, not just ACCEPTED).
    const options = await listPlacementOptions(creds, inboundPlanId);
    const option = options.find((o) => o.placementOptionId === placementOptionId);
    if (!option) {
      return NextResponse.json({ error: `Placement option ${placementOptionId} not found on plan` }, { status: 404 });
    }
    const shipmentIds = option.shipmentIds || [];
    if (shipmentIds.length === 0) {
      return NextResponse.json({ error: 'Placement option has no shipments' }, { status: 400 });
    }

    // Existing transportation options for this placement option, if any.
    let transportOptions: TransportationOption[] = [];
    try {
      transportOptions = await listTransportationOptions(creds, inboundPlanId, placementOptionId);
    } catch {
      transportOptions = [];
    }

    // Generate (and retry — Amazon computes the Partnered rate lazily; the
    // minimal body is deliberate, extra fields suppress Partnered).
    const MAX_TRIES = 3;
    let tries = 0;
    while (!hasPartneredQuote(transportOptions, shipmentIds) && tries < MAX_TRIES) {
      tries++;
      try {
        const readyToShipDate = new Date(Date.now() + 86400000).toISOString();
        const gen = await generateTransportationOptions(creds, inboundPlanId, {
          placementOptionId,
          shipmentConfigurations: shipmentIds.map((sid) => ({
            shipmentId: sid,
            contactInformation,
            readyToShipDate,
          })),
        });
        const op = await waitForOp(creds, gen.operationId);
        if (!op.success) break;
      } catch {
        break;
      }
      try {
        transportOptions = await listTransportationOptions(creds, inboundPlanId, placementOptionId);
      } catch {
        break;
      }
    }

    // Cheapest Partnered quote per shipment (GROUND_SMALL_PARCEL preferred —
    // in practice it's the only quoted Partnered mode for small parcel).
    const shipments = shipmentIds.map((sid) => {
      const quoted = transportOptions
        .filter(
          (o) =>
            o.shipmentId === sid &&
            String(o.shippingSolution || '').includes('PARTNERED') &&
            typeof o.quote?.cost?.amount === 'number'
        )
        .sort((a, b) => (a.quote!.cost!.amount) - (b.quote!.cost!.amount));
      const best = quoted[0] || null;
      return {
        shipmentId: sid,
        partneredCents: best ? Math.round(best.quote!.cost!.amount * 100) : null,
        shippingMode: best?.shippingMode || null,
        carrier: best?.carrier?.name || best?.carrier?.alphaCode || null,
      };
    });

    const complete = shipments.every((s) => s.partneredCents !== null);
    const partneredTotalCents = complete
      ? shipments.reduce((sum, s) => sum + (s.partneredCents || 0), 0)
      : null;

    return NextResponse.json({
      placementOptionId,
      shipmentCount: shipmentIds.length,
      shipments,
      partneredTotalCents,
      complete,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
