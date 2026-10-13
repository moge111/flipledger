/**
 * Walmart SKU setup from a listing batch — one feed per item, like Amazon:
 *
 *   WFS_NEW      no SKU yet, WFS batch       → MP_WFS_ITEM (direct WFS setup)
 *   WFS_CONVERT  seller-fulfilled SKU, WFS   → OMNI_WFS (switch to WFS)
 *   SF_NEW       no SKU yet, seller-fulfilled → MP_ITEM_MATCH 4.2 (offer on the existing page)
 *
 * The WFS feeds are built from Walmart's current spec (specForm.ts). The
 * offer-match feed is small and fixed (sku, GTIN, price, shipping weight,
 * condition); its 4.2 version is what worked live on Oct 7, 2026.
 *
 * An item's setup is PENDING until Walmart's feed reports the item SUCCESS
 * (READY) or an error (FAILED, with Walmart's message). The feed is kept so a
 * failure can be resubmitted as-is.
 *
 * Not handled (Walmart needs documents FlipLedger doesn't collect): lithium
 * batteries, chemicals/aerosols/pesticides, Prop 65 warnings.
 */
import { walmartFetch } from './auth';
import type { WalmartCredentials } from './types';

export const MATCH_VERSION = '4.2';
export const NO_BATTERY = 'Does Not Contain a Battery';
export const LITHIUM_TYPES = ['Lithium Ion', 'Lithium Primary (Lithium Metal)'];

export type SetupKind = 'WFS_NEW' | 'WFS_CONVERT' | 'SF_NEW';
export type SetupStatus = 'PENDING' | 'READY' | 'FAILED';
export type FeedType = 'MP_WFS_ITEM' | 'OMNI_WFS' | 'MP_ITEM_MATCH';

export const FEED_FOR_KIND: Record<SetupKind, FeedType> = {
  WFS_NEW: 'MP_WFS_ITEM',
  WFS_CONVERT: 'OMNI_WFS',
  SF_NEW: 'MP_ITEM_MATCH',
};

export interface SetupState {
  status: SetupStatus;
  kind: SetupKind;
  feedType: FeedType;
  feedId: string;
  sku: string;
  gtin14: string;
  /** The feed body that was sent, kept for Retry. */
  feed: unknown;
  error?: string;
  /** Walmart's compliance-review note while an item is held, if any. */
  pending?: string;
  updatedAt: string;
}

/** Declarations FlipLedger can't submit; empty when fine. */
export function unsupportedReasons(f: { batteryType: string; batterySize?: string; isChemical?: boolean; isAerosol?: boolean; isPesticide?: boolean; prop65?: boolean }): string[] {
  const out: string[] = [];
  if (LITHIUM_TYPES.includes(f.batteryType)) out.push('Lithium batteries need battery specs (cells, watt-hours, weight) — set this item up in Seller Center.');
  else if (f.batteryType && f.batteryType !== NO_BATTERY && !f.batterySize) out.push('Choose the battery size.');
  if (f.isChemical || f.isAerosol || f.isPesticide) out.push('Chemicals, aerosols and pesticides need a safety data sheet — set this item up in Seller Center.');
  if (f.prop65) out.push('Items with a Prop 65 warning need the warning text — set this item up in Seller Center.');
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Seller-fulfilled offer on an existing Walmart page. */
export function buildMatchFeed(f: { sku: string; gtin14: string; priceDollars: number; shippingWeightLb: number }) {
  return {
    MPItemFeedHeader: { processMode: 'REPLACE', subset: 'EXTERNAL', locale: 'en', sellingChannel: 'mpsetupbymatch', version: MATCH_VERSION },
    MPItem: [{
      Item: {
        sku: f.sku,
        productIdentifiers: { productIdType: 'GTIN', productId: f.gtin14 },
        price: r2(f.priceDollars),
        ShippingWeight: r2(f.shippingWeightLb),
        condition: 'New',
      },
    }],
  };
}

export async function submitFeed(creds: WalmartCredentials, feedType: FeedType, body: unknown): Promise<string> {
  const r = await walmartFetch(creds, '/feeds', { method: 'POST', params: { feedType }, body });
  const feedId = r.json?.feedId;
  if (!feedId) throw new Error(`Walmart accepted the ${feedType} feed but returned no feed id.`);
  return String(feedId);
}

export interface FeedItemResult {
  state: 'PENDING' | 'SUCCESS' | 'FAILED';
  errors: string[];
  pending?: string;
}

export function readFeedResult(json: any, sku: string): FeedItemResult {
  const items: any[] = json?.itemDetails?.itemIngestionStatus ?? [];
  const item = items.find(i => i.sku === sku) ?? items[0];
  const errorsOf = (e: any) => (e?.ingestionErrors?.ingestionError ?? []).map((x: any) => x.description || x.code).filter(Boolean);
  if (item) {
    if (item.ingestionStatus === 'SUCCESS') return { state: 'SUCCESS', errors: [] };
    if (item.ingestionStatus === 'INPROGRESS') return { state: 'PENDING', errors: [], pending: item.pendingStatusDescription };
    return { state: 'FAILED', errors: errorsOf(item).length ? errorsOf(item) : [item.ingestionStatus] };
  }
  if (json?.feedStatus === 'ERROR') return { state: 'FAILED', errors: errorsOf(json).length ? errorsOf(json) : ['Walmart rejected the feed.'] };
  return { state: 'PENDING', errors: [] };
}

export async function getFeedResult(creds: WalmartCredentials, feedId: string, sku: string): Promise<FeedItemResult> {
  const r = await walmartFetch(creds, `/feeds/${encodeURIComponent(feedId)}`, { params: { includeDetails: 'true' } });
  return readFeedResult(r.json, sku);
}

/**
 * Walmart errors that need the seller to act outside FlipLedger, with what to do.
 * ERR_EXT_DATA_00010733 (consumableGtin) was hit live on Oct 7, 2026 with an
 * OMNI_WFS feed on the outdated 5.0.20250121 spec; Seller Center's conversion
 * on 5.0.20260803 then worked. Specs now come from Walmart's recommended list.
 */
export function explainSetupErrors(errors: string[], s: Pick<SetupState, 'sku' | 'gtin14'>): string {
  const text = errors.join('; ');
  if (/Duplicate items found/i.test(text)) {
    return `${text} Try "Convert to WFS" on SKU ${s.sku} in Seller Center (that worked for LEGO 75389); if it fails there too, ` +
      `open a Seller Support case quoting ERR_EXT_DATA_00010733 (consumableGtin), SKU ${s.sku}, GTIN ${s.gtin14}.`;
  }
  return text;
}

const VERB: Record<SetupKind, string> = {
  WFS_NEW: 'create the WFS item',
  WFS_CONVERT: 'switch the item to WFS',
  SF_NEW: 'create the offer',
};

/** Check Walmart once and return the next state. */
export async function advanceSetup(state: SetupState, deps: {
  feedResult(feedId: string, sku: string): Promise<FeedItemResult>;
  now(): string;
}): Promise<SetupState> {
  if (state.status !== 'PENDING') return state;
  const r = await deps.feedResult(state.feedId, state.sku);
  if (r.state === 'PENDING') return { ...state, pending: r.pending, updatedAt: deps.now() };
  if (r.state === 'FAILED') {
    return { ...state, status: 'FAILED', pending: undefined, error: `Walmart didn't ${VERB[state.kind]}: ${explainSetupErrors(r.errors, state)}`, updatedAt: deps.now() };
  }
  return { ...state, status: 'READY', pending: undefined, error: undefined, updatedAt: deps.now() };
}
