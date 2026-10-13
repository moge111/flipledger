/**
 * Shared DB plumbing for WFS (Walmart) listing batches. The Walmart calls live
 * in src/lib/walmart-api/wfsInbound.ts; this file only reads and writes
 * FlipLedger's own tables.
 */
import Database from 'better-sqlite3';
import type { Address, CreatedShipment, ParcelQuote, WfsBox } from '@/lib/walmart-api/wfsInbound';

export interface WfsBatchRow {
  id: number;
  name: string;
  status: string;
  channel: string;
  inbound_order_id: string | null;
  is_holding: number | null;
  ship_from_name: string | null;
  ship_from_address_line1: string | null;
  ship_from_city: string | null;
  ship_from_state: string | null;
  ship_from_postal_code: string | null;
  ship_from_country_code: string | null;
  ship_from_phone: string | null;
}

export type WfsBatchLookup = { ok: true; batch: WfsBatchRow } | { ok: false; status: number; error: string };

export const WALMART_CHANNELS = ['WFS', 'WMT_SF'] as const;
export type WalmartChannel = typeof WALMART_CHANNELS[number];

/** A Walmart batch; by default only WFS (shipment routes). Pass both channels for item routes. */
export function loadWfsBatch(db: Database.Database, batchId: number, allow: readonly WalmartChannel[] = ['WFS']): WfsBatchLookup {
  const batch = db.prepare(`
    SELECT id, name, status, channel, inbound_order_id, is_holding, ship_from_name, ship_from_address_line1, ship_from_city,
           ship_from_state, ship_from_postal_code, ship_from_country_code, ship_from_phone
    FROM listing_batches WHERE id = ?
  `).get(batchId) as WfsBatchRow | undefined;
  if (!batch) return { ok: false, status: 404, error: 'Batch not found' };
  if (!(allow as readonly string[]).includes(batch.channel)) {
    return { ok: false, status: 400, error: allow.length === 1 && allow[0] === 'WFS' ? 'This is not a WFS batch.' : 'This is not a Walmart batch.' };
  }
  return { ok: true, batch };
}

export const HOLDING_BATCH_NAME = 'Walmart stock to send';

/** The standing "Walmart stock to send" batch (a draft WFS batch never sent itself); created on first use. */
export function getOrCreateHoldingBatch(db: Database.Database): number {
  const row = db.prepare("SELECT id FROM listing_batches WHERE is_holding = 1 AND channel = 'WFS' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (row) return row.id;
  const now = new Date().toISOString();
  const res = db.prepare(`
    INSERT INTO listing_batches (name, status, channel, marketplace, is_holding, created_at, updated_at)
    VALUES (?, 'draft', 'WFS', 'walmart', 1, ?, ?)
  `).run(HOLDING_BATCH_NAME, now, now);
  return Number(res.lastInsertRowid);
}

export interface HoldingItem {
  id: number; sku: string; productName: string | null; imageUrl: string | null; walmartItemId: string | null;
  quantity: number; buyPriceCents: number; walmartSetupStatus: string | null;
}

/** Units waiting in "Walmart stock to send". */
export function holdingItems(db: Database.Database): HoldingItem[] {
  return db.prepare(`
    SELECT i.id, i.sku, i.product_name AS productName, i.image_url AS imageUrl, i.walmart_item_id AS walmartItemId,
           i.quantity, i.buy_price_cents AS buyPriceCents, i.walmart_setup_status AS walmartSetupStatus
    FROM listing_batch_items i JOIN listing_batches b ON b.id = i.batch_id
    WHERE b.is_holding = 1 AND i.quantity > 0
    ORDER BY i.id
  `).all() as HoldingItem[];
}

/** The batch's ship-from address, or a message naming what is missing. */
export function batchShipFrom(batch: WfsBatchRow): { ok: true; address: Address & { name: string; phone: string } } | { ok: false; error: string } {
  const address = {
    name: (batch.ship_from_name ?? '').trim(),
    phone: (batch.ship_from_phone ?? '').trim(),
    addressLine1: (batch.ship_from_address_line1 ?? '').trim(),
    city: (batch.ship_from_city ?? '').trim(),
    stateCode: (batch.ship_from_state ?? '').trim(),
    postalCode: (batch.ship_from_postal_code ?? '').trim(),
    countryCode: (batch.ship_from_country_code ?? 'US').trim() || 'US',
  };
  const missing = (['addressLine1', 'city', 'stateCode', 'postalCode'] as const).filter(k => !address[k]);
  if (missing.length) return { ok: false, error: `The batch's ship-from address is incomplete (${missing.join(', ')}). Fill it in under Settings → Ship-From Address.` };
  return { ok: true, address };
}

export interface WfsShipmentRow {
  id: number;
  batch_id: number;
  inbound_order_id: string;
  shipment_id: string;
  fc_name: string | null;
  ship_to: string | null;
  items: string | null;
  expected_delivery_date: string | null;
  boxes: string | null;
  quotes: string | null;
  quoted_at: string | null;
  booked_quote_id: string | null;
  booked_charge_cents: number | null;
  booked_at: string | null;
  carrier_name: string | null;
  tracking: string | null;
  tracking_sent_at: string | null;
  status: string;
  error: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export function shipmentView(row: WfsShipmentRow, walmartStatus: string | null) {
  return {
    id: row.id,
    shipmentId: row.shipment_id,
    inboundOrderId: row.inbound_order_id,
    fcName: row.fc_name,
    shipTo: parse<(Address & { fcName?: string }) | null>(row.ship_to, null),
    items: parse<{ sku: string; quantity: number }[]>(row.items, []),
    expectedDeliveryDate: row.expected_delivery_date,
    boxes: parse<WfsBox[]>(row.boxes, []),
    quotes: parse<ParcelQuote[]>(row.quotes, []),
    quotedAt: row.quoted_at,
    bookedQuoteId: row.booked_quote_id,
    bookedChargeCents: row.booked_charge_cents,
    bookedAt: row.booked_at,
    carrierName: row.carrier_name,
    tracking: parse<string[]>(row.tracking, []),
    trackingSentAt: row.tracking_sent_at,
    status: row.status,
    error: row.error,
    walmartStatus,
  };
}

export function loadShipment(db: Database.Database, batchId: number, shipmentId: string): WfsShipmentRow | undefined {
  return db.prepare('SELECT * FROM wfs_batch_shipments WHERE batch_id = ? AND shipment_id = ?').get(batchId, shipmentId) as WfsShipmentRow | undefined;
}

export function updateShipment(db: Database.Database, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE wfs_batch_shipments SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k] as any), new Date().toISOString(), id);
}

export function insertShipments(db: Database.Database, batchId: number, inboundOrderId: string, shipments: CreatedShipment[], now: string) {
  const ins = db.prepare(`
    INSERT INTO wfs_batch_shipments (batch_id, inbound_order_id, shipment_id, fc_name, ship_to, items, expected_delivery_date, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)
  `);
  for (const s of shipments) {
    ins.run(batchId, inboundOrderId, s.shipmentId, s.shipTo.fcName ?? null, JSON.stringify(s.shipTo), JSON.stringify(s.items), s.expectedDeliveryDate, now, now);
  }
}

/** Shipment status from the hourly Walmart sync (AWAITING_DELIVERY, RECEIVING, CLOSED…). */
export function walmartShipmentStatus(db: Database.Database, shipmentId: string): string | null {
  const row = db.prepare("SELECT status FROM inbound_shipments WHERE shipment_id = ? AND marketplace = 'walmart'").get(shipmentId) as { status: string } | undefined;
  return row?.status ?? null;
}

export function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export interface LastCost { buyPriceCents: number; supplier: string | null; datePurchased: string }

/** The SKU's most recent paid cost lot (newest purchase date, then newest lot); null if none. */
export function lastCost(db: Database.Database, sku: string): LastCost | null {
  if (!sku) return null;
  const row = db.prepare(`
    SELECT il.buy_price AS buyPriceCents, s.name AS supplier, il.date_purchased AS datePurchased
    FROM inventory_ledger il LEFT JOIN suppliers s ON s.id = il.supplier_id
    WHERE il.sku = ? AND il.buy_price > 0
    ORDER BY il.date_purchased DESC, il.id DESC LIMIT 1
  `).get(sku) as LastCost | undefined;
  return row ?? null;
}
