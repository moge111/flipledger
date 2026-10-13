/**
 * POST /api/list/batches/[id]/wfs/move { itemId, quantity }
 *
 * Moves units from "Walmart stock to send" into this draft WFS batch. The units
 * keep the cost lot recorded when they were bought (no second lot): moving all
 * of a line re-points the line; moving part of it splits the line and its lot
 * into two at the same cost, supplier and purchase date, so FIFO is unchanged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { openDb } from '@/lib/db-conn';
import { recalculateFIFO } from '@/lib/fifo';
import { insertItemLot, lotUnitsSold } from '@/lib/listing-ledger';
import { loadWfsBatch } from '@/lib/wfs-batch';

const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const batchId = parseInt((await params).id, 10);
  const body = await request.json().catch(() => ({}));
  const itemId = Number(body.itemId);
  const quantity = parseInt(String(body.quantity ?? ''), 10);
  if (!Number.isInteger(itemId)) return json({ error: 'itemId is required.' }, 400);
  if (!Number.isFinite(quantity) || quantity < 1) return json({ error: 'Quantity must be 1 or more.' }, 400);

  const db = openDb();
  let sku: string;
  try {
    const found = loadWfsBatch(db, batchId);
    if (!found.ok) return json({ error: found.error }, found.status);
    if (found.batch.is_holding) return json({ error: 'Move units into a shipment batch, not into Walmart stock to send.' }, 400);
    if (found.batch.status !== 'draft') return json({ error: 'Units can only be moved into a draft batch.' }, 400);

    const item = db.prepare(`
      SELECT i.*, b.is_holding FROM listing_batch_items i JOIN listing_batches b ON b.id = i.batch_id WHERE i.id = ?
    `).get(itemId) as Record<string, any> | undefined;
    if (!item || !item.is_holding) return json({ error: 'That line is not in Walmart stock to send.' }, 404);
    if (quantity > item.quantity) return json({ error: `Only ${item.quantity} unit${item.quantity === 1 ? '' : 's'} of ${item.sku} are waiting.` }, 400);
    sku = item.sku;
    const now = new Date().toISOString();

    if (quantity === item.quantity) {
      db.transaction(() => {
        db.prepare('UPDATE listing_batch_items SET batch_id = ? WHERE id = ?').run(batchId, itemId);
        db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id IN (?, ?)').run(now, batchId, item.batch_id);
      })();
      return json({ success: true, movedItemId: itemId, quantity, sku });
    }

    // Split: the waiting line keeps (qty − n); a new line with n units joins this batch.
    const keep = item.quantity - quantity;
    const sold = lotUnitsSold(db, item as any);
    if (item.inventory_ledger_id != null && sold > keep) {
      return json({ error: `${sold} unit${sold === 1 ? '' : 's'} of this line's cost lot already went to sales, so it can't be split this way. Move the whole line instead.` }, 409);
    }
    const newId = db.transaction(() => {
      if (item.inventory_ledger_id != null) {
        db.prepare('UPDATE inventory_ledger SET quantity = quantity - ?, quantity_remaining = MAX(0, quantity_remaining - ?) WHERE id = ?')
          .run(quantity, quantity, item.inventory_ledger_id);
      }
      db.prepare('UPDATE listing_batch_items SET quantity = ? WHERE id = ?').run(keep, itemId);
      const cols = Object.keys(item).filter(c => !['id', 'is_holding', 'batch_id', 'quantity', 'inventory_ledger_id', 'created_at'].includes(c));
      const res = db.prepare(`
        INSERT INTO listing_batch_items (batch_id, quantity, created_at, ${cols.join(', ')})
        VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})
      `).run(batchId, quantity, now, ...cols.map(c => item[c]));
      const id = Number(res.lastInsertRowid);
      if (item.inventory_ledger_id != null) {
        const lot = db.prepare('SELECT buy_price, date_purchased, supplier_id FROM inventory_ledger WHERE id = ?').get(item.inventory_ledger_id) as
          { buy_price: number; date_purchased: string; supplier_id: number | null } | undefined;
        const lotId = insertItemLot(db, {
          id, asin: item.asin, sku: item.sku, quantity, buy_price_cents: lot?.buy_price ?? item.buy_price_cents,
          supplier: item.supplier, purchase_date: lot?.date_purchased ?? item.purchase_date,
        }, now);
        if (lot) db.prepare('UPDATE inventory_ledger SET supplier_id = ? WHERE id = ?').run(lot.supplier_id, lotId);
      }
      db.prepare('UPDATE listing_batches SET updated_at = ? WHERE id IN (?, ?)').run(now, batchId, item.batch_id);
      return id;
    })();
    db.close();
    recalculateFIFO({ sku });
    return json({ success: true, movedItemId: newId, quantity, sku, left: keep });
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
