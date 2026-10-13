/**
 * POST /api/list/batches/[id]/wfs/price { itemId, priceDollars }
 *
 * Set the item's SKU price on Walmart (PUT /v3/price, base price) and record it
 * on every line of that SKU in the batch. Works in any batch status — the price
 * is usually decided when the shipment goes out. Refused while Walmart is still
 * setting the SKU up (the item doesn't exist on Walmart yet; the setup feed
 * carries the price entered on the setup form).
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { getWalmartCredentials, walmartFetch } from '@/lib/walmart-api/auth';
import { walmartErrorMessage } from '@/lib/walmart-api/wfsInbound';
import { loadWfsBatch, WALMART_CHANNELS } from '@/lib/wfs-batch';

const log = createLogger('api/list/batches/wfs/price');

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const body = await req.json().catch(() => ({}));
  const price = Math.round(Number(body.priceDollars) * 100) / 100;
  if (!(price > 0)) return NextResponse.json({ error: 'Enter a price above $0.' }, { status: 400 });

  const creds = getWalmartCredentials();
  if (!creds) return NextResponse.json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, { status: 400 });

  const db = openDb();
  try {
    const found = loadWfsBatch(db, batchId, WALMART_CHANNELS);
    if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
    const item = db.prepare('SELECT id, sku, walmart_setup_status AS setup FROM listing_batch_items WHERE id = ? AND batch_id = ?')
      .get(Number(body.itemId), batchId) as { id: number; sku: string; setup: string | null } | undefined;
    if (!item) return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
    if (item.setup === 'PENDING') return NextResponse.json({ error: 'Walmart is still setting this SKU up. Change the price once it shows as set up.' }, { status: 409 });
    if (item.setup === 'FAILED') return NextResponse.json({ error: "This SKU's Walmart setup failed, so there's no Walmart price to change yet." }, { status: 409 });

    try {
      await walmartFetch(creds, '/price', {
        method: 'PUT',
        body: { sku: item.sku, pricing: [{ currentPriceType: 'BASE', currentPrice: { currency: 'USD', amount: price } }] },
      });
    } catch (err) {
      return NextResponse.json({ error: `Walmart didn't change the price: ${walmartErrorMessage(err)}` }, { status: 502 });
    }
    db.prepare('UPDATE listing_batch_items SET list_price_cents = ? WHERE batch_id = ? AND sku = ?').run(Math.round(price * 100), batchId, item.sku);
    log.info(`batch ${batchId}: ${item.sku} price → $${price.toFixed(2)}`);
    return NextResponse.json({ success: true, sku: item.sku, priceDollars: price });
  } finally {
    db.close();
  }
}
