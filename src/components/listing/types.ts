

export interface Batch {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  inboundPlanId: string | null;
  inboundOperationId?: string | null;
  planStatus?: string | null;
  sendError?: string | null;
  sentAt?: string | null;
  shipFromCity: string | null;
  shipFromState: string | null;
  // Phase 3: packing
  packingStatus?: string | null;
  packingError?: string | null;
  packingConfirmedAt?: string | null;
  // Phase 3: placement
  placementStatus?: string | null;
  placementOptionId?: string | null;
  placementFeeCents?: number | null;
  placementError?: string | null;
  placementConfirmedAt?: string | null;
  // Phase 4: transportation (carrier booking)
  transportationStatus?: string | null;
  transportationOptionId?: string | null;
  transportationCarrier?: string | null;
  transportationCostCents?: number | null;
  transportationShippingMode?: string | null;
  transportationConfirmedAt?: string | null;
  transportationError?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BoxItemAssignment {
  id?: number;
  boxId?: number;
  itemId: number;
  quantity: number;
}

export interface Box {
  id?: number;
  boxIndex?: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  packingGroupId?: string | null; // which Amazon pack group this box belongs to (for multi-group batches)
  items: BoxItemAssignment[];
}

// Amazon-assigned pack group: a subset of batch items that ship as their own
// shipment (and possibly to a different FC). Multi-group batches must be
// boxed group-by-group.

// Amazon-assigned pack group: a subset of batch items that ship as their own
// shipment (and possibly to a different FC). Multi-group batches must be
// boxed group-by-group.
export interface PackGroup {
  id: number;                      // local DB id
  packingGroupId: string;          // Amazon's pgXXX id
  groupIndex: number;
  items: Array<{
    itemId: number;
    sku: string;
    productName: string | null;
    quantity: number;
  }>;
}

interface PlacementFee {
  target: string;
  type: string;
  value: { amount: number; code: string };
  description?: string;
}

export interface PlacementOption {
  placementOptionId: string;
  shipmentIds: string[];
  fees: PlacementFee[];
  status: 'OFFERED' | 'ACCEPTED' | 'EXPIRED';
  discounts?: any[];
}

export interface BatchItem {
  id: number;
  asin: string;
  sku: string;
  msku: string | null;
  productName: string | null;
  imageUrl: string | null;
  condition: string;
  quantity: number;
  listPriceCents: number;
  buyPriceCents: number;
  estimatedFeeCents: number;
  estimatedShipCents: number;
  supplier: string | null;
  purchaseDate: string | null;
  listingStatus?: string | null;
  listingError?: string | null;
  labelsPrintedAt?: string | null;  // user marks "I'm done labeling this SKU"
  // Pre-flight validation (checked at add time — see /preflight route)
  fnsku?: string | null;
  inboundReady?: number | null;
  prepCategory?: string | null;
  preflightStatus?: string | null;  // READY | PENDING | GATED | CATALOG_ISSUE | STUCK | FAILED | UNPRICED
  preflightDetail?: {
    restriction?: { status: string; reasons: string[]; approvalUrl: string | null };
    errorIssues?: string[];
    catalogDefect?: boolean;
  } | null;
}

interface FeeEstimate {
  totalFeeCents: number;
  referralFeeCents: number;
  fbaFeeCents: number;
  source: 'sp-api' | 'cache' | 'fallback';
}

interface ShippingEstimate {
  costCents: number;
  source: 'per-asin' | 'marketplace-avg' | 'none';
  sampleSize: number;
}

interface ExistingMsku {
  msku: string;
  lastBuyPriceCents: number;
  source: 'live_inventory' | 'inventory_ledger' | 'listing_batch';
  unitsInStock?: number | null;
  /** Fulfillment channel this MSKU is currently registered on, when known. */
  channel?: 'FBA' | 'MFN';
  /** False when reusing it would flip the live listing's channel. */
  compatible?: boolean;
}

export interface CatalogResult {
  asin: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  dimensions: { lengthIn?: number; widthIn?: number; heightIn?: number; weightLb?: number } | null;
  source: 'amazon' | 'local';
  avgFeeRate?: number;
  avgSalePrice?: number;
  unitsSoldLast30d?: number;
  unitsSoldLast90d?: number;
  currentFbaStock?: number;
  lastBuyPrice?: number;
  feeEstimate?: FeeEstimate | null;
  feeEstimatePriceCents?: number;
  shippingEstimate?: ShippingEstimate | null;
  existingMskus?: ExistingMsku[];
}

export interface BoxingWorkflowProps {
  batch: Batch;
  items: BatchItem[];
  boxes: Box[];
  packGroups: PackGroup[];
  placementOptions: PlacementOption[];
  savingBoxes: boolean;
  packing: boolean;
  loadingPlacement: boolean;
  confirmingPlacementId: string | null;
  onAddBox: (packingGroupId?: string) => void;
  onRemoveBox: (idx: number) => void;
  onUpdateBoxField: (idx: number, field: keyof Box, value: number) => void;
  onSetBoxItemQty: (boxIdx: number, itemId: number, qty: number) => void;
  onSaveBoxes: () => void;
  onConfirmPacking: () => void;
  onGeneratePlacement: () => void;
  onLoadPlacement: () => void;
  onConfirmPlacement: (optionId: string) => void;
}

export interface TransportationOption {
  transportationOptionId: string;
  shipmentId: string;
  shippingSolution: 'USE_YOUR_OWN_CARRIER' | 'AMAZON_PARTNERED_CARRIER' | string;
  shippingMode: string;
  carrier?: { name?: string; alphaCode?: string };
  quote?: { cost?: { amount: number; code: string } } | null;
  preconditions?: string[];
}
