/**
 * POST /api/list/batches/[id]/wfs/items — add a product to a draft Walmart batch
 * (WFS or seller fulfilled), like an Amazon batch add.
 *
 * Body: { query: <walmart.com link | Walmart item ID | UPC>, quantity, buyPrice (optional on a restock: the SKU's last cost lot is used),
 *         supplier?, purchaseDate?, sendQty?, setup? }
 *
 * The product's existing SKU is reused (Walmart allows one SKU per product):
 *   WFS batch:  WFS SKU → restock · seller-fulfilled SKU → switch it to WFS (OMNI_WFS)
 *               · no SKU → create it straight on WFS (MP_WFS_ITEM)
 *   SF batch:   seller-fulfilled SKU → restock · WFS SKU → refused (use a WFS batch)
 *               · no SKU → create the offer (MP_ITEM_MATCH)
 * When a setup is needed, the first call answers 409 { needsSetup, form } (the
 * prefilled form, built from Walmart's current spec); the second call carries
 * { setup } and the feed goes to Walmart. The item gets its own cost lot at add
 * time either way and FIFO re-runs for the SKU.
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { recalculateFIFO } from '@/lib/fifo';
import { insertItemLot } from '@/lib/listing-ledger';
import { getWalmartCredentials, walmartApiRequest } from '@/lib/walmart-api/auth';
import { liveDeps, resolveWalmartProduct, type WalmartCatalogProduct } from '@/lib/walmart-api/catalogLookup';
import type { SetupKind, SetupState } from '@/lib/walmart-api/itemSetup';
import type { WalmartCredentials } from '@/lib/walmart-api/types';
import { isWfsSku, walmartErrorMessage } from '@/lib/walmart-api/wfsInbound';
import { holdingItems, lastCost, loadWfsBatch, WALMART_CHANNELS } from '@/lib/wfs-batch';
import { buildSetupForm, setupFromForm, submitSetup } from '@/lib/wfs-item-setup';

/** True when the seller already has this SKU on Walmart (seller catalog search 404s when not). */
async function ownSkuExists(creds: WalmartCredentials, sku: string): Promise<boolean> {
  try {
    const r = await walmartApiRequest(creds, '/items/catalog/search', undefined, 'POST', { query: { field: 'sku', value: sku } });
    return (r?.payload ?? []).some((x: { sku: string }) => x.sku === sku);
  } catch (err) {
    if (/ 404 /.test(String((err as Error).message))) return false;
    throw err;
  }
}

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });


export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const body = await request.json().catch(() => ({}));
  const quantity = parseInt(String(body.quantity ?? ''), 10);
  // Buy price may be left blank on a restock: the SKU's last cost lot fills it in.
  const buyBlank = body.buyPrice === undefined || body.buyPrice === null || String(body.buyPrice).trim() === '';
  let buyPrice = buyBlank ? NaN : Number(body.buyPrice);
  let supplier: string | null = body.supplier || null;
  let costFrom: ReturnType<typeof lastCost> = null;
  if (!Number.isFinite(quantity) || quantity < 1) return json({ error: 'Quantity must be 1 or more.' }, 400);
  if (!buyBlank && (!Number.isFinite(buyPrice) || buyPrice < 0)) return json({ error: 'Enter a valid buy price.' }, 400);

  let channel: string;
  let holding = false;
  {
    const db = openDb({ readonly: true });
    try {
      const found = loadWfsBatch(db, batchId, WALMART_CHANNELS);
      if (!found.ok) return json({ error: found.error }, found.status);
      if (found.batch.status !== 'draft') return json({ error: 'Items can only be added while the batch is a draft.' }, 400);
      channel = found.batch.channel;
      holding = !!found.batch.is_holding;
    } finally {
      db.close();
    }
  }
  const wfs = channel === 'WFS';

  const creds = getWalmartCredentials();
  if (!creds) return json({ error: 'Walmart API credentials are not set (Settings → Walmart).' }, 400);

  let lookup;
  try {
    lookup = await resolveWalmartProduct(String(body.query ?? ''), liveDeps(creds));
  } catch (err) {
    return json({ error: `Walmart lookup failed: ${walmartErrorMessage(err)}` }, 502);
  }
  if (!lookup.ok || !lookup.product) return json({ error: lookup.error, lookup }, 404);
  const product = lookup.product;
  const existing = lookup.existing;

  if (existing?.lifecycleStatus === 'RETIRED') {
    return json({ error: `Your SKU ${existing.sku} is retired on Walmart. Reactivate it in Seller Center before adding stock.`, lookup }, 409);
  }

  // Units of this product already waiting in "Walmart stock to send": moving
  // them keeps their cost lot; adding again records a second purchase.
  if (wfs && !holding && !body.newPurchase && !body.setup) {
    const db = openDb({ readonly: true });
    try {
      const waiting = holdingItems(db).filter(i => i.walmartItemId === product.itemId);
      const units = waiting.reduce((s, i) => s + i.quantity, 0);
      if (units > 0) {
        return json({
          inHolding: { units, sku: waiting[0].sku, itemIds: waiting.map(i => i.id) },
          error: `You have ${units} unit${units === 1 ? '' : 's'} of this (${waiting[0].sku}) in Walmart stock to send. Move them in from the Stock to send panel, or add these as a new purchase.`,
        }, 409);
      }
    } finally {
      db.close();
    }
  }

  // A SKU FlipLedger already submitted for this product (still being created on
  // Walmart, so the catalog search can't see it yet): reuse it, don't create another.
  let localSetup: { sku: string; state: SetupState } | null = null;
  if (!existing) {
    const db = openDb({ readonly: true });
    try {
      const row = db.prepare(`
        SELECT sku, walmart_setup FROM listing_batch_items
        WHERE walmart_item_id = ? AND fulfillment_channel = ? AND walmart_setup_status IN ('PENDING', 'READY') AND walmart_setup IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(product.itemId, wfs ? 'WFS' : 'SELLER') as { sku: string; walmart_setup: string } | undefined;
      if (row) localSetup = { sku: row.sku, state: JSON.parse(row.walmart_setup) as SetupState };
    } finally {
      db.close();
    }
  }

  // Which setup (if any) this item needs.
  let kind: SetupKind | null = null;
  if (localSetup) {
    // restock of a SKU still being set up: no new feed
  } else if (!existing) {
    kind = wfs ? 'WFS_NEW' : 'SF_NEW';
  } else {
    let onWfs: boolean;
    try { onWfs = await isWfsSku(creds, existing.sku); }
    catch (err) { return json({ error: `Couldn't check WFS status for ${existing.sku}: ${walmartErrorMessage(err)}` }, 502); }
    if (wfs && !onWfs) kind = 'WFS_CONVERT';
    if (!wfs && onWfs) return json({ error: `Your SKU ${existing.sku} is on WFS. Add it to a Walmart WFS batch instead.`, lookup }, 409);
  }

  const db = openDb();
  try {
    let state: SetupState | null = localSetup?.state ?? null;
    let sku = existing?.sku ?? localSetup?.sku ?? '';
    if (buyBlank) {
      // A new product needs a cost (it's also part of the SKU FlipLedger creates).
      costFrom = kind && kind !== 'WFS_CONVERT' ? null : lastCost(db, sku);
      if (!costFrom) {
        return json({
          error: kind && kind !== 'WFS_CONVERT'
            ? `${product.title} is new to you on Walmart. Enter the buy price.`
            : `No past cost on file for ${sku}. Enter the buy price.`,
          needsBuyPrice: true,
        }, 400);
      }
      buyPrice = costFrom.buyPriceCents / 100;
      supplier = supplier ?? costFrom.supplier;
    }
    if (kind) {
      let setupInput = body.setup;
      if (!setupInput) {
        let form;
        try {
          form = await buildSetupForm(db, creds, product, {
            kind, existingSku: existing?.sku, existingPriceCents: existing?.priceCents, supplier, buyPrice,
            ownSkuExists: s => ownSkuExists(creds, s),
          });
        } catch (err) {
          return json({ error: `Couldn't prepare the Walmart setup: ${walmartErrorMessage(err)}`, lookup }, 502);
        }
        // An existing SKU whose details are all known switches to WFS with no form.
        if (form.autoReady) {
          setupInput = setupFromForm(form);
        } else {
          const message = kind === 'WFS_CONVERT'
            ? `You already sell this as ${existing!.sku}, shipped by you. Adding it moves that SKU to WFS — FlipLedger just needs the details below.`
            : kind === 'WFS_NEW'
              ? `You don't have a Walmart SKU on this product yet. Check the details below and FlipLedger will create it on WFS.`
              : `You don't have a Walmart SKU on this product yet. Check the details below and FlipLedger will create the offer.`;
          return json({ needsSetup: true, kind, error: message, product, form }, 409);
        }
      }

      if (kind !== 'WFS_CONVERT') {
        const wanted = String(setupInput.sku ?? '').trim();
        const localTaken = db.prepare('SELECT 1 FROM listing_batch_items WHERE sku = ? UNION SELECT 1 FROM inventory_ledger WHERE sku = ?').get(wanted, wanted);
        let walmartTaken = false;
        try { walmartTaken = await ownSkuExists(creds, wanted); }
        catch (err) { return json({ error: `Couldn't check the SKU on Walmart: ${walmartErrorMessage(err)}` }, 502); }
        if (localTaken || walmartTaken) return json({ error: `SKU ${wanted} is already in use. Pick another.` }, 409);
      }
      const setup = { ...setupInput, sku: kind === 'WFS_CONVERT' ? existing!.sku : setupInput.sku };
      let result;
      try {
        result = await submitSetup(db, creds, product, kind, setup);
      } catch (err) {
        return json({ error: `Walmart didn't accept the setup: ${walmartErrorMessage(err)}` }, 502);
      }
      if (!result.ok) return json({ error: result.error, problems: result.problems, batteryConflict: result.batteryConflict }, result.status);
      state = result.state;
      sku = state.sku;
    }

    const now = new Date().toISOString();
    const listPriceCents = body.setup?.priceDollars ? Math.round(Number(body.setup.priceDollars) * 100) : (existing?.priceCents ?? product.priceCents ?? 0);
    const itemId = insertItem(db, {
      batchId, sku, product, quantity, buyPrice, listPriceCents, supplier,
      purchaseDate: body.purchaseDate || null, sendQty: body.sendQty !== false, state, now, channel: wfs ? 'WFS' : 'SELLER',
    });
    db.close();

    const fifo = recalculateFIFO({ sku });
    return json({ success: true, itemId, sku, product, kind, setup: state, note: lookup.note, costFrom, fifo });
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function insertItem(db: ReturnType<typeof openDb>, o: {
  batchId: number; sku: string; product: WalmartCatalogProduct; quantity: number; buyPrice: number; listPriceCents: number;
  supplier: string | null; purchaseDate: string | null; sendQty: boolean; state: SetupState | null; now: string; channel: string;
}): number {
  return db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO listing_batch_items (
        batch_id, asin, sku, msku, product_name, image_url, condition, quantity,
        list_price_cents, buy_price_cents, supplier, purchase_date, fulfillment_channel,
        walmart_item_id, gtin, walmart_setup_status, walmart_setup, send_qty_to_amazon, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      o.batchId, o.sku, o.sku, o.sku, o.product.title, o.product.imageUrl, o.quantity,
      o.listPriceCents, Math.round(o.buyPrice * 100), o.supplier, o.purchaseDate, o.channel,
      o.product.itemId, o.product.gtin14, o.state?.status ?? null, o.state ? JSON.stringify(o.state) : null,
      o.sendQty ? 1 : 0, o.now,
    );
    const id = Number(res.lastInsertRowid);
    // Walmart sales and lots key on the SKU (order_items.asin = sku), so the lot does too.
    insertItemLot(db, {
      id, asin: o.sku, sku: o.sku, quantity: o.quantity, buy_price_cents: Math.round(o.buyPrice * 100),
      supplier: o.supplier, purchase_date: o.purchaseDate,
    }, o.now);
    db.prepare(`
      INSERT INTO products (asin, sku, name, image_url, marketplace, walmart_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'walmart', ?, ?, ?)
      ON CONFLICT(asin) DO UPDATE SET
        name = COALESCE(products.name, excluded.name),
        image_url = COALESCE(excluded.image_url, products.image_url),
        walmart_item_id = COALESCE(excluded.walmart_item_id, products.walmart_item_id),
        updated_at = excluded.updated_at
    `).run(o.sku, o.sku, o.product.title, o.product.imageUrl, o.product.itemId, o.now, o.now);
    db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(o.now, o.batchId);
    return id;
  })();
}
