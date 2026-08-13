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
