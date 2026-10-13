/**
 * The inventory_ledger lot behind each listing-batch item.
 *
 * Every batch item owns exactly one lot, stored in
 * listing_batch_items.inventory_ledger_id. Edits and deletes act on that lot
 * only. Before Sept 22 2026 (review A-latent-2/3):
 *   - adding a restock at the same price merged into an existing lot and
 *     re-dated it, so FIFO order changed;
 *   - deleting an item or batch decremented the SKU's OLDEST lot by rowid,
 *     which moved COGS between closed months on multi-lot SKUs;
 *   - buy-price and quantity edits never reached the ledger at all.
 * An item with no lot link (legacy rows) is never guessed at: callers get
 * applied=false and a reason to show the user.
 */
import Database from 'better-sqlite3';
import { resolveSupplierId } from '@/lib/suppliers';

export interface LedgerItem {
  id: number;
  sku: string;
  quantity: number;
  buy_price_cents: number;
  inventory_ledger_id: number | null;
}

export type LedgerResult = { applied: true; changed?: boolean } | { applied: false; reason: string };

/**
 * A 0-quantity item (MFN only: listing registered before any stock was bought,
 * Oct 4 2026) owns no lot. Nothing was bought, so there is nothing to cost;
 * the lot is created when its quantity is first raised above 0.
 */
export function isZeroQtyUnlotted(item: Pick<LedgerItem, 'quantity' | 'inventory_ledger_id'>): boolean {
  return item.inventory_ledger_id == null && Number(item.quantity) === 0;
}

export interface LotSource {
  id: number;
  asin: string;
  sku: string;
  quantity: number;
  buy_price_cents: number;
  supplier: string | null;
  purchase_date: string | null;
}

/** Write a batch item's own lot and link it on the item. Returns the lot id. */
export function insertItemLot(db: Database.Database, item: LotSource, now: string): number {
  const supplierId = resolveSupplierId(db, item.supplier, now);
  const lot = db.prepare(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.asin, item.sku, item.buy_price_cents, item.quantity, item.quantity, supplierId, item.purchase_date || now, now);
  const lotId = Number(lot.lastInsertRowid);
  db.prepare('UPDATE listing_batch_items SET inventory_ledger_id = ? WHERE id = ?').run(lotId, item.id);
  return lotId;
}

/**
 * Units of the item's own lot that FIFO has already given to sales. Those
 * sales take their COGS from this lot, so the lot can't be deleted or shrunk
 * below this (Oct 4 2026: deleting batch 51's sold-out Pokémon row would have
 * stripped the cost from 3 real sales).
 */
export function lotUnitsSold(db: Database.Database, item: Pick<LedgerItem, 'inventory_ledger_id'>): number {
  if (item.inventory_ledger_id == null) return 0;
  const lot = db.prepare('SELECT quantity, quantity_remaining FROM inventory_ledger WHERE id = ?').get(item.inventory_ledger_id) as
    { quantity: number; quantity_remaining: number } | undefined;
  return lot ? Math.max(0, lot.quantity - lot.quantity_remaining) : 0;
}

/** Units FlipLedger shows in stock for a SKU: every lot's quantity_remaining. */
export function skuStockInFlipLedger(db: Database.Database, sku: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(quantity_remaining), 0) AS n FROM inventory_ledger WHERE sku = ?').get(sku) as { n: number };
  return Math.max(0, Number(row.n) || 0);
}

export const soldUnitsMessage = (sku: string, sold: number) =>
  `${sold} unit${sold === 1 ? '' : 's'} of ${sku} already sold, and those sales take their cost from this item. ` +
  `Removing it would wipe that cost from your books. To drop units you didn't get, lower the quantity (not below ${sold}).`;

const NO_LINK = 'This item has no linked cost lot (added before Sept 22 2026), so the change was not applied to COGS. Adjust it under Products & COGS → Lots.';

/** Apply a batch-item quantity and/or buy-price edit to the item's own lot. */
export function applyItemLedgerEdit(
  db: Database.Database,
  item: LedgerItem,
  edit: { quantity?: number; buyPriceCents?: number },
): LedgerResult {
  if (edit.quantity === undefined && edit.buyPriceCents === undefined) return { applied: true, changed: false };
  // No lot yet and nothing bought: the caller creates the lot (insertItemLot)
  // once the edited quantity is above 0.
  if (isZeroQtyUnlotted(item)) return { applied: true, changed: false };
  if (item.inventory_ledger_id == null) return { applied: false, reason: NO_LINK };
  const lot = db.prepare('SELECT id, quantity FROM inventory_ledger WHERE id = ?').get(item.inventory_ledger_id) as { id: number; quantity: number } | undefined;
  if (!lot) return { applied: false, reason: `Linked lot ${item.inventory_ledger_id} no longer exists; COGS not changed.` };

  const delta = edit.quantity === undefined ? 0 : edit.quantity - item.quantity;
  db.prepare(`
    UPDATE inventory_ledger SET
      quantity = MAX(0, quantity + ?),
      quantity_remaining = MAX(0, quantity_remaining + ?),
      buy_price = COALESCE(?, buy_price)
    WHERE id = ?
  `).run(delta, delta, edit.buyPriceCents ?? null, lot.id);
  return { applied: true, changed: true };
}

/** Remove a deleted batch item's units from its own lot (the lot goes when it hits 0). */
export function rollbackItemLedger(db: Database.Database, item: LedgerItem): LedgerResult {
  if (isZeroQtyUnlotted(item)) return { applied: true, changed: false };
  if (item.inventory_ledger_id == null) return { applied: false, reason: NO_LINK };
  const lot = db.prepare('SELECT id, quantity, quantity_remaining FROM inventory_ledger WHERE id = ?').get(item.inventory_ledger_id) as
    { id: number; quantity: number; quantity_remaining: number } | undefined;
  if (!lot) return { applied: true, changed: false }; // already gone
  const newQty = Math.max(0, lot.quantity - item.quantity);
  if (newQty === 0) {
    db.prepare('DELETE FROM inventory_ledger WHERE id = ?').run(lot.id);
  } else {
    db.prepare('UPDATE inventory_ledger SET quantity = ?, quantity_remaining = MAX(0, quantity_remaining - ?) WHERE id = ?')
      .run(newQty, item.quantity, lot.id);
  }
  return { applied: true, changed: true };
}
