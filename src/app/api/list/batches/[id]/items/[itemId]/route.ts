/**
 * Single batch item API.
 *
 * PATCH  /api/list/batches/[id]/items/[itemId] - update quantity/price/condition
 * DELETE /api/list/batches/[id]/items/[itemId] - remove an item from a batch
 *
 * Quantity and buy-price edits are applied to the item's own inventory_ledger
 * lot and FIFO is re-run, so a cost correction reaches COGS. Items with no lot
 * link (added before Sept 22 2026) are updated here only; the response says so.
 * A 0-qty MFN item has no lot either (nothing bought yet): raising its quantity
 * creates the lot then, same as a normal add; deleting it touches no lot.
 */
import { NextRequest, NextResponse } from 'next/server';
import { recalculateFIFO } from '@/lib/fifo';
import { openDb } from '@/lib/db-conn';
import { refreshItemFee } from '@/lib/listing-fees';
import { applyItemLedgerEdit, rollbackItemLedger, isZeroQtyUnlotted, insertItemLot, lotUnitsSold, soldUnitsMessage, type LedgerItem, type LedgerResult, type LotSource } from '@/lib/listing-ledger';

const getDb = () => openDb();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itemIdNum = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itemIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await request.json();
  const db = getDb();
  try {
    // Verify the batch is in an editable state
    const batch = db.prepare('SELECT status, channel, inbound_plan_id FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

    // Edit rules by status:
    //   draft: any field editable (full edit set — pre-Amazon)
    //   ready, boxing, placement: only quantity + buyPrice editable.
    //     These are FlipLedger-local — qty reconciles at FBA receipt and
    //     buyPrice only affects FIFO/COGS. Other fields (listPrice,
    //     condition, MSKU) are baked into the live Amazon listing and would
    //     silently diverge if changed locally — to change those, edit in
    //     Seller Central.
    //   sending, shipping, shipped, failed, closed: no edits.
    const isDraft = batch.status === 'draft';
    const isPostDraftEditable = ['ready', 'boxing', 'placement'].includes(batch.status);
    if (!isDraft && !isPostDraftEditable) {
      return NextResponse.json({ error: `Cannot edit items in status: ${batch.status}` }, { status: 400 });
    }

    // Whitelist of fields per status. The frontend mirrors these rules but
    // we enforce them server-side too — if a misbehaving client sends a
    // locked field, reject explicitly so the divergence is impossible.
    //
    // labelsPrintedAt is a purely-local UI tracking field (when the user marks
    // a row as physically labeled) — always editable, never touches Amazon.
    const allowedFields = isDraft
      ? new Set(['msku', 'condition', 'quantity', 'supplier', 'purchaseDate', 'listPrice', 'buyPrice', 'labelsPrintedAt'])
      : new Set(['quantity', 'buyPrice', 'labelsPrintedAt']);

    for (const k of Object.keys(body)) {
      if (!allowedFields.has(k)) {
        return NextResponse.json({
          error: `Field '${k}' is not editable in '${batch.status}' status. Allowed: ${[...allowedFields].join(', ')}.`,
        }, { status: 400 });
      }
    }

    const sets: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      msku: 'msku',
      condition: 'condition',
      quantity: 'quantity',
      supplier: 'supplier',
      purchaseDate: 'purchase_date',
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (body[key] !== undefined && allowedFields.has(key)) {
        if (key === 'quantity') {
          const newQty = parseInt(String(body.quantity), 10);
          if (!Number.isFinite(newQty) || newQty < 0) {
            return NextResponse.json({ error: 'quantity must be a non-negative integer' }, { status: 400 });
          }
          // A sent FBA batch's quantities live in Amazon's inbound plan, and the
          // boxing screen + setPackingInformation use the plan's numbers. Amazon
          // has no API to change plan quantities before placement, so a local
          // edit would only make FlipLedger and Amazon disagree.
          if (!isDraft && batch.channel === 'FBA' && batch.inbound_plan_id) {
            const current = db.prepare('SELECT quantity FROM listing_batch_items WHERE id = ? AND batch_id = ?')
              .get(itemIdNum, batchId) as { quantity: number } | undefined;
            if (current && current.quantity !== newQty) {
              return NextResponse.json({
                error: `Amazon's shipment plan already has ${current.quantity} of this item, and Amazon doesn't allow changing plan quantities at this stage. Use Cancel & Edit (listings stay live), change the quantity, then Send again.`,
              }, { status: 409 });
            }
          }
          // Boxing guard: don't reduce qty below the units already allocated
          // to boxes. The user has to free them up first.
          const allocatedRow = db.prepare(`
            SELECT COALESCE(SUM(bi.quantity), 0) as allocated
            FROM listing_batch_box_items bi
            INNER JOIN listing_batch_boxes b ON b.id = bi.box_id
            WHERE b.batch_id = ? AND bi.item_id = ?
          `).get(batchId, itemIdNum) as { allocated: number };
          // Sold-units guard: FIFO already gave some of this item's lot to
          // sales; their COGS comes from it, so the lot can't shrink below them.
          const linked = db.prepare('SELECT sku, inventory_ledger_id FROM listing_batch_items WHERE id = ? AND batch_id = ?')
            .get(itemIdNum, batchId) as { sku: string; inventory_ledger_id: number | null } | undefined;
          const sold = linked ? lotUnitsSold(db, linked) : 0;
          if (newQty < sold) {
            return NextResponse.json({
              error: `${sold} unit${sold === 1 ? '' : 's'} of ${linked!.sku} already sold, so the quantity can't go below ${sold}.`,
              unitsSold: sold,
            }, { status: 409 });
          }
          if (allocatedRow.allocated > newQty) {
            return NextResponse.json({
              error: `Quantity ${newQty} is below the ${allocatedRow.allocated} units already allocated to boxes. Remove some from boxes first, then reduce quantity.`,
            }, { status: 400 });
          }
          sets.push('quantity = ?');
          values.push(newQty);
        } else {
          sets.push(`${col} = ?`);
          values.push(body[key]);
        }
      }
    }
    if (body.listPrice !== undefined && allowedFields.has('listPrice')) {
      sets.push('list_price_cents = ?');
      values.push(Math.round(Number(body.listPrice) * 100));
    }
    if (body.buyPrice !== undefined && allowedFields.has('buyPrice')) {
      sets.push('buy_price_cents = ?');
      values.push(Math.round(Number(body.buyPrice) * 100));
    }
    // labelsPrintedAt: pass null to clear, true/timestamp to set
    if (body.labelsPrintedAt !== undefined && allowedFields.has('labelsPrintedAt')) {
      sets.push('labels_printed_at = ?');
      // Accept boolean true or string. true → current ISO timestamp, false/null → cleared
      let val: string | null = null;
      if (body.labelsPrintedAt === true) val = new Date().toISOString();
      else if (typeof body.labelsPrintedAt === 'string' && body.labelsPrintedAt.length > 0) val = body.labelsPrintedAt;
      values.push(val);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const item = db.prepare('SELECT id, sku, quantity, buy_price_cents, inventory_ledger_id FROM listing_batch_items WHERE id = ? AND batch_id = ?')
      .get(itemIdNum, batchId) as LedgerItem | undefined;
    if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    const ledgerEdit = {
      quantity: body.quantity !== undefined && allowedFields.has('quantity') ? parseInt(String(body.quantity), 10) : undefined,
      buyPriceCents: body.buyPrice !== undefined && allowedFields.has('buyPrice') ? Math.round(Number(body.buyPrice) * 100) : undefined,
    };

    values.push(itemIdNum, batchId);
    const ledger = db.transaction((): LedgerResult => {
      const r = applyItemLedgerEdit(db, item, ledgerEdit);
      const now = new Date().toISOString();
      db.prepare(`UPDATE listing_batch_items SET ${sets.join(', ')} WHERE id = ? AND batch_id = ?`).run(...values);
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(now, batchId);
      // 0 → N on an item that owns no lot: write the lot now, from the item's
      // saved (post-edit) values, exactly as the add route would have.
      if (isZeroQtyUnlotted(item) && (ledgerEdit.quantity ?? 0) > 0) {
        const fresh = db.prepare(`
          SELECT id, asin, sku, quantity, buy_price_cents, supplier, purchase_date
          FROM listing_batch_items WHERE id = ? AND batch_id = ?
        `).get(itemIdNum, batchId) as LotSource;
        insertItemLot(db, fresh, now);
        return { applied: true, changed: true };
      }
      return r;
    })();

    const touchedLedger = ledger.applied && ledger.changed === true;
    if (touchedLedger) recalculateFIFO({ sku: item.sku });

    // A price change moves the referral fee (and an item first priced here had
    // no fee at all), so re-estimate it rather than keep a stale/zero value.
    const feeCents = body.listPrice !== undefined && allowedFields.has('listPrice')
      ? await refreshItemFee(db, batchId, itemIdNum)
      : null;

    return NextResponse.json({
      success: true,
      status: batch.status,
      editScope: isDraft ? 'full' : 'qty-and-buy-only',
      ledgerUpdated: touchedLedger,
      ...(feeCents != null ? { estimatedFeeCents: feeCents } : {}),
      ...(ledger.applied ? {} : { ledgerWarning: ledger.reason }),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await params;
  const batchId = parseInt(id);
  const itemIdNum = parseInt(itemId);
  if (!Number.isFinite(batchId) || !Number.isFinite(itemIdNum)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const db = getDb();
  let affectedSku: string | null = null;
  let ledgerResult = { applied: true } as LedgerResult;
  let removedZeroQty = false;
  try {
    const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.status !== 'draft') {
      return NextResponse.json({ error: `Cannot remove items in status: ${batch.status}` }, { status: 400 });
    }

    // Roll back the inventory_ledger add that happened when this item was created,
    // so deleting a mistakenly-added batch item doesn't leave zombie inventory.
    const rollback = db.transaction(() => {
      const item = db.prepare('SELECT id, sku, quantity, buy_price_cents, inventory_ledger_id FROM listing_batch_items WHERE id = ? AND batch_id = ?')
        .get(itemIdNum, batchId) as LedgerItem | undefined;
      if (!item) return null;

      const sold = lotUnitsSold(db, item);
      if (sold > 0) return { blocked: soldUnitsMessage(item.sku, sold), unitsSold: sold };
      affectedSku = item.sku;
      removedZeroQty = isZeroQtyUnlotted(item);
      // Only ever the item's own lot. It used to shrink the SKU's oldest lot.
      ledgerResult = rollbackItemLedger(db, item);

      db.prepare('DELETE FROM listing_batch_items WHERE id = ? AND batch_id = ?').run(itemIdNum, batchId);
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), batchId);
      return item;
    });

    const removed = rollback();
    db.close();
    if (removed && 'blocked' in removed) {
      return NextResponse.json({ error: removed.blocked, unitsSold: removed.unitsSold }, { status: 409 });
    }

    // Re-run FIFO for the affected SKU so order_items cogs_per_unit rebalances
    // against the reduced ledger. Skipped for a 0-qty MFN item: it owned no
    // lot, so the books cannot move.
    if (affectedSku && !removedZeroQty) {
      try { recalculateFIFO({ sku: affectedSku }); } catch { /* best effort */ }
    }

    return NextResponse.json({ success: true, removed, ...(ledgerResult.applied ? {} : { ledgerWarning: ledgerResult.reason }) });
  } catch (err) {
    db.close();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
