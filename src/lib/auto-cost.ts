/**
 * Fill in missing buy costs so a sale never books $0 COGS for want of a lot.
 *
 * Runs at the start of every full FIFO recalculation, for SKUs that have
 * sales or live stock but no inventory_ledger lot (by SKU or ASIN):
 *
 *  1. Same product: copy the most recent costed lot of another SKU whose
 *     product name is exactly the same (ignoring case and surrounding spaces).
 *     eBay gives every listing its own custom label, so a second Pokémon
 *     Center ETB sold as LOCAL-ITEM_168 with no cost while LOCAL-ITEM_169 had
 *     $125.
 *  2. SKU price: read the trailing price the MSKU generator writes into the
 *     SKU (`wm-mahjong-49.70` → $49.70; an optional `-mfn` follows it). The
 *     prefix names the supplier (`wm` → Walmart).
 *
 * Both write one lot tagged in `notes` with AUTO_COST_NOTE; the Products page
 * flags it and saving the cost there confirms it (clears the tag). Quantity =
 * units sold + current marketplace stock, so no phantom stock is created.
 */
import type Database from 'better-sqlite3';
import { createLogger } from './log';
import { supplierFromAbbreviation } from './listing-msku';
import { resolveSupplierId } from './suppliers';
import { marketToday } from './market-day';

const log = createLogger('auto-cost');

export const AUTO_COST_NOTE = '[auto-cost]';

/** Names this short are too generic to match on. */
const MIN_NAME_LENGTH = 12;
/** SKU prefixes that are counters, not suppliers (SKU-NEW-070, LOCAL-ITEM_171). */
const NON_SUPPLIER_PREFIXES = new Set(['sku', 'local']);
const SKU_COST = /^([a-z0-9]{2,6})-.+-(\d+(?:\.\d{1,2})?)(?:-mfn)?$/i;

export interface AutoCostLot {
  sku: string;
  method: 'same-product' | 'sku-price';
  from: string;
  buyPrice: number;
}

/** Cost and supplier prefix encoded in a generated SKU, or null. */
export function costFromSku(sku: string): { cents: number; prefix: string } | null {
  const m = sku.match(SKU_COST);
  if (!m) return null;
  const [, prefix, num] = m;
  if (NON_SUPPLIER_PREFIXES.has(prefix.toLowerCase())) return null;
  if (/^0\d/.test(num)) return null; // "070" is a counter, not $70
  const cents = Math.round(Number(num) * 100);
  if (!(cents > 0 && cents < 500000)) return null;
  return { cents, prefix };
}

interface Uncosted { sku: string; asin: string | null; sold: number; stock: number; name: string | null; firstSale: string | null }

function findUncosted(db: Database.Database): Uncosted[] {
  return db.prepare(`
    WITH sold AS (
      SELECT oi.sku, MIN(oi.asin) AS asin, SUM(oi.quantity) AS units, MIN(o.purchase_date) AS first_sale
      FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
      WHERE oi.sku IS NOT NULL AND oi.sku != ''
      GROUP BY oi.sku
    ),
    stock AS (
      SELECT sku, MIN(asin) AS asin, SUM(total_qty) AS units
      FROM live_inventory WHERE total_qty > 0 AND sku IS NOT NULL AND sku != ''
      GROUP BY sku
    ),
    skus AS (SELECT sku FROM sold UNION SELECT sku FROM stock)
    SELECT k.sku, COALESCE(s.asin, st.asin) AS asin,
           COALESCE(s.units, 0) AS sold, COALESCE(st.units, 0) AS stock, s.first_sale AS firstSale,
           LOWER(TRIM(COALESCE(
             (SELECT p.name FROM products p WHERE p.sku = k.sku LIMIT 1),
             (SELECT p.name FROM products p WHERE p.asin = COALESCE(s.asin, st.asin) LIMIT 1)
           ))) AS name
    FROM skus k
    LEFT JOIN sold s ON s.sku = k.sku
    LEFT JOIN stock st ON st.sku = k.sku
    WHERE NOT EXISTS (SELECT 1 FROM inventory_ledger il WHERE il.sku = k.sku)
      AND NOT EXISTS (SELECT 1 FROM inventory_ledger il
                      WHERE COALESCE(s.asin, st.asin, '') != '' AND il.asin = COALESCE(s.asin, st.asin))
  `).all() as Uncosted[];
}

export function autoCostMissingLots(db: Database.Database, now = new Date().toISOString()): AutoCostLot[] {
  const findSameProduct = db.prepare(`
    SELECT il.sku, il.buy_price, il.supplier_id, il.date_purchased
    FROM inventory_ledger il
    WHERE il.buy_price > 0 AND COALESCE(il.intentional_zero_cogs, 0) = 0
      AND il.sku IS NOT NULL AND il.sku != ?
      AND LOWER(TRIM(COALESCE(
        (SELECT p.name FROM products p WHERE p.sku = il.sku LIMIT 1),
        (SELECT p.name FROM products p WHERE p.asin = il.asin LIMIT 1)
      ))) = ?
    ORDER BY il.id DESC
    LIMIT 1
  `);
  const insertLot = db.prepare(`
    INSERT INTO inventory_ledger (asin, sku, buy_price, quantity, quantity_remaining, supplier_id, date_purchased, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const created: AutoCostLot[] = [];
  for (const u of findUncosted(db)) {
    const qty = u.sold + u.stock;
    if (qty <= 0) continue;

    if (u.name && u.name.length >= MIN_NAME_LENGTH) {
      const src = findSameProduct.get(u.sku, u.name) as
        { sku: string; buy_price: number; supplier_id: number | null; date_purchased: string } | undefined;
      if (src) {
        insertLot.run(u.asin || u.sku, u.sku, src.buy_price, qty, qty, src.supplier_id, src.date_purchased,
          `${AUTO_COST_NOTE} copied from ${src.sku} (same product name). Edit to confirm.`, now);
        created.push({ sku: u.sku, method: 'same-product', from: src.sku, buyPrice: src.buy_price });
        continue;
      }
    }

    const fromSku = costFromSku(u.sku);
    if (fromSku) {
      const supplier = supplierFromAbbreviation(fromSku.prefix);
      const supplierId = supplier ? resolveSupplierId(db, supplier, now) : null;
      const dollars = (fromSku.cents / 100).toFixed(2);
      insertLot.run(u.asin || u.sku, u.sku, fromSku.cents, qty, qty, supplierId,
        (u.firstSale ?? marketToday()).slice(0, 10),
        `${AUTO_COST_NOTE} $${dollars} read from the SKU. Edit to confirm.`, now);
      created.push({ sku: u.sku, method: 'sku-price', from: u.sku, buyPrice: fromSku.cents });
    }
  }
  if (created.length) {
    log.info(`Filled ${created.length} missing cost(s): ${created.map(c => `${c.sku} $${(c.buyPrice / 100).toFixed(2)} (${c.method === 'same-product' ? `from ${c.from}` : 'SKU price'})`).join(', ')}`);
  }
  return created;
}
