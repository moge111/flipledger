/**
 * WFS inbound shipments: send stock from a FlipLedger batch to Walmart's
 * fulfillment centers. Request shapes come from Walmart's published OpenAPI
 * definitions (developer.walmart.com reference pages, fetched Oct 7, 2026).
 *
 * Flow per batch:
 *   1. createInboundOrder  — one inbound order for the whole batch; Walmart
 *      answers with one or more shipments (it may split across FCs).
 *   2. per shipment: boxes (dims/weight, single- or mixed-SKU), then either
 *        - Walmart Preferred Carrier (FedEx parcel): quote → book → carrier label
 *        - own carrier: send the tracking numbers
 *   3. per shipment: WFS receiving labels (one per box, required by the FC).
 *
 * Loose units follow what Seller Center itself sends for this account
 * (checked on shipment 2606920WFB): vendorPackQty = units, innerPackQty = 1.
 * WFS scans each unit's own UPC, so there are no per-unit labels.
 */
import { walmartFetch, WalmartApiError } from './auth';
import type { WalmartCredentials } from './types';

export type LoadType = 'SINGLE SKU' | 'MIXED SKUS';

export interface WfsBatchItem {
  sku: string;
  gtin: string;
  productName: string;
  quantity: number;
}

export interface Address {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateCode: string;
  postalCode: string;
  countryCode: string;
}

export interface WfsBox {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  loadType: LoadType;
}

export interface CreatedShipment {
  shipmentId: string;
  shipTo: Address & { fcName?: string };
  items: { sku: string; quantity: number }[];
  expectedDeliveryDate: string | null;
}

export interface ParcelQuote {
  quoteId: string;
  carrierName: string;
  netChargeCents: number;
  estimatedDelivery: string | null;
  status: string | null;
}

/** Days from today used as the expected delivery date; Walmart adjusts it. */
export const DEFAULT_DELIVERY_DAYS = 7;

/** Walmart rejects duplicate SKU lines; batch items of one SKU ship as one line. */
export function aggregateBySku(items: WfsBatchItem[]): WfsBatchItem[] {
  const bySku = new Map<string, WfsBatchItem>();
  for (const it of items) {
    if (it.quantity <= 0) continue;
    const prev = bySku.get(it.sku);
    if (prev) {
      if (prev.gtin !== it.gtin) throw new Error(`SKU ${it.sku} has two different barcodes in this batch (${prev.gtin}, ${it.gtin}).`);
      prev.quantity += it.quantity;
    } else {
      bySku.set(it.sku, { ...it });
    }
  }
  return [...bySku.values()];
}

export function buildInboundOrderBody(opts: {
  inboundOrderId: string;
  returnAddress: Address;
  items: WfsBatchItem[];
  expectedDeliveryDate: string;
}) {
  const lines = aggregateBySku(opts.items);
  if (lines.length === 0) throw new Error('The batch has no units to send.');
  return {
    inboundOrderId: opts.inboundOrderId,
    returnAddress: {
      addressLine1: opts.returnAddress.addressLine1,
      ...(opts.returnAddress.addressLine2 ? { addressLine2: opts.returnAddress.addressLine2 } : {}),
      city: opts.returnAddress.city,
      stateCode: opts.returnAddress.stateCode,
      countryCode: opts.returnAddress.countryCode,
      postalCode: opts.returnAddress.postalCode,
    },
    orderItems: lines.map(l => ({
      productId: l.gtin.padStart(14, '0'),
      productType: 'GTIN',
      sku: l.sku,
      itemDesc: l.productName.slice(0, 200),
      itemQty: l.quantity,
      vendorPackQty: l.quantity,
      innerPackQty: 1,
      expectedDeliveryDate: opts.expectedDeliveryDate,
    })),
  };
}

export function parseCreatedShipments(json: any): CreatedShipment[] {
  const payload: any[] = Array.isArray(json?.payload) ? json.payload : [];
  return payload.map(s => ({
    shipmentId: String(s.shipmentId),
    shipTo: {
      fcName: s.shipToAddress?.fcName,
      addressLine1: s.shipToAddress?.addressLine1 ?? '',
      addressLine2: s.shipToAddress?.addressLine2 ?? '',
      city: s.shipToAddress?.city ?? '',
      stateCode: s.shipToAddress?.stateCode ?? '',
      postalCode: s.shipToAddress?.postalCode ?? '',
      countryCode: s.shipToAddress?.countryCode ?? 'US',
    },
    items: (s.shipmentItems ?? []).map((i: any) => ({ sku: String(i.vendorSku), quantity: Number(i.itemQty) })),
    expectedDeliveryDate: s.expectedDeliveryDate ?? null,
  }));
}

export function boxCounts(boxes: WfsBox[]): { single: number; mixed: number } {
  return {
    single: boxes.filter(b => b.loadType === 'SINGLE SKU').length,
    mixed: boxes.filter(b => b.loadType === 'MIXED SKUS').length,
  };
}

export function validateBoxes(boxes: WfsBox[]): string | null {
  if (boxes.length === 0) return 'Add at least one box.';
  for (const [i, b] of boxes.entries()) {
    for (const [k, v] of [['length', b.lengthIn], ['width', b.widthIn], ['height', b.heightIn], ['weight', b.weightLb]] as const) {
      if (!(Number(v) > 0)) return `Box ${i + 1}: ${k} must be more than 0.`;
    }
    if (b.loadType !== 'SINGLE SKU' && b.loadType !== 'MIXED SKUS') return `Box ${i + 1}: choose single-SKU or mixed.`;
  }
  return null;
}

export function buildParcelQuoteBody(opts: {
  shipmentId: string;
  origin: Address & { phone: string; name: string };
  destination: Address;
  boxes: WfsBox[];
}) {
  return {
    payload: {
      shipmentId: opts.shipmentId,
      quoteType: 'Parcel',
      units: [{
        origin: {
          addressLine1: opts.origin.addressLine1,
          addressLine2: opts.origin.addressLine2 ?? '',
          city: opts.origin.city,
          stateOrProvince: opts.origin.stateCode,
          country: opts.origin.countryCode,
          postalCode: opts.origin.postalCode,
          phone: opts.origin.phone.replace(/\D/g, ''),
          localName: opts.origin.name,
        },
        destination: {
          locationType: 'DC',
          addressLine1: opts.destination.addressLine1,
          addressLine2: opts.destination.addressLine2 ?? '',
          city: opts.destination.city,
          stateOrProvince: opts.destination.stateCode,
          country: opts.destination.countryCode,
          postalCode: opts.destination.postalCode,
        },
        unitDetails: {
          shipmentPackages: opts.boxes.map((b, i) => ({
            packageSequenceNumber: i + 1,
            weight: b.weightLb,
            weightUOM: 'lb',
            length: b.lengthIn,
            width: b.widthIn,
            height: b.heightIn,
            lengthUOM: 'in',
            packageType: b.loadType,
          })),
        },
      }],
    },
  };
}

/**
 * Walmart's live quote response (checked Oct 7, 2026 on shipment 2606920WFB)
 * is NOT the documented `rateQuotes[]`: it carries one `rateQuote`, the
 * shipment total in `aggregates.totalCharge` / `netCharge`, and the charge per
 * box in `shipmentPackages[]`. Both shapes are read; the shipment total wins.
 */
export function parseParcelQuotes(json: any): ParcelQuote[] {
  const p = json?.payload ?? {};
  const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  if (p.rateQuote?.quoteId || p.quoteId) {
    const rq = p.rateQuote ?? {};
    const total = p.aggregates?.totalCharge?.measurementValue ?? p.netCharge ?? rq.netCharge;
    return [{
      quoteId: String(rq.quoteId ?? p.quoteId),
      carrierName: rq.carrier?.carrierName ?? p.carrier?.carrierName ?? 'FedEx',
      netChargeCents: toCents(total),
      estimatedDelivery: rq.estimatedDeliveryDateTime ?? p.estimatedDeliveryDateTime ?? null,
      status: p.quoteStatus ?? rq.status ?? null,
    }];
  }
  const quotes: any[] = Array.isArray(p.rateQuotes) ? p.rateQuotes : [];
  return quotes
    .filter(q => q?.quoteId)
    .map(q => ({
      quoteId: String(q.quoteId),
      carrierName: q.carrier?.carrierName ?? q.carrier?.carrierId ?? 'FedEx',
      netChargeCents: toCents(q.netCharge ?? q.totalCharge ?? p.netCharge),
      estimatedDelivery: q.estimatedDeliveryDateTime ?? null,
      status: q.status ?? null,
    }));
}

export function buildParcelBookingBody(shipmentId: string, quoteId: string, boxes: WfsBox[], acceptedAt: string) {
  const { single, mixed } = boxCounts(boxes);
  return {
    payload: {
      shipmentId,
      bookingDetails: {
        termsAcceptedTime: acceptedAt,
        quoteType: 'Parcel',
        quoteId,
        unitDetails: [{ noOfSingleSkuBoxes: single, noOfMixedSkuBoxes: mixed }],
      },
    },
  };
}

export function buildReceivingLabelBody(shipmentId: string, boxes: WfsBox[]) {
  const { single, mixed } = boxCounts(boxes);
  return {
    shipmentId,
    labelSize: 'X4_6',
    labelFormat: 'PDF',
    loadTypes: [
      ...(single ? [{ loadType: 'SINGLE SKU', count: single }] : []),
      ...(mixed ? [{ loadType: 'MIXED SKUS', count: mixed }] : []),
    ],
  };
}

/** A readable message from Walmart's error body (RFC 9457 or legacy shape). */
export function walmartErrorMessage(err: unknown): string {
  if (err instanceof WalmartApiError) {
    try {
      const j = JSON.parse(err.body);
      const errs: any[] = j.errors ?? j.error ?? [];
      const parts = errs.map(e => e.description || e.info || e.code).filter(Boolean);
      if (parts.length) return parts.join('; ');
      if (j.detail || j.title) return j.detail || j.title;
    } catch { /* not JSON */ }
    return `Walmart returned ${err.status}: ${err.body.slice(0, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ── Walmart calls ────────────────────────────────────────────────────────────

/** True when the SKU has a WFS stock location (i.e. it was converted to WFS). */
export async function isWfsSku(creds: WalmartCredentials, sku: string): Promise<boolean> {
  try {
    const r = await walmartFetch(creds, '/fulfillment/inventory', { params: { sku } });
    const inv: any[] = r.json?.payload?.inventory ?? [];
    return inv.some(i => i.sku === sku && (i.shipNodes ?? []).some((n: any) => n.shipNodeType === 'WFSFulfilled'));
  } catch (err) {
    // Walmart answers an unknown SKU with an empty body or a 404.
    if (err instanceof WalmartApiError && err.status === 404) return false;
    throw err;
  }
}

export async function createInboundOrder(creds: WalmartCredentials, body: ReturnType<typeof buildInboundOrderBody>): Promise<CreatedShipment[]> {
  // No retry on 5xx: a retried create could open a second inbound order.
  const r = await walmartFetch(creds, '/fulfillment/inbound-shipments', { method: 'POST', body, maxRetries: 0 });
  return parseCreatedShipments(r.json);
}

export async function cancelInboundOrder(creds: WalmartCredentials, inboundOrderId: string): Promise<void> {
  await walmartFetch(creds, `/fulfillment/inbound-shipments/${encodeURIComponent(inboundOrderId)}`, { method: 'DELETE' });
}

export async function getReceivingLabels(creds: WalmartCredentials, shipmentId: string, boxes: WfsBox[]): Promise<Buffer> {
  const r = await walmartFetch(creds, '/fulfillment/shipment-label', {
    method: 'POST', body: buildReceivingLabelBody(shipmentId, boxes), accept: 'application/pdf',
  });
  if (!r.buffer) throw new Error('Walmart returned no label file.');
  return r.buffer;
}

export async function sendTracking(creds: WalmartCredentials, shipmentId: string, carrierName: string, trackingNumbers: string[]): Promise<void> {
  await walmartFetch(creds, '/fulfillment/shipment-tracking', {
    method: 'POST', body: { shipmentId, carrierName, trackingInfo: trackingNumbers },
  });
}

/** Ask for Walmart Preferred Carrier (FedEx) parcel rates. Free; nothing is booked. */
export async function quoteParcel(creds: WalmartCredentials, body: ReturnType<typeof buildParcelQuoteBody>): Promise<ParcelQuote[]> {
  const r = await walmartFetch(creds, '/fulfillment/inbound-shipments-quote', { method: 'POST', body });
  const quotes = parseParcelQuotes(r.json);
  if (quotes.length) return quotes;
  // Some responses only acknowledge; the quotes are then read back.
  const again = await walmartFetch(creds, '/fulfillment/inbound-shipments-quote', {
    params: { quoteType: 'Parcel', shipmentId: body.payload.shipmentId },
  });
  return parseParcelQuotes(again.json);
}

/** Book a quote. THIS CHARGES MONEY. Cancellable within 24 hours (cancelParcelBooking). */
export async function bookParcel(creds: WalmartCredentials, body: ReturnType<typeof buildParcelBookingBody>): Promise<any> {
  const r = await walmartFetch(creds, '/fulfillment/inbound-shipments-booking', { method: 'POST', body, maxRetries: 0 });
  return r.json;
}

export async function cancelParcelBooking(creds: WalmartCredentials, shipmentId: string): Promise<void> {
  await walmartFetch(creds, '/fulfillment/inbound-shipments-booking', {
    method: 'DELETE', params: { shipmentId, mode: 'Parcel' },
  });
}

export async function requestCarrierLabel(creds: WalmartCredentials, shipmentId: string, shipDate: string): Promise<void> {
  await walmartFetch(creds, '/fulfillment/generate-label', {
    method: 'POST', body: { payload: { shipmentId, labelType: 'Carrier', shipDate } }, accept: 'application/json, application/pdf',
  });
}

/** The booked shipment's FedEx labels, or null while Walmart is still making them (202). */
export async function downloadCarrierLabel(creds: WalmartCredentials, shipmentId: string): Promise<Buffer | null> {
  const r = await walmartFetch(creds, '/fulfillment/download-label', {
    params: { shipmentId, labelType: 'Carrier', labelSize: 'X4_6' }, accept: 'application/pdf',
  });
  if (r.status === 202 || !r.buffer) return null;
  return r.buffer;
}
