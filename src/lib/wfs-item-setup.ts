/**
 * Server side of creating a Walmart SKU from a Walmart batch (WFS or seller
 * fulfilled): building the setup form, submitting it, and moving pending
 * setups forward (from the batch page while it's open, and from the auto-sync
 * tick so a closed tab doesn't stall them).
 */
import type Database from 'better-sqlite3';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';
import { generateMSKU } from '@/lib/listing-msku';
import { spApiRequest } from '@/lib/sp-api/auth';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import type { WalmartCatalogProduct } from '@/lib/walmart-api/catalogLookup';
import type { WalmartCredentials } from '@/lib/walmart-api/types';
import {
  advanceSetup, buildMatchFeed, FEED_FOR_KIND, getFeedResult, NO_BATTERY, submitFeed, unsupportedReasons,
  type SetupKind, type SetupState,
} from '@/lib/walmart-api/itemSetup';
import { fetchProductPageHtml, parseProductDetails, type ProductPageDetails } from '@/lib/walmart-api/productPage';
import { anthropicApiKey, suggestFields } from '@/lib/walmart-api/aiFill';
import {
  buildSetupFeed, buildVisibleFields, describeField, getItemSpec, missingVisibleKeys, recommendedVersion,
  rememberAnswers, rememberedAnswers, specLayout, toSchemaValue, validateFeed,
  type CoreFields, type FieldDescriptor, type SetupFeedType,
} from '@/lib/walmart-api/specForm';

const log = createLogger('wfs-item-setup');

/** Parker declares China for every product (Oct 7, 2026); still editable on the form. */
export const DEFAULT_COUNTRY = 'CN - China';

function amazonCredentials(db: Database.Database): SPAPICredentials | null {
  const s = Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
  if (!s.clientId || !s.clientSecret || !s.refreshToken) return null;
  return { clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken, marketplaceId: s.marketplaceId || 'ATVPDKIKX0DER' };
}

interface AmazonHints {
  asin: string;
  unit?: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number };
  hasBatteries?: boolean;
  /** Battery chemistry in Walmart's words ("Lithium Ion", "Alkaline"…), when Amazon states it. */
  batteryType?: string;
  /** Amazon's battery size codes (num_batteries type, e.g. "aa", "lr44"), for matching Walmart's size list. */
  batterySizes?: string[];
}

const inches = (d: any) => (d?.unit === 'centimeters' ? d.value / 2.54 : d?.value);
const pounds = (d: any) => (d?.unit === 'kilograms' ? d.value * 2.20462 : d?.unit === 'ounces' ? d.value / 16 : d?.value);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Package size/weight and battery flags from the Amazon catalog, by UPC. Best effort. */
export async function amazonHintsByUpc(db: Database.Database, upc: string): Promise<AmazonHints | null> {
  const creds = amazonCredentials(db);
  if (!creds) return null;
  try {
    const r = await spApiRequest(creds, '/catalog/2022-04-01/items', {
      identifiers: upc, identifiersType: upc.length === 13 ? 'EAN' : 'UPC', marketplaceIds: creds.marketplaceId,
      includedData: 'dimensions,attributes',
    });
    const it = r?.items?.[0];
    if (!it) return null;
    const pkg = it.dimensions?.[0]?.package;
    const attr = it.attributes ?? {};
    const unit = pkg?.length && pkg.width && pkg.height && pkg.weight ? {
      lengthIn: round2(inches(pkg.length)), widthIn: round2(inches(pkg.width)), heightIn: round2(inches(pkg.height)), weightLb: round2(pounds(pkg.weight)),
    } : undefined;
    const batteryType = amazonBatteryType(attr);
    return {
      asin: it.asin,
      unit: unit && Object.values(unit).every(v => v > 0) ? unit : undefined,
      hasBatteries: !!(batteryType || attr.batteries_required?.[0]?.value || attr.batteries_included?.[0]?.value),
      batteryType,
      batterySizes: (attr.num_batteries ?? []).map((n: any) => String(n?.type ?? '')).filter(Boolean),
    };
  } catch (err) {
    log.warn(`Amazon catalog lookup for ${upc} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Walmart's batteryTechnologyType for a chemistry written any common way
 * ("lithium_ion", "Li-ion", "Lithium Polymer", "NiMH", "Alkaline"…), or undefined.
 */
export function walmartBatteryType(text: string): string | undefined {
  const t = text.replace(/_/g, ' ').toLowerCase();
  if (/lithium[\s-]*(ion|polymer)|\bli[\s-]?(ion|po|poly)\b/.test(t)) return 'Lithium Ion';
  if (/lithium/.test(t)) return 'Lithium Primary (Lithium Metal)';
  if (/alkaline/.test(t)) return 'Alkaline';
  if (/nickel[\s-]*metal|\bni[\s-]?mh\b/.test(t)) return 'Nickel Metal Hydride';
  if (/nickel[\s-]*cadmium|\bni[\s-]?cd\b|\bnicad\b/.test(t)) return 'Nickel Cadmium';
  if (/lead[\s-]*acid/.test(t)) return /non[\s-]*spill/.test(t) ? 'Lead Acid (Non-Spillable)' : 'Lead Acid';
  if (/carbon[\s-]*zinc|zinc[\s-]*carbon/.test(t)) return 'Carbon Zinc';
  if (/silver/.test(t)) return 'Silver';
  if (/mercury/.test(t)) return 'Mercury';
  if (/magnesium/.test(t)) return 'Magnesium';
  return undefined;
}

/**
 * The battery chemistry Amazon's catalog states: battery.cell_composition first,
 * then the lithium cell counts. num_batteries' types are NOT used for this — on
 * real listings they mix junk ("12v", "p76") into a lithium-ion camera.
 */
export function amazonBatteryType(attr: Record<string, any>): string | undefined {
  for (const b of attr.battery ?? []) {
    for (const c of b?.cell_composition ?? []) {
      const type = walmartBatteryType(String(c?.value ?? ''));
      if (type) return type;
    }
  }
  if (Number(attr.number_of_lithium_ion_cells?.[0]?.value) > 0) return 'Lithium Ion';
  if (Number(attr.number_of_lithium_metal_cells?.[0]?.value) > 0) return 'Lithium Primary (Lithium Metal)';
  return undefined;
}

/** Battery type from Walmart's page specs ("Battery Type: Lithium Ion"), else Amazon's catalog. */
export function knownBatteryType(page: ProductPageDetails | null, amazon: AmazonHints | null): string | undefined {
  for (const s of page?.specs ?? []) {
    if (/batter/i.test(s.name) && /type|chemistry|technology/i.test(s.name)) {
      const type = walmartBatteryType(s.value);
      if (type) return type;
    }
  }
  return amazon?.batteryType;
}

/** One Walmart battery size matching Amazon's size codes, only when exactly one matches. */
export function knownBatterySize(amazon: AmazonHints | null, sizes: string[]): string {
  const bySize = new Map(sizes.map(s => [s.toUpperCase(), s]));
  const hits = new Set((amazon?.batterySizes ?? []).map(t => bySize.get(t.toUpperCase())).filter((s): s is string => !!s));
  return hits.size === 1 ? [...hits][0] : '';
}

/** A SKU in the user's usual style that isn't taken on Walmart or in FlipLedger. */
export async function freeSku(db: Database.Database, base: string, takenOnWalmart: (sku: string) => Promise<boolean>): Promise<string> {
  const takenLocally = (sku: string) => !!db.prepare('SELECT 1 FROM listing_batch_items WHERE sku = ? UNION SELECT 1 FROM inventory_ledger WHERE sku = ?').get(sku, sku);
  for (let n = 1; n < 20; n++) {
    const sku = n === 1 ? base : `${base}-${n}`;
    if (!takenLocally(sku) && !(await takenOnWalmart(sku))) return sku;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Whether the item contains a battery, from real data only. Walmart's page is
 * checked first (warnings like "This product contains a battery", specs such as
 * "Battery Type"), then Amazon's catalog. Unknown stays unknown — the user is
 * asked rather than FlipLedger declaring "no battery" to Walmart. (Oct 7, 2026:
 * the Polaroid Go Gen 2 has no Amazon record for its barcode and has a built-in
 * battery; the old default would have declared none.)
 */
export function batteryEvidence(page: ProductPageDetails | null, amazon: AmazonHints | null): { contains: boolean | null; why: string } {
  const mentions = [...(page?.warnings ?? []), ...(page?.specs ?? [])].filter(x => /batter/i.test(`${x.name} ${x.value}`));
  const negative = mentions.length > 0 && mentions.every(x => /batter/i.test(x.name) && /^(no|n|none|0|not included|does not contain a battery)$/i.test(x.value.trim()));
  if (mentions.length && !negative) return { contains: true, why: "Walmart's page says this item contains a battery — choose the type." };
  if (amazon?.hasBatteries) return { contains: true, why: 'Amazon lists this item with batteries — choose the type.' };
  if (negative || amazon) return { contains: false, why: negative ? "Walmart's page lists no battery." : 'Amazon lists no batteries for this item.' };
  return { contains: null, why: "FlipLedger couldn't find battery info for this item — please choose." };
}

export interface SetupForm {
  kind: SetupKind;
  productType: string;
  sku: string;
  skuLocked: boolean;
  priceDollars: number | null;
  shippingWeightLb: number | null;
  /** WFS only from here down. */
  unit: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number } | null;
  countryOfOrigin: string;
  countries: string[];
  batteryType: string;
  batteryTypes: string[];
  /** Pre-filled battery size, when Amazon's size code matches exactly one of Walmart's. */
  batterySize: string;
  batterySizes: string[];
  batteryHint: string | null;
  electronics: boolean;
  fields: FieldDescriptor[];
  /** Optional extras sent along unchanged (e.g. secondary images). */
  silent: Record<string, unknown>;
  /** Required fields of a shape the form can't edit — the item can't be set up here. */
  unsupported: string[];
  /** Everything is known from data: an existing SKU can be switched without showing the form. */
  autoReady: boolean;
  /** Why Claude didn't help with the empty fields (no key, request failed), if so. */
  aiNote: string | null;
}

function coreDefaults(form: Pick<SetupForm, 'sku' | 'priceDollars' | 'shippingWeightLb' | 'unit' | 'countryOfOrigin' | 'batteryType'>, gtin14: string): CoreFields {
  return {
    sku: form.sku, gtin14, priceDollars: form.priceDollars ?? 1, shippingWeightLb: form.shippingWeightLb ?? 1,
    unit: form.unit ?? { lengthIn: 1, widthIn: 1, heightIn: 1, weightLb: 1 },
    countryOfOrigin: form.countryOfOrigin, batteryType: form.batteryType || NO_BATTERY,
    electronics: false, isChemical: false, isAerosol: false, isPesticide: false,
  };
}

export async function buildSetupForm(db: Database.Database, creds: WalmartCredentials, product: WalmartCatalogProduct, opts: {
  kind: SetupKind; existingSku?: string; existingPriceCents?: number | null; supplier: string | null; buyPrice: number; ownSkuExists: (sku: string) => Promise<boolean>;
}): Promise<SetupForm> {
  if (!product.productType) throw new Error('Walmart did not report a product type for this item.');
  const upc = product.upc ?? product.gtin14.replace(/^0+/, '');
  const base = generateMSKU(opts.supplier || 'Walmart', product.title, opts.buyPrice) || `wm-${product.itemId}`;
  const sku = opts.existingSku ?? await freeSku(db, base, opts.ownSkuExists);
  const priceCents = opts.existingPriceCents || product.priceCents;
  const priceDollars = priceCents ? priceCents / 100 : null;

  if (opts.kind === 'SF_NEW') {
    const amazon = await amazonHintsByUpc(db, upc);
    return {
      kind: 'SF_NEW', productType: product.productType, sku, skuLocked: false, priceDollars,
      shippingWeightLb: amazon?.unit?.weightLb ?? null, unit: null, countryOfOrigin: '', countries: [],
      batteryType: '', batteryTypes: [], batterySize: '', batterySizes: [], batteryHint: null, electronics: false, fields: [], silent: {}, unsupported: [], autoReady: false, aiNote: null,
    };
  }

  const feedType = FEED_FOR_KIND[opts.kind] as SetupFeedType;
  const version = await recommendedVersion(db, feedType);
  const [spec, html, amazon] = await Promise.all([
    getItemSpec(db, creds, feedType, version, product.productType),
    fetchProductPageHtml(product.itemId).catch(() => null),
    amazonHintsByUpc(db, upc),
  ]);
  const page: ProductPageDetails | null = html ? parseProductDetails(html) : null;
  const layout = specLayout(spec, feedType, product.productType);
  const ctx = {
    page,
    catalog: { title: product.title, brand: product.brand, imageUrl: product.imageUrl },
    remembered: rememberedAnswers(db, product.productType),
  };

  const countries: string[] = layout.trade.properties?.countryOfOriginAssembly?.items?.enum ?? [];
  const battery = batteryEvidence(page, amazon);
  const batteryTypes: string[] = layout.orderable.properties?.batteryTechnologyType?.enum ?? [];
  const batterySizes: string[] = (layout.orderable.properties?.batterySize?.enum ?? []).slice().sort();
  // A stated chemistry is filled in (Parker, Oct 12: "if it can find the battery,
  // it should be inputting it"); "no battery" only when the evidence says none.
  const typeFound = knownBatteryType(page, amazon);
  const batteryType = typeFound && batteryTypes.includes(typeFound) ? typeFound : battery.contains === false ? NO_BATTERY : '';
  const filledType = batteryType && batteryType !== NO_BATTERY;
  const form: SetupForm = {
    kind: opts.kind, productType: product.productType, sku, skuLocked: !!opts.existingSku, priceDollars,
    shippingWeightLb: amazon?.unit?.weightLb ?? null,
    unit: amazon?.unit ?? null,
    countryOfOrigin: countries.includes(DEFAULT_COUNTRY) ? DEFAULT_COUNTRY : '',
    countries: countries.slice().sort(),
    batteryType,
    batteryTypes,
    batterySize: filledType ? knownBatterySize(amazon, batterySizes) : '',
    batterySizes,
    batteryHint: filledType ? `${batteryType} filled in from ${page?.specs.some(s => /batter/i.test(s.name) && walmartBatteryType(s.value)) ? "Walmart's page" : "Amazon's catalog"} — check it.` : battery.why,
    // A battery means electronic parts in practice; otherwise default No.
    electronics: battery.contains === true || !!filledType,
    fields: [], silent: {}, unsupported: [], autoReady: false, aiNote: null,
  };

  // Pass 1: the plainly required fields. Pass 2: whatever the schema still
  // reports missing once those are in (if/then requirements, e.g. Condition).
  let built = buildVisibleFields(layout, ctx);
  const draftVisible = (fields: FieldDescriptor[], silent: Record<string, unknown>) => {
    const v: Record<string, unknown> = { ...silent };
    for (const f of fields) { const x = toSchemaValue(f, f.value) ?? placeholderFor(f); if (x !== undefined) v[f.key] = x; }
    return v;
  };
  const draft = buildSetupFeed({ feedType, version, productType: product.productType, layout, core: coreDefaults(form, product.gtin14), visible: draftVisible(built.fields, built.silent) });
  const extra = missingVisibleKeys(spec, draft, layout);
  if (extra.length) built = buildVisibleFields(layout, ctx, extra);

  // Whatever is still empty: ask Claude (shown as a suggestion for the user to check).
  let aiNote: string | null = null;
  const empty = built.fields.filter(f => f.required && toSchemaValue(f, f.value) === undefined);
  if (empty.length) {
    const key = anthropicApiKey(db);
    if (!key) {
      aiNote = 'Add an Anthropic API key in Settings and FlipLedger will suggest answers for fields like these.';
    } else {
      try {
        const answers = await suggestFields(key, { title: product.title, brand: product.brand, productType: product.productType, page, imageUrl: product.imageUrl }, empty);
        built = { ...built, fields: built.fields.map(f => (f.key in answers ? { ...f, value: answers[f.key], source: 'ai' as const } : f)) };
      } catch (err) {
        aiNote = `Claude couldn't suggest answers: ${(err as Error).message}`;
        log.warn(`AI fill for ${product.itemId}: ${(err as Error).message}`);
      }
    }
  }
  const complete = built.unsupported.length === 0 && built.fields.every(f => !f.required || toSchemaValue(f, f.value) !== undefined);
  return {
    ...form, fields: built.fields, silent: built.silent, unsupported: built.unsupported,
    aiNote,
    // Claude's suggestions always need the user's look, so they never auto-submit.
    autoReady: opts.kind === 'WFS_CONVERT' && complete && !built.fields.some(f => f.source === 'ai') && !!form.unit && !!form.priceDollars && !!form.countryOfOrigin && form.batteryType === NO_BATTERY,
  };
}

/** A schema-valid stand-in so unanswered fields don't hide conditional requirements. */
function placeholderFor(f: FieldDescriptor): unknown {
  switch (f.kind) {
    case 'enum': return f.options?.[0];
    case 'multi': return f.options?.slice(0, 1);
    case 'list': return ['x'];
    case 'text': case 'longtext': return 'placeholder text';
    case 'integer': case 'number': return 1;
    case 'measure': return { [f.measureKey!]: 1, [f.unitKey!]: f.units?.[0] };
  }
}

export interface SetupInput {
  sku: string;
  priceDollars: number;
  shippingWeightLb: number;
  unit?: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number };
  countryOfOrigin?: string;
  batteryType?: string;
  batterySize?: string;
  electronics?: boolean;
  isChemical?: boolean;
  isAerosol?: boolean;
  isPesticide?: boolean;
  prop65?: boolean;
  visible?: Record<string, unknown>;
  silent?: Record<string, unknown>;
  /** Field keys the user filled themselves (remembered for the next item of this type). */
  askedKeys?: string[];
  /** Submit "Does Not Contain a Battery" even though Walmart's page / Amazon say otherwise (the user confirmed). */
  overrideBatteryEvidence?: boolean;
}

export type SubmitResult = { ok: true; state: SetupState } | { ok: false; status: number; error: string; problems?: string[]; batteryConflict?: boolean };

export async function submitSetup(db: Database.Database, creds: WalmartCredentials, product: WalmartCatalogProduct, kind: SetupKind, input: SetupInput): Promise<SubmitResult> {
  const sku = String(input.sku ?? '').trim();
  const price = Number(input.priceDollars);
  const shipWeight = Number(input.shippingWeightLb);
  if (!sku || sku.length > 50) return { ok: false, status: 400, error: 'Enter a SKU (50 characters max).' };
  if (!(price > 0)) return { ok: false, status: 400, error: 'Enter the selling price.' };
  const now = new Date().toISOString();

  if (kind === 'SF_NEW') {
    if (!(shipWeight > 0)) return { ok: false, status: 400, error: 'Enter the shipping weight.' };
    const feed = buildMatchFeed({ sku, gtin14: product.gtin14, priceDollars: price, shippingWeightLb: shipWeight });
    const feedId = await submitFeed(creds, 'MP_ITEM_MATCH', feed);
    return { ok: true, state: { status: 'PENDING', kind, feedType: 'MP_ITEM_MATCH', feedId, sku, gtin14: product.gtin14, feed, updatedAt: now } };
  }

  const reasons = unsupportedReasons({
    batteryType: input.batteryType ?? '', batterySize: input.batterySize,
    isChemical: input.isChemical, isAerosol: input.isAerosol, isPesticide: input.isPesticide, prop65: input.prop65,
  });
  if (reasons.length) return { ok: false, status: 400, error: reasons.join(' ') };
  const unit = input.unit;
  if (!unit || ![unit.lengthIn, unit.widthIn, unit.heightIn, unit.weightLb].every(v => Number(v) > 0)) {
    return { ok: false, status: 400, error: "Enter the unit's box size and weight." };
  }
  if (!input.countryOfOrigin) return { ok: false, status: 400, error: 'Choose the country of origin.' };
  if (!input.batteryType) return { ok: false, status: 400, error: 'Choose the battery type.' };
  // Never declare "no battery" against the evidence (Oct 7, 2026: a Polaroid Go
  // Gen 2, built-in lithium battery, went to Walmart as "Does Not Contain a
  // Battery" because only the browser checked this).
  if (input.batteryType === NO_BATTERY) {
    const html = await fetchProductPageHtml(product.itemId).catch(() => null);
    const evidence = batteryEvidence(html ? parseProductDetails(html) : null, await amazonHintsByUpc(db, product.upc ?? product.gtin14.replace(/^0+/, '')));
    if (evidence.contains && !input.overrideBatteryEvidence) {
      return { ok: false, status: 400, batteryConflict: true, error: `${evidence.why.replace(/ — choose the type\.$/, '.')} Choose its battery type instead of "Does Not Contain a Battery".` };
    }
    // Parker, Oct 12: his call to override — logged so it can be found later.
    if (evidence.contains) log.warn(`${sku}: "Does Not Contain a Battery" submitted over the evidence (${evidence.why}) — user override`);
  }

  const feedType = FEED_FOR_KIND[kind] as SetupFeedType;
  const version = await recommendedVersion(db, feedType);
  const spec = await getItemSpec(db, creds, feedType, version, product.productType!);
  const layout = specLayout(spec, feedType, product.productType!);
  const props = layout.visible.properties ?? {};

  const visible: Record<string, unknown> = { ...(input.silent ?? {}) };
  for (const [key, raw] of Object.entries(input.visible ?? {})) {
    const d = describeField(key, props[key], true);
    if (!d) continue;
    const v = toSchemaValue(d, raw);
    if (v !== undefined) visible[key] = v;
  }
  const feed = buildSetupFeed({
    feedType, version, productType: product.productType!, layout, visible,
    core: {
      sku, gtin14: product.gtin14, priceDollars: price, shippingWeightLb: shipWeight > 0 ? shipWeight : Number(unit.weightLb),
      unit: { lengthIn: Number(unit.lengthIn), widthIn: Number(unit.widthIn), heightIn: Number(unit.heightIn), weightLb: Number(unit.weightLb) },
      countryOfOrigin: input.countryOfOrigin, batteryType: input.batteryType, batterySize: input.batterySize,
      electronics: !!input.electronics, isChemical: !!input.isChemical, isAerosol: !!input.isAerosol, isPesticide: !!input.isPesticide,
    },
  });
  const problems = validateFeed(spec, feed, layout);
  if (problems.length) return { ok: false, status: 400, error: `Walmart would reject this: ${problems.join('; ')}.`, problems };

  const feedId = await submitFeed(creds, feedType, feed);
  const asked = Object.fromEntries((input.askedKeys ?? []).filter(k => k in (input.visible ?? {})).map(k => [k, input.visible![k]]));
  rememberAnswers(db, product.productType!, asked);
  return { ok: true, state: { status: 'PENDING', kind, feedType, feedId, sku, gtin14: product.gtin14, feed, updatedAt: now } };
}

/** Advance every pending setup (optionally one batch). Returns how many changed. */
export async function advancePendingSetups(batchId?: number): Promise<{ checked: number; changed: number }> {
  const creds = getWalmartCredentials();
  if (!creds) return { checked: 0, changed: 0 };
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT id, walmart_setup FROM listing_batch_items
      WHERE walmart_setup_status = 'PENDING' ${batchId ? 'AND batch_id = ?' : ''}
    `).all(...(batchId ? [batchId] : [])) as { id: number; walmart_setup: string }[];
    let changed = 0;
    for (const row of rows) {
      const state = JSON.parse(row.walmart_setup) as SetupState;
      let next: SetupState;
      try {
        next = await advanceSetup(state, { feedResult: (feedId, sku) => getFeedResult(creds, feedId, sku), now: () => new Date().toISOString() });
      } catch (err) {
        log.warn(`setup for item ${row.id} (${state.sku}) not checked: ${(err as Error).message}`);
        continue;
      }
      if (next.status !== state.status || next.pending !== state.pending) {
        db.prepare('UPDATE listing_batch_items SET walmart_setup_status = ?, walmart_setup = ? WHERE id = ?').run(next.status, JSON.stringify(next), row.id);
        if (next.status !== state.status) {
          changed++;
          log.info(`Walmart setup ${state.sku} (${state.kind}): ${state.status} → ${next.status}${next.error ? ` (${next.error})` : ''}`);
        }
      }
    }
    return { checked: rows.length, changed };
  } finally {
    db.close();
  }
}

/** Resubmit a FAILED setup's feed unchanged (after the cause was fixed on Walmart's side). */
export async function retrySetup(creds: WalmartCredentials, state: SetupState): Promise<SetupState> {
  const feedId = await submitFeed(creds, state.feedType, state.feed);
  return { ...state, status: 'PENDING', feedId, error: undefined, pending: undefined, updatedAt: new Date().toISOString() };
}

/** The setup a fully known form would submit, untouched (used to switch an existing SKU without a form). */
export function setupFromForm(form: SetupForm): SetupInput {
  return {
    sku: form.sku, priceDollars: form.priceDollars ?? 0, shippingWeightLb: form.unit?.weightLb ?? 0, unit: form.unit ?? undefined,
    countryOfOrigin: form.countryOfOrigin, batteryType: form.batteryType, electronics: form.electronics,
    isChemical: false, isAerosol: false, isPesticide: false,
    visible: Object.fromEntries(form.fields.map(f => [f.key, f.value])), silent: form.silent, askedKeys: [],
  };
}
