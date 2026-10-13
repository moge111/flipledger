/**
 * GET /api/list/walmart/lookup?q=<walmart.com link | Walmart item ID | UPC>
 *
 * Returns the Walmart catalog product the input refers to, confirmed by
 * barcode, plus the seller's existing SKU on it when there is one.
 * See src/lib/walmart-api/catalogLookup.ts for how each input is resolved.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import { liveDeps, resolveWalmartProduct } from '@/lib/walmart-api/catalogLookup';
import { createLogger } from '@/lib/log';

const log = createLogger('api/list/walmart/lookup');

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  const creds = getWalmartCredentials();
  if (!creds) return NextResponse.json({ ok: false, error: 'Walmart API credentials are not set (Settings → Walmart).' }, { status: 400 });

  try {
    const result = await resolveWalmartProduct(q, liveDeps(creds));
    return NextResponse.json(result, { status: result.ok ? 200 : result.input === 'invalid' ? 400 : 404 });
  } catch (err: any) {
    log.error(`lookup failed for "${q}": ${err?.message}`);
    return NextResponse.json({ ok: false, error: `Walmart lookup failed: ${err?.message ?? 'unknown error'}` }, { status: 502 });
  }
}
