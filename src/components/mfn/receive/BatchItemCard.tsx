'use client';

import { useEffect, useRef } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { Package, X, CheckCircle2, Loader2, Save, PackagePlus, Info } from 'lucide-react';
import { BatchItemRow } from '@/components/mfn/receive/BatchItemRow';
import { UpcChip } from '@/components/mfn/receive/SearchResultCard';
import { calcProfit, chipsForBatchItem, getReceiveProgress, liveStateBadge, resolveShippingTemplate } from '@/components/mfn/receive/helpers';
import { BatchItemCardProps } from '@/components/mfn/receive/types';
import { AsinLink, BatchItemChips, ChannelBadge, ReceiveProgressBar } from '@/components/mfn/receive/widgets';

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

export function BatchItemCard({ item, onChange, onRemove, onSave, onCreateLot, onPrintLabel, onEdit, onSaveQty, onMarkInspected, onImageClick, onShowDetail, focusQty, onQtyFocused, amazonTemplates, locked = false }: BatchItemCardProps) {
  const noLot = item.il_id == null;
  const profit = calcProfit(item);

  const qtyRef              = useRef<HTMLInputElement>(null);
  const listPriceRef        = useRef<HTMLInputElement>(null);
  const conditionRef        = useRef<HTMLSelectElement>(null);
  const buyCostRef          = useRef<HTMLInputElement>(null);
  const binRef              = useRef<HTMLInputElement>(null);
  const shippingEstRef      = useRef<HTMLInputElement>(null);
  const shippingTemplateRef = useRef<HTMLSelectElement>(null);
  const primaryActionRef    = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusQty && qtyRef.current) {
      qtyRef.current.focus();
      qtyRef.current.select();
      onQtyFocused();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQty]);

  // Collapsed view delegates to BatchItemRow — keeps BatchItemCard focused on the edit path.
  if (item.save_state === 'saved') {
    return (
      <BatchItemRow
        item={item}
        onRemove={onRemove}
        onPrintLabel={onPrintLabel}
        onEdit={onEdit}
        onSaveQty={onSaveQty}
        onMarkInspected={onMarkInspected}
        onImageClick={onImageClick}
        onShowDetail={onShowDetail}
        focusQty={focusQty}
        onQtyFocused={onQtyFocused}
        amazonTemplates={amazonTemplates}
        locked={locked}
      />
    );
  }

  const borderClass = item.save_state === 'error'
    ? 'border-red-500/30 bg-red-500/5'
    : noLot
      ? 'border-border-subtle bg-slate-800 border-l-2 border-l-sky-500/30'
      : 'border-border-subtle bg-slate-800';

  return (
    <div className={`rounded-xl border p-4 transition-colors ${borderClass}`}>

      {/* Header */}
      <div className="flex items-start gap-4 mb-3">
        {item.image_url
          ? (
              <button
                type="button"
                onClick={onImageClick}
                className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
                title="View larger"
              >
                <img src={item.image_url} alt="" className="w-28 h-28 object-contain block p-1.5" />
              </button>
            )
          : <div className="w-28 h-28 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={28} className="text-text-tertiary/40" /></div>}

        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-text-primary leading-snug line-clamp-2" title={item.product_name ?? item.asin}>
            {item.product_name || item.asin}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <AsinLink asin={item.asin} className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline" />
            {liveStateBadge(item.amazon_status, item.amazon_qty)}
            <ChannelBadge channel={item.fulfillment_channel} />
            {item.amazon_qty != null && (
              <span className="text-[10px] text-text-tertiary">Amz qty: {item.amazon_qty}</span>
            )}
            {item.upc && <UpcChip upc={item.upc} />}
          </div>
          {(() => {
            const blockers = chipsForBatchItem(item).filter(c => c.tone === 'blocker');
            return blockers.length > 0 ? (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <BatchItemChips chips={blockers} />
              </div>
            ) : null;
          })()}
        </div>

        {noLot ? (
          <button
            ref={primaryActionRef}
            onClick={onCreateLot}
            disabled={item.create_lot_state === 'creating'}
            className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            {item.create_lot_state === 'creating'
              ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
              : <><PackagePlus size={11} /> Save item</>}
          </button>
        ) : (
          <button
            ref={primaryActionRef}
            onClick={onSave}
            disabled={item.save_state === 'saving'}
            className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            {item.save_state === 'saving'
              ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
              : <><Save size={11} /> Save changes</>}
          </button>
        )}
        <button
          onClick={onShowDetail}
          className="shrink-0 p-1 text-text-tertiary/60 hover:text-blue-400 rounded transition-colors"
          title="View details"
        >
          <Info size={14} />
        </button>
        <button
          onClick={onRemove}
          className="shrink-0 p-1 text-text-tertiary/40 hover:text-text-tertiary rounded transition-colors"
          title="Remove from batch"
        >
          <X size={14} />
        </button>
      </div>

      {/* Profit strip */}
      {profit.listCents != null && profit.costCents != null && (
        <div className="mb-2 px-2.5 py-1.5 bg-slate-900/40 rounded-lg border border-border-subtle">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-baseline gap-2">
              <span className={`text-sm font-semibold tabular-nums ${
                !profit.hasFee
                  ? 'text-text-secondary'
                  : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {profit.netCents != null ? `${!profit.hasFee ? '~' : ''}${formatCurrency(profit.netCents)}` : '—'}
              </span>
              {profit.roiPct != null && profit.hasFee && (
                <span className={`text-xs font-medium ${profit.roiPct > 0 ? 'text-green-400/80' : 'text-red-400/80'}`}>
                  {profit.roiPct.toFixed(1)}% ROI
                </span>
              )}
              {profit.marginPct != null && profit.hasFee && (
                <span className={`text-[10px] ${profit.marginPct > 0 ? 'text-text-tertiary' : 'text-red-400/70'}`}>
                  {profit.marginPct.toFixed(1)}% margin
                </span>
              )}
            </div>
            {!profit.hasFee && (
              <span className="text-[10px] text-text-tertiary/60 italic">Estimate — fee not cached</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-text-tertiary flex-wrap">
            <span>List {formatCurrency(profit.listCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Cost {formatCurrency(profit.costCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            <span>Ship {formatCurrency(profit.shipCents)}</span>
            <span className="text-text-tertiary/30">−</span>
            {profit.referralCents != null ? (
              <>
                <span>
                  Referral{profit.referralRate != null
                    ? ` (${(profit.referralRate * 100).toFixed(0)}%)`
                    : ''} {formatCurrency(profit.referralCents)}
                </span>
                {profit.vcfCents > 0 && (
                  <>
                    <span className="text-text-tertiary/30">−</span>
                    <span>VCF {formatCurrency(profit.vcfCents)}</span>
                  </>
                )}
              </>
            ) : (
              <span className="text-text-tertiary/50 italic">Amazon fee not cached</span>
            )}
          </div>
        </div>
      )}

      {/* Receive progress — only when there's a lot AND a usable total signal */}
      {(() => { const p = getReceiveProgress(item); return p ? <ReceiveProgressBar progress={p} variant="full" /> : null; })()}

      {/* Mark inspected — only when received but not yet inspected */}
      {item.il_id != null && (item.quantity_received ?? 0) > 0 && !item.inspected_at && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={onMarkInspected}
            disabled={item.marking_inspected}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
            title="Marks this item inspected. Does not update Amazon."
          >
            {item.marking_inspected
              ? <Loader2 size={11} className="animate-spin" />
              : <CheckCircle2 size={11} />}
            Mark inspected
          </button>
          <span className="text-[10px] text-text-tertiary/50">Does not update Amazon</span>
          {item.mark_inspect_error && (
            <span className="text-[10px] text-red-400">{item.mark_inspect_error}</span>
          )}
        </div>
      )}

      {/* Input grid — keyboard flow: Qty → List Price → Condition → Buy Cost (noLot) or Bin → Bin → Est. Shipping → Template → Save
          Row 1: Qty | List Price | Condition
          Row 2: Buy Cost | Bin | Est. Shipping
          Below: Shipping Template (full width) */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">Qty Received</label>
          <input
            ref={qtyRef}
            type="number" min="0" step="1"
            value={item.draft_qty}
            onChange={e => onChange({ draft_qty: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); listPriceRef.current?.focus(); } }}
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">List Price ($)</label>
          <input
            ref={listPriceRef}
            type="number" min="0" step="0.01"
            value={item.draft_list_price}
            onChange={e => onChange({ draft_list_price: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); conditionRef.current?.focus(); } }}
            placeholder="0.00"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5 uppercase tracking-wide">Condition</label>
          <select
            ref={conditionRef}
            value={item.draft_condition}
            onChange={e => onChange({ draft_condition: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); noLot ? buyCostRef.current?.focus() : binRef.current?.focus(); } }}
            className="w-full h-9 px-2.5 bg-slate-800 border border-border-default rounded-md text-sm text-text-primary focus:border-blue-500 focus:outline-none"
          >
            <option value="">— select —</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">
            {noLot ? 'Buy Cost ($)' : 'Buy Cost (locked)'}
          </label>
          <input
            ref={buyCostRef}
            type="number" min="0" step="0.01"
            value={item.draft_buy_price}
            onChange={e => noLot ? onChange({ draft_buy_price: e.target.value }) : undefined}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); binRef.current?.focus(); } }}
            readOnly={!noLot}
            tabIndex={noLot ? 0 : -1}
            placeholder="0.00"
            className={`w-full h-9 px-3 rounded-md text-sm font-mono placeholder:text-text-tertiary focus:outline-none ${
              noLot
                ? 'bg-slate-800 border border-border-default text-text-primary focus:border-blue-500'
                : 'bg-slate-800/40 border border-border-subtle text-text-tertiary cursor-default'
            }`}
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">Bin <span className="normal-case font-normal opacity-60">(optional)</span></label>
          <input
            ref={binRef}
            type="text"
            value={item.draft_bin}
            onChange={e => onChange({ draft_bin: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); shippingEstRef.current?.focus(); } }}
            placeholder="e.g. S1-B3"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-tertiary/50 mb-1.5 uppercase tracking-wide">Est. Shipping ($)</label>
          <input
            ref={shippingEstRef}
            type="number" min="0" step="0.01"
            value={item.draft_shipping_est}
            onChange={e => onChange({ draft_shipping_est: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); shippingTemplateRef.current?.focus(); } }}
            placeholder="8.00"
            className="w-full h-9 px-3 bg-slate-800 border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-2">
        <label className="block text-[10px] text-text-tertiary/50 mb-1 uppercase tracking-wide">Shipping Template</label>
        {amazonTemplates === null ? (
          <div className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs text-text-tertiary flex items-center">
            Syncing Amazon templates…
          </div>
        ) : amazonTemplates.length === 0 ? (
          <div className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs text-text-tertiary flex items-center">
            No templates found — sync in Settings
          </div>
        ) : (
          <select
            ref={shippingTemplateRef}
            value={resolveShippingTemplate(item.draft_shipping_template, amazonTemplates)?.key ?? item.draft_shipping_template}
            onChange={e => onChange({ draft_shipping_template: e.target.value, save_state: 'idle' })}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); primaryActionRef.current?.click(); } }}
            className="w-full h-8 px-2.5 bg-slate-800 border border-border-default rounded-md text-xs font-mono text-text-primary focus:border-blue-500 focus:outline-none appearance-none cursor-pointer"
          >
            <option value="">Select template…</option>
            {/* Unknown stored values (old display names not in Amazon list) surface as a selectable option so nothing looks blank */}
            {item.draft_shipping_template && !resolveShippingTemplate(item.draft_shipping_template, amazonTemplates) && (
              <option value={item.draft_shipping_template}>Stored: {item.draft_shipping_template} (not synced)</option>
            )}
            {amazonTemplates.map(t => (
              <option key={t.key} value={t.key}>{t.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Error / slow-save status */}
      {(item.save_state === 'error' || item.create_lot_state === 'error') && (
        <p className="text-[10px] text-red-400 mt-1">
          {item.save_state === 'error' ? (item.save_error || 'Save failed') : (item.create_lot_error || 'Create failed')}
        </p>
      )}
      {item.create_lot_state === 'creating' && item.slow_create_lot && (
        <p className="text-[10px] text-text-tertiary italic mt-1 text-center">Still saving…</p>
      )}
      {item.save_state === 'saving' && item.slow_save && (
        <p className="text-[10px] text-text-tertiary italic mt-1 text-center">Still working — saving…</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

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
