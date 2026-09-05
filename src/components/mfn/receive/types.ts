




export interface SearchResult {
  ml_id: number | null;
  il_id: number | null;
  asin: string;
  sku: string;
  amazon_qty: number | null;
  amazon_status: string | null;
  fulfillment_channel: string | null;
  amazon_list_price_cents: number | null;
  last_synced: string | null;
  product_name: string | null;
  image_url: string | null;
  buy_price: number | null;
  il_list_price_cents: number | null;
  bin_location: string | null;
  condition: string | null;
  quantity_received: number | null;
  quantity_remaining: number | null;
  received_at: string | null;
  inspected_at: string | null;
  merchant_shipping_group_name: string | null;
  parsed_cost_cents: number | null;
  parsed_list_price_cents: number | null;
  parsed_order_qty: number | null;
  sku_parse_status: 'parsed' | 'unparsed';
  fee_cents: number | null;
  referral_fee_cents: number | null;
  fee_list_price_cents: number | null;
  upc?: string | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type CreateLotState = 'idle' | 'creating' | 'error';

export interface BatchItem extends SearchResult {
  draft_qty: string;
  draft_bin: string;
  draft_condition: string;
  draft_list_price: string;
  draft_buy_price: string;
  draft_shipping_template: string;
  draft_shipping_est: string;
  save_state: SaveState;
  save_error: string | null;
  slow_save: boolean;            // true once save has been in-flight > 3s
  create_lot_state: CreateLotState;
  create_lot_error: string | null;
  slow_create_lot: boolean;      // true once create-lot has been in-flight > 3s
  marking_inspected: boolean;
  mark_inspect_error: string | null;
}

export interface ShippingTemplate { key: string; name: string; }

// Match a stored value (which may be an old display name OR a current key) to
// a template entry by checking key first, then name. Returns null if unknown.

export interface LabelSpec {
  labelMode: 'asin';
  size: '2x1';
  asin?: string;
  title?: string;
  condition?: string;
  bin?: string;
  showBin?: boolean;
}

export interface ProfitCalc {
  netCents: number | null;
  roiPct: number | null;
  marginPct: number | null;
  listCents: number | null;
  costCents: number | null;
  shipCents: number;
  // Fee breakdown (all adjusted to current list price):
  referralCents: number | null;  // referral % applied to current draft price
  referralRate: number | null;   // e.g. 0.15 for 15%
  vcfCents: number;              // per-item variable closing fee (flat; $1.80 for media, $0 otherwise)
  feeCents: number | null;       // total Amazon fee = referralCents + vcfCents
  hasFee: boolean;
  feeEstimatedAtCents: number | null; // price the cached fee was originally estimated at
}

type ChipTone = 'blocker' | 'warn' | 'info';

export interface Chip { label: string; tone: ChipTone; title?: string }

export type WarnLabel = 'Not inspected' | 'Stale status' | 'No price' | 'Fee unknown';

export interface BatchSummary {
  total: number;
  saved: number;
  unsaved: number;
  totalQty: number;
  totalListCents: number;
  totalCostCents: number;
  totalShipCents: number;
  totalFeeCents: number;
  totalNetCents: number;
  roiPct: number | null;
  marginPct: number | null;
  // True if any qty>0 item is missing fee (but has list+cost). Narrower flag for messaging.
  feeIncomplete: boolean;
  // True if any qty>0 item is missing list, cost, or net entirely. Broader flag.
  priceOrCostIncomplete: boolean;
  // Combined: drives the asterisk + amber color on Fees/Net/ROI/Margin.
  profitIncomplete: boolean;
  warnCounts: Record<WarnLabel, number>;
}

// Independent receive-state predicates for the filter strip. Each predicate
// is evaluated per item independently — buckets are NOT mutually exclusive
// (e.g. a clean 1/1 saved row is both Complete and Ready to push). Print All
// and Preview & Push do NOT use these — they keep their own eligibility
// logic on the full batch.

// Independent receive-state predicates for the filter strip. Each predicate
// is evaluated per item independently — buckets are NOT mutually exclusive
// (e.g. a clean 1/1 saved row is both Complete and Ready to push). Print All
// and Preview & Push do NOT use these — they keep their own eligibility
// logic on the full batch.
export type FilterKey = 'over' | 'needs-work' | 'complete' | 'ready';

// Receive progress derived from existing fields — display only.
// total    = parsed_order_qty (from MSKU) ?? quantity_received (best local proxy)
// received = quantity_received
// remaining = max(0, total - received)
// Returns null when there's no lot OR no usable signal for total.
export interface ReceiveProgress { total: number; received: number; remaining: number; pct: number; isOver: boolean }

// Inline qty quick-edit for the saved row. Local UI state; commits via
// the parent's onSave (which only touches quantity_received via the
// existing inventory-lots PATCH route).
export interface InlineQtyEditProps {
  value: number | null;
  onSave: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  forceOpen?: boolean;
  onOpened?: () => void;
}

// Read-only details flyout. No API calls; reuses ChannelBadge,
// WarningChip, ReceiveProgressBar, calcProfit, formatCurrency. Doesn't
// mutate save_state or touch any draft_* fields.
export interface ItemDetailDrawerProps {
  item: SearchResult | BatchItem;
  onImageClick: () => void;
  onPrintLabel?: () => void;
  onEdit?: () => void;
  onClose: () => void;
  amazonTemplates?: ShippingTemplate[] | null;
}

export interface SearchResultCardProps {
  result: SearchResult;
  inBatch: boolean;
  onAdd: () => void;
  onImageClick: () => void;
  onShowDetail: () => void;
}

export interface BatchItemRowProps {
  item: BatchItem;
  onRemove: () => void;
  onPrintLabel: () => void;
  onEdit: () => void;
  onSaveQty: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  onMarkInspected: () => void;
  onImageClick: () => void;
  onShowDetail: () => void;
  focusQty: boolean;
  onQtyFocused: () => void;
  amazonTemplates: ShippingTemplate[] | null;
  locked?: boolean;
}

export interface BatchItemCardProps {
  item: BatchItem;
  onChange: (updates: Partial<BatchItem>) => void;
  onRemove: () => void;
  onSave: () => void;
  onCreateLot: () => void;
  onPrintLabel: () => void;
  onEdit: () => void;
  onSaveQty: (newQty: number) => Promise<{ ok: boolean; error?: string }>;
  onMarkInspected: () => void;
  onImageClick: () => void;
  onShowDetail: () => void;
  focusQty: boolean;
  onQtyFocused: () => void;
  amazonTemplates: ShippingTemplate[] | null;
  locked?: boolean;
}

/**
 * Reusable MFN receive workflow. Mounts at both /mfn/batch (standalone,
 * batchId=null) and inside /list/[id] for MFN-channel batches (batchId set
 * from the URL param).
 *
 * When batchId is null (standalone): exactly the legacy /mfn/batch behavior.
 * Tray is React-state-only; refresh loses unsaved items; saved lots persist
 * with batch_id = NULL.
 *
 * When batchId is a positive integer: every create-mfn-local-lot POST includes
 * batchId so the inserted (or claimed) inventory_ledger row carries it; on
 * mount, the tray hydrates from /api/data/mfn-batch-items?batchId=N so a
 * refresh returns the saved items.
 *
 * Setting batch_id never touches buy_price, quantity, quantity_remaining, or
 * date_purchased on any lot — FIFO is unaffected.
 */
export interface MfnBatchReceiveWorkflowProps {
  batchId?: number | null;
  /** When true the batch is closed/in History: read-only, no add/edit/push. */
  locked?: boolean;
}
