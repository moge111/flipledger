/**
 * SP-API Fulfillment Inbound v2024-03-20 client.
 *
 * Phase 2 of the FlipLedger listing tool uses this to create real Amazon
 * inbound shipment plans from a FlipLedger batch.
 *
 * Docs: https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v2024-03-20-reference
 */
import { getAccessToken, getEndpoint, spApiRequest } from './auth';
import type { SPAPICredentials } from './types';

export interface SourceAddress {
  name: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  phoneNumber: string;
  email?: string;
}

export interface InboundPlanItem {
  msku: string;          // seller's MSKU that must already exist as a listing
  quantity: number;
  // prepOwner: 'NONE' if no prep needed (most arbitrage items), 'SELLER' if you'll
  // prep before shipping (poly-bag, bubble-wrap, etc.), 'AMAZON' if Amazon should
  // prep on your behalf (charges fee). Defaults to 'NONE' in createInboundPlan.
  prepOwner?: 'NONE' | 'SELLER' | 'AMAZON';
  labelOwner?: 'SELLER' | 'AMAZON' | 'NONE';
  expiration?: string;   // yyyy-MM-dd, for items with expirations
}

export interface CreateInboundPlanParams {
  name: string;
  sourceAddress: SourceAddress;
  destinationMarketplaces: string[];
  items: InboundPlanItem[];
}

export interface CreateInboundPlanResult {
  inboundPlanId: string;
  operationId: string;
}

/**
 * Create an inbound plan. Returns an inboundPlanId plus the operation that
 * Amazon uses to track async plan creation — you must poll getOperation() until
 * the operation status is SUCCESS before the plan can be used for packing.
 *
 * POST /inbound/fba/2024-03-20/inboundPlans
 */
export async function createInboundPlan(
  credentials: SPAPICredentials,
  params: CreateInboundPlanParams
): Promise<CreateInboundPlanResult> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // Default prepOwner to 'NONE' (most items don't need prep). If Amazon
  // rejects with "{MSKU} requires prepOwner" for items that DO need prep
  // (poly bagging for soft toys, bubble wrap for fragile, etc.), we'd need
  // to call Amazon's prep guidance API per-ASIN to decide. For now: pass
  // NONE by default; pass SELLER only when the caller explicitly requests it.
  //
  // Sending prepOwner='SELLER' for items that don't need prep returns:
  //   "{MSKU} does not require prepOwner but SELLER was assigned. Accepted values: [NONE]"
  const body: any = {
    name: params.name,
    sourceAddress: params.sourceAddress,
    destinationMarketplaces: params.destinationMarketplaces,
    items: params.items.map((i) => ({
      msku: i.msku,
      quantity: i.quantity,
      prepOwner: i.prepOwner || 'NONE',
      labelOwner: i.labelOwner || 'SELLER',
      ...(i.expiration ? { expiration: i.expiration } : {}),
    })),
  };

  const response = await fetch(`${endpoint}/inbound/fba/2024-03-20/inboundPlans`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API createInboundPlan ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.inboundPlanId || !data?.operationId) {
    throw new Error(`createInboundPlan: unexpected response shape: ${JSON.stringify(data)}`);
  }

  return { inboundPlanId: data.inboundPlanId, operationId: data.operationId };
}

// ─── Prep Details (per-MSKU, account-level — not plan-level) ─────────────
//
// Each MSKU must have a "prep classification" registered before any inbound
// plan involving it can complete. This is a one-time per-MSKU registration
// at the seller account level, NOT something specific to a single plan.
//
// Without this, createInboundPlan succeeds and returns an inboundPlanId, but
// the async operation that processes the plan FAILS with code FBA_INB_0182:
//   "Prep classification for this SKU was missing. Choose the prep category
//    that applies to this SKU and apply any required prep and labeling to
//    each sellable unit."
//
// Categories: NONE (no prep needed — most arbitrage items), ADULT, BABY,
// FC_PROVIDED, FRAGILE, GRANULAR, HANGER, LIQUID, PERFORATED, SET, SHARP,
// SMALL, TEXTILE, UNKNOWN.
//
// PrepInstructions (the actual prep types): None, Labeling, Polybagging,
// Bubblewrapping, Taping, BlackShrinkwrapping, Boxing, Sealing, RemoveFromHanger.
//
// Default: NONE category + None instruction = no prep needed. Safe for the
// vast majority of resold consumer goods.

export interface MskuPrepDetail {
  msku: string;
  prepCategory?: string;          // default 'NONE'
  prepTypes?: string[];           // default ['ITEM_NO_PREP_NEEDED']
}

/**
 * POST /inbound/fba/2024-03-20/items/prepDetails
 *
 * Set prep classification for one or more MSKUs at the account level.
 * Async — returns an operationId; poll getInboundOperation() until SUCCESS.
 *
 * NOTE: this endpoint is POST, not PUT — sending PUT returns 403 Unauthorized
 * even though the seller has full inbound role permissions. Verified
 * empirically against the live API.
 *
 * Valid prepCategory values: NONE, ADULT, BABY, FC_PROVIDED, FRAGILE,
 *   GRANULAR, HANGER, LIQUID, PERFORATED, SET, SHARP, SMALL, TEXTILE, UNKNOWN.
 * Valid prepType values: ITEM_NO_PREP, ITEM_LABELING, ITEM_POLYBAGGING,
 *   ITEM_BUBBLEWRAPPING, ITEM_TAPING, ITEM_BLACKSHRINKWRAPPING, ITEM_BOXING,
 *   ITEM_SETCREATION, ITEM_SETSTKR, ITEM_REMOVEHANG.
 *
 * Default category 'NONE' + type 'ITEM_NO_PREP' is safe for typical
 * retail-arbitrage resold goods. Items that actually need prep (poly bagging
 * for soft toys, bubble wrap for fragile, etc.) should be passed explicitly.
 */
export async function setPrepDetails(
  credentials: SPAPICredentials,
  details: MskuPrepDetail[]
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    marketplaceId: credentials.marketplaceId,
    mskuPrepDetails: details.map((d) => ({
      msku: d.msku,
      prepCategory: d.prepCategory || 'NONE',
      prepTypes: d.prepTypes && d.prepTypes.length > 0
        ? d.prepTypes
        : ['ITEM_NO_PREP'],
    })),
  };

  const response = await fetch(`${endpoint}/inbound/fba/2024-03-20/items/prepDetails`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API setPrepDetails ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`setPrepDetails: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * Get an existing inbound plan (read-only).
 * Useful for surfacing the current state back to the user after a plan is created.
 *
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}
 */
export async function getInboundPlan(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any> {
  return spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}`
  );
}

export interface OperationStatus {
  operationId: string;
  operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';
  operationProblems: any[];
}

/**
 * Poll the status of an async inbound operation.
 * GET /inbound/fba/2024-03-20/operations/{operationId}
 */
export async function getInboundOperation(
  credentials: SPAPICredentials,
  operationId: string
): Promise<OperationStatus> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/operations/${encodeURIComponent(operationId)}`
  );
  return {
    operationId: data.operationId || operationId,
    operationStatus: data.operationStatus || 'IN_PROGRESS',
    operationProblems: data.operationProblems || [],
  };
}

// ─── Phase 3: Packing ─────────────────────────────────────────────────────
//
// The inbound plan lifecycle after createInboundPlan:
//   1. generatePackingOptions → async op, returns available packing options
//   2. listPackingOptions     → read the generated options
//   3. setPackingInformation  → tell Amazon box dimensions/weight/contents
//      (The seller describes how they've actually boxed the product.)
//   4. confirmPackingOption   → commit to one option
//   5. (then placement flow — see below)
//
// A "pack group" is Amazon's grouping of items that must ship together (based
// on prep requirements, expiration dates, etc.). Most small FBA sellers have
// one pack group. The seller then declares one or more BOXES inside that pack
// group and assigns items to each box.

export interface PackingConfiguration {
  box: {
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    weightLb: number;
  };
  // Items packed in this box. Must match the plan's items exactly — Amazon
  // validates labelOwner + prepOwner against what was registered when the
  // inbound plan was created. Mismatch returns 400 "Package group X did not
  // contain expected items and/or quantities".
  items: Array<{
    msku: string;
    quantity: number;
    labelOwner?: 'SELLER' | 'AMAZON' | 'NONE';
    prepOwner?: 'SELLER' | 'AMAZON' | 'NONE';
    expiration?: string;
    manufacturingLotCode?: string;
  }>;
}

export interface PackingGroup {
  packingGroupId: string;
  boxes: PackingConfiguration[];
}

/**
 * Generate packing options for an inbound plan.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions
 *
 * Amazon runs async optimization to figure out how items can be packed. Poll
 * the returned operationId until SUCCESS, then call listPackingOptions().
 */
export async function generatePackingOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API generatePackingOptions ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`generatePackingOptions: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * List the packing options that Amazon generated for an inbound plan.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions
 */
export async function listPackingOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`
  );
  return data?.packingOptions || [];
}

/**
 * List the items inside a specific pack group. For multi-group batches,
 * Amazon splits items into groups by some internal logic (bulky vs standard,
 * hazmat status, prep requirements, etc.) and each group ships separately.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingGroups/{packingGroupId}/items
 */
export async function listPackingGroupItems(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packingGroupId: string
): Promise<Array<{ msku: string; quantity: number; prepInstructions?: any[] }>> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingGroups/${encodeURIComponent(packingGroupId)}/items`
  );
  return data?.items || [];
}

/**
 * Declare how the seller has actually boxed the product.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingInformation
 *
 * NOTE 2026-05-05: Amazon's published docs say PUT, but PUT is genuinely
 * entitlement-gated and returns 403 AccessDeniedException for our app (and
 * for many other SP-API apps per community reports). POST on the same path
 * works — auth passes, body validates the same way, op is processed.
 * Verified empirically against batch 17's plan: PUT → 403 with full valid
 * body, POST → 400 BadRequest "placement option is already confirmed"
 * (= op was processed; rejected only because the plan was past this state).
 *
 * Each item REQUIRES labelOwner and prepOwner per Amazon's body validator.
 * Defaults: labelOwner='SELLER', prepOwner='NONE' (typical retail-arb).
 *
 * `packageGroupings` is an array — one entry per packing group returned from
 * listPackingOptions. For small batches there's usually just one group.
 */
export async function setPackingInformation(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packageGroupings: Array<{
    packingGroupId: string;
    boxes: Array<{
      contentInformationSource?: 'BOX_CONTENT_PROVIDED' | 'MANUAL_PROCESS' | 'BARCODE_2D';
      dimensions: {
        unitOfMeasurement: 'IN';
        length: number;
        width: number;
        height: number;
      };
      weight: {
        unit: 'LB';
        value: number;
      };
      quantity: number; // number of identical boxes
      items: Array<{
        msku: string;
        quantity: number;
        // labelOwner + prepOwner are REQUIRED by Amazon's body validator.
        // expiration, manufacturingLotCode are optional.
        labelOwner?: 'AMAZON' | 'NONE' | 'SELLER';
        prepOwner?: 'AMAZON' | 'NONE' | 'SELLER';
        expiration?: string;
        manufacturingLotCode?: string;
      }>;
    }>;
  }>
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const body = {
    packageGroupings: packageGroupings.map((g) => ({
      packingGroupId: g.packingGroupId,
      boxes: g.boxes.map((b) => ({
        contentInformationSource: b.contentInformationSource || 'BOX_CONTENT_PROVIDED',
        dimensions: {
          unitOfMeasurement: b.dimensions.unitOfMeasurement,
          length: b.dimensions.length,
          width: b.dimensions.width,
          height: b.dimensions.height,
        },
        weight: {
          unit: b.weight.unit,
          value: b.weight.value,
        },
        quantity: b.quantity,
        items: b.items.map((i) => {
          // Amazon validates the box's item set against the pack group's
          // registered items by comparing the FULL Item shape, including
          // mlc/expiration. Per the error response:
          //   "expected: Item(msku=..., mlc=null, expiration=null,
          //    labelOwner=SELLER, prepOwner=NONE)"
          // Including the optional fields explicitly with null values matches
          // the expected shape exactly. We only include expiration/mlc when
          // the caller specified them; otherwise we omit so Amazon treats as null.
          const out: Record<string, unknown> = {
            msku: i.msku,
            quantity: i.quantity,
            labelOwner: i.labelOwner || 'SELLER',
            prepOwner: i.prepOwner || 'NONE',
          };
          if (i.expiration) out.expiration = i.expiration;
          if (i.manufacturingLotCode) out.manufacturingLotCode = i.manufacturingLotCode;
          return out;
        }),
      })),
    })),
  };

  console.log('[setPackingInformation] request body:', JSON.stringify(body, null, 2));
  // Persist the body so we can inspect it server-side after a failure.
  // (The error message dialog truncates; the file gives us the full body.)
  try {
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(
      path.join(process.cwd(), 'data', 'debug-set-packing-information.json'),
      JSON.stringify(body, null, 2)
    );
  } catch { /* non-fatal */ }

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingInformation`,
    {
      // POST not PUT — see header comment. PUT is auth-gated; POST is not.
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API setPackingInformation ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

/**
 * Confirm the seller's choice of packing option.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/packingOptions/{packingOptionId}/confirmation
 */
export async function confirmPackingOption(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  packingOptionId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions/${encodeURIComponent(packingOptionId)}/confirmation`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API confirmPackingOption ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

// ─── Phase 3: Placement ───────────────────────────────────────────────────
//
// After packing is confirmed, Amazon runs a placement optimization: it decides
// how to distribute your boxes across multiple fulfillment centers. Returns
// 3 options:
//   - Optimized (multiple destinations, cheapest overall, but more boxes)
//   - Partial   (middle ground)
//   - Minimal   (one destination, simpler + faster delivery, but higher fees)
//
// Amazon exposes the optimization fees for each option so the seller can
// compare. FlipLedger's innovation here is visualizing this on a map.

export interface PlacementOption {
  placementOptionId: string;
  shipmentIds: string[];
  fees: Array<{
    target: string;
    type: string;
    value: { amount: number; code: string };
    description?: string;
  }>;
  status: 'OFFERED' | 'ACCEPTED' | 'EXPIRED';
  expiresAt?: string;
  discounts?: any[];
}

/**
 * Kick off placement optimization.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions
 */
export async function generatePlacementOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API generatePlacementOptions ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  if (!data?.operationId) {
    throw new Error(`generatePlacementOptions: missing operationId in response: ${JSON.stringify(data)}`);
  }
  return { operationId: data.operationId };
}

/**
 * List the placement options Amazon generated.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions
 */
export async function listPlacementOptions(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<PlacementOption[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`
  );
  return data?.placementOptions || [];
}

/**
 * Confirm a placement option.
 * POST /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/placementOptions/{placementOptionId}/confirmation
 */
export async function confirmPlacementOption(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  placementOptionId: string
): Promise<{ operationId: string }> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetch(
    `${endpoint}/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions/${encodeURIComponent(placementOptionId)}/confirmation`,
    {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API confirmPlacementOption ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return { operationId: data.operationId || '' };
}

/**
 * List the shipments for an inbound plan. After a placement option is
 * confirmed, Amazon creates 1+ shipments — each with its own destination
 * fulfillment center address. This is what powers the map visualization.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/shipments
 */
export async function listShipments(
  credentials: SPAPICredentials,
  inboundPlanId: string
): Promise<any[]> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments`
  );
  return data?.shipments || [];
}

// ─── Phase 4: Labels (FNSKU + box ID) ─────────────────────────────────────
//
// Once placement is confirmed and shipments exist, Amazon can generate two
// kinds of labels for each shipment:
//
//   - FNSKU per-unit labels (LabelType=UNIQUE): one barcode per individual
//     product unit, applied over the original UPC. For Parker's stickered
//     inventory this is required.
//
//   - Box ID labels (LabelType=BARCODE_2D): one big barcode per box,
//     identifies the box to Amazon's receiving warehouse. Required, applied
//     to the outside of each box.
//
// Amazon returns a download URL pointing at a PDF; we fetch it server-side
// and either stream it back to the browser OR print it directly to the
// user's Rollo via macOS `lpr`.

export type LabelPageType =
  | 'PackageLabel_Letter_2'      // 2 labels per Letter page (4×6 each)
  | 'PackageLabel_Letter_4'      // 4 per page
  | 'PackageLabel_Letter_6'      // 6 per page (most common for FNSKU)
  | 'PackageLabel_A4_2'
  | 'PackageLabel_A4_4'
  | 'PackageLabel_Plain_Paper'   // plain paper, one per page
  | 'PackageLabel_Plain_Paper_CarrierBottom'
  | 'PackageLabel_Thermal'        // 4×6 thermal
  | 'PackageLabel_Thermal_Unified'
  | 'PackageLabel_Thermal_NonPCP';

export type LabelType = 'BARCODE_2D' | 'UNIQUE' | 'PALLET';

export interface ShipmentLabels {
  documents?: Array<{
    url: string;
    downloadType?: string;
  }>;
  // Some marketplaces return a flat downloadURL instead of documents[]
  downloadURL?: string;
}

/**
 * List the boxes for a shipment within an inbound plan.
 * GET /inbound/fba/2024-03-20/inboundPlans/{inboundPlanId}/shipments/{shipmentId}/boxes
 *
 * Used internally by getShipmentLabels to derive the v0 shipmentConfirmationId
 * (FBAxxxxxxx) from a v2024 boxId (FBAxxxxxxxU000001). Each boxId contains the
 * confirmation ID as its prefix.
 */
export async function listShipmentBoxes(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string
): Promise<Array<{ boxId: string; quantity?: number; weight?: any; dimensions?: any }>> {
  const data = await spApiRequest(
    credentials,
    `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/boxes`
  );
  return data?.boxes || [];
}

/**
 * Derive the v0 shipmentConfirmationId from a v2024 boxId.
 * Box ID format: FBA19CRM1CZ6U000001 (confirmation ID + 'U' + 6-digit box index)
 * Confirmation ID: FBA19CRM1CZ6 (12 chars, "FBA" + 9 alphanumeric)
 */
function boxIdToShipmentConfirmationId(boxId: string): string {
  const match = boxId.match(/^(FBA[A-Z0-9]+?)U\d{6}$/);
  if (!match) {
    throw new Error(`Cannot derive shipmentConfirmationId from boxId: ${boxId}`);
  }
  return match[1];
}

/**
 * Get labels for a shipment.
 *
 * IMPORTANT — uses v0 inbound API, not v2024 (May 6, 2026):
 * The v2024 endpoint /inbound/fba/2024-03-20/inboundPlans/.../labels returns
 * 403 AccessDeniedException for standard seller accounts (verified empirically).
 * The v0 endpoint /fba/inbound/v0/shipments/{confirmationId}/labels works.
 *
 * Four bugs the docs/SDK don't tell you about (all empirically verified):
 *   1. Use v0 endpoint, not v2024 (v2024 is 403 for non-private apps).
 *   2. v0 takes shipmentConfirmationId (FBA19CRM1CZ6), NOT the v2024 UUID.
 *      Derive it by calling listShipmentBoxes first and stripping U+6digits
 *      off any boxId.
 *   3. PageSize is an INTEGER (pagination), not a label-format enum. The
 *      format goes in PageType. Pass PageSize=1, PageStartIndex=0.
 *   4. Response field is payload.DownloadURL (capital URL), not payload.URL.
 *
 * Use:
 *   - LabelType='UNIQUE' for per-unit FNSKU labels (one per product unit)
 *   - LabelType='BARCODE_2D' for box ID labels (one per box)
 */
export async function getShipmentLabels(
  credentials: SPAPICredentials,
  inboundPlanId: string,
  shipmentId: string,
  pageType: LabelPageType = 'PackageLabel_Letter_6',
  labelType: LabelType = 'UNIQUE'
): Promise<ShipmentLabels> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  // Step 1: derive the v0 confirmation ID (FBAxxxxxxxxx) from a v2024 boxId,
  //         and collect ALL box IDs for the PackageLabelsToPrint param.
  const boxes = await listShipmentBoxes(credentials, inboundPlanId, shipmentId);
  if (boxes.length === 0) {
    throw new Error(`No boxes found for shipment ${shipmentId} — packing may not be confirmed yet`);
  }
  const allBoxIds = boxes.map((b) => b.boxId).filter(Boolean);
  if (allBoxIds.length === 0) {
    throw new Error(`No boxId on any box for shipment ${shipmentId}`);
  }
  const confirmationId = boxIdToShipmentConfirmationId(allBoxIds[0]);

  // Step 2: call v0 labels endpoint with INTEGER pagination params.
  // Amazon REQUIRES PackageLabelsToPrint (list of box IDs) — internally mapped
  // to cartonIdList. Without it, request 400s with "cartonIdList must not be null".
  const url = new URL(
    `${endpoint}/fba/inbound/v0/shipments/${encodeURIComponent(confirmationId)}/labels`
  );
  url.searchParams.set('PageType', pageType);
  url.searchParams.set('LabelType', labelType);
  url.searchParams.set('PageSize', '1');         // integer pagination
  url.searchParams.set('PageStartIndex', '0');   // integer pagination
  // List query params: SP-API uses comma-separated for List<String>.
  url.searchParams.set('PackageLabelsToPrint', allBoxIds.join(','));

  const response = await fetch(url.toString(), {
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`SP-API getShipmentLabels ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  // v0 returns { payload: { DownloadURL: "..." } } — capital URL.
  // Normalize to our ShipmentLabels shape so callers don't need to know.
  const downloadURL = data?.payload?.DownloadURL || data?.payload?.URL || data?.DownloadURL;
  return {
    downloadURL,
    documents: downloadURL ? [{ url: downloadURL }] : undefined,
  };
}

/**
 * Pull a label PDF down from Amazon's S3 URL and return the binary as a Buffer.
 * Most label download URLs are time-limited; do this server-side and stream
 * to the browser OR pipe directly to lpr.
 */
export async function downloadLabelPdf(downloadUrl: string): Promise<Buffer> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Label PDF download failed: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
