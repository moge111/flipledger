/**
 * Spec-driven Walmart item setup. Walmart's required fields depend on the feed
 * type, the spec version (they change every few months) and the product type,
 * so nothing here is hard-coded per category:
 *
 *   1. read the current spec for the product type (POST /v3/items/spec, cached)
 *   2. turn every required product-detail field into a form field
 *   3. fill what we can: the walmart.com page, Amazon's catalog, fixed
 *      defaults, and the user's last answer for that product type
 *   4. assemble the feed and validate it against Walmart's own JSON schema
 *      (ajv) BEFORE sending, so a missing field is a form message, not a
 *      rejected feed an hour later.
 *
 * Why the version matters (Oct 7, 2026): an OMNI_WFS feed on the 5.0.20250121
 * spec (the one in Walmart's docs examples) failed twice with
 * "Duplicate items found … consumableGtin" on LEGO 75389; Seller Center's own
 * conversion of the same SKU minutes later used 5.0.20260803 and succeeded.
 */
import Ajv from 'ajv';
import type Database from 'better-sqlite3';
import { walmartFetch } from './auth';
import type { WalmartCredentials } from './types';
import type { ProductPageDetails } from './productPage';

export type SetupFeedType = 'MP_WFS_ITEM' | 'OMNI_WFS';

/** Walmart's recommended versions on Oct 7, 2026; used when the docs page can't be read. */
export const FALLBACK_VERSIONS: Record<SetupFeedType, string> = {
  MP_WFS_ITEM: '5.0.20260803-17_50_56-api',
  OMNI_WFS: '5.0.20260803-17_50_56-api',
};

const VERSIONS_URL = 'https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting.md';

/** Recommended version per feed type from the "Item spec: versioning" table. */
export function parseRecommendedVersions(markdown: string): Partial<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of markdown.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 3) continue;
    const version = cells[2].match(/\d+\.\d+\.\d{8}-\d{2}_\d{2}_\d{2}-api/)?.[0];
    if (version && /^[A-Z_]+$/.test(cells[1])) out[cells[1]] = version;
  }
  return out;
}

export async function recommendedVersion(db: Database.Database, feedType: SetupFeedType): Promise<string> {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'walmart_spec_versions'").get() as { value: string } | undefined;
  let cached: { fetchedAt: string; versions: Record<string, string> } | null = null;
  try { cached = row ? JSON.parse(row.value) : null; } catch { cached = null; }
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < 86400000;
  if (!fresh) {
    try {
      const res = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(10000) });
      const versions = res.ok ? parseRecommendedVersions(await res.text()) : {};
      if (versions.MP_WFS_ITEM || versions.OMNI_WFS) {
        cached = { fetchedAt: new Date().toISOString(), versions: versions as Record<string, string> };
        db.prepare(`INSERT INTO settings (key, value) VALUES ('walmart_spec_versions', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cached));
      }
    } catch { /* keep the cached or fallback version */ }
  }
  return cached?.versions?.[feedType] ?? FALLBACK_VERSIONS[feedType];
}

export async function getItemSpec(db: Database.Database, creds: WalmartCredentials, feedType: SetupFeedType, version: string, productType: string): Promise<any> {
  const hit = db.prepare(`SELECT spec FROM walmart_item_specs WHERE feed_type = ? AND version = ? AND product_type = ? AND fetched_at > datetime('now', '-30 days')`)
    .get(feedType, version, productType) as { spec: string } | undefined;
  if (hit) return JSON.parse(hit.spec);
  const r = await walmartFetch(creds, '/items/spec', { method: 'POST', body: { feedType, version, productTypes: [productType] } });
  const spec = r.json?.schema;
  if (!spec) throw new Error(`Walmart returned no ${feedType} spec for "${productType}".`);
  db.prepare(`INSERT INTO walmart_item_specs (feed_type, version, product_type, spec, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(feed_type, version, product_type) DO UPDATE SET spec = excluded.spec, fetched_at = excluded.fetched_at`)
    .run(feedType, version, productType, JSON.stringify(spec));
  return spec;
}

// ── Spec layout ──────────────────────────────────────────────────────────────

export interface SpecLayout {
  headerKey: string;
  itemsKey: string;
  visible: any;      // Visible[productType] schema
  orderable: any;
  trade: any;
}

export function specLayout(spec: any, feedType: SetupFeedType, productType: string): SpecLayout {
  const headerKey = feedType === 'OMNI_WFS' ? 'SupplierItemFeedHeader' : 'MPItemFeedHeader';
  const itemsKey = feedType === 'OMNI_WFS' ? 'SupplierItem' : 'MPItem';
  const item = spec?.properties?.[itemsKey]?.items?.properties ?? {};
  const visible = item.Visible?.properties?.[productType];
  if (!visible) throw new Error(`Walmart's ${feedType} spec has no product type "${productType}".`);
  return { headerKey, itemsKey, visible, orderable: item.Orderable ?? {}, trade: item.TradeItem ?? {} };
}

// ── Form fields ──────────────────────────────────────────────────────────────

export type FieldKind = 'text' | 'longtext' | 'list' | 'enum' | 'multi' | 'integer' | 'number' | 'measure';
export type FieldSource = 'walmart' | 'amazon' | 'default' | 'remembered' | 'ai';

export interface FieldDescriptor {
  key: string;
  title: string;
  description?: string;
  kind: FieldKind;
  options?: string[];
  units?: string[];
  measureKey?: string;
  unitKey?: string;
  integer?: boolean;
  required: boolean;
  value: unknown;              // form-shaped: string | string[] | number | {measure, unit}
  source: FieldSource | null;
}

/** Form field for one schema property, or null when the shape isn't one we can edit. */
export function describeField(key: string, schema: any, required: boolean): FieldDescriptor | null {
  if (!schema || typeof schema !== 'object') return null;
  const base = { key, title: schema.title || key, description: (schema.description || '').slice(0, 300), required, value: null, source: null };
  if (schema.type === 'string' && Array.isArray(schema.enum)) return { ...base, kind: 'enum', options: schema.enum };
  if (schema.type === 'string') return { ...base, kind: !/url/i.test(key) && ((schema.maxLength ?? 0) > 300 || /description/i.test(key)) ? 'longtext' : 'text' };
  if (schema.type === 'integer') return { ...base, kind: 'integer' };
  if (schema.type === 'number') return { ...base, kind: 'number' };
  if (schema.type === 'array') {
    const items = schema.items ?? {};
    if (Array.isArray(items.enum)) return { ...base, kind: 'multi', options: items.enum };
    if (items.type === 'string') return { ...base, kind: 'list' };
    return null;
  }
  if (schema.type === 'object' && schema.properties) {
    const keys = Object.keys(schema.properties);
    const numKey = keys.find(k => ['number', 'integer'].includes(schema.properties[k].type));
    const unitKey = keys.find(k => schema.properties[k].type === 'string' && Array.isArray(schema.properties[k].enum));
    if (numKey && unitKey && keys.length === 2) {
      return { ...base, kind: 'measure', measureKey: numKey, unitKey, units: schema.properties[unitKey].enum, integer: schema.properties[numKey].type === 'integer' };
    }
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (key: string) => key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

/** Extra names Walmart's page uses for a spec field. */
const PAGE_ALIASES: Record<string, string[]> = {
  pieceCount: ['piece count', 'number of pieces'],
  minimumRecommendedAge: ['minimum recommended age'],
  maximumRecommendedAge: ['maximum recommended age'],
  ageGroup: ['age group'],
  material: ['material', 'materials'],
  color: ['color'],
  gender: ['gender'],
  character: ['character'],
};

/** Convert a free-text page value into the field's shape; null when it doesn't fit. */
export function coercePageValue(f: FieldDescriptor, raw: string): unknown {
  const v = raw.trim();
  if (!v) return null;
  const pick = (opt: string[] | undefined, s: string) => opt?.find(o => norm(o) === norm(s)) ?? null;
  switch (f.kind) {
    case 'text': case 'longtext': return v;
    case 'list': return v.split(/\s*;\s*/).filter(Boolean);
    case 'enum': return pick(f.options, v);
    case 'multi': {
      const vals = v.split(/\s*[;,]\s*/).map(s => pick(f.options, s)).filter((x): x is string => !!x);
      return vals.length ? vals : null;
    }
    case 'integer': case 'number': {
      const n = Number(v.match(/-?\d+(\.\d+)?/)?.[0]);
      return Number.isFinite(n) ? (f.kind === 'integer' ? Math.round(n) : n) : null;
    }
    case 'measure': {
      const n = Number(v.match(/-?\d+(\.\d+)?/)?.[0]);
      if (!Number.isFinite(n)) return null;
      let unit = f.units?.find(u => new RegExp(`\\b${u.replace(/[^a-z0-9]/gi, '')}`, 'i').test(v)) ?? null;
      if (!unit && /age/i.test(f.key)) unit = f.units?.find(u => /year/i.test(u)) ?? null;
      if (!unit && f.units?.length === 1) unit = f.units[0];
      return unit ? { measure: f.integer ? Math.round(n) : n, unit } : null;
    }
  }
}

export interface FillContext {
  page: ProductPageDetails | null;
  catalog: { title: string; brand: string | null; imageUrl: string | null };
  remembered: Record<string, unknown>;
}

/** Value + source for a Visible field, or nulls when nothing fits. */
export function fillVisibleField(f: FieldDescriptor, ctx: FillContext): { value: unknown; source: FieldSource | null } {
  const page = ctx.page;
  const fixed = (value: unknown, source: FieldSource = 'default') => ({ value, source });
  switch (f.key) {
    case 'productName': return fixed(page?.title || ctx.catalog.title, 'walmart');
    case 'brand': return fixed(page?.brand || ctx.catalog.brand, 'walmart');
    case 'shortDescription': {
      const d = page?.shortDescription || page?.keyFeatures.join(' ');
      return d ? fixed(d, 'walmart') : { value: null, source: null };
    }
    case 'keyFeatures': return page?.keyFeatures.length ? fixed(page.keyFeatures, 'walmart') : { value: null, source: null };
    case 'mainImageUrl': {
      const img = page?.images[0] || (ctx.catalog.imageUrl ? ctx.catalog.imageUrl.split('?')[0] : null);
      return img ? fixed(img, 'walmart') : { value: null, source: null };
    }
    case 'productSecondaryImageURL': return page?.images.length ? fixed(page.images.slice(1, 9), 'walmart') : { value: null, source: null };
    case 'countPerPack': return fixed(f.kind === 'integer' ? 1 : '1');
    case 'isProp65WarningRequired': return fixed('No');
    case 'condition': return fixed(f.options?.includes('New') ? 'New' : null);
    case 'has_written_warranty': return fixed(f.options?.includes('No') ? 'No' : null);
    case 'netContent': {
      const unit = f.units?.includes('Count') ? 'Count' : f.units?.includes('Each') ? 'Each' : null;
      return unit ? fixed({ measure: 1, unit }) : { value: null, source: null };
    }
  }
  if (page) {
    const names = new Set([f.title, words(f.key), ...(PAGE_ALIASES[f.key] ?? [])].map(norm));
    const spec = page.specs.find(s => names.has(norm(s.name)));
    if (spec) {
      const v = coercePageValue(f, spec.value);
      if (v != null) return { value: v, source: 'walmart' };
    }
  }
  if (ctx.remembered[f.key] != null) return { value: ctx.remembered[f.key], source: 'remembered' };
  return { value: null, source: null };
}

/**
 * Required Visible fields as form fields, filled where possible. Unsupported
 * required shapes are listed. `extraRequired` adds fields that are required
 * only conditionally (if/then in the schema) — found by validating a draft.
 */
export function buildVisibleFields(layout: SpecLayout, ctx: FillContext, extraRequired: string[] = []): { fields: FieldDescriptor[]; unsupported: string[]; silent: Record<string, unknown> } {
  const props = layout.visible.properties ?? {};
  const required: string[] = [...new Set([...(layout.visible.required ?? []), ...extraRequired.filter(k => k in props)])];
  const fields: FieldDescriptor[] = [];
  const unsupported: string[] = [];
  for (const key of required) {
    const d = describeField(key, props[key], true);
    if (!d) { unsupported.push(props[key]?.title || key); continue; }
    const { value, source } = fillVisibleField(d, ctx);
    fields.push({ ...d, value, source });
  }
  // Optional extras worth sending when we have them (not shown on the form).
  const silent: Record<string, unknown> = {};
  if (props.productSecondaryImageURL && !required.includes('productSecondaryImageURL')) {
    const d = describeField('productSecondaryImageURL', props.productSecondaryImageURL, false);
    const v = d ? fillVisibleField(d, ctx).value : null;
    if (Array.isArray(v) && v.length) silent.productSecondaryImageURL = v;
  }
  return { fields, unsupported, silent };
}

/** Form value → the shape the schema wants. Returns undefined for an empty value. */
export function toSchemaValue(f: FieldDescriptor, v: unknown): unknown {
  if (v == null || v === '') return undefined;
  switch (f.kind) {
    case 'text': case 'longtext': case 'enum': { const s = String(v).trim(); return s || undefined; }
    case 'list': {
      const arr = (Array.isArray(v) ? v : String(v).split('\n')).map(x => String(x).trim()).filter(Boolean);
      return arr.length ? arr : undefined;
    }
    case 'multi': {
      const arr = (Array.isArray(v) ? v : [v]).map(String).filter(x => !f.options || f.options.includes(x));
      return arr.length ? arr : undefined;
    }
    case 'integer': { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : undefined; }
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
    case 'measure': {
      const m = v as { measure?: unknown; unit?: unknown };
      const n = Number(m?.measure);
      if (!Number.isFinite(n) || !m?.unit) return undefined;
      return { [f.measureKey!]: f.integer ? Math.round(n) : n, [f.unitKey!]: String(m.unit) };
    }
  }
}

// ── Feed assembly + validation ───────────────────────────────────────────────

export interface CoreFields {
  sku: string;
  gtin14: string;
  priceDollars: number;
  shippingWeightLb: number;
  unit: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number };
  countryOfOrigin: string;
  batteryType: string;
  batterySize?: string;
  electronics: boolean;
  isChemical: boolean;
  isAerosol: boolean;
  isPesticide: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const yn = (b: boolean) => (b ? 'Yes' : 'No');

export function buildSetupFeed(opts: {
  feedType: SetupFeedType; version: string; productType: string; layout: SpecLayout;
  core: CoreFields; visible: Record<string, unknown>;
}) {
  const { core, layout } = opts;
  const op = layout.orderable.properties ?? {};
  const has = (k: string) => k in op;
  const hasBattery = core.batteryType && core.batteryType !== 'Does Not Contain a Battery';
  const orderable: Record<string, unknown> = {
    sku: core.sku,
    productIdentifiers: { productIdType: 'GTIN', productId: core.gtin14 },
    price: r2(core.priceDollars),
    stateRestrictions: [{ stateRestrictionsText: 'None' }],
    electronicsIndicator: yn(core.electronics),
    batteryTechnologyType: core.batteryType,
  };
  if (hasBattery) {
    if (has('hasBatteries')) orderable.hasBatteries = 'Yes';
    if (has('batterySize') && core.batterySize) orderable.batterySize = core.batterySize;
  }
  if (has('isChemical')) { orderable.isChemical = yn(core.isChemical); orderable.isAerosol = yn(core.isAerosol); orderable.isPesticide = yn(core.isPesticide); }
  else if (has('chemicalAerosolPesticide')) orderable.chemicalAerosolPesticide = yn(core.isChemical || core.isAerosol || core.isPesticide);
  if (has('ShippingWeight')) orderable.ShippingWeight = r2(core.shippingWeightLb);

  const tradeProps = layout.trade.properties ?? {};
  const eachReq: string[] = tradeProps.each?.required ?? [];
  const trade: Record<string, unknown> = {
    sku: core.sku,
    countryOfOriginAssembly: [core.countryOfOrigin],
    each: {
      eachDepth: r2(core.unit.lengthIn), eachWidth: r2(core.unit.widthIn),
      eachHeight: r2(core.unit.heightIn), eachWeight: r2(core.unit.weightLb),
      ...(eachReq.includes('eachGTIN') ? { eachGTIN: core.gtin14 } : {}),
    },
  };
  // Only send the GTIN on the trade item when the spec demands it.
  if ((layout.trade.required ?? []).includes('orderableGTIN')) trade.orderableGTIN = core.gtin14;

  return {
    [layout.headerKey]: { businessUnit: 'WALMART_US', locale: 'en', version: opts.version },
    [layout.itemsKey]: [{ Orderable: orderable, Visible: { [opts.productType]: opts.visible }, TradeItem: trade }],
  };
}

// multipleOfPrecision: without it 1.15 fails "multiple of 0.0001" (1.15 / 0.0001 = 11499.999… in floating point).
const newAjv = () => new Ajv({ allErrors: true, jsonPointers: true, schemaId: 'auto', unknownFormats: 'ignore', multipleOfPrecision: 8 });

/** Visible fields the schema reports missing (catches if/then requirements). */
export function missingVisibleKeys(spec: any, feed: unknown, layout: SpecLayout): string[] {
  const ajv = newAjv();
  const validate = ajv.compile(spec);
  if (validate(feed)) return [];
  const props = layout.visible.properties ?? {};
  return [...new Set((validate.errors ?? [])
    .filter(e => e.keyword === 'required' && /\/Visible\//.test(e.dataPath || ''))
    .map(e => (e.params as any).missingProperty as string)
    .filter(k => k in props))];
}

/** Readable problems from validating the feed against Walmart's schema; empty when valid. */
export function validateFeed(spec: any, feed: unknown, layout: SpecLayout): string[] {
  const ajv = newAjv();
  const validate = ajv.compile(spec);
  if (validate(feed)) return [];
  const titleOf = (key: string) =>
    layout.visible.properties?.[key]?.title || layout.orderable.properties?.[key]?.title || layout.trade.properties?.[key]?.title || key;
  const msgs = new Set<string>();
  for (const e of validate.errors ?? []) {
    if (['oneOf', 'anyOf', 'if', 'allOf'].includes(e.keyword)) continue;
    const parts = (e.dataPath || '').split('/').filter(Boolean);
    const field = e.keyword === 'required' ? (e.params as any).missingProperty : parts.filter(p => !/^\d+$/.test(p)).pop() ?? '';
    const where = titleOf(field);
    if (e.keyword === 'required') msgs.add(`${where} is required`);
    else if (e.keyword === 'enum') msgs.add(`${where} must be one of Walmart's listed values`);
    else msgs.add(`${where} ${e.message}`);
  }
  return [...msgs];
}

// ── Remembered answers ───────────────────────────────────────────────────────

export function rememberedAnswers(db: Database.Database, productType: string): Record<string, unknown> {
  const rows = db.prepare('SELECT field_key, value FROM walmart_field_memory WHERE product_type = ?').all(productType) as { field_key: string; value: string }[];
  return Object.fromEntries(rows.map(r => { try { return [r.field_key, JSON.parse(r.value)]; } catch { return [r.field_key, null]; } }));
}

/** Save the user's answers for fields we couldn't fill, so the next item of this type is prefilled. */
export function rememberAnswers(db: Database.Database, productType: string, answers: Record<string, unknown>) {
  const up = db.prepare(`INSERT INTO walmart_field_memory (product_type, field_key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(product_type, field_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  for (const [k, v] of Object.entries(answers)) if (v != null) up.run(productType, k, JSON.stringify(v));
}
