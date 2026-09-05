/**
 * Validated readers for query-string parameters that end up inside SQL.
 *
 * Several report routes splice the `marketplace` filter straight into their
 * query text (`AND o.marketplace = '${marketplace}'`). Binding it everywhere
 * would mean re-threading the parameter lists of ~30 hand-built queries, so
 * instead the value is allow-listed here: anything that is not a known
 * marketplace is treated as "no filter", which is what an empty param already
 * meant. This is a single-user local app, but a closed set is still the right
 * shape for a value that reaches SQL.
 */
export const MARKETPLACES = ['amazon', 'walmart', 'ebay', 'paypal'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export function isMarketplace(v: string | null | undefined): v is Marketplace {
  return !!v && (MARKETPLACES as readonly string[]).includes(v);
}

/** The `marketplace` query param if it is a known marketplace, else null. */
export function marketplaceParam(searchParams: URLSearchParams): Marketplace | null {
  const v = searchParams.get('marketplace');
  return isMarketplace(v) ? v : null;
}
