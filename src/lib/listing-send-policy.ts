/**
 * Pure decision logic extracted from the send route so the listing/inbound
 * pipeline's hard-won behaviors are unit-testable (July 8, 2026 hardening:
 * this path had ZERO tests and every fix could silently regress).
 */

/**
 * How many 20s FNSKU polls the send waits before excluding a stuck listing.
 * First-time sends get the full 10-minute window (brand-new MSKUs genuinely
 * take that long). Once the user has approved a partial send they've said
 * "ship without stragglers" — a 2-minute grace still catches an almost-ready
 * listing without re-imposing the full wait for a known-stuck one.
 */
export function fnskuMaxAttempts(allowPartial: boolean): number {
  return allowPartial ? 6 : 30;
}

/**
 * Is this createInboundPlan error just Amazon's eventual consistency —
 * i.e. the MSKUs/prep exist but haven't propagated to the Inbound Plans
 * service yet? These are retried with a delay; anything else is a real
 * problem (bad ASIN, missing attributes, permissions) and fails fast.
 */
export function isPropagationError(errStr: string): boolean {
  return (
    errStr.includes('not available for inbound') ||
    errStr.includes('recently added, please try again later') ||
    errStr.includes('MSKUs are not valid') ||
    errStr.includes('Prep classification') ||
    errStr.includes('FBA_INB_0182')
  );
}

/**
 * Parse Amazon's per-MSKU prepOwner complaints out of a createInboundPlan
 * error and return which MSKUs to flip. Amazon uses two phrasings:
 *   "{MSKU} requires prepOwner but NONE was assigned. Accepted values: [AMAZON, SELLER]"
 *   "{MSKU} does not require prepOwner but SELLER was assigned. Accepted values: [NONE]"
 * The "does not require" regex also matches inside "requires prepOwner"
 * lines, so MSKUs in needsPrep are removed from doesntNeedPrep.
 */
export function parsePrepOwnerFlips(errStr: string): { needsPrep: string[]; doesntNeedPrep: string[] } {
  const requiresPrepRegex = /(\S+)\s+requires prepOwner/g;
  const doesNotRequirePrepRegex = /(\S+)\s+does not require prepOwner/g;
  const needsPrep: string[] = [];
  const doesntNeedPrep: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = requiresPrepRegex.exec(errStr)) !== null) needsPrep.push(m[1]);
  while ((m = doesNotRequirePrepRegex.exec(errStr)) !== null) doesntNeedPrep.push(m[1]);
  return { needsPrep, doesntNeedPrep: doesntNeedPrep.filter((s) => !needsPrep.includes(s)) };
}

/**
 * Amazon's createInboundPlan rejects names over 40 characters with a cryptic
 * "failed to satisfy constraint: Member must have length less than or equal
 * to 40" 400 — at the very END of the send flow. Found by the July 8, 2026
 * test shipment ("TEST HARNESS Jul 8 (auto — will be cancelled)" = 44 chars).
 * Trim + collapse whitespace + truncate so any batch name is always valid.
 */
export function sanitizePlanName(name: string): string {
  const cleaned = (name || '').replace(/\s+/g, ' ').trim();
  return (cleaned || 'FlipLedger Shipment').slice(0, 40);
}

export interface CarrierOptionLike {
  transportationOptionId: string;
  shipmentId: string;
  shippingSolution: string;
  shippingMode: string;
  carrier?: { name?: string; alphaCode?: string };
}

/**
 * Amazon requires a transportation option confirmed for EVERY shipment in a
 * placement. The user picks ONE carrier choice in the UI; expand it to all
 * shipments by matching (shippingSolution, shippingMode, carrier) to an
 * option on each shipment. Explicitly-picked options for a shipment win.
 * Returns the per-shipment selections plus any shipments where the chosen
 * carrier isn't offered (caller surfaces "pick a carrier offered for every
 * shipment"). (July 8, 2026: confirming only the clicked shipment made
 * Amazon 400 with "provided shipment ids do not match the shipments in the
 * confirmed placement".)
 */
export function expandCarrierChoice<T extends CarrierOptionLike>(
  picked: T[],
  allOptions: T[]
): { selected: T[]; missing: string[]; shipmentIds: string[] } {
  const choice = picked[0];
  const shipmentIds = [...new Set(allOptions.map((o) => o.shipmentId))];
  const carrierName = (choice?.carrier?.name || '').toLowerCase();
  const selected: T[] = [];
  const missing: string[] = [];
  for (const sid of shipmentIds) {
    const explicit = picked.find((o) => o.shipmentId === sid);
    const match = explicit || allOptions.find((o) =>
      o.shipmentId === sid &&
      o.shippingSolution === choice.shippingSolution &&
      o.shippingMode === choice.shippingMode &&
      (o.carrier?.name || '').toLowerCase() === carrierName
    );
    if (match) selected.push(match);
    else missing.push(sid);
  }
  return { selected, missing, shipmentIds };
}

/**
 * Minimal shape of a getListing() response (summaries, offers,
 * fulfillmentAvailability) for the readiness checks below.
 */
export interface ListingLike {
  summaries?: { status?: string[]; fnSku?: string }[];
  offers?: unknown[];
  fulfillmentAvailability?: { fulfillmentChannelCode?: string; quantity?: number }[];
}

/** Units Amazon currently shows on the listing's merchant (DEFAULT) channel. */
export function mfnLiveQuantity(listing: ListingLike | null | undefined): number {
  const mfn = (listing?.fulfillmentAvailability || []).find((f) => f.fulfillmentChannelCode === 'DEFAULT');
  return Number(mfn?.quantity) || 0;
}

/**
 * Is a batch item's listing "done" from the batch flow's point of view?
 *   FBA: FNSKU assigned (BUYABLE only follows physical receipt).
 *   MFN with stock: BUYABLE.
 *   MFN offering 0 — quantity 0, Qty → Amazon off, or already sold out
 *     (Oct 4 2026: batch 51's Pokémon bundles sold out the day after they were
 *     listed and read STUCK) — is never BUYABLE. Done once Amazon holds the
 *     offer on the merchant channel at 0: a summary, an offer with a price,
 *     and a DEFAULT fulfillment entry. Verified against real 0-qty MFN
 *     listings, which read status [DISCOVERABLE], offers [{price}],
 *     fulfillmentAvailability [{DEFAULT, quantity 0}]. A DISCOVERABLE listing
 *     showing units is still propagating, so it is not done yet.
 */
export function isItemListingReady(
  channel: 'FBA' | 'MFN',
  quantity: number,
  listing: ListingLike | null | undefined,
): boolean {
  if (!listing) return false;
  const summary = listing.summaries?.[0];
  if (channel === 'FBA') return !!summary?.fnSku;
  if ((summary?.status || []).includes('BUYABLE')) return true;
  if (Number(quantity) !== 0 && mfnLiveQuantity(listing) > 0) return false;
  return !!summary
    && (listing.offers?.length || 0) > 0
    && (listing.fulfillmentAvailability || []).some((f) => f.fulfillmentChannelCode === 'DEFAULT');
}

/**
 * The MFN "Qty → Amazon" switch (Oct 4 2026, Parker: "on = send that stock
 * qty to Amazon, off = don't"). An MFN PUT SETS the quantity, so:
 *   ON:  Amazon gets the SKU's stock in FlipLedger — units bought minus units
 *        sold (sum of the SKU's lots' quantity_remaining). Never the batch
 *        quantity: that would re-list units already sold (batch 51's Pokémon).
 *   OFF: FlipLedger never changes the Amazon quantity. A new offer is created
 *        at 0; an existing one keeps what Amazon shows (stock is managed in
 *        Seller Central), and Publish doesn't PUT it at all.
 */
export interface QtySwitch {
  channel: 'FBA' | 'MFN';
  sendQty: boolean;
  skuStock: number;
}

/** Publish skips the PUT for an existing MFN listing whose switch is OFF. */
export function skipMfnPut(channel: 'FBA' | 'MFN', sendQty: boolean, existing: ListingLike | null | undefined): boolean {
  return channel === 'MFN' && !sendQty && (existing?.summaries?.length || 0) > 0;
}

/** Quantity to PUT on an MFN listing (FBA ignores the quantity). */
export function mfnQuantityToPut(q: QtySwitch, existing: ListingLike | null | undefined): number {
  if (q.sendQty) return Math.max(0, Number(q.skuStock) || 0);
  return (existing?.summaries?.length || 0) > 0 ? mfnLiveQuantity(existing) : 0;
}

/** What the item offers, for the readiness check: 0 when the switch is OFF. */
export function offeredQuantity(sendQty: boolean, skuStock: number): number {
  return sendQty ? Math.max(0, Number(skuStock) || 0) : 0;
}
