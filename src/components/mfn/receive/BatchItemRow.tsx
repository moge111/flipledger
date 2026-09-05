'use client';

import { formatCurrency } from '@/lib/formatters';
import { Package, X, CheckCircle2, Printer, Pencil, Info } from 'lucide-react';

import { getReceiveProgress } from '@/components/mfn/receive/helpers';
import { BatchItem, BatchItemRowProps } from '@/components/mfn/receive/types';
import { AsinLink, ChannelBadge, InlineQtyEdit, MskuLink, ReceiveProgressBar } from '@/components/mfn/receive/widgets';

// Derives display values for a saved/collapsed BatchItemCard row.
// Fallback priority: persisted DB field → draft field → null.
// Pure helper — no side effects, safe to call from any render context.
function getSavedDisplay(item: BatchItem) {
  return {
    savedQty:      item.quantity_received ?? (parseInt(item.draft_qty, 10) || null),
    savedPrice:    item.il_list_price_cents
      ?? (item.draft_list_price ? Math.round(parseFloat(item.draft_list_price) * 100) : null),
    savedCogs:     item.buy_price
      ?? (item.draft_buy_price ? Math.round(parseFloat(item.draft_buy_price) * 100) : null),
    savedBin:      item.bin_location || item.draft_bin.trim() || null,
    savedCond:     item.condition    || item.draft_condition.trim() || null,
    savedTemplate: item.merchant_shipping_group_name || item.draft_shipping_template.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// BatchItemRow — collapsed view for saved items
// ---------------------------------------------------------------------------

export function BatchItemRow({ item, onRemove, onPrintLabel, onEdit, onSaveQty, onImageClick, onShowDetail, focusQty, onQtyFocused, locked = false }: BatchItemRowProps) {
  const { savedQty, savedPrice, savedCogs } = getSavedDisplay(item);
  const receiveProgress = getReceiveProgress(item);

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border-subtle border-l-2 border-l-green-500/40">

      {/* Zone 1 — image */}
      {item.image_url
        ? (
            <button type="button" onClick={onImageClick}
              className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
              title="View larger">
              <img src={item.image_url} alt="" className="w-20 h-20 object-contain block p-1.5" />
            </button>
          )
        : <div className="w-20 h-20 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={22} className="text-text-tertiary/40" /></div>}

      {/* Zone 2 — product identity (flex-1, truncates): name + ASIN + MSKU + channel */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 size={15} className="text-green-400 shrink-0" />
          <span className="text-base font-medium text-text-primary truncate" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <AsinLink asin={item.asin} className="font-mono text-sm text-blue-400/80 shrink-0 hover:text-blue-300 hover:underline" />
          <ChannelBadge channel={item.fulfillment_channel} />
        </div>
        <MskuLink sku={item.sku} className="font-mono text-xs text-blue-400/80 truncate block mt-0.5 hover:text-blue-300 hover:underline" />
      </div>

      {/* Zone 4 — Qty (w-32 fixed): InlineQtyEdit + optional receive progress */}
      <div className="w-32 shrink-0 flex flex-col items-start gap-0.5 overflow-hidden">
        {locked
          ? <span className="font-mono text-base text-text-primary px-1">{savedQty}</span>
          : <InlineQtyEdit value={savedQty} onSave={onSaveQty} forceOpen={focusQty} onOpened={onQtyFocused} />}
        {receiveProgress && <ReceiveProgressBar progress={receiveProgress} variant="compact" />}
      </div>

      {/* Zone 5 — COGS (w-20 right): buy price per unit, to verify the import */}
      <div className="w-20 shrink-0 text-right">
        {savedCogs != null
          ? <span className="font-mono text-base text-text-secondary">{formatCurrency(savedCogs)}</span>
          : <span className="text-text-tertiary/30">—</span>}
      </div>

      {/* Zone 6 — List price (w-20 right) */}
      <div className="w-20 shrink-0 text-right">
        {savedPrice != null
          ? <span className="font-mono text-base text-text-primary">{formatCurrency(savedPrice)}</span>
          : <span className="text-text-tertiary/30">—</span>}
      </div>

      {/* Zone 7 — Actions (w-24 fixed, right-aligned) */}
      <div className="w-24 shrink-0 flex items-center justify-end">
        <button onClick={onShowDetail} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="View details"><Info size={13} /></button>
        <button onClick={onPrintLabel} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="Print ASIN label"><Printer size={13} /></button>
        {!locked && <button onClick={onEdit} className="p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors" title="Edit (reopens this card)"><Pencil size={13} /></button>}
        {!locked && <button onClick={onRemove} className="p-1 text-text-tertiary/40 hover:text-text-tertiary rounded" title="Remove"><X size={13} /></button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BatchItemCard
// ---------------------------------------------------------------------------
