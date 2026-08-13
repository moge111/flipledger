/**
 * FIFO (First In, First Out) COGS calculator.
 *
 * Walks through inventory purchases (oldest first) and allocates them to sales
 * (oldest first) to determine the cost of goods sold per unit.
 *
 * Can recalculate a single SKU/ASIN (after editing a buy price) or all items.
 */
import Database from 'better-sqlite3';
import path from 'path';

interface InventoryBatch {
  id: number;
  sku: string;
  asin: string;
  buyPrice: number; // cents
  quantity: number;
  quantityRemaining: number;
  datePurchased: string;
}

interface SaleItem {
  id: number;
  orderId: string;
  sku: string;
  asin: string;
  quantity: number;
  purchaseDate: string;
  currentCogs: number;
  isReturned: number; // 1 if the full quantity was returned to inventory
  refundDate: string | null; // earliest qualifying return refund date
  recognitionDate: string; // cash-basis sale date (MIN ShipmentEvent, fallback purchase_date)
  marketplace: string;
}

interface FIFOResult {
  itemsUpdated: number;
  batchesUpdated: number;
  skusProcessed: number;
  errors: string[];
}

function getDb(readonly = false) {
  const dbPath = process.env.FLIPLEDGER_DB_PATH || path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Recalculate FIFO COGS for a specific SKU, ASIN, or all items.
 *
 * @param sku - Recalculate only this SKU (optional)
 * @param asin - Recalculate only this ASIN (optional, used if no SKU match)
 * @param recalcAll - If true, recalculate everything (ignores sku/asin params)
 */
export function recalculateFIFO(options: {
  sku?: string;
  asin?: string;
  recalcAll?: boolean;
} = {}): FIFOResult {
  const { sku, asin, recalcAll } = options;
  const db = getDb();

  const result: FIFOResult = {
    itemsUpdated: 0,
    batchesUpdated: 0,
    skusProcessed: 0,
    errors: [],
  };

  try {
    // Determine which SKUs to process
    let skusToProcess: { sku: string; asin: string }[] = [];

    if (recalcAll) {
      // Get all unique SKUs from inventory_ledger
      skusToProcess = db.prepare(`
        SELECT DISTINCT sku, asin FROM inventory_ledger
        WHERE buy_price > 0
        ORDER BY sku
      `).all() as any[];
    } else if (sku) {
      // Single SKU
      const entry = db.prepare('SELECT sku, asin FROM inventory_ledger WHERE sku = ? LIMIT 1').get(sku) as any;
      if (entry) {
        skusToProcess = [{ sku: entry.sku, asin: entry.asin }];
      } else {
        result.errors.push(`No inventory_ledger entry for SKU: ${sku}`);
        db.close();
        return result;
      }
    } else if (asin) {
      // All SKUs for this ASIN
      skusToProcess = db.prepare(`
        SELECT DISTINCT sku, asin FROM inventory_ledger WHERE asin = ? AND buy_price > 0
      `).all(asin) as any[];
      if (skusToProcess.length === 0) {
        result.errors.push(`No inventory_ledger entries for ASIN: ${asin}`);
        db.close();
        return result;
      }
    } else {
      result.errors.push('Must specify sku, asin, or recalcAll');
      db.close();
      return result;
    }

    // Prepared statements
    const getBatches = db.prepare(`
      SELECT id, sku, asin, buy_price as buyPrice, quantity, quantity_remaining as quantityRemaining, date_purchased as datePurchased
      FROM inventory_ledger
      WHERE sku = ? AND buy_price > 0
      ORDER BY date_purchased ASC, id ASC
    `);

    // An order_item counts as "returned" when there's a refund for the same
    // order + product with item_returned = 1 covering the full quantity. A
    // returned unit re-enters sellable inventory (FBA sellable disposition,
    // or an MFN customer return shipped back to the seller), so its COGS
    // belongs to the eventual resale — not this refunded sale.
    //
    // Marketplace timing: Amazon/eBay refunds settle immediately, so the
    // refund row is enough. WALMART refunds are multi-stage (return initiated
    // → Walmart refunds customer → Walmart deducts seller in recon 1-3 weeks
    // later). item_returned=1 is set at initiation, but the refund/revenue
    // reversal is only recognized once it SETTLES (a WalmartRefundEvent
    // Product Price row exists — same gate the P&L/Dashboard use). Zeroing
    // COGS before settlement, while revenue is still fully counted, makes a
    // returned order show phantom profit. So for Walmart, only treat as
    // returned once the refund has settled — keeping COGS and refund
    // recognition in lockstep.
    const RETURNED_MATCH = `
      FROM refunds r
      WHERE r.order_id = oi.order_id
        AND r.item_returned = 1
        AND r.quantity >= oi.quantity
        AND (r.sku = oi.sku OR r.asin = oi.asin OR r.sku = oi.asin)
        AND (
          r.marketplace != 'walmart'
          OR EXISTS (
            SELECT 1 FROM financial_events fe
            WHERE fe.event_type = 'WalmartRefundEvent'
              AND fe.order_id = r.order_id
              AND json_extract(fe.raw_data, '$."Amount Type"') = 'Product Price'
          )
        )
    `;
    const RETURNED_FLAG = `EXISTS (SELECT 1 ${RETURNED_MATCH}) as isReturned`;
    // Extra columns for period-aware return handling: when the refund lands in
    // a DIFFERENT calendar year than the sale's cash-basis recognition date,
    // zeroing the sale's COGS would rewrite an already-filed year. Those sales
    // keep their COGS and get a cogs_reversals credit dated at the refund.
    const RETURN_PERIOD_COLS = `
      (SELECT MIN(r.refund_date) ${RETURNED_MATCH}) as refundDate,
      COALESCE(
        (SELECT MIN(fe2.posted_date) FROM financial_events fe2
         WHERE fe2.event_type = 'ShipmentEvent' AND fe2.order_id = oi.order_id),
        o.purchase_date
      ) as recognitionDate,
      o.marketplace
    `;

    // Get sales for a SKU — match by sku first (primary), then by asin (fallback)
    const getSalesBySku = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs,
        ${RETURNED_FLAG}, ${RETURN_PERIOD_COLS}
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.sku = ?
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    const getSalesByAsin = db.prepare(`
      SELECT oi.id, oi.order_id as orderId, oi.sku, oi.asin, oi.quantity, o.purchase_date as purchaseDate, oi.cogs_per_unit as currentCogs,
        ${RETURNED_FLAG}, ${RETURN_PERIOD_COLS}
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.order_id
      WHERE oi.asin = ? AND (oi.sku IS NULL OR oi.sku = '' OR oi.sku NOT IN (SELECT DISTINCT sku FROM inventory_ledger WHERE buy_price > 0))
      ORDER BY o.purchase_date ASC, oi.id ASC
    `);

    const updateCogs = db.prepare('UPDATE order_items SET cogs_per_unit = ? WHERE id = ?');
    const updateBatchRemaining = db.prepare('UPDATE inventory_ledger SET quantity_remaining = ? WHERE id = ?');
    const upsertReversal = db.prepare(`
      INSERT INTO cogs_reversals (order_item_id, order_id, sku, asin, quantity, amount, refund_date, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_item_id) DO UPDATE SET
        quantity = excluded.quantity,
        amount = excluded.amount,
        refund_date = excluded.refund_date,
        marketplace = excluded.marketplace
    `);
    const deleteReversal = db.prepare('DELETE FROM cogs_reversals WHERE order_item_id = ?');
    const nowIso = new Date().toISOString();

    // Process all SKUs in a single transaction
    const processAll = db.transaction(() => {
      // Reversals whose order_item no longer exists (e.g. cancelled-order
      // reversal deleted the item) are orphans — purge on full recalcs.
      if (recalcAll) {
        db.prepare('DELETE FROM cogs_reversals WHERE order_item_id NOT IN (SELECT id FROM order_items)').run();
      }
      for (const item of skusToProcess) {
        const batches = getBatches.all(item.sku) as InventoryBatch[];
        if (batches.length === 0) continue;

        // Get sales — by SKU primarily
        let sales = getSalesBySku.all(item.sku) as SaleItem[];

        // Also get sales matched by ASIN that don't have their own SKU inventory entry
        const asinSales = getSalesByAsin.all(item.asin) as SaleItem[];
        sales = [...sales, ...asinSales];

        // Sort by purchase_date
        sales.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.id - b.id);

        if (sales.length === 0) {
          // No sales — reset all batches to full quantity
          for (const batch of batches) {
            updateBatchRemaining.run(batch.quantity, batch.id);
            result.batchesUpdated++;
          }
          result.skusProcessed++;
          continue;
        }

        // Reset batch quantities to full before recalculating
        const batchState = batches.map(b => ({
          ...b,
          remaining: b.quantity,
        }));

        // Walk through sales, consuming from earliest batches
        for (const sale of sales) {
          // Period scope of a return: same calendar year as the sale's cash-
          // basis recognition date → zero COGS at the sale (annual totals are
          // identical either way). DIFFERENT year → the sale keeps its COGS
          // (the sale year may be filed) and the relief is booked as a
          // cogs_reversals row dated at the refund.
          const crossYearReturn = Boolean(
            sale.isReturned &&
            sale.refundDate &&
            sale.recognitionDate &&
            sale.refundDate.slice(0, 4) !== sale.recognitionDate.slice(0, 4)
          );

          // Same-year returned sale: the physical unit came back to sellable
          // inventory, so it doesn't permanently consume a batch and carries
          // no COGS — the cost flows to whatever sale consumes that unit next.
          if (sale.isReturned && !crossYearReturn) {
            deleteReversal.run(sale.id);
            if (sale.currentCogs !== 0) {
              updateCogs.run(0, sale.id);
              result.itemsUpdated++;
            }
            continue;
          }

          let unitsNeeded = sale.quantity;
          let totalCost = 0;
          let batchIdx = 0;
          const consumed: { idx: number; units: number }[] = [];

          while (unitsNeeded > 0 && batchIdx < batchState.length) {
            const batch = batchState[batchIdx];
            if (batch.remaining <= 0) {
              batchIdx++;
              continue;
            }

            const unitsFromBatch = Math.min(unitsNeeded, batch.remaining);
            totalCost += unitsFromBatch * batch.buyPrice;
            consumed.push({ idx: batchIdx, units: unitsFromBatch });
            batch.remaining -= unitsFromBatch;
            unitsNeeded -= unitsFromBatch;

            if (batch.remaining <= 0) batchIdx++;
          }

          // Fallback for units not covered by a recorded lot: when more units
          // sold than the recorded quantity, the lot is "depleted" — but the
          // extra units of the same product cost ~the same, so cost them at the
          // most-recent lot's buy price instead of $0. This keeps COGS accurate
          // and prevents the "depleted lot" / $0-COGS state on any SKU that has
          // a real cost basis recorded.
          if (unitsNeeded > 0) {
            const fallbackPrice = batchState[batchState.length - 1].buyPrice;
            totalCost += unitsNeeded * fallbackPrice;
            unitsNeeded = 0;
          }

          // Weighted average COGS per unit across all units in this sale.
          const cogsPerUnit = sale.quantity > 0 ? Math.round(totalCost / sale.quantity) : 0;

          // Only update if changed
          if (cogsPerUnit !== sale.currentCogs) {
            updateCogs.run(cogsPerUnit, sale.id);
            result.itemsUpdated++;
          }

          if (crossYearReturn) {
            // Book the relief in the refund's year. Amount mirrors exactly
            // what the sale carries (cogs_per_unit × qty) so the two periods
            // net to zero across years, to the cent.
            upsertReversal.run(
              sale.id, sale.orderId, sale.sku, sale.asin, sale.quantity,
              cogsPerUnit * sale.quantity, sale.refundDate, sale.marketplace || 'amazon', nowIso
            );
            // The returned unit re-entered sellable inventory — un-consume it
            // so later sales draw from the same stock (matches the same-year
            // path's skip-consumption behavior).
            for (const c of consumed) batchState[c.idx].remaining += c.units;
          } else {
            deleteReversal.run(sale.id);
          }
        }

        // Update batch remaining quantities
        for (let i = 0; i < batchState.length; i++) {
          if (batchState[i].remaining !== batches[i].quantityRemaining) {
            updateBatchRemaining.run(batchState[i].remaining, batches[i].id);
            result.batchesUpdated++;
          }
        }

        result.skusProcessed++;
      }
    });

    processAll();
    db.close();
    return result;
  } catch (err) {
    db.close();
    result.errors.push(String(err));
    return result;
  }
}
