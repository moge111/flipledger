/**
 * Batch items API.
 *
 * POST /api/list/batches/[id]/items
 *   - Adds an item to a batch. Also writes to inventory_ledger (for COGS/FIFO).
 *   - Auto-triggers FIFO recalculation for the affected SKU/ASIN.
 *   - MFN batches accept quantity 0 (Oct 4 2026): the SKU is registered on
 *     Amazon out of stock before anything is bought. No lot is written and
 *     FIFO is not run; the lot appears when the quantity is raised (PATCH).
 *   - MFN `sendQtyToAmazon` (default true): the "Qty → Amazon" switch. false
 *     = FlipLedger never sets the Amazon quantity (new offer created at 0,
 *     stock managed in Seller Central). The lot is written either way, so COGS
 *     and inventory are right from purchase. Legacy `awaitingDelivery: true`
 *     (older FBA Scout builds) means false.
 */
import { refreshItemFee, liveOfferPriceCents, isAmazonChannel } from '@/lib/listing-fees';
import { NextRequest, NextResponse } from 'next/server';
import { recalculateFIFO } from '@/lib/fifo';
import { insertItemLot } from '@/lib/listing-ledger';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const body = await request.json();
  const {
    asin,
    msku,
    productName,
    imageUrl,
    condition = 'NewItem',
    quantity = 1,
    listPrice,           // dollars
    buyPrice,            // dollars
    supplier,
    purchaseDate,
    estimatedFeeCents,   // already in cents (optional)
    estimatedShipCents,  // already in cents (optional) — MFN seller shipping estimate
    sendQtyToAmazon,          // MFN only: false = don't set the Amazon quantity
    awaitingDelivery,         // legacy alias: true = sendQtyToAmazon false
  } = body;
  // `sku` is mutable: the duplicate-SKU safeguard below may append a
  // differentiator before any insert. All downstream writes use this value.
  let sku: string = (body.sku || '').toString().trim();

  if (!asin) return NextResponse.json({ error: 'asin is required' }, { status: 400 });
  if (!sku) return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  // The range is checked once the batch channel is known: MFN allows 0.
  if (!Number.isFinite(quantity)) {
    return NextResponse.json({ error: 'quantity must be >= 1' }, { status: 400 });
  }

  let listPriceCents = Math.round((Number(listPrice) || 0) * 100);
  const buyPriceCents = Math.round((Number(buyPrice) || 0) * 100);

  const db = getDb();
  try {
    // Make sure the batch exists and is editable
    const batch = db.prepare('SELECT status, channel FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot add items to batch in status: ${batch.status}` }, { status: 400 });
    }
    const isMfnBatch = String(batch.channel || 'FBA').toUpperCase() === 'MFN';
    const minQty = isMfnBatch ? 0 : 1;
    if (quantity < minQty) {
      return NextResponse.json({ error: `quantity must be >= ${minQty}` }, { status: 400 });
    }
    const zeroQty = quantity === 0;
    const sendQty = !(sendQtyToAmazon === false || awaitingDelivery === true);
    if (!sendQty && !isMfnBatch) {
      return NextResponse.json({ error: 'sendQtyToAmazon is only for MFN batches (FBA stock is counted by Amazon\'s warehouse)' }, { status: 400 });
    }

    // ── Cross-channel MSKU safeguard ─────────────────────────────────────
    // Amazon keeps an MSKU on exactly ONE fulfillment channel. PUTting an MFN
    // offer onto an MSKU that is live on FBA rewrites fulfillment_channel_code
    // to DEFAULT — the FBA listing becomes merchant-fulfilled and its warehouse
    // (and in-transit) units are stranded. The reverse is equally destructive.
    // The UI hides incompatible restock chips, but enforce it here too so a
    // hand-typed or imported SKU can't slip through.
    const wantChannel: 'FBA' | 'MFN' = String(batch.channel || 'FBA').toUpperCase() === 'MFN' ? 'MFN' : 'FBA';
    const skuChannel = (candidate: string): 'FBA' | 'MFN' | null => {
      const row = db.prepare(`
        SELECT channel FROM (
          SELECT CASE WHEN UPPER(COALESCE(fulfillment_channel,'')) = 'DEFAULT' THEN 'MFN'
                      WHEN UPPER(COALESCE(fulfillment_channel,'')) LIKE 'AMAZON%' THEN 'FBA' END AS channel,
                 3 AS rank
          FROM merchant_listings WHERE sku = ?
          UNION ALL
          SELECT CASE WHEN COALESCE(bi.fnsku,'') != '' THEN 'FBA' ELSE UPPER(b.channel) END AS channel, 2 AS rank
          FROM listing_batch_items bi JOIN listing_batches b ON b.id = bi.batch_id
          WHERE bi.sku = ? AND bi.batch_id != ?
          UNION ALL
          SELECT 'FBA' AS channel, 1 AS rank FROM live_inventory
          WHERE sku = ? AND marketplace = 'amazon'
            AND (COALESCE(fulfillable_qty,0) + COALESCE(inbound_qty,0) + COALESCE(reserved_qty,0)) > 0
        ) WHERE channel IS NOT NULL ORDER BY rank DESC LIMIT 1
      `).get(candidate, candidate, batchId, candidate) as any;
      return row?.channel === 'FBA' || row?.channel === 'MFN' ? row.channel : null;
    };
    const conflict = skuChannel(sku);
    if (conflict && conflict !== wantChannel) {
      const suffixed = wantChannel === 'MFN' && !sku.toLowerCase().endsWith('-mfn')
        ? `${sku}-mfn`
        : `${sku}-${wantChannel.toLowerCase()}`;
      // Only auto-rename into a slot that is itself free of a channel conflict.
      const stillConflicts = skuChannel(suffixed);
      if (stillConflicts && stillConflicts !== wantChannel) {
        return NextResponse.json({
          error: `MSKU "${sku}" is registered on the ${conflict} channel and this is a ${wantChannel} batch. ` +
                 `Reusing it would move the existing Amazon listing to ${wantChannel}. Choose a different MSKU.`,
          skuChannelConflict: { sku, existingChannel: conflict, batchChannel: wantChannel },
        }, { status: 409 });
      }
      sku = suffixed;
    }

    // ── Duplicate-SKU safeguard ──────────────────────────────────────────
    // Two DIFFERENT ASINs must never share an MSKU — they'd collide onto a
    // single Amazon listing (and, with auto-create-on-add, the 2nd add would
    // silently overwrite the 1st's listing). The auto-generated SKU
    // (supplier-slug-cost) CAN collide for same-named, same-priced product-line
    // variants (e.g. Royale High Nature vs Ice Fairy, both $9.99). If the
    // proposed SKU is already used by a DIFFERENT ASIN anywhere, append
    // -2/-3/… until unique. Reusing a SKU for the SAME ASIN is left alone —
    // that's an intentional restock (e.g. the Minecraft cube).
    const skuTakenByOtherAsin = (candidate: string): boolean => !!db.prepare(`
      SELECT 1 FROM (
        SELECT asin, sku FROM listing_batch_items WHERE sku = ?
        UNION SELECT asin, sku FROM inventory_ledger WHERE sku = ?
        UNION SELECT asin, sku FROM products WHERE sku = ?
      ) WHERE asin IS NOT NULL AND asin != ? LIMIT 1
    `).get(candidate, candidate, candidate, asin);
    if (skuTakenByOtherAsin(sku)) {
      const base = sku;
      let n = 2;
      while (skuTakenByOtherAsin(`${base}-${n}`)) n++;
      sku = `${base}-${n}`;
    }

    const now = new Date().toISOString();

    // No price given for a SKU that's already on Amazon (FBA Scout, imports,
    // a blank price box): use what that SKU sells for there now.
    let priceFromAmazon = false;
    if (listPriceCents <= 0 && isAmazonChannel(batch.channel)) {
      const live = await liveOfferPriceCents(db, sku);
      if (live) { listPriceCents = live; priceFromAmazon = true; }
    }

    const addItem = db.transaction(() => {
      // 1. Insert into listing_batch_items
      const result = db.prepare(`
        INSERT INTO listing_batch_items (
          batch_id, asin, sku, msku, product_name, image_url, condition,
          quantity, list_price_cents, buy_price_cents, supplier, purchase_date,
          estimated_fee_cents, estimated_ship_cents, send_qty_to_amazon, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        asin,
        sku,
        msku || null,
        productName || null,
        imageUrl || null,
        condition,
        quantity,
        listPriceCents,
        buyPriceCents,
        supplier || null,
        purchaseDate || null,
        estimatedFeeCents || 0,
        estimatedShipCents || 0,
        sendQty ? 1 : 0,
        now
      );

      // 2–3. Write this item's OWN inventory_ledger lot (supplier resolved
      //    inside), linked on the item, so edits and deletes can act on exactly
      //    that lot. Restocks used to merge into an existing same-price lot and
      //    re-date it, which both reordered FIFO and made rollback guess which
      //    lot to shrink (Sept 22 2026 review, A-latent-2).
      //    A 0-qty MFN item owns no lot: nothing was bought yet.
      if (!zeroQty) {
        insertItemLot(db, {
          id: Number(result.lastInsertRowid),
          asin,
          sku,
          quantity,
          buy_price_cents: buyPriceCents,
          supplier: supplier || null,
          purchase_date: purchaseDate || null,
        }, now);
      }

      // 4. Upsert into products so the name/image get reused next time
      if (productName) {
        db.prepare(`
          INSERT INTO products (asin, sku, name, image_url, marketplace, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'amazon', ?, ?)
          ON CONFLICT(asin) DO UPDATE SET
            name = COALESCE(excluded.name, name),
            image_url = COALESCE(excluded.image_url, image_url),
            updated_at = excluded.updated_at
        `).run(asin, sku, productName, imageUrl || null, now, now);
      }

      // 5. Bump the batch's updated_at
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);

      return result.lastInsertRowid;
    });

    const itemId = addItem();
    // Adds that skip the scan form (FBA Scout, imports) arrive without a fee.
    if ((priceFromAmazon || !(Number(estimatedFeeCents) > 0)) && listPriceCents > 0 && itemId != null) {
      await refreshItemFee(db, batchId, Number(itemId));
    }
    db.close();

    // 6. Auto-recalculate FIFO for this SKU (matches Products page behavior).
    //    Skipped for a 0-qty item: no lot was written, so nothing can move.
    const fifo = zeroQty ? null : recalculateFIFO({ sku });

    return NextResponse.json({ id: itemId, success: true, fifo, sku, quantity, listPriceCents, priceFromAmazon, lotCreated: !zeroQty, sendQtyToAmazon: sendQty });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
