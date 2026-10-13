/**
 * Walmart SKU setup from a batch (Oct 7, 2026): one feed per item, built from
 * Walmart's current spec and validated against it before sending. Fixtures are
 * the real MP_WFS_ITEM 5.0.20260803 spec for "Interlocking Block Building Sets"
 * and the parsed walmart.com page of LEGO 75389 (item 5298070748).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import {
  advanceSetup, buildMatchFeed, explainSetupErrors, readFeedResult, unsupportedReasons, NO_BATTERY, type SetupState,
} from '../src/lib/walmart-api/itemSetup';
import {
  buildSetupFeed, buildVisibleFields, coercePageValue, describeField, missingVisibleKeys, parseRecommendedVersions,
  specLayout, toSchemaValue, validateFeed, type CoreFields, type FieldDescriptor,
} from '../src/lib/walmart-api/specForm';
import { parseProductDetails } from '../src/lib/walmart-api/productPage';

const fx = (f: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures/walmart', f), 'utf8'));
const SPEC = fx('mp-wfs-item-lego-spec.json');
const PAGE = fx('lego-75389-page.json');
const PT = 'Interlocking Block Building Sets';
const VERSION = '5.0.20260803-17_50_56-api';
const LAYOUT = specLayout(SPEC, 'MP_WFS_ITEM', PT);
const CTX = { page: PAGE, catalog: { title: PAGE.title, brand: 'LEGO', imageUrl: null }, remembered: {} };
const CORE: CoreFields = {
  sku: 'wm-LegoStarWars-143.95', gtin14: '00673419389594', priceDollars: 250, shippingWeightLb: 6,
  unit: { lengthIn: 18.75, widthIn: 14.5, heightIn: 4.5, weightLb: 6 }, countryOfOrigin: 'CN - China',
  batteryType: NO_BATTERY, electronics: false, isChemical: false, isAerosol: false, isPesticide: false,
};

function visibleFrom(fields: FieldDescriptor[], extra: Record<string, unknown> = {}) {
  const v: Record<string, unknown> = {};
  for (const f of fields) { const x = toSchemaValue(f, f.value); if (x !== undefined) v[f.key] = x; }
  return { ...v, ...extra };
}

test("fills LEGO 75389 from Walmart's own page; only material and small-parts are left to ask", () => {
  const { fields, unsupported } = buildVisibleFields(LAYOUT, CTX);
  assert.deepEqual(unsupported, []);
  const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
  assert.equal(byKey.pieceCount.value, 1579);
  assert.deepEqual(byKey.minimumRecommendedAge.value, { measure: 10, unit: 'years' });
  assert.deepEqual(byKey.ageGroup.value, ['Child', 'Teen', 'Adult']);
  assert.equal(byKey.keyFeatures.source, 'walmart');
  assert.deepEqual(fields.filter(f => f.value == null).map(f => f.key).sort(), ['material', 'smallPartsWarnings']);
});

test('remembered answers fill the fields the page lacks', () => {
  const { fields } = buildVisibleFields(LAYOUT, { ...CTX, remembered: { material: ['Plastic'] } });
  const material = fields.find(f => f.key === 'material')!;
  assert.deepEqual([material.value, material.source], [['Plastic'], 'remembered']);
});

test("the assembled feed passes Walmart's schema once the asked fields are answered (incl. if/then Condition)", () => {
  let { fields } = buildVisibleFields(LAYOUT, CTX);
  const answers = { material: ['Plastic'], smallPartsWarnings: ['3 - Choking hazard contains small parts'] };
  const feed = (fs: FieldDescriptor[]) => buildSetupFeed({ feedType: 'MP_WFS_ITEM', version: VERSION, productType: PT, layout: LAYOUT, core: CORE, visible: visibleFrom(fs, answers) });
  // Condition is required only conditionally, so the first pass misses it…
  const extra = missingVisibleKeys(SPEC, feed(fields), LAYOUT);
  assert.deepEqual(extra, ['condition']);
  // …and the second pass picks it up and fills it.
  fields = buildVisibleFields(LAYOUT, CTX, extra).fields;
  assert.equal(fields.find(f => f.key === 'condition')?.value, 'New');
  assert.deepEqual(validateFeed(SPEC, feed(fields), LAYOUT), []);
});

test('decimal weights like 1.15 lb pass "multiple of 0.0001" (floating-point division must not reject them)', () => {
  const fields = buildVisibleFields(LAYOUT, CTX, ['condition']).fields;
  const answers = { material: ['Plastic'], smallPartsWarnings: ['3 - Choking hazard contains small parts'] };
  for (const weightLb of [1.15, 1.14, 0.3]) {
    const core = { ...CORE, shippingWeightLb: weightLb, unit: { lengthIn: 10.25, widthIn: 7.5, heightIn: 3, weightLb } };
    const feed = buildSetupFeed({ feedType: 'MP_WFS_ITEM', version: VERSION, productType: PT, layout: LAYOUT, core, visible: visibleFrom(fields, answers) });
    assert.deepEqual(validateFeed(SPEC, feed, LAYOUT), [], `weight ${weightLb}`);
  }
});

test('validation names the missing fields in plain words', () => {
  const { fields } = buildVisibleFields(LAYOUT, CTX);
  const problems = validateFeed(SPEC, buildSetupFeed({ feedType: 'MP_WFS_ITEM', version: VERSION, productType: PT, layout: LAYOUT, core: CORE, visible: visibleFrom(fields) }), LAYOUT);
  assert.ok(problems.some(p => /^Material is required/.test(p)), problems.join(' | '));
});

test('orderable fields follow the spec version: separate chemical/aerosol/pesticide, no GTIN on the trade item', () => {
  const feed: any = buildSetupFeed({ feedType: 'MP_WFS_ITEM', version: VERSION, productType: PT, layout: LAYOUT, core: CORE, visible: {} });
  const item = feed.MPItem[0];
  assert.equal(feed.MPItemFeedHeader.version, VERSION);
  assert.deepEqual([item.Orderable.isChemical, item.Orderable.isAerosol, item.Orderable.isPesticide], ['No', 'No', 'No']);
  assert.equal('chemicalAerosolPesticide' in item.Orderable, false);
  assert.equal('orderableGTIN' in item.TradeItem, false);
  assert.deepEqual(item.TradeItem.countryOfOriginAssembly, ['CN - China']);
});

test('field shapes and page-value coercion', () => {
  const props = LAYOUT.visible.properties;
  const age = describeField('minimumRecommendedAge', props.minimumRecommendedAge, true)!;
  assert.equal(age.kind, 'measure');
  assert.deepEqual(coercePageValue(age, '10 Years & Up'), { measure: 10, unit: 'years' });
  const group = describeField('ageGroup', props.ageGroup, true)!;
  assert.deepEqual(coercePageValue(group, 'Child, Teen, Adult'), ['Child', 'Teen', 'Adult']);
  assert.equal(coercePageValue(group, 'Grown-ups'), null);
  assert.equal(describeField('mainImageUrl', props.mainImageUrl, true)!.kind, 'text');
});

test("reads the recommended spec versions from Walmart's docs table", () => {
  const md = `<tr><td>Create new items for WFS</td><td>MP_WFS_ITEM</td><td>[5.0.20260803-17_50_56-api](/file/x.zip)</td><td>old</td></tr>
    <tr><td>Convert existing item to WFS</td><td>OMNI_WFS</td><td>[5.0.20260803-17_50_56-api](/file/y.zip)</td><td>old</td></tr>`;
  assert.deepEqual(parseRecommendedVersions(md), { MP_WFS_ITEM: '5.0.20260803-17_50_56-api', OMNI_WFS: '5.0.20260803-17_50_56-api' });
});

test('product page parser reads description bullets and specs', () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: {
    product: { usItemId: '1', upc: '0123', name: 'Thing', brand: 'B', imageInfo: { allImages: [{ url: 'a.jpg' }, { url: 'b.jpg' }] } },
    idml: { longDescription: '<ul><li>One &amp; two</li><li>Three</li></ul>', specifications: [{ name: 'Material', value: 'Plastic' }] },
  } } } } })}</script>`;
  const d = parseProductDetails(html)!;
  assert.deepEqual(d.keyFeatures, ['One & two', 'Three']);
  assert.deepEqual(d.specs, [{ name: 'Material', value: 'Plastic' }]);
  assert.deepEqual(d.images, ['a.jpg', 'b.jpg']);
});

test('seller-fulfilled offer feed: the 4.2 match shape that worked live', () => {
  assert.deepEqual(buildMatchFeed({ sku: 'S', gtin14: '00673419389594', priceDollars: 250, shippingWeightLb: 6 }).MPItem[0].Item, {
    sku: 'S', productIdentifiers: { productIdType: 'GTIN', productId: '00673419389594' }, price: 250, ShippingWeight: 6, condition: 'New',
  });
});

test('items Walmart needs documents for are refused with a reason', () => {
  assert.equal(unsupportedReasons({ batteryType: NO_BATTERY }).length, 0);
  assert.match(unsupportedReasons({ batteryType: 'Lithium Ion' })[0], /Lithium/);
  assert.match(unsupportedReasons({ batteryType: NO_BATTERY, isAerosol: true })[0], /safety data sheet/);
  assert.match(unsupportedReasons({ batteryType: 'Alkaline' })[0], /battery size/);
});

test('feed results and the PENDING → READY / FAILED step', async () => {
  const item = (ingestionStatus: string, extra = {}) => ({ itemDetails: { itemIngestionStatus: [{ sku: 'S', ingestionStatus, ...extra }] } });
  assert.equal(readFeedResult(item('INPROGRESS', { pendingStatusDescription: 'under review' }), 'S').pending, 'under review');
  assert.deepEqual(readFeedResult(item('DATA_ERROR', { ingestionErrors: { ingestionError: [{ description: 'Bad GTIN' }] } }), 'S'), { state: 'FAILED', errors: ['Bad GTIN'] });

  const base: SetupState = { status: 'PENDING', kind: 'WFS_NEW', feedType: 'MP_WFS_ITEM', feedId: 'F', sku: 'S', gtin14: 'G', feed: {}, updatedAt: 'T0' };
  const step = (state: 'PENDING' | 'SUCCESS' | 'FAILED', errors: string[] = []) =>
    advanceSetup(base, { feedResult: async () => ({ state, errors }), now: () => 'T' });
  assert.equal((await step('PENDING')).status, 'PENDING');
  assert.equal((await step('SUCCESS')).status, 'READY');
  const failed = await step('FAILED', ['Duplicate items found for the request.']);
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error!, /Convert to WFS/);
  // A failed setup is left alone until Retry.
  assert.equal((await advanceSetup(failed, { feedResult: async () => { throw new Error('not called'); }, now: () => 'T' })).status, 'FAILED');
});

test('duplicate-items error tells the user what to do', () => {
  const msg = explainSetupErrors(['Duplicate items found for the request. Please contact seller support team for cleanup.'], { sku: 'wm-X', gtin14: '000123' });
  assert.match(msg, /ERR_EXT_DATA_00010733/);
  assert.match(msg, /wm-X/);
  assert.equal(explainSetupErrors(['Bad GTIN'], { sku: 'x', gtin14: 'y' }), 'Bad GTIN');
});

test('battery comes from evidence; unknown is asked, never declared "no battery"', async () => {
  const { batteryEvidence } = await import('../src/lib/wfs-item-setup');
  const page = (warnings: { name: string; value: string }[], specs: { name: string; value: string }[] = []) =>
    ({ ...PAGE, warnings, specs });
  // The Polaroid Go Gen 2's real walmart.com warning; Amazon has no record of its barcode.
  const polaroid = page([{ name: 'Ingestion Hazard', value: 'This product contains a battery. Death or serious injury can occur if ingested.' }]);
  assert.equal(batteryEvidence(polaroid, null).contains, true);
  assert.equal(batteryEvidence(page([]), null).contains, null);
  assert.equal(batteryEvidence(page([]), { asin: 'B0', hasBatteries: false }).contains, false);
  assert.equal(batteryEvidence(page([]), { asin: 'B0', hasBatteries: true }).contains, true);
  assert.equal(batteryEvidence(page([], [{ name: 'Batteries Required', value: 'No' }]), null).contains, false);
  // LEGO 75389: no battery mentions on the page, Amazon says none.
  assert.equal(batteryEvidence(PAGE, { asin: 'B0CV2HV7WH', hasBatteries: false }).contains, false);
});

test('battery type is read from Amazon / Walmart data when stated', async () => {
  const { amazonBatteryType, knownBatteryType, knownBatterySize } = await import('../src/lib/wfs-item-setup');
  const mkt = { marketplace_id: 'ATVPDKIKX0DER' };
  // Polaroid Go Gen 2 (B0CG7P9KTH), real attributes: num_batteries mixes junk types in.
  const polaroid = {
    battery: [{ cell_composition: [{ value: 'lithium_ion' }], weight: [{ unit: 'grams', value: 13.9 }], ...mkt }],
    num_batteries: [{ quantity: 1, type: 'lr44', ...mkt }, { quantity: 1, type: 'lithium_ion', ...mkt }, { quantity: 1, type: '12v', ...mkt }],
    batteries_required: [{ value: true, ...mkt }],
  };
  assert.equal(amazonBatteryType(polaroid), 'Lithium Ion');
  assert.equal(amazonBatteryType({ number_of_lithium_ion_cells: [{ value: 1 }] }), 'Lithium Ion');
  assert.equal(amazonBatteryType({ battery: [{ cell_composition: [{ value: 'alkaline' }] }] }), 'Alkaline');
  // WD_BLACK C50 (B0C44XVWCH): a stray lithium_battery weight with batteries required/included false.
  assert.equal(amazonBatteryType({ lithium_battery: [{ weight: [{ unit: 'grams', value: 0.5 }] }], batteries_required: [{ value: false }] }), undefined);
  // Walmart's page spec wins over Amazon.
  const page = { ...PAGE, specs: [{ name: 'Battery Type', value: 'Nickel-Metal Hydride (NiMH)' }] };
  assert.equal(knownBatteryType(page, { asin: 'B0', batteryType: 'Alkaline' }), 'Nickel Metal Hydride');
  assert.equal(knownBatteryType(PAGE, { asin: 'B0', batteryType: 'Alkaline' }), 'Alkaline');
  // Size only when exactly one of Amazon's codes is on Walmart's list.
  assert.equal(knownBatterySize({ asin: 'B0', batterySizes: ['aa'] }, ['AA', 'AAA']), 'AA');
  assert.equal(knownBatterySize({ asin: 'B0', batterySizes: ['aa', 'aaa'] }, ['AA', 'AAA']), '');
  assert.equal(knownBatterySize({ asin: 'B0', batterySizes: ['12v'] }, ['AA', 'AAA']), '');
});

test("Claude's answers: schema limits choices to Walmart's values; off-list or empty answers are dropped", async () => {
  const { answerSchema, acceptAnswer } = await import('../src/lib/walmart-api/aiFill');
  const { fields } = buildVisibleFields(LAYOUT, CTX);
  const empty = fields.filter(f => f.value == null);                 // material, smallPartsWarnings
  const schema: any = answerSchema(empty);
  assert.deepEqual(schema.required.sort(), ['material', 'smallPartsWarnings']);
  assert.equal(schema.additionalProperties, false);
  const sp = schema.properties.smallPartsWarnings.anyOf[0];
  assert.ok(sp.items.enum.includes('3 - Choking hazard contains small parts'));

  const small = empty.find(f => f.key === 'smallPartsWarnings')!;
  const material = empty.find(f => f.key === 'material')!;
  assert.deepEqual(acceptAnswer(small, ['3 - Choking hazard contains small parts', 'made-up value']), ['3 - Choking hazard contains small parts']);
  assert.equal(acceptAnswer(small, ['made-up value']), null);
  assert.deepEqual(acceptAnswer(material, ['Plastic', ' ']), ['Plastic']);
  assert.equal(acceptAnswer(material, null), null);
  const age = describeField('minimumRecommendedAge', LAYOUT.visible.properties.minimumRecommendedAge, true)!;
  assert.equal(acceptAnswer(age, { measure: 10, unit: 'decades' }), null);
  assert.deepEqual(acceptAnswer(age, { measure: 10, unit: 'years' }), { measure: 10, unit: 'years' });
});
