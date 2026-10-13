/**
 * Product content from a walmart.com product page, used to fill Walmart's item
 * setup without retyping what Walmart already shows. The page is not an API
 * (it can change or be blocked), so everything here is best effort: a missing
 * value just becomes a field the user fills in.
 *
 * Source: the __NEXT_DATA__ JSON, props.pageProps.initialData.data:
 *   product.{usItemId, upc, name, brand, shortDescription, imageInfo.allImages}
 *   idml.{shortDescription, longDescription (HTML <li> list), specifications,
 *         specificationsV2, productHighlights, warnings, warranty}
 * (checked on LEGO 75389, item 5298070748, Oct 7, 2026).
 */
export interface PageSpec { name: string; value: string }

export interface ProductPageDetails {
  itemId: string;
  upc: string | null;
  title: string | null;
  brand: string | null;
  shortDescription: string | null;
  keyFeatures: string[];
  images: string[];
  specs: PageSpec[];
  warnings: PageSpec[];
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Accept': 'text/html',
  'Accept-Language': 'en-US',
};

export async function fetchProductPageHtml(itemId: string): Promise<string | null> {
  const res = await fetch(`https://www.walmart.com/ip/${itemId}`, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  return res.ok ? res.text() : null;
}

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseProductDetails(html: string): ProductPageDetails | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data: any;
  try { data = JSON.parse(m[1])?.props?.pageProps?.initialData?.data; } catch { return null; }
  const product = data?.product;
  if (!product?.usItemId) return null;
  const idml = data.idml ?? {};

  const longHtml: string = idml.longDescription ?? '';
  const bullets = [...longHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => stripTags(x[1])).filter(Boolean);
  const shortHtml: string = idml.shortDescription ?? product.shortDescription ?? '';

  const specs: PageSpec[] = [];
  const seen = new Set<string>();
  const addSpec = (name: unknown, value: unknown) => {
    const n = String(name ?? '').trim();
    const v = Array.isArray(value) ? value.join('; ') : String(value ?? '').trim();
    if (!n || !v || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    specs.push({ name: n, value: v });
  };
  for (const s of idml.specifications ?? []) addSpec(s.name, s.value);
  for (const g of idml.specificationsV2 ?? []) for (const s of g.specificationGroup ?? []) addSpec(s.displayName, s.attributeValue);
  for (const s of idml.productHighlights ?? []) addSpec(s.name, s.value);

  return {
    itemId: String(product.usItemId),
    upc: product.upc ? String(product.upc) : null,
    title: product.name ?? null,
    brand: product.brand ?? null,
    shortDescription: shortHtml ? stripTags(shortHtml) : null,
    keyFeatures: bullets,
    images: (product.imageInfo?.allImages ?? []).map((i: any) => i.url).filter(Boolean),
    specs,
    warnings: (idml.warnings ?? []).map((w: any) => ({ name: String(w.name ?? ''), value: String(w.value ?? '') })),
  };
}
