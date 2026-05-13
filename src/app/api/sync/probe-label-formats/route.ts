import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken, getEndpoint } from '@/lib/sp-api/auth';
import { listShipmentBoxes } from '@/lib/sp-api/inboundPlansV2';

// Inline copy of the (currently private) helper in inboundPlansV2.ts
function boxIdToShipmentConfirmationId(boxId: string): string {
  return boxId.replace(/U\d{6}$/, '');
}
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
 * For a Partnered UPS shipment, probe what each PageType returns.
 * Specifically: does NonPCP/Plain_Paper format strip the UPS portion?
 * Use ?planId=...&shipmentId=...
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const planId = searchParams.get('planId');
  const shipmentId = searchParams.get('shipmentId');
  if (!planId || !shipmentId) {
    return NextResponse.json({ error: 'planId + shipmentId required' }, { status: 400 });
  }

  const creds = getCredentials();
  const endpoint = getEndpoint(creds.marketplaceId);
  const accessToken = await getAccessToken(creds);

  const boxes = await listShipmentBoxes(creds, planId, shipmentId);
  const confirmationId = boxIdToShipmentConfirmationId(boxes[0].boxId);

  const pageTypes = [
    'PackageLabel_Thermal_Unified',  // combined (current default for Partnered)
    'PackageLabel_Thermal_NonPCP',   // non-PCP thermal — does Amazon return just FBA?
    'PackageLabel_Plain_Paper',       // plain — what does Partnered do here?
    'PackageLabel_Plain_Paper_CarrierBottom',
    'PackageLabel_Letter_2',
  ];

  const results = [];
  for (const pt of pageTypes) {
    try {
      const url = new URL(`${endpoint}/fba/inbound/v0/shipments/${confirmationId}/labels`);
      url.searchParams.set('PageType', pt);
      url.searchParams.set('LabelType', 'BARCODE_2D');
      url.searchParams.set('PageSize', String(boxes.length));
      url.searchParams.set('PageStartIndex', '0');
      url.searchParams.set('PackageLabelsToPrint', boxes.map((b) => b.boxId).join(','));
      const resp = await fetch(url.toString(), {
        headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
      });
      const text = await resp.text();
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      results.push({
        pageType: pt,
        status: resp.status,
        ok: resp.ok,
        hasDownloadURL: !!(parsed?.payload?.DownloadURL),
        downloadURL: parsed?.payload?.DownloadURL || null,
        error: !resp.ok ? (parsed?.errors?.[0]?.message || text.slice(0, 200)) : null,
      });
    } catch (err: any) {
      results.push({ pageType: pt, error: err?.message || String(err) });
    }
  }

  return NextResponse.json({ planId, shipmentId, confirmationId, boxCount: boxes.length, results });
}
