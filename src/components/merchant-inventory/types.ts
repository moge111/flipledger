


type RowSource  = 'matched' | 'live_only' | 'local_only';

export type LiveState  = 'active' | 'oos' | 'inactive' | 'not_listed';

export type FilterView = 'live' | 'oos' | 'inactive' | 'local_only' | 'ready' | null;

export type ReceiveStatus = 'pending' | 'received' | 'inspected' | 'ready';

export interface MerchantRow {
  row_key: string;
  row_source: RowSource;

  // Identity
  asin: string;
  sku: string;

  // Amazon data — null for local_only rows
  ml_id: number | null;
  amazon_qty: number | null;
  amazon_status: string | null;
  amazon_list_price_cents: number | null;
  last_synced: string | null;
  live_state: LiveState;

  // Local lot data — null for live_only rows
  il_id: number | null;
  quantity: number | null;
  quantity_remaining: number | null;
  buy_price: number | null;
  date_purchased: string | null;
  bin_location: string | null;
  condition: string | null;
  quantity_received: number | null;
  received_at: string | null;
  inspected_at: string | null;
  receive_notes: string | null;
  il_list_price_cents: number | null;
  merchant_shipping_group_name: string | null;

  // Product metadata
  product_name: string | null;
  image_url: string | null;
  fnsku: string | null;
  supplier_name: string | null;
  category: string | null;

  // Parsed from MSKU — read-only, no DB source
  parsed_cost_cents: number | null;
  parsed_list_price_cents: number | null;
  parsed_order_qty: number | null;
  parsed_date: string | null;
  sku_parse_status: 'parsed' | 'unparsed';
}

// Activation preview/push UI lives in /mfn/batch — this page is read-only.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type LabelMode = 'asin' | 'warehouse' | 'fnsku' | 'custom';

export interface LabelSpec {
  labelMode: LabelMode;
  size: '2x1' | '4x6';
  title?: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  bin?: string;
  condition?: string;
  priceCents?: number;
  showPrice?: boolean;
  showBin?: boolean;
  subtitle?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// ReceiveModal
// ---------------------------------------------------------------------------

export interface ReceiveModalProps {
  row: MerchantRow;
  title?: string;
  onClose: () => void;
  onSaved: () => void;
}

export interface PrintModalProps {
  selected: MerchantRow[];
  onClose: () => void;
}
