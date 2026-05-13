import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken, getEndpoint } from '@/lib/sp-api/auth';
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
 * Probe to see why AMAZON_PARTNERED_CARRIER isn't appearing for Parker's plan.
 * Try several body variants — wider readyToShipWindow, explicit pallet info,
 * etc. — and report what each yields.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const planId = searchParams.get('planId');
  const shipmentId = searchParams.get('shipmentId');
  const placementOptionId = searchParams.get('placementOptionId');
  if (!planId || !shipmentId || !placementOptionId) {
    return NextResponse.json({ error: 'planId + shipmentId + placementOptionId required' }, { status: 400 });
  }

  const creds = getCredentials();
  const endpoint = getEndpoint(creds.marketplaceId);
  const accessToken = await getAccessToken(creds);

  const contactInformation = {
    name: 'DealsDudes',
    email: 'parkermorgan99@gmail.com',
    phoneNumber: '8013196522',
  };

  // Try the simplest body first, then progressively add fields
  const bodyVariants = [
    {
      label: 'minimal: just readyToShipWindow.start',
      body: {
        placementOptionId,
        shipmentTransportationConfigurations: [{
          shipmentId,
          contactInformation,
          readyToShipWindow: { start: new Date(Date.now() + 86400000).toISOString() },
        }],
      },
    },
    {
      label: 'with start + end window (3-day range)',
      body: {
        placementOptionId,
        shipmentTransportationConfigurations: [{
          shipmentId,
          contactInformation,
          readyToShipWindow: {
            start: new Date(Date.now() + 86400000).toISOString(),
            end: new Date(Date.now() + 4 * 86400000).toISOString(),
          },
        }],
      },
    },
    {
      label: 'with pallet info (declares 1 pallet, encourages Partnered LTL/PCP)',
      body: {
        placementOptionId,
        shipmentTransportationConfigurations: [{
          shipmentId,
          contactInformation,
          readyToShipWindow: { start: new Date(Date.now() + 86400000).toISOString() },
          pallets: [{ dimensions: { unitOfMeasurement: 'IN', length: 48, width: 40, height: 60 }, weight: { unit: 'LB', value: 62 }, quantity: 1, stackability: 'STACKABLE' }],
        }],
      },
    },
    {
      label: 'with freightInformation (LTL)',
      body: {
        placementOptionId,
        shipmentTransportationConfigurations: [{
          shipmentId,
          contactInformation,
          readyToShipWindow: { start: new Date(Date.now() + 86400000).toISOString() },
          freightInformation: { freightClass: 'FC_50', declaredValue: { amount: 100, code: 'USD' } },
        }],
      },
    },
  ];

  const results = [];
  for (const variant of bodyVariants) {
    try {
      const genResp = await fetch(
        `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/transportationOptions`,
        {
          method: 'POST',
          headers: {
            'x-amz-access-token': accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(variant.body),
        }
      );
      const genText = await genResp.text();
      let genParsed: any;
      try { genParsed = JSON.parse(genText); } catch { genParsed = genText; }

      const opId = genParsed?.operationId;
      let listed: any[] = [];
      let opStatus: string | null = null;

      if (opId) {
        // Poll the op
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const opResp = await fetch(
            `${endpoint}/inbound/fba/2024-03-20/operations/${opId}`,
            { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } }
          );
          const opData = await opResp.json();
          opStatus = opData?.operationStatus;
          if (opStatus === 'SUCCESS' || opStatus === 'FAILED') break;
        }

        // List
        const listResp = await fetch(
          `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(planId)}/transportationOptions?placementOptionId=${placementOptionId}`,
          { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } }
        );
        const listData = await listResp.json();
        listed = listData?.transportationOptions || [];
      }

      const partnered = listed.filter((o: any) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER');
      results.push({
        variant: variant.label,
        genStatus: genResp.status,
        opStatus,
        totalOptions: listed.length,
        partneredCount: partnered.length,
        partneredCarriers: partnered.map((o: any) => ({
          mode: o.shippingMode,
          carrier: o.carrier?.name,
          quote: o.quote?.cost?.amount,
        })),
        genResponseSnippet: typeof genParsed === 'object' ? JSON.stringify(genParsed).slice(0, 300) : String(genParsed).slice(0, 300),
      });
    } catch (err: any) {
      results.push({ variant: variant.label, error: err?.message || String(err) });
    }
  }

  return NextResponse.json({ planId, shipmentId, placementOptionId, results });
}
