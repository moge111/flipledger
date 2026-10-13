/**
 * Pairs Amazon Multi-Channel Fulfillment (MCF) shipments with the
 * Walmart/eBay/PayPal sale they fulfilled.
 *
 * An MCF shipment is Amazon shipping a unit out of FBA stock for a sale made
 * elsewhere. It arrives as a $0 Amazon ShipmentEvent (MarketplaceName
 * "Non-Amazon US"), and FIFO used to cost it on top of the sale's own COGS:
 * one unit, two costs ($161.16 over 4 LEGO orders in 2026, review A4).
 *
 * A paired MCF line gets no COGS. An unpaired one keeps its COGS (the
 * conservative choice: it may have fulfilled a sale FlipLedger never saw) and
 * is logged, so a double cost can only survive while it is visible.
 *
 * Pairing, strictest first:
 *   1. exact: the MCF SellerOrderId equals the sale's order id or its Walmart
 *      Customer Order #;
 *   2. product+date: exactly one unpaired non-Amazon sale, bought 0-7 days
 *      before the MCF shipment posted, whose product name shares the model
 *      number or most of its words. Two equally good candidates → no pair.
 */
import Database from 'better-sqlite3';
import { createLogger } from '../log';

const log = createLogger('sp-api/mcf');

const STOP = new Set(['the', 'and', 'for', 'with', 'kids', 'girls', 'boys', 'ages', 'gift', 'idea', 'ideas', 'set', 'toy', 'toys', 'new']);

export function productTokens(name: string | null): Set<string> {
  return new Set((name || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t)));
}

/** 1 when the names share a model number (4+ digits), else word overlap (Jaccard). */
export function productSimilarity(a: string | null, b: string | null): number {
  const ta = productTokens(a), tb = productTokens(b);
  if (!ta.size || !tb.size) return 0;
  for (const t of ta) if (/^\d{4,}$/.test(t) && tb.has(t)) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const MIN_SIMILARITY = 0.5;

interface McfOrder { orderId: string; posted: string; sellerOrderId: string | null; name: string | null }
interface Sale { orderId: string; purchaseDate: string; customerOrderId: string | null; name: string | null }

const nameOf = `COALESCE(
  (SELECT p.name FROM products p WHERE p.asin = oi.asin AND p.name IS NOT NULL LIMIT 1),
  (SELECT p.name FROM products p WHERE p.sku = oi.sku AND p.name IS NOT NULL LIMIT 1),
  (SELECT li.product_name FROM live_inventory li WHERE li.sku = oi.sku AND li.product_name <> '' LIMIT 1))`;

export function pairMcfOrders(db: Database.Database): { paired: number; unpaired: string[] } {
  const mcf = db.prepare(`
    SELECT o.order_id AS orderId, MIN(fe.posted_date) AS posted,
      json_extract(MIN(fe.raw_data), '$.SellerOrderId') AS sellerOrderId,
      (SELECT ${nameOf} FROM order_items oi WHERE oi.order_id = o.order_id LIMIT 1) AS name
    FROM orders o JOIN financial_events fe ON fe.order_id = o.order_id AND fe.event_type = 'ShipmentEvent'
    WHERE o.fulfillment_channel = 'MCF'
      AND NOT EXISTS (SELECT 1 FROM mcf_fulfillments m WHERE m.mcf_order_id = o.order_id)
    GROUP BY o.order_id ORDER BY posted
  `).all() as McfOrder[];
  if (!mcf.length) return { paired: 0, unpaired: [] };

  const sales = db.prepare(`
    SELECT o.order_id AS orderId, o.purchase_date AS purchaseDate,
      (SELECT json_extract(fe.raw_data, '$."Customer Order #"') FROM financial_events fe
        WHERE fe.order_id = o.order_id AND json_extract(fe.raw_data, '$."Customer Order #"') IS NOT NULL LIMIT 1) AS customerOrderId,
      (SELECT ${nameOf} FROM order_items oi WHERE oi.order_id = o.order_id LIMIT 1) AS name
    FROM orders o
    WHERE o.marketplace != 'amazon' AND o.fulfillment_channel IN ('Seller', 'MFN')
      AND o.status NOT IN ('Cancelled', 'Canceled')
      AND NOT EXISTS (SELECT 1 FROM mcf_fulfillments m WHERE m.sale_order_id = o.order_id)
  `).all() as Sale[];

  const insert = db.prepare(`INSERT INTO mcf_fulfillments (mcf_order_id, sale_order_id, method) VALUES (?, ?, ?)`);
  const taken = new Set<string>();
  const unpaired: string[] = [];
  let paired = 0;

  db.transaction(() => {
    for (const m of mcf) {
      let match: Sale | undefined;
      let method = 'exact';
      if (m.sellerOrderId) {
        match = sales.find(s => !taken.has(s.orderId) && (s.orderId === m.sellerOrderId || s.customerOrderId === m.sellerOrderId));
      }
      if (!match) {
        method = 'product+date';
        const posted = new Date(m.posted).getTime();
        const scored = sales
          .filter(s => !taken.has(s.orderId))
          .map(s => ({ s, age: (posted - new Date(s.purchaseDate).getTime()) / 86400000, sim: productSimilarity(m.name, s.name) }))
          .filter(x => x.age >= 0 && x.age <= 7 && x.sim >= MIN_SIMILARITY)
          .sort((a, b) => b.sim - a.sim || a.age - b.age);
        // Only a clear winner: a tie on similarity AND timing is ambiguous.
        if (scored.length === 1 || (scored.length > 1 && (scored[0].sim > scored[1].sim || scored[0].age < scored[1].age))) {
          match = scored[0].s;
        }
      }
      if (match) {
        insert.run(m.orderId, match.orderId, method);
        taken.add(match.orderId);
        paired++;
      } else {
        unpaired.push(m.orderId);
      }
    }
  })();

  if (unpaired.length) {
    log.warn(`${unpaired.length} MCF shipment(s) not paired with a sale; they keep their COGS and may double-count it: ${unpaired.join(', ')}`);
  }
  return { paired, unpaired };
}
