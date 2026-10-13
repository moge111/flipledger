/**
 * Walmart product lookup for the listing tool: takes whatever the user has —
 * a walmart.com link, a Walmart item ID, or a UPC/EAN/GTIN — and returns the
 * one Walmart catalog product it refers to, CONFIRMED by barcode.
 *
 * Why each step exists (verified live Oct 7, 2026):
 *  - The public catalog search (/items/walmart/search) only accepts a barcode
 *    or keyword, never an item ID. A 12-digit `gtin` returns junk (a slippers
 *    listing for a Pokémon UPC, with no standardUpc at all); the 14-digit
 *    padded GTIN returns the right item with `standardUpc`. So every search
 *    pads to 14 and keeps only results whose standardUpc equals it exactly.
 *  - The seller catalog search (POST /items/catalog/search) DOES accept an
 *    item ID, but only finds items this seller already has a SKU on.
 *  - For any other item ID, the walmart.com product page carries the UPC in
 *    __NEXT_DATA__ (props.pageProps.initialData.data.product.upc). That page is
 *    not an API and may get blocked, so its UPC is only a hint: it must come
 *    back from the official barcode search on the SAME item ID, or we refuse.
 */
import { walmartApiRequest } from './auth';
import type { WalmartCredentials } from './types';
import { createLogger } from '@/lib/log';

const log = createLogger('walmart-api/catalogLookup');

export type WalmartLookupInput =
  | { kind: 'barcode'; raw: string; digits: string; gtin14: string; maybeItemId: boolean }
  | { kind: 'itemId'; raw: string; itemId: string; fromLink: boolean }
  | { kind: 'invalid'; raw: string; reason: string };

export interface WalmartCatalogProduct {
  itemId: string;
  gtin14: string;
  upc: string | null;          // 12-digit UPC-A when the GTIN is one
  title: string;
  brand: string | null;
  productType: string | null;
  imageUrl: string | null;
  priceCents: number | null;   // price shown on Walmart right now
  url: string;
}

export interface WalmartExistingSku {
  sku: string;
  publishedStatus: string | null;
  lifecycleStatus: string | null;
  /** The SKU's current Walmart price. */
  priceCents?: number | null;
}

export interface WalmartLookupResult {
  ok: boolean;
  input: WalmartLookupInput['kind'];
  via?: 'barcode' | 'own-catalog' | 'product-page';
  product?: WalmartCatalogProduct;
  /** Other Walmart items carrying the same barcode (rare: duplicate pages). */
  otherItems?: WalmartCatalogProduct[];
  /** Set when the seller already has a SKU on this item — a restock. */
  existing?: WalmartExistingSku;
  note?: string;
  error?: string;
}

// ── Input parsing ────────────────────────────────────────────────────────────

const BARCODE_LENGTHS = new Set([8, 12, 13, 14]);

export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export const toGtin14 = (digits: string) => digits.padStart(14, '0');

function upcFromGtin14(gtin14: string): string | null {
  return gtin14.startsWith('00') ? gtin14.slice(2) : null;
}

export function parseWalmartInput(raw: string): WalmartLookupInput {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'invalid', raw: text, reason: 'Enter a walmart.com link, a Walmart item ID, or a UPC.' };

  if (/walmart\.com/i.test(text) || /^https?:\/\//i.test(text)) {
    let pathname: string;
    try {
      pathname = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).pathname;
    } catch {
      return { kind: 'invalid', raw: text, reason: "That link couldn't be read." };
    }
    if (!/walmart\.com/i.test(text)) return { kind: 'invalid', raw: text, reason: 'Only walmart.com links are supported.' };
    const m = pathname.match(/\/ip\/(?:[^/]+\/)?(\d{5,14})(?:\/|$)/);
    if (!m) return { kind: 'invalid', raw: text, reason: 'That walmart.com link is not a product page (it should contain /ip/…).' };
    return { kind: 'itemId', raw: text, itemId: m[1], fromLink: true };
  }

  const digits = text.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return { kind: 'invalid', raw: text, reason: 'Enter a walmart.com link, a Walmart item ID, or a UPC.' };
  if (BARCODE_LENGTHS.has(digits.length) && gtinCheckDigitValid(digits)) {
    // Item IDs run 5–12 digits, so a short number with a valid check digit
    // could still be an item ID — the resolver tries that if no barcode matches.
    return { kind: 'barcode', raw: text, digits, gtin14: toGtin14(digits), maybeItemId: digits.length <= 12 && !digits.startsWith('0') };
  }
  if (digits.length >= 5 && digits.length <= 11) return { kind: 'itemId', raw: text, itemId: digits, fromLink: false };
  if (digits.length === 12 && !digits.startsWith('0')) return { kind: 'itemId', raw: text, itemId: digits, fromLink: false };
  return { kind: 'invalid', raw: text, reason: `${digits} is not a valid UPC (check digit doesn't match) or Walmart item ID.` };
}

// ── Walmart calls (injectable for tests) ─────────────────────────────────────

export interface PageProduct { itemId: string; upc: string | null; title: string | null }

export interface WalmartLookupDeps {
  searchByGtin(gtin14: string): Promise<WalmartCatalogProduct[]>;
  ownCatalog(field: 'itemId' | 'gtin', value: string): Promise<(WalmartExistingSku & { itemId: string | null; gtin14: string | null; title: string | null })[]>;
  fetchProductPage(itemId: string): Promise<PageProduct | null>;
  /** Walmart's keyword search with the item ID as the query: the item's own barcode, or null. */
  barcodeForItemId(itemId: string): Promise<PageProduct | null>;
}

const itemUrl = (itemId: string) => `https://www.walmart.com/ip/${itemId}`;
// Measured Oct 7, 2026: ~1 in 4 searches returns the corrupted record, sometimes
// several in a row — 6 spaced attempts make a false "not on Walmart" very rare.
const SEARCH_ATTEMPTS = 6;
const SEARCH_PAUSE_MS = 500;

function toProduct(x: any, gtin14: string): WalmartCatalogProduct {
  return {
    itemId: String(x.itemId),
    gtin14,
    upc: upcFromGtin14(gtin14),
    title: x.title ?? '',
    brand: x.brand ?? null,
    productType: x.productType ?? null,
    imageUrl: x.images?.[0]?.url ?? null,
    priceCents: x.price?.amount != null ? Math.round(Number(x.price.amount) * 100) : null,
    url: itemUrl(String(x.itemId)),
  };
}

export function liveDeps(creds: WalmartCredentials): WalmartLookupDeps {
  return {
    async searchByGtin(gtin14) {
      // Walmart's search intermittently answers with a corrupted record (a
      // slippers listing with no standardUpc) for a valid barcode; the next
      // call is fine. Alternate the gtin/upc forms and retry until a result
      // carries the exact barcode, or every attempt has come back empty.
      const upc = upcFromGtin14(gtin14);
      const attempts: Record<string, string>[] = [{ gtin: gtin14 }, upc ? { upc } : { gtin: gtin14 }];
      for (let i = 0; i < SEARCH_ATTEMPTS; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, SEARCH_PAUSE_MS * i));
        const r = await walmartApiRequest(creds, '/items/walmart/search', attempts[i % attempts.length]);
        const items: any[] = Array.isArray(r?.items) ? r.items : [];
        const exact = items.filter(x => Array.isArray(x.standardUpc) && x.standardUpc.some((u: string) => toGtin14(String(u)) === gtin14));
        if (exact.length) return exact.map(x => toProduct(x, gtin14));
      }
      return [];
    },

    async ownCatalog(field, value) {
      const r = await walmartApiRequest(creds, '/items/catalog/search', undefined, 'POST', { query: { field, value } });
      const rows: any[] = Array.isArray(r?.payload) ? r.payload : [];
      return rows.map(x => ({
        sku: String(x.sku),
        itemId: x.itemId != null ? String(x.itemId) : (field === 'itemId' ? value : null),
        gtin14: x.gtin ? toGtin14(String(x.gtin)) : (x.upc ? toGtin14(String(x.upc)) : null),
        title: x.productName ?? null,
        publishedStatus: x.publishedStatus?.status ?? null,
        lifecycleStatus: x.lifecycleStatus ?? null,
        priceCents: x.price?.amount != null ? Math.round(Number(x.price.amount) * 100) : null,
      }));
    },

    async barcodeForItemId(itemId) {
      // The search takes no item-ID parameter, but a keyword query of the bare
      // item ID returns that item (checked Oct 8, 2026). Same corrupted-record
      // flakiness as the barcode search: a hit can come back with no
      // standardUpc, so retry until one carries it.
      for (let i = 0; i < SEARCH_ATTEMPTS; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, SEARCH_PAUSE_MS * i));
        const r = await walmartApiRequest(creds, '/items/walmart/search', { query: itemId });
        const items: any[] = Array.isArray(r?.items) ? r.items : [];
        const hit = items.find(x => String(x.itemId) === itemId && Array.isArray(x.standardUpc) && x.standardUpc.length);
        if (hit) return { itemId, upc: String(hit.standardUpc[0]).replace(/\D/g, ''), title: hit.title ?? null };
      }
      return null;
    },

    async fetchProductPage(itemId) {
      const res = await fetch(itemUrl(itemId), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { log.warn(`walmart.com/ip/${itemId} returned ${res.status}`); return null; }
      return parseProductPage(await res.text());
    },
  };
}

/** Pull the page's own product (not ads/recommendations) out of __NEXT_DATA__. */
export function parseProductPage(html: string): PageProduct | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const product = JSON.parse(m[1])?.props?.pageProps?.initialData?.data?.product;
    if (!product?.usItemId) return null;
    const upc = product.upc ? String(product.upc).replace(/\D/g, '') : '';
    return { itemId: String(product.usItemId), upc: upc || null, title: product.name ?? null };
  } catch {
    return null;
  }
}

// ── Resolver ─────────────────────────────────────────────────────────────────

async function existingSkuFor(deps: WalmartLookupDeps, itemId: string, gtin14: string): Promise<WalmartExistingSku | undefined> {
  try {
    const rows = await deps.ownCatalog('gtin', gtin14);
    const hit = rows.find(r => r.itemId === itemId) ?? rows[0];
    return hit ? { sku: hit.sku, publishedStatus: hit.publishedStatus, lifecycleStatus: hit.lifecycleStatus, priceCents: hit.priceCents ?? null } : undefined;
  } catch (err: any) {
    log.warn(`own-catalog check failed for ${gtin14}: ${err?.message}`);
    return undefined;
  }
}

async function resolveBarcode(deps: WalmartLookupDeps, gtin14: string): Promise<WalmartLookupResult> {
  const matches = await deps.searchByGtin(gtin14);
  if (matches.length === 0) return { ok: false, input: 'barcode', error: `No Walmart product has the barcode ${upcFromGtin14(gtin14) ?? gtin14}.` };
  const [product, ...others] = matches;
  return {
    ok: true,
    input: 'barcode',
    via: 'barcode',
    product,
    otherItems: others.length ? others : undefined,
    existing: await existingSkuFor(deps, product.itemId, gtin14),
    note: others.length ? `${matches.length} Walmart pages share this barcode — check the item ID before listing.` : undefined,
  };
}

async function resolveItemId(deps: WalmartLookupDeps, itemId: string): Promise<WalmartLookupResult> {
  // 1) An item this seller already has a SKU on: the seller API knows its barcode.
  const own = (await deps.ownCatalog('itemId', itemId).catch(() => [])).find(r => r.gtin14);
  if (own?.gtin14) {
    const confirmed = (await deps.searchByGtin(own.gtin14)).find(p => p.itemId === itemId);
    const existing: WalmartExistingSku = { sku: own.sku, publishedStatus: own.publishedStatus, lifecycleStatus: own.lifecycleStatus, priceCents: own.priceCents ?? null };
    if (confirmed) return { ok: true, input: 'itemId', via: 'own-catalog', product: confirmed, existing };
    // Retired/unpublished items can drop out of the public search; the seller
    // record is still authoritative for the item's own barcode.
    return {
      ok: true, input: 'itemId', via: 'own-catalog', existing,
      product: {
        itemId, gtin14: own.gtin14, upc: upcFromGtin14(own.gtin14), title: own.title ?? '',
        brand: null, productType: null, imageUrl: null, priceCents: null, url: itemUrl(itemId),
      },
      note: 'This item is not showing in Walmart\'s public catalog right now (it may be unpublished).',
    };
  }

  // 2) Anyone else's item: get its barcode from Walmart's API search (or, if
  //    that finds nothing, off walmart.com, which often serves a bot check),
  //    then confirm it with the barcode search.
  let page: PageProduct | null = null;
  try {
    page = await deps.barcodeForItemId(itemId);
  } catch (err: any) {
    log.warn(`Walmart item search failed for ${itemId}: ${err?.message}`);
  }
  if (!page?.upc) {
    try {
      page = await deps.fetchProductPage(itemId);
    } catch (err: any) {
      log.warn(`walmart.com page read failed for ${itemId}: ${err?.message}`);
    }
  }
  const unreadable = "Couldn't find that item's barcode on Walmart — scan or type the UPC instead.";
  if (!page?.upc) return { ok: false, input: 'itemId', error: unreadable };

  const gtin14 = toGtin14(page.upc);
  const matches = await deps.searchByGtin(gtin14);
  const confirmed = matches.find(p => p.itemId === page!.itemId);
  if (!confirmed) {
    return {
      ok: false, input: 'itemId',
      error: `walmart.com shows UPC ${page.upc} for item ${page.itemId}, but Walmart's catalog doesn't link that UPC to this item — scan the UPC on the box instead.`,
    };
  }
  return {
    ok: true, input: 'itemId', via: 'product-page', product: confirmed,
    existing: await existingSkuFor(deps, confirmed.itemId, gtin14),
    note: page.itemId !== itemId ? `walmart.com redirected item ${itemId} to item ${page.itemId}.` : undefined,
  };
}

export async function resolveWalmartProduct(raw: string, deps: WalmartLookupDeps): Promise<WalmartLookupResult> {
  const input = parseWalmartInput(raw);
  if (input.kind === 'invalid') return { ok: false, input: 'invalid', error: input.reason };
  if (input.kind === 'itemId') return resolveItemId(deps, input.itemId);

  const byBarcode = await resolveBarcode(deps, input.gtin14);
  if (byBarcode.ok || !input.maybeItemId) return byBarcode;
  const asItemId = await resolveItemId(deps, input.digits);
  return asItemId.ok ? asItemId : byBarcode;
}
