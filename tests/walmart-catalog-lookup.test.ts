/**
 * Walmart product lookup (Oct 7, 2026): a walmart.com link, a Walmart item ID
 * or a UPC must all land on the same catalog product, and nothing may be
 * returned unless Walmart's own barcode search ties it to that item.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWalmartInput,
  gtinCheckDigitValid,
  parseProductPage,
  resolveWalmartProduct,
  type WalmartLookupDeps,
  type WalmartCatalogProduct,
} from '../src/lib/walmart-api/catalogLookup';

const POKEMON: WalmartCatalogProduct = {
  itemId: '1339239849', gtin14: '00045496597818', upc: '045496597818',
  title: 'Pokemon Brilliant Diamond (Nintendo Switch)', brand: 'Nintendo', productType: 'Video Games',
  imageUrl: null, priceCents: 9095, url: 'https://www.walmart.com/ip/1339239849',
};

function deps(over: Partial<WalmartLookupDeps> = {}): WalmartLookupDeps & { pageReads: string[] } {
  const pageReads: string[] = [];
  return {
    pageReads,
    searchByGtin: async g => (g === POKEMON.gtin14 ? [POKEMON] : []),
    ownCatalog: async () => [],
    fetchProductPage: async id => { pageReads.push(id); return id === '1339239849' ? { itemId: id, upc: '045496597818', title: 'x' } : null; },
    barcodeForItemId: async () => null,
    ...over,
  };
}

test('parses links, item IDs and barcodes', () => {
  const link = parseWalmartInput('https://www.walmart.com/ip/Role-Playing-Games/1339239849?athbdg=L1600');
  assert.deepEqual(link, { kind: 'itemId', raw: link.raw, itemId: '1339239849', fromLink: true });
  assert.equal((parseWalmartInput('walmart.com/ip/1339239849') as any).itemId, '1339239849');
  assert.equal(parseWalmartInput('1339239849').kind, 'itemId');
  const upc = parseWalmartInput('0 45496 59781 8');
  assert.equal(upc.kind, 'barcode');
  assert.equal((upc as any).gtin14, '00045496597818');
  assert.equal(parseWalmartInput('https://www.amazon.com/dp/B095Y1YQB4').kind, 'invalid');
  assert.equal(parseWalmartInput('https://www.walmart.com/search?q=lego').kind, 'invalid');
  // A barcode with a wrong check digit is a typo, not an item ID.
  assert.equal(parseWalmartInput('045496597819').kind, 'invalid');
});

test('GTIN check digit', () => {
  assert.equal(gtinCheckDigitValid('045496597818'), true);
  assert.equal(gtinCheckDigitValid('8908014554835'), true);
  assert.equal(gtinCheckDigitValid('045496597819'), false);
});

test('reads the page product, not ads or recommendations', () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { data: { product: {
      usItemId: '1339239849', upc: '045496597818', name: 'Pokemon',
      addOnServices: [{ groups: [{ services: [{ usItemId: '12840071070', upc: '999999999993' }] }] }],
    } } } } },
  })}</script>`;
  assert.deepEqual(parseProductPage(html), { itemId: '1339239849', upc: '045496597818', title: 'Pokemon' });
  assert.equal(parseProductPage('<html>Robot or human?</html>'), null);
});

test('link, item ID and UPC resolve to the same product', async () => {
  for (const q of ['https://www.walmart.com/ip/x/1339239849', '1339239849', '045496597818']) {
    const r = await resolveWalmartProduct(q, deps());
    assert.equal(r.ok, true, q);
    assert.equal(r.product?.itemId, '1339239849', q);
  }
});

test('refuses when the page UPC belongs to a different Walmart item', async () => {
  const r = await resolveWalmartProduct('1339239849', deps({
    searchByGtin: async () => [{ ...POKEMON, itemId: '8877403227' }],
  }));
  assert.equal(r.ok, false);
  assert.equal(r.product, undefined);
});

test('an unreadable walmart.com page asks for the UPC instead of guessing', async () => {
  const r = await resolveWalmartProduct('5555555555', deps());
  assert.equal(r.ok, false);
  assert.match(r.error!, /UPC/);
});

test('own items resolve by item ID without reading walmart.com, and report the SKU', async () => {
  const d = deps({
    ownCatalog: async (field, value) => (field === 'itemId' && value === '1339239849'
      ? [{ sku: 'wm-pokebd-40', itemId: '1339239849', gtin14: POKEMON.gtin14, title: 'P', publishedStatus: 'PUBLISHED', lifecycleStatus: 'ACTIVE' }]
      : []),
  });
  const r = await resolveWalmartProduct('1339239849', d);
  assert.equal(r.via, 'own-catalog');
  assert.equal(r.existing?.sku, 'wm-pokebd-40');
  assert.deepEqual(d.pageReads, []);
});

test('a short number that is not a matching barcode is tried as an item ID', async () => {
  // 12345670 has a valid EAN-8 check digit but no Walmart barcode match.
  const d = deps({
    fetchProductPage: async id => (id === '12345670' ? { itemId: id, upc: '045496597818', title: 'x' } : null),
    searchByGtin: async g => (g === POKEMON.gtin14 ? [{ ...POKEMON, itemId: '12345670' }] : []),
  });
  const r = await resolveWalmartProduct('12345670', d);
  assert.equal(r.ok, true);
  assert.equal(r.product?.itemId, '12345670');
});

test('an item ID resolves through Walmart\'s API search when walmart.com is blocked', async () => {
  // Oct 8, 2026: walmart.com answered every page read with a "Robot or human?" check.
  const d = deps({
    barcodeForItemId: async id => (id === '1339239849' ? { itemId: id, upc: '00045496597818', title: 'P' } : null),
    fetchProductPage: async () => null,
  });
  const r = await resolveWalmartProduct('https://www.walmart.com/ip/x/1339239849', d);
  assert.equal(r.ok, true);
  assert.equal(r.product?.itemId, '1339239849');
});

test('an API-search barcode is still refused when the barcode search ties it to another item', async () => {
  const r = await resolveWalmartProduct('1339239849', deps({
    barcodeForItemId: async id => ({ itemId: id, upc: '045496597818', title: 'P' }),
    searchByGtin: async () => [{ ...POKEMON, itemId: '8877403227' }],
  }));
  assert.equal(r.ok, false);
});
