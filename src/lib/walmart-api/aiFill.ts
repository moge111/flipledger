/**
 * Ask Claude to fill the Walmart setup fields that neither walmart.com, Amazon
 * nor a remembered answer could fill (e.g. material, small-parts warning).
 * The answer is constrained to a JSON schema built from the fields themselves
 * (choice fields can only return Walmart's listed values) and every value is
 * re-checked here. Since Oct 8, 2026 (Parker: "have Haiku fill everything it
 * possibly can") Claude gives its best answer for every field, estimates
 * included (e.g. dimensions from the photo); null only when no sensible answer
 * exists. Suggestions are shown on the form as "suggested by Claude" — never
 * sent to Walmart without the user's click.
 *
 * Battery / electronics / chemical declarations are NOT asked here: those stay
 * evidence-based or the user's own answer (wfs-item-setup.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { createLogger } from '@/lib/log';
import type { FieldDescriptor } from './specForm';
import type { ProductPageDetails } from './productPage';

const log = createLogger('walmart-api/aiFill');

// Haiku at Parker's request (Oct 7, 2026): picking a material or a warning code
// from Walmart's list doesn't need a larger model. Haiku 5.5 (released Oct 7,
// 2026; structured outputs + effort per the Models API) replaced Haiku 4.5.
export const AI_FILL_MODEL = 'claude-haiku-5-5';

export function anthropicApiKey(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get() as { value: string } | undefined;
  return row?.value?.trim() || null;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** JSON schema for Claude's answer: one property per field, typed like the field. */
export function answerSchema(fields: FieldDescriptor[]) {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    let s: Record<string, unknown>;
    switch (f.kind) {
      case 'enum': s = { type: 'string', enum: f.options ?? [] }; break;
      case 'multi': s = { type: 'array', items: { type: 'string', enum: f.options ?? [] } }; break;
      case 'list': s = { type: 'array', items: { type: 'string' } }; break;
      case 'integer': s = { type: 'integer' }; break;
      case 'number': s = { type: 'number' }; break;
      case 'measure':
        s = {
          type: 'object',
          properties: { measure: { type: 'number' }, unit: { type: 'string', enum: f.units ?? [] } },
          required: ['measure', 'unit'],
          additionalProperties: false,
        };
        break;
      default: s = { type: 'string' };
    }
    properties[f.key] = nullable(s);
  }
  return { type: 'object', properties, required: fields.map(f => f.key), additionalProperties: false };
}

/** Keep only answers that fit the field (Claude's JSON is schema-constrained, but check anyway). */
export function acceptAnswer(f: FieldDescriptor, v: unknown): unknown {
  if (v == null) return null;
  switch (f.kind) {
    case 'enum': return typeof v === 'string' && f.options?.includes(v) ? v : null;
    case 'multi': {
      const arr = Array.isArray(v) ? v.filter(x => typeof x === 'string' && f.options?.includes(x)) : [];
      return arr.length ? arr : null;
    }
    case 'list': {
      const arr = Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
      return arr.length ? arr : null;
    }
    case 'integer': return Number.isInteger(v) ? v : null;
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? v : null;
    case 'measure': {
      const m = v as { measure?: unknown; unit?: unknown };
      return typeof m?.measure === 'number' && typeof m.unit === 'string' && f.units?.includes(m.unit) ? { measure: m.measure, unit: m.unit } : null;
    }
    default: return typeof v === 'string' && v.trim() ? v.trim() : null;
  }
}

const SYSTEM = `You fill in Walmart Marketplace item-setup fields for a retail product a reseller is listing.
Fill EVERY field with your best answer. The seller reviews each answer before anything is sent to Walmart, so a reasonable estimate is better than a blank.
Sources, best first: the product photo (read the packaging: age, warnings, contents, edition), the product information given, then what you know about this exact product (brand, model, set number, product line) and products like it.
Copy fields (siteDescription / shortDescription, keyFeatures): describe the product plainly from its title, brand, photo and what you know of it. Don't claim features you can't see or don't know.
Choice fields: answer only with one of the listed values. Measurements: give units exactly as listed.
Dimensions (assembled product height / width / depth / weight): the real size of the product if you know it; otherwise estimate it from the photo (e.g. hand-sized figures, the size of the box) and similar products. For a set sold and displayed in its box, use the boxed size.
Recommended ages: the minimum is the age printed on the packaging (e.g. "6+" = 6 years). If the product has no upper age limit, give a maximum of 99 years.
Small-parts warning (smallPartsWarnings): read the choking warning printed on the packaging ("CHOKING HAZARD – Small parts" = "3 - Choking hazard contains small parts"; small ball / balloon / marble have their own codes). If the warning panel isn't legible, decide from the product: a toy or game made of or containing small pieces (figures, mini figures, building pieces, game pieces, accessories) = 3; "0 - No warning applicable" only for items with no small pieces (e.g. a large plush, a game console, adult electronics).
Material: what the product is made of (e.g. vinyl or plastic figures, plastic building bricks, polyester plush); a flocked/fuzzy coating doesn't change the base material.
Color: the product's main color as seen in the photo; an item in many colors is "Multicolor".
Only answer null when no sensible answer exists at all.`;

/**
 * The product photo, as base64 (Walmart's image CDN isn't behind the bot check
 * that walmart.com product pages are). Null when it can't be fetched — Claude
 * then works from the text alone.
 */
async function fetchImage(url: string | null | undefined): Promise<Anthropic.ImageBlockParam | null> {
  if (!url) return null;
  try {
    const sized = url.includes('walmartimages.com') && !url.includes('odnWidth') ? `${url}${url.includes('?') ? '&' : '?'}odnHeight=1000&odnWidth=1000&odnBg=FFFFFF` : url;
    const res = await fetch(sized, { signal: AbortSignal.timeout(10_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    if (!res.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return null;
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: type as 'image/jpeg', data } };
  } catch (err) {
    log.warn(`product photo fetch failed: ${(err as Error).message}`);
    return null;
  }
}

export async function suggestFields(apiKey: string, product: {
  title: string; brand: string | null; productType: string; page: ProductPageDetails | null; imageUrl?: string | null;
}, fields: FieldDescriptor[]): Promise<Record<string, unknown>> {
  if (fields.length === 0) return {};
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  const productInfo = {
    title: product.title,
    brand: product.brand,
    walmartProductType: product.productType,
    description: product.page?.shortDescription ?? null,
    keyFeatures: product.page?.keyFeatures ?? [],
    specifications: product.page?.specs ?? [],
    warnings: product.page?.warnings ?? [],
  };
  const fieldInfo = fields.map(f => ({
    key: f.key, title: f.title, description: f.description,
    ...(f.options ? { allowedValues: f.options } : {}),
    ...(f.units ? { allowedUnits: f.units } : {}),
  }));

  const image = await fetchImage(product.page?.images?.[0] ?? product.imageUrl);
  const text = `Product:\n${JSON.stringify(productInfo, null, 1)}\n\nFields to fill:\n${JSON.stringify(fieldInfo, null, 1)}`;

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: AI_FILL_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: answerSchema(fields) } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: image ? [image, { type: 'text', text }] : text,
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key in Settings was rejected.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit hit — try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude request failed (${err.status}).`);
    throw err;
  }
  if (response.stop_reason === 'refusal') {
    log.warn(`Claude declined to suggest fields for "${product.title}"`);
    return {};
  }
  const answerText = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(answerText); } catch { log.warn(`Claude returned unparseable JSON for "${product.title}"`); return {}; }

  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = acceptAnswer(f, raw[f.key]);
    if (v != null) out[f.key] = v;
  }
  log.info(`answered ${Object.keys(out).length} of ${fields.length} field(s) for "${product.title.slice(0, 60)}"${image ? ' (with photo)' : ''} — ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`);
  return out;
}
