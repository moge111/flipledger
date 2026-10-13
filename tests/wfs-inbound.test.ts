/**
 * WFS inbound shipments (Oct 7, 2026): request bodies built from a batch, the
 * Walmart responses parsed back, and the request helper that the carrier
 * endpoints need (Basic auth + version headers, PDF and empty bodies).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateBySku, buildInboundOrderBody, parseCreatedShipments, parseParcelQuotes, buildParcelBookingBody,
  buildReceivingLabelBody, buildParcelQuoteBody, validateBoxes, isWfsSku, bookParcel, createInboundOrder, type WfsBox,
} from '../src/lib/walmart-api/wfsInbound';
import { walmartFetch, clearTokenCache } from '../src/lib/walmart-api/auth';

const ADDR = { addressLine1: '1 Main St', city: 'Springfield', stateCode: 'IL', postalCode: '62701', countryCode: 'US' };
const box = (loadType: WfsBox['loadType'], w = 10): WfsBox => ({ lengthIn: 18, widthIn: 14, heightIn: 12, weightLb: w, loadType });

test('one order line per SKU, matching what Seller Center sends for loose units', () => {
  const body = buildInboundOrderBody({
    inboundOrderId: 'FL1-1', returnAddress: ADDR, expectedDeliveryDate: '2026-10-14T00:00:00.000Z',
    items: [
      { sku: 'wm-a', gtin: '045496597818', productName: 'A', quantity: 3 },
      { sku: 'wm-a', gtin: '045496597818', productName: 'A', quantity: 2 },
      { sku: 'wm-b', gtin: '00810172933507', productName: 'B', quantity: 1 },
    ],
  });
  assert.equal(body.orderItems.length, 2);
  assert.deepEqual(body.orderItems[0], {
    productId: '00045496597818', productType: 'GTIN', sku: 'wm-a', itemDesc: 'A',
    itemQty: 5, vendorPackQty: 5, innerPackQty: 1, expectedDeliveryDate: '2026-10-14T00:00:00.000Z',
  });
  assert.equal(body.returnAddress.stateCode, 'IL');
});

test('a SKU with two different barcodes in one batch is refused', () => {
  assert.throws(() => aggregateBySku([
    { sku: 'wm-a', gtin: '1', productName: 'A', quantity: 1 },
    { sku: 'wm-a', gtin: '2', productName: 'A', quantity: 1 },
  ]), /two different barcodes/);
});

test('an empty batch cannot be sent', () => {
  assert.throws(() => buildInboundOrderBody({ inboundOrderId: 'x', returnAddress: ADDR, expectedDeliveryDate: 'd', items: [] }), /no units/);
});

test('parses the shipments Walmart creates (it may split across FCs)', () => {
  const s = parseCreatedShipments({ status: 'OK', payload: [
    { shipmentId: '0000966GDM', shipToAddress: { fcName: 'PHX1', addressLine1: '6600 N Sarival', city: 'Litchfield Park', stateCode: 'AZ', countryCode: 'US', postalCode: '85340' },
      shipmentItems: [{ vendorSku: 'wm-a', itemQty: 4 }], expectedDeliveryDate: '2026-10-14T00:00:00.000Z' },
    { shipmentId: '0000967GDM', shipToAddress: { city: 'Shepherdsville', stateCode: 'KY' }, shipmentItems: [{ vendorSku: 'wm-a', itemQty: 1 }] },
  ] });
  assert.equal(s.length, 2);
  assert.equal(s[0].shipTo.fcName, 'PHX1');
  assert.deepEqual(s[0].items, [{ sku: 'wm-a', quantity: 4 }]);
  assert.equal(s[1].expectedDeliveryDate, null);
});

test('box checks', () => {
  assert.match(validateBoxes([])!, /at least one box/);
  assert.match(validateBoxes([{ ...box('SINGLE SKU'), weightLb: 0 }])!, /weight/);
  assert.equal(validateBoxes([box('SINGLE SKU'), box('MIXED SKUS')]), null);
});

test('booking and receiving labels count single- and mixed-SKU boxes', () => {
  const boxes = [box('SINGLE SKU'), box('SINGLE SKU'), box('MIXED SKUS')];
  assert.deepEqual(buildParcelBookingBody('S1', 'Q1', boxes, 'T').payload.bookingDetails.unitDetails, [{ noOfSingleSkuBoxes: 2, noOfMixedSkuBoxes: 1 }]);
  assert.deepEqual(buildReceivingLabelBody('S1', boxes).loadTypes, [
    { loadType: 'SINGLE SKU', count: 2 }, { loadType: 'MIXED SKUS', count: 1 },
  ]);
  assert.deepEqual(buildReceivingLabelBody('S1', [box('MIXED SKUS')]).loadTypes, [{ loadType: 'MIXED SKUS', count: 1 }]);
});

test('parcel quote lists one package per box, origin phone digits only', () => {
  const q = buildParcelQuoteBody({
    shipmentId: 'S1', origin: { ...ADDR, phone: '(801) 555-0100', name: 'Biz' }, destination: ADDR, boxes: [box('SINGLE SKU', 7), box('MIXED SKUS', 9)],
  });
  const unit = q.payload.units[0];
  assert.equal(q.payload.quoteType, 'Parcel');
  assert.equal(unit.origin.phone, '8015550100');
  assert.equal(unit.destination.locationType, 'DC');
  assert.deepEqual(unit.unitDetails.shipmentPackages.map(p => [p.packageSequenceNumber, p.weight, p.packageType]), [[1, 7, 'SINGLE SKU'], [2, 9, 'MIXED SKUS']]);
});

test("reads Walmart's live quote shape (one rateQuote + shipment total), not just the documented one", () => {
  // Trimmed from the real response for shipment 2606920WFB (Oct 7, 2026).
  const live = { payload: {
    shipmentId: '2606920WFB', quoteType: 'PARCEL', quoteId: '1554897020425084928',
    shipmentPackages: [{ quoteId: '1554897020425084928', packageSequenceNumber: 1, netCharge: 4.0 }, { packageSequenceNumber: 2, netCharge: 5.46 }],
    carrier: { carrierId: 'FEDEX', carrierName: 'FEDEX' },
    rateQuote: { quoteId: '1554897020425084928', estimatedDeliveryDateTime: '2026-10-05T23:59:00.000Z', carrier: { carrierName: 'FEDEX' }, netCharge: 4.0, status: 'ACTIVE' },
    aggregates: { totalCharge: { unitOfMeasure: 'USD', measurementValue: 9.460000038146973 } },
    netCharge: 9.46, quoteStatus: 'ACTIVE',
  } };
  assert.deepEqual(parseParcelQuotes(live), [{
    quoteId: '1554897020425084928', carrierName: 'FEDEX', netChargeCents: 946,
    estimatedDelivery: '2026-10-05T23:59:00.000Z', status: 'ACTIVE',
  }]);
});

test('quotes parse to cents and skip entries without an id', () => {
  const quotes = parseParcelQuotes({ payload: { rateQuotes: [
    { quoteId: 'Q1', carrier: { carrierName: 'FedEx' }, netCharge: 47.63, estimatedDeliveryDateTime: '2026-10-12T00:00:00Z' },
    { carrier: { carrierName: 'FedEx' }, netCharge: 1 },
  ] } });
  assert.deepEqual(quotes, [{ quoteId: 'Q1', carrierName: 'FedEx', netChargeCents: 4763, estimatedDelivery: '2026-10-12T00:00:00Z', status: null }]);
});

// ── request helper, with Walmart stubbed ─────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; clearTokenCache(); });

function stub(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/v3/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 900 }), { headers: { 'content-type': 'application/json' } });
    calls.push({ url: u, init });
    return handler(u, init);
  }) as typeof fetch;
  return calls;
}
const CREDS = { clientId: 'id', clientSecret: 'secret' };

test('walmartFetch sends the Basic and version headers the carrier endpoints require', async () => {
  const calls = stub(() => new Response(JSON.stringify({ status: 'OK' }), { headers: { 'content-type': 'application/json' } }));
  const r = await walmartFetch(CREDS, '/fulfillment/inbound-shipments-quote', { method: 'POST', body: { a: 1 } });
  assert.deepEqual(r.json, { status: 'OK' });
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h['Authorization'], 'Basic ' + Buffer.from('id:secret').toString('base64'));
  assert.equal(h['WM_SEC.ACCESS_TOKEN'], 'tok');
  assert.equal(h['WM_GLOBAL_VERSION'], '3.1');
  assert.equal(h['WM_MARKET'], 'US');
});

test('walmartFetch returns PDF bytes and tolerates an empty body', async () => {
  stub(u => u.includes('label')
    ? new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { 'content-type': 'application/pdf' } })
    : new Response(null, { status: 200 }));
  const pdf = await walmartFetch(CREDS, '/fulfillment/shipment-label', { method: 'POST', body: {}, accept: 'application/pdf' });
  assert.equal(pdf.buffer?.toString('latin1'), '%PDF');
  const empty = await walmartFetch(CREDS, '/fulfillment/inventory', { params: { sku: 'x' } });
  assert.equal(empty.json, null);
  assert.equal(empty.buffer, null);
});

test('isWfsSku: WFS stock location → true; unknown SKU (empty body) → false', async () => {
  stub(u => u.includes('sku=wfs')
    ? new Response(JSON.stringify({ payload: { inventory: [{ sku: 'wfs', shipNodes: [{ shipNodeType: 'WFSFulfilled' }] }] } }), { headers: { 'content-type': 'application/json' } })
    : new Response('', { status: 200 }));
  assert.equal(await isWfsSku(CREDS, 'wfs'), true);
  assert.equal(await isWfsSku(CREDS, 'nope'), false);
});

test('walmartFetch never retries a failed booking or order create (no double charge)', async () => {
  let n = 0;
  stub(() => { n++; return new Response('{"errors":[{"description":"boom"}]}', { status: 500 }); });
  await assert.rejects(bookParcel(CREDS, buildParcelBookingBody('S1', 'Q1', [box('SINGLE SKU')], 'T')), /500/);
  assert.equal(n, 1);
  await assert.rejects(createInboundOrder(CREDS, buildInboundOrderBody({
    inboundOrderId: 'x', returnAddress: ADDR, expectedDeliveryDate: 'd', items: [{ sku: 'a', gtin: '1', productName: 'A', quantity: 1 }],
  })), /500/);
  assert.equal(n, 2);
});

test('WM_GLOBAL_VERSION/WM_MARKET only go to the Preferred Carrier endpoints', async () => {
  const { needsCarrierHeaders } = await import('../src/lib/walmart-api/auth');
  // These 400 "invalid martId,buId" with the headers (live, Oct 8 2026).
  for (const e of ['/fulfillment/inbound-shipments', '/fulfillment/inbound-shipments/FL62-1', '/fulfillment/shipment-label', '/fulfillment/shipment-tracking', '/fulfillment/inventory', '/feeds'])
    assert.equal(needsCarrierHeaders(e), false, e);
  for (const e of ['/fulfillment/inbound-shipments-quote', '/fulfillment/inbound-shipments-booking', '/fulfillment/generate-label', '/fulfillment/download-label'])
    assert.equal(needsCarrierHeaders(e), true, e);
});
