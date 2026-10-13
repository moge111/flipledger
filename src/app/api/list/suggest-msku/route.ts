/**
 * MSKU suggestion for outside callers (the FBA Scout extension / Amazon leads dashboard).
 *
 * GET /api/list/suggest-msku?supplier=Walmart&name=...&buyPrice=12.99&asin=B0...&channel=FBA|MFN
 *   → { msku }
 *
 * Read-only: wraps the same generateMSKU the batch page uses, so SKUs added from
 * outside FlipLedger follow the same {supplier}-{productSlug}-{buyCost} format.
 * Restock detection (reusing an existing MSKU) stays with /api/list/catalog/search.
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateMSKU } from '@/lib/listing-msku';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const channel = params.get('channel')?.toUpperCase() === 'MFN' ? 'MFN' : 'FBA';
  const msku = generateMSKU(
    params.get('supplier'),
    params.get('name'),
    params.get('buyPrice'),
    params.get('asin'),
    channel
  );
  return NextResponse.json({ msku });
}
