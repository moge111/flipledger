/**
 * Regression tests for the FBA listing → send → box → pack → carrier pipeline.
 *
 * This path had ZERO automated tests until July 8, 2026 — the day a 20-item
 * shipment (batch 28) took ~3 hours because six separate "one bad item fails
 * the whole batch" landmines fired one at a time, mid-send, on live Amazon.
 * Every fix from that session is locked here so it can't silently regress:
 *
 *  - setPrepDetails drops FC_PROVIDED MSKUs and retries with the rest
 *  - listTransportationOptions follows pagination (multi-shipment placements)
 *  - winAnsiSafe strips U+200B etc. (label PDF crash)
 *  - isQueueDisabled detects a paused CUPS queue (false "printed" success)
 *  - allowPartial short FNSKU wait vs full wait
 *  - createInboundPlan propagation-error detection + prepOwner-flip parsing
 *  - expandCarrierChoice books a carrier for EVERY shipment
 *  - /boxes POST ignores excluded items and accepts partial drafts (auto-save)
 *  - listing-reconcile: excluded items don't block readiness; batch fails
 *    only when nothing shippable remains
 *
 * SP-API calls are exercised against a mocked global fetch — no network.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildGoldenDb, GoldenDb } from './fixtures/golden-db';

// ─── Pure helpers (no DB / no network) ─────────────────────────────────────

test('winAnsiSafe strips zero-width + fancy unicode that crashes the PDF encoder', async () => {
  const { winAnsiSafe } = await import('../src/lib/fnsku-labels');
  // U+200B leading (the exact July 8 Toy Story Woody crash)
  assert.equal(winAnsiSafe('​Toy Story Woody'), 'Toy Story Woody');
  // BOM, bidi marks, soft hyphen all stripped
  assert.equal(winAnsiSafe('﻿A‎‏B­C'), 'ABC');
  // curly quotes, dashes, ellipsis normalize to ASCII
  assert.equal(winAnsiSafe('‘x’ “y” – — …'), `'x' "y" - - ...`);
  // nothing outside Latin-1 survives (emoji dropped)
  assert.ok(!/[^\x00-\xFF]/.test(winAnsiSafe('Sonic 🦔 Figure – “Deluxe”')));
  assert.equal(winAnsiSafe('Sonic 🦔Figure'), 'Sonic Figure');
  // plain Latin-1 untouched
  assert.equal(winAnsiSafe('Bowers & Wilkins Px8'), 'Bowers & Wilkins Px8');
});

test('isQueueDisabled detects a paused CUPS queue', async () => {
  const { isQueueDisabled } = await import('../src/lib/print');
  assert.equal(isQueueDisabled('printer Printer_ThermalPrinter is idle.  enabled since Tue 08 Jul 2026'), false);
  assert.equal(isQueueDisabled('printer Printer_ThermalPrinter disabled since Tue 08 Jul 2026 -\n\tUnable to send data to printer.'), true);
  assert.equal(isQueueDisabled('printer HP_LaserJet is idle.  enabled since Mon\nprinter Printer_ThermalPrinter disabled since Tue'), true);
  assert.equal(isQueueDisabled(''), false);
});

test('isCatalogDefectIssue recognizes the demand-but-reject signature', async () => {
  const { isCatalogDefectIssue } = await import('../src/lib/listing-preflight');
  assert.equal(isCatalogDefectIssue(["We can't accept the is_used_where you entered for this product (code 90244)"]), true);
  assert.equal(isCatalogDefectIssue(['Attribute toy_figure_type does not belong to this product type... ignoring']), true);
  assert.equal(isCatalogDefectIssue(["'Battery Installation Device Type' is required but not supplied"]), false);
  assert.equal(isCatalogDefectIssue([]), false);
});

test('fnskuMaxAttempts: full 10-min window first send, 2-min once partial approved', async () => {
  const { fnskuMaxAttempts } = await import('../src/lib/listing-send-policy');
  assert.equal(fnskuMaxAttempts(false), 30); // 30 × 20s = 10 min
  assert.equal(fnskuMaxAttempts(true), 6);   // 6 × 20s = 2 min
});

test('isPropagationError matches every Amazon phrasing, rejects real errors', async () => {
  const { isPropagationError } = await import('../src/lib/listing-send-policy');
  assert.equal(isPropagationError('The following MSKUs are not available for inbound.'), true);
  assert.equal(isPropagationError('These were recently added, please try again later'), true);
  assert.equal(isPropagationError('The following MSKUs are not valid: [x]'), true);
  assert.equal(isPropagationError('Prep classification for this SKU was missing'), true);
  assert.equal(isPropagationError('Error code FBA_INB_0182'), true);
  assert.equal(isPropagationError('Access to requested resource is denied.'), false);
  assert.equal(isPropagationError('Ship-from address is invalid'), false);
});

test('parsePrepOwnerFlips parses both phrasings and dedupes', async () => {
  const { parsePrepOwnerFlips } = await import('../src/lib/listing-send-policy');
  const err =
    'sku-a requires prepOwner but NONE was assigned. Accepted values: [AMAZON, SELLER]. ' +
    'sku-b does not require prepOwner but SELLER was assigned. Accepted values: [NONE].';
  const { needsPrep, doesntNeedPrep } = parsePrepOwnerFlips(err);
  assert.deepEqual(needsPrep, ['sku-a']);
  assert.deepEqual(doesntNeedPrep, ['sku-b']);
  const none = parsePrepOwnerFlips('Something unrelated');
  assert.deepEqual(none.needsPrep, []);
  assert.deepEqual(none.doesntNeedPrep, []);
});

test('sanitizePlanName keeps inbound plan names within Amazon\'s 40-char limit', async () => {
  const { sanitizePlanName } = await import('../src/lib/listing-send-policy');
  // The exact July 8 test-shipment failure: 44 chars → cryptic createInboundPlan 400
  assert.equal(sanitizePlanName('TEST HARNESS Jul 8 (auto — will be cancelled)').length <= 40, true);
  assert.equal(sanitizePlanName('Jul 8 Batch'), 'Jul 8 Batch');
  assert.equal(sanitizePlanName('  spaced\t\tout   name  '), 'spaced out name');
  assert.equal(sanitizePlanName(''), 'FlipLedger Shipment');
  assert.equal(sanitizePlanName('x'.repeat(100)).length, 40);
});

test('expandCarrierChoice books the chosen carrier on EVERY shipment', async () => {
  const { expandCarrierChoice } = await import('../src/lib/listing-send-policy');
  const ups1 = { transportationOptionId: 'to-ups-1', shipmentId: 'sh1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'UPS' } };
  const ups2 = { transportationOptionId: 'to-ups-2', shipmentId: 'sh2', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'UPS' } };
  const dhl1 = { transportationOptionId: 'to-dhl-1', shipmentId: 'sh1', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'DHL' } };
  const dhl2 = { transportationOptionId: 'to-dhl-2', shipmentId: 'sh2', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'DHL' } };

  // User clicked UPS on shipment 1 → both shipments get their UPS option.
  const r1 = expandCarrierChoice([ups1], [ups1, ups2, dhl1, dhl2]);
  assert.deepEqual(r1.selected.map((o) => o.transportationOptionId).sort(), ['to-ups-1', 'to-ups-2']);
  assert.deepEqual(r1.missing, []);
  assert.equal(r1.shipmentIds.length, 2);

  // Carrier not offered on shipment 2 → reported missing, not silently skipped.
  const r2 = expandCarrierChoice([ups1], [ups1, dhl1, dhl2]);
  assert.deepEqual(r2.missing, ['sh2']);

  // Explicit per-shipment picks win over matching.
  const r3 = expandCarrierChoice([ups1, dhl2], [ups1, ups2, dhl1, dhl2]);
  assert.deepEqual(r3.selected.map((o) => o.transportationOptionId).sort(), ['to-dhl-2', 'to-ups-1']);
});

// ─── SP-API client behavior against a mocked fetch ─────────────────────────

const CREDS = { clientId: 'test', clientSecret: 'test', refreshToken: 'test', marketplaceId: 'ATVPDKIKX0DER' };
const realFetch = globalThis.fetch;
let fetchLog: { url: string; init?: RequestInit }[] = [];
let fetchHandler: ((url: string, init?: RequestInit) => Response | null) | null = null;

function mockFetch() {
  fetchLog = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    fetchLog.push({ url, init });
    if (url.includes('api.amazon.com/auth/o2/token')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    const res = fetchHandler?.(url, init);
    if (res) return res;
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
  fetchHandler = null;
}

test('setPrepDetails drops FC_PROVIDED MSKUs and retries with the rest', async (t) => {
  const { clearTokenCache } = await import('../src/lib/sp-api/auth');
  const { setPrepDetails } = await import('../src/lib/sp-api/inboundPlansV2');
  clearTokenCache();
  mockFetch();
  t.after(restoreFetch);

  let prepCalls = 0;
  fetchHandler = (url) => {
    if (url.includes('/items/prepDetails')) {
      prepCalls++;
      if (prepCalls === 1) {
        return new Response(
          JSON.stringify({ errors: [{ message: 'Prep category and types cannot be updated for msku funko-1 with existing prep category of FC_PROVIDED.' }] }),
          { status: 400 }
        );
      }
      return new Response(JSON.stringify({ operationId: 'op-99' }), { status: 202 });
    }
    return null;
  };

  const result = await setPrepDetails(CREDS, [
    { msku: 'funko-1', prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] },
    { msku: 'toy-2', prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] },
    { msku: 'toy-3', prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] },
  ]);

  assert.equal(result.operationId, 'op-99');
  assert.deepEqual(result.skipped, ['funko-1']);
  assert.equal(prepCalls, 2);
  // The retry body must exclude the dropped msku
  const retryBody = JSON.parse(String(fetchLog.filter((f) => f.url.includes('prepDetails'))[1].init?.body));
  const retryMskus = retryBody.mskuPrepDetails.map((d: any) => d.msku);
  assert.deepEqual(retryMskus.sort(), ['toy-2', 'toy-3']);
});

test('setPrepDetails throws (no infinite loop) when the named msku is not ours', async (t) => {
  const { clearTokenCache } = await import('../src/lib/sp-api/auth');
  const { setPrepDetails } = await import('../src/lib/sp-api/inboundPlansV2');
  clearTokenCache();
  mockFetch();
  t.after(restoreFetch);

  fetchHandler = (url) => {
    if (url.includes('/items/prepDetails')) {
      return new Response(
        JSON.stringify({ errors: [{ message: 'Prep category and types cannot be updated for msku SOMEONE-ELSES-SKU with existing prep category of FC_PROVIDED.' }] }),
        { status: 400 }
      );
    }
    return null;
  };

  await assert.rejects(
    () => setPrepDetails(CREDS, [{ msku: 'mine-1', prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] }]),
    /unresolved/
  );
});

test('listTransportationOptions follows pagination across all shipments', async (t) => {
  const { clearTokenCache } = await import('../src/lib/sp-api/auth');
  const { listTransportationOptions } = await import('../src/lib/sp-api/inboundPlansV2');
  clearTokenCache();
  mockFetch();
  t.after(restoreFetch);

  fetchHandler = (url) => {
    if (!url.includes('/transportationOptions')) return null;
    if (!url.includes('paginationToken')) {
      // Page 1: shipment 1's options only (the July 8 trap)
      return new Response(JSON.stringify({
        transportationOptions: [
          { transportationOptionId: 'to-1', shipmentId: 'sh1', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'UPS' } },
        ],
        pagination: { nextToken: 'PAGE2' },
      }), { status: 200 });
    }
    assert.ok(url.includes('paginationToken=PAGE2'));
    return new Response(JSON.stringify({
      transportationOptions: [
        { transportationOptionId: 'to-2', shipmentId: 'sh2', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrier: { name: 'UPS' } },
      ],
    }), { status: 200 });
  };

  const options = await listTransportationOptions(CREDS, 'wf-test', 'pl-test');
  assert.equal(options.length, 2);
  assert.deepEqual([...new Set(options.map((o: any) => o.shipmentId))].sort(), ['sh1', 'sh2']);
});

// ─── Route + reconcile behavior against a fixture DB ───────────────────────

let golden: GoldenDb;
let db: Database.Database;

before(async () => {
  golden = await buildGoldenDb();
  db = new Database(golden.dbPath);
  // Credentials + cached seller id so nothing needs the network for reconcile.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clientId','x'),('clientSecret','y'),('refreshToken','z'),('marketplaceId','ATVPDKIKX0DER'),('amazon_seller_id','ATESTSELLER01')").run();
});

after(() => {
  db?.close();
  golden?.cleanup();
  restoreFetch();
});

function seedBatch(opts: {
  status: string;
  channel?: string;
  items: Array<{ sku: string; qty: number; listingStatus: string | null }>;
}): { batchId: number; itemIds: number[] } {
  const now = new Date().toISOString();
  const b = db.prepare(`
    INSERT INTO listing_batches (name, status, channel, marketplace, created_at, updated_at)
    VALUES (?, ?, ?, 'amazon', ?, ?)
  `).run(`Test ${Math.random().toString(36).slice(2, 8)}`, opts.status, opts.channel || 'FBA', now, now);
  const batchId = Number(b.lastInsertRowid);
  const itemIds: number[] = [];
  for (const it of opts.items) {
    const r = db.prepare(`
      INSERT INTO listing_batch_items (batch_id, asin, sku, condition, quantity, list_price_cents, buy_price_cents, listing_status, created_at)
      VALUES (?, 'B000TEST00', ?, 'NewItem', ?, 1999, 999, ?, ?)
    `).run(batchId, it.sku, it.qty, it.listingStatus, now);
    itemIds.push(Number(r.lastInsertRowid));
  }
  return { batchId, itemIds };
}

async function postBoxes(batchId: number, boxes: any[]) {
  const { POST } = await import('../src/app/api/list/batches/[id]/boxes/route');
  const req = new Request(`http://test/api/list/batches/${batchId}/boxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boxes }),
  });
  const res = await POST(req as any, { params: Promise.resolve({ id: String(batchId) }) });
  return { status: res.status, body: await res.json() };
}

const BOX_DIMS = { lengthIn: 18, widthIn: 14, heightIn: 12, weightLb: 20 };

test('/boxes POST: excluded items (NOT_INBOUND_READY / FAILED) never block allocation', async () => {
  const { batchId, itemIds } = seedBatch({
    status: 'ready',
    items: [
      { sku: 'active-1', qty: 2, listingStatus: 'ACTIVE' },
      { sku: 'stuck-1', qty: 3, listingStatus: 'NOT_INBOUND_READY' },
      { sku: 'gated-1', qty: 1, listingStatus: 'FAILED' },
    ],
  });
  // Fully allocate ONLY the ACTIVE item — must save fine even though the
  // excluded items have zero allocation (July 8: excluded Giganotosaurus
  // permanently disabled Confirm packing).
  const r = await postBoxes(batchId, [{ ...BOX_DIMS, items: [{ itemId: itemIds[0], quantity: 2 }] }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  // First save transitions ready → boxing
  const batch = db.prepare('SELECT status FROM listing_batches WHERE id = ?').get(batchId) as any;
  assert.equal(batch.status, 'boxing');
});

test('/boxes POST: partial allocation is a valid draft (auto-save durability)', async () => {
  const { batchId, itemIds } = seedBatch({
    status: 'ready',
    items: [{ sku: 'active-2', qty: 5, listingStatus: 'ACTIVE' }],
  });
  // Only 2 of 5 boxed so far — mid-packing state must persist (a Chrome crash
  // on July 8 lost ~10 boxes because drafts couldn't save until complete).
  const r = await postBoxes(batchId, [{ ...BOX_DIMS, items: [{ itemId: itemIds[0], quantity: 2 }] }]);
  assert.equal(r.status, 200);
  const saved = db.prepare(`
    SELECT bi.quantity FROM listing_batch_box_items bi
    JOIN listing_batch_boxes b ON b.id = bi.box_id WHERE b.batch_id = ?
  `).all(batchId) as any[];
  assert.equal(saved.length, 1);
  assert.equal(saved[0].quantity, 2);
});

test('/boxes POST: over-allocation is rejected', async () => {
  const { batchId, itemIds } = seedBatch({
    status: 'ready',
    items: [{ sku: 'active-3', qty: 2, listingStatus: 'ACTIVE' }],
  });
  const r = await postBoxes(batchId, [{ ...BOX_DIMS, items: [{ itemId: itemIds[0], quantity: 5 }] }]);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /allocated/);
});

test('/boxes POST: unknown item id is rejected', async () => {
  const { batchId } = seedBatch({
    status: 'ready',
    items: [{ sku: 'active-4', qty: 1, listingStatus: 'ACTIVE' }],
  });
  const r = await postBoxes(batchId, [{ ...BOX_DIMS, items: [{ itemId: 999999, quantity: 1 }] }]);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Unknown item/);
});

test('reconcile: excluded items do not block a sending batch from going ready', async () => {
  const { reconcileSendingBatch } = await import('../src/lib/listing-reconcile');
  // MFN batch (no inbound-plan operation to poll); items already resolved so
  // no listing polls fire → fully offline.
  const { batchId } = seedBatch({
    status: 'sending',
    channel: 'MFN',
    items: [
      { sku: 'ok-1', qty: 1, listingStatus: 'ACTIVE' },
      { sku: 'excluded-1', qty: 1, listingStatus: 'NOT_INBOUND_READY' },
      { sku: 'rejected-1', qty: 1, listingStatus: 'FAILED' },
    ],
  });
  const result = await reconcileSendingBatch(batchId);
  assert.equal(result.reconciled, true);
  assert.equal(result.status, 'ready');
});

test('reconcile: batch fails only when NOTHING shippable remains', async () => {
  const { reconcileSendingBatch } = await import('../src/lib/listing-reconcile');
  const { batchId } = seedBatch({
    status: 'sending',
    channel: 'MFN',
    items: [
      { sku: 'excluded-2', qty: 1, listingStatus: 'NOT_INBOUND_READY' },
      { sku: 'rejected-2', qty: 1, listingStatus: 'FAILED' },
    ],
  });
  const result = await reconcileSendingBatch(batchId);
  assert.equal(result.status, 'failed');
  const batch = db.prepare('SELECT send_error as e FROM listing_batches WHERE id = ?').get(batchId) as any;
  assert.match(batch.e, /failed or was excluded/);
});

// ─── Label geometry (pdf-fit) ──────────────────────────────────────────────
//
// Aug 31, 2026: Partnered UPS shipping labels printed ~20% too small. Amazon
// returns a 1200×1800 px (4×6 @300dpi) UPS bitmap drawn at only 244×366 pt on
// a 306×432 (4.25×6) page — a uniform 84.7% shrink — and fit-to-page on a 4"
// Rollo compounded it. fitLabelsTo4x6 re-lays pages onto true 4×6 media.
// These lock BOTH halves: it must scale the label up, and it must refuse to
// touch pages it doesn't positively recognize as a lone 4×6 image.

/**
 * Build a page that mimics Amazon's PackageLabel_Thermal UPS page.
 *
 * The content stream is hand-authored because it must reproduce Amazon's
 * EXACT operator form, copied verbatim from a real Partnered UPS label:
 *
 *     q 244 0 0 366 31 61 cm /img2 Do Q
 *
 * pdf-lib's own drawImage() emits a chain of `cm` ops instead
 * (`1 0 0 1 31 61 cm` / `244 0 0 366 0 0 cm` / `1 0 0 1 0 0 cm` / `Do`), which
 * pdf-fit deliberately does NOT recognize — it only ever touches the single
 * axis-aligned placement it can reason about exactly, and anything else falls
 * back to a safe whole-page fit.
 */
async function makeThermalPdf(opts: {
  imgW: number; imgH: number; imgX: number; imgY: number;
  pageW?: number; pageH?: number; extraVectorContent?: boolean;
}): Promise<Buffer> {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([opts.pageW ?? 306, opts.pageH ?? 432]);
  // 1×1 black PNG — enough to be a real image XObject.
  const png = await doc.embedPng(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ));
  page.node.setXObject(PDFName.of('img2'), (png as unknown as { ref: unknown }).ref as never);

  const vector = opts.extraVectorContent ? '0 0 0 rg\n10 400 100 6 re\nf\n' : '';
  const content =
    `q\nBT\n0 432 Td\nET\nQ\nq\n${vector}Q\nq\n2 J\n0 G\nQ\n` +
    `q ${opts.imgW} 0 0 ${opts.imgH} ${opts.imgX} ${opts.imgY} cm /img2 Do Q\n`;
  const stream = doc.context.stream(content);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));

  return Buffer.from(await doc.save());
}

/** Read the /BBox [x0 y0 x1 y1] of the embedded source page in the output. */
function embeddedBBox(pdf: Buffer): { x0: number; y0: number; x1: number; y1: number } | null {
  const m = Buffer.from(pdf).toString('latin1')
    .match(/\/BBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) return null;
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
}

/**
 * Compose every `a 0 0 d e f cm` scale factor on an output page. This reads
 * what pdf-fit ACTUALLY drew, not what the BBox implies — the difference
 * matters: a "stretch to fill" bug is invisible on a perfectly 2:3 rect and
 * only shows up on the fallback path.
 */
async function drawnScale(pdf: Buffer, pageIndex = 0): Promise<{ sx: number; sy: number }> {
  const { PDFDocument, PDFRawStream, PDFArray, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPages()[pageIndex];
  const chunks: string[] = [];
  const collect = (v: unknown) => {
    const r = doc.context.lookup(v as never);
    if (r instanceof PDFRawStream) chunks.push(Buffer.from(decodePDFRawStream(r).decode()).toString('latin1'));
    else if (r instanceof PDFArray) r.asArray().forEach(collect);
  };
  collect(page.node.Contents());
  let sx = 1, sy = 1;
  for (const m of chunks.join('\n').matchAll(/(-?[\d.]+)\s+0\s+0\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm/g)) {
    sx *= parseFloat(m[1]);
    sy *= parseFloat(m[2]);
  }
  return { sx, sy };
}

async function pageSizes(pdf: Buffer): Promise<{ width: number; height: number }[]> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => p.getSize());
}

test('pdf-fit: 84.7%-scaled UPS label is scaled up to fill a true 4×6 page', async () => {
  const { fitLabelsTo4x6, LABEL_4X6 } = await import('../src/lib/pdf-fit');
  // Exactly Amazon's real numbers: `q 244 0 0 366 31 61 cm /img2 Do Q` on 306×432.
  const before = await makeThermalPdf({ imgW: 244, imgH: 366, imgX: 31, imgY: 61 });
  const after = await fitLabelsTo4x6(before);

  const sizes = await pageSizes(after);
  assert.equal(sizes.length, 1);
  assert.equal(sizes[0].width, LABEL_4X6.width);   // 288 pt = 4"
  assert.equal(sizes[0].height, LABEL_4X6.height); // 432 pt = 6"

  // The embedded form must be clipped to the image rect (244×366 at 31,61) and
  // drawn at full page size — i.e. scaled by exactly 288/244, no distortion.
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(after);
  const box = embeddedBBox(after);
  assert.ok(box, 'embedded page form should declare a BBox');
  assert.ok(Math.abs(box!.x0 - 31) < 0.01 && Math.abs(box!.y0 - 61) < 0.01,
    `BBox should start at the image origin (31,61), got (${box!.x0},${box!.y0})`);
  const bw = box!.x1 - box!.x0;
  const bh = box!.y1 - box!.y0;
  assert.ok(Math.abs(bw - 244) < 0.01 && Math.abs(bh - 366) < 0.01,
    `BBox should be the 244×366 image rect, got ${bw}×${bh}`);
  // Read the scale actually applied, not one re-derived from the BBox.
  const { sx, sy } = await drawnScale(after);
  assert.ok(Math.abs(sx - sy) < 1e-6, `non-uniform scale would distort: ${sx} vs ${sy}`);
  assert.ok(Math.abs(sx - LABEL_4X6.width / 244) < 1e-6,
    `expected exactly 288/244 = 1.1803× scale-up, got ${sx}`);
  assert.equal(doc.getPages().length, 1);
});

test('pdf-fit: pages that are NOT a lone 4×6 image are fit whole, never cropped', async () => {
  const { fitLabelsTo4x6 } = await import('../src/lib/pdf-fit');
  // The FBA carton-ID page shape: vector content + an image on one page.
  const before = await makeThermalPdf({
    imgW: 244, imgH: 366, imgX: 31, imgY: 61, extraVectorContent: true,
  });
  const after = await fitLabelsTo4x6(before);
  const box = embeddedBBox(after);
  assert.ok(box);
  // Must fall back to the WHOLE 306×432 page, so no vector content is clipped.
  assert.ok(Math.abs(box!.x1 - box!.x0 - 306) < 0.01, 'should keep full page width');
  assert.ok(Math.abs(box!.y1 - box!.y0 - 432) < 0.01, 'should keep full page height');
  const sizes = await pageSizes(after);
  assert.equal(sizes[0].width, 288);
  assert.equal(sizes[0].height, 432);
  // 306×432 into 288×432 must scale UNIFORMLY (0.941 both axes). Stretching
  // the height to fill would distort every barcode on the carton label.
  const { sx, sy } = await drawnScale(after);
  assert.ok(Math.abs(sx - sy) < 1e-6, `carton page must not be stretched: ${sx} vs ${sy}`);
  assert.ok(Math.abs(sx - 288 / 306) < 1e-6, `expected 288/306 = 0.941×, got ${sx}`);
});

test('pdf-fit: an image with the wrong aspect is not mistaken for a 4×6 label', async () => {
  const { fitLabelsTo4x6 } = await import('../src/lib/pdf-fit');
  // A wide banner (2:1), not 2:3 — must NOT be blown up to fill the label.
  const before = await makeThermalPdf({ imgW: 200, imgH: 100, imgX: 50, imgY: 300 });
  const after = await fitLabelsTo4x6(before);
  const box = embeddedBBox(after);
  assert.ok(box);
  assert.ok(Math.abs(box!.x1 - box!.x0 - 306) < 0.01, 'wrong-aspect image must fall back to full page');
});

test('pdf-fit: an unparseable PDF is returned untouched rather than throwing', async () => {
  const { fitLabelsTo4x6 } = await import('../src/lib/pdf-fit');
  const garbage = Buffer.from('not a pdf at all');
  const out = await fitLabelsTo4x6(garbage);
  assert.equal(out.toString(), 'not a pdf at all');
});
