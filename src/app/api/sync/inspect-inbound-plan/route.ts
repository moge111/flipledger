import { NextRequest, NextResponse } from 'next/server';
import { getInboundPlan, listPackingOptions } from '@/lib/sp-api/inboundPlansV2';
import { spApiRequest } from '@/lib/sp-api/auth';
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

export async function GET(request: NextRequest) {
  const planId = new URL(request.url).searchParams.get('planId');
  if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });

  const credentials = getCredentials();
  try {
    const plan = await getInboundPlan(credentials, planId);
    const packingOptions = await listPackingOptions(credentials, planId);

    // Also call Amazon's listPackingGroupItems for each packingGroup to see
    // what items Amazon thinks are in each group.
    const groupDetails: any[] = [];
    for (const opt of packingOptions) {
      for (const groupId of (opt.packingGroups || [])) {
        try {
          const itemsResp = await spApiRequest(
            credentials,
            `/inbound/fba/2024-03-20/inboundPlans/${planId}/packingGroups/${groupId}/items`
          );
          groupDetails.push({
            packingOptionId: opt.packingOptionId,
            packingGroupId: groupId,
            optionStatus: opt.status,
            items: itemsResp?.payload?.items || itemsResp?.items || itemsResp,
          });
        } catch (err: any) {
          groupDetails.push({
            packingOptionId: opt.packingOptionId,
            packingGroupId: groupId,
            optionStatus: opt.status,
            error: err?.message || String(err),
          });
        }
      }
    }

    return NextResponse.json({ plan, packingOptions, groupDetails });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
