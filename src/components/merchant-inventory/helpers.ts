
import { MerchantRow, ReceiveStatus } from '@/components/merchant-inventory/types';

export function getReceiveStatus(row: MerchantRow): ReceiveStatus | null {
  if (row.il_id == null) return null;
  const received = (row.quantity_received ?? 0) > 0 && row.received_at != null;
  const inspected = received && row.inspected_at != null;
  const ready =
    inspected &&
    !!(row.bin_location?.trim()) &&
    !!(row.condition?.trim()) &&
    (row.il_list_price_cents ?? 0) > 0;
  if (ready) return 'ready';
  if (inspected) return 'inspected';
  if (received) return 'received';
  return 'pending';
}

export function realFnsku(value: string | null | undefined): string | null {
  const f = String(value || '').trim().toUpperCase();
  return /^X00[A-Z0-9]+$/.test(f) ? f : null;
}

// Deep-link an MSKU to its listing in Seller Central inventory.

// Deep-link an MSKU to its listing in Seller Central inventory.
export function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  const value = (sku ?? '').trim();
  return value
    ? `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(value)}`
    : null;
}

// Labeled identifier with copy button — Prep Ship Hub-style product info block.
// When `href` is set, the value becomes a link (opens in a new tab).
