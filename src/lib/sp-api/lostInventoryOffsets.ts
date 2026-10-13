/**
 * Cost offsets for Amazon inventory lost or damaged BEFORE it sold.
 *
 * A pre-order loss reimbursement is income, but the lost unit never went
 * through FIFO (only a sale releases cost), so its cost has to be expensed
 * separately (CLAUDE.md, June 17 2026 rule). Until Sept 2026 that was done by
 * hand as `expenses` rows; none were added after Jun 19, so later losses were
 * booked as pure income (review A3).
 *
 * This rebuilds, on every sync, one expense row per qualifying reimbursement:
 *   - Amazon, canonical numeric id, reason Lost/Damaged_Warehouse or
 *     Lost/Damaged_Inbound, positive amount, dated after the last manual
 *     offset (AUTO_OFFSET_FROM);
 *   - no Amazon order id, and no replacement order for the product in the 60
 *     days before (post-order cases already carry their COGS on the orders);
 *   - units net of any Reimbursement_Reversal that names it (the unit was
 *     found) and of units recorded in lost_inventory_arrived (they arrived
 *     after all), valued at the latest lot cost for the SKU (ASIN fallback).
 * Rows are identified by the "[auto] reimbursement <id>" description and fully
 * replaced each run. The hand-entered rows before AUTO_OFFSET_FROM are never
 * touched. Reimbursements with no cost on file are skipped and logged.
 */
import Database from 'better-sqlite3';
import { createLogger } from '../log';

const log = createLogger('sp-api/lostInventoryOffsets');

export const AUTO_OFFSET_FROM = '2026-06-20';
export const AUTO_OFFSET_PREFIX = '[auto] reimbursement ';
const CATEGORY = 'Lost Inventory (Amazon)';
const PRE_ORDER_LOSS_REASONS = ['Lost_Warehouse', 'Damaged_Warehouse', 'Lost_Inbound', 'Damaged_Inbound'];

interface Loss { reimbursementId: string; baseId: string; date: string; asin: string | null; sku: string | null; reason: string; quantity: number }

export function rebuildLostInventoryOffsets(db: Database.Database): { offsets: number; totalCents: number; skippedNoCost: string[] } {
  const losses = db.prepare(`
    SELECT r.reimbursement_id AS reimbursementId, CASE WHEN instr(r.reimbursement_id, ':') > 0 THEN substr(r.reimbursement_id, 1, instr(r.reimbursement_id, ':') - 1) ELSE r.reimbursement_id END AS baseId,
           r.reimbursement_date AS date, r.asin, r.sku, r.reason,
           COALESCE(r.quantity, 1) AS quantity
    FROM reimbursements r
    WHERE r.marketplace = 'amazon'
      AND r.reimbursement_id GLOB '[0-9]*'
      AND r.reason IN (${PRE_ORDER_LOSS_REASONS.map(() => '?').join(',')})
      AND r.amount > 0
      AND date(r.reimbursement_date) >= date(?)
      AND COALESCE(r.amazon_order_id, '') = ''
      -- A unit damaged in shipping and replaced: the replacement order carries
      -- the new unit's COGS and the damaged unit's cost is on the original
      -- sale, so the reimbursement needs no offset. Not when a unit of that
      -- pair came back sellable: FIFO then credits that unit's COGS back, so
      -- the replacement no longer covers anything (Lego Porsche: a sellable
      -- unit was damaged in the FC on Aug 25 and this rule hid its cost until
      -- Oct 11 2026, balanced only by the replacement being costed twice).
      AND NOT EXISTS (
        SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.is_replacement = 1
          AND (oi.sku IN (r.sku, r.asin) OR oi.asin IN (r.sku, r.asin))
          AND julianday(r.reimbursement_date) - julianday(o.purchase_date) BETWEEN 0 AND 60
          AND NOT EXISTS (
            SELECT 1 FROM fba_customer_returns u
            WHERE u.disposition = 'SELLABLE' AND u.order_id IN (o.order_id, o.replaced_order_id)
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.category LIKE 'Lost Inventory%' AND e.description NOT LIKE '[auto]%'
          AND e.description LIKE '%' || CASE WHEN instr(r.reimbursement_id, ':') > 0 THEN substr(r.reimbursement_id, 1, instr(r.reimbursement_id, ':') - 1) ELSE r.reimbursement_id END || '%'
      )
    ORDER BY r.reimbursement_date
  `).all(...PRE_ORDER_LOSS_REASONS, AUTO_OFFSET_FROM) as Loss[];

  // Units Amazon took back by reversing this reimbursement (it found them).
  // A multi-line reimbursement's reversal names the bare id; its SKU picks the line.
  const reversedUnits = db.prepare(`
    SELECT COALESCE(SUM(ABS(COALESCE(quantity, 1))), 0) AS units FROM reimbursements
    WHERE marketplace = 'amazon' AND reason = 'Reimbursement_Reversal' AND original_reimbursement_id = ?
      AND (sku = ? OR sku IS NULL OR ? IS NULL)
  `);
  // Units recorded by hand as having arrived after all (Sept 2026: two Royale
  // High units left out of batch 21, shipped in batch 22, reimbursed as lost).
  const arrivedUnits = db.prepare(`SELECT COALESCE(SUM(units), 0) AS units FROM lost_inventory_arrived WHERE reimbursement_id = ?`);
  const latestCost = db.prepare(`
    SELECT buy_price FROM inventory_ledger
    WHERE (sku = ? AND ? IS NOT NULL) OR (asin = ? AND ? IS NOT NULL)
    ORDER BY (sku = ?) DESC, date_purchased DESC, id DESC LIMIT 1
  `);

  const rows: { date: string; amount: number; description: string }[] = [];
  const skippedNoCost: string[] = [];
  for (const l of losses) {
    const units = l.quantity
      - (reversedUnits.get(l.baseId, l.sku, l.sku) as { units: number }).units
      - (arrivedUnits.get(l.reimbursementId) as { units: number }).units;
    if (units <= 0) continue;
    const cost = latestCost.get(l.sku, l.sku, l.asin, l.asin, l.sku) as { buy_price: number } | undefined;
    if (!cost || cost.buy_price <= 0) { skippedNoCost.push(l.reimbursementId); continue; }
    rows.push({
      date: l.date.slice(0, 10),
      amount: units * cost.buy_price,
      description: `${AUTO_OFFSET_PREFIX}${l.reimbursementId} ${l.reason}: ${units} × ${l.sku || l.asin} @ $${(cost.buy_price / 100).toFixed(2)}`,
    });
  }

  const totalCents = db.transaction(() => {
    db.prepare(`DELETE FROM expenses WHERE category = ? AND description LIKE ?`).run(CATEGORY, `${AUTO_OFFSET_PREFIX}%`);
    const ins = db.prepare(`
      INSERT INTO expenses (date, category, amount, description, recurring, created_at)
      VALUES (?, ?, ?, ?, 'one-time', datetime('now'))
    `);
    let total = 0;
    for (const r of rows) { ins.run(r.date, CATEGORY, r.amount, r.description); total += r.amount; }
    return total;
  })();

  if (skippedNoCost.length) {
    log.warn(`No cost on file for lost-inventory reimbursement(s) ${skippedNoCost.join(', ')}; add a lot under Products & COGS so the loss is expensed.`);
  }
  return { offsets: rows.length, totalCents, skippedNoCost };
}
