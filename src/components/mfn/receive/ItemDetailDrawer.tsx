'use client';

import { formatCurrency } from '@/lib/formatters';
import { Package, X, Printer, Pencil } from 'lucide-react';
import { calcProfit, chipsForBatchItem, getReceiveProgress, isBatchItem, liveStateBadge, resolveShippingTemplate } from '@/components/mfn/receive/helpers';
import { Chip, ItemDetailDrawerProps, SearchResult, ShippingTemplate } from '@/components/mfn/receive/types';
import { AsinLink, ChannelBadge, MskuLink, ReceiveProgressBar, WarningChip } from '@/components/mfn/receive/widgets';

// Return the user-facing label for a stored value. If the value matches a
// known template (by key or name), returns the template's name. Unknown values
// are returned as-is so nothing is silently lost.
function displayShippingTemplate(value: string, templates: ShippingTemplate[] | null): string {
  if (!value) return '';
  return resolveShippingTemplate(value, templates)?.name ?? value;
}

// Return the canonical Amazon key to write to the DB / PATCH body. If the
// value resolves to a known template, returns its key (normalizing old display
// names → keys). Unknown values are passed through unchanged.

function chipsForResult(r: SearchResult): Chip[] {
  const chips: Chip[] = [];
  if (r.amazon_status && r.amazon_status !== 'Active') chips.push({ label: 'Stale status', tone: 'warn', title: `Local Amazon status is "${r.amazon_status}" — may be out of sync with Seller Central` });
  if (r.referral_fee_cents == null) chips.push({ label: 'Fee unknown', tone: 'info', title: 'No cached referral fee — ROI estimate excludes Amazon fee' });
  return chips;
}

export function ItemDetailDrawer({ item, onImageClick, onPrintLabel, onEdit, onClose, amazonTemplates }: ItemDetailDrawerProps) {
  const inBatch = isBatchItem(item);
  const progress = inBatch ? getReceiveProgress(item) : null;
  const profit   = inBatch ? calcProfit(item) : null;
  const chips    = inBatch ? chipsForBatchItem(item) : chipsForResult(item);

  // Saved-field fallback display values (prefer persisted, then drafts).
  const condDisplay = (item.condition || (inBatch ? item.draft_condition.trim() : '')) || null;
  const binDisplay  = (item.bin_location || (inBatch ? item.draft_bin.trim() : '')) || null;
  const rawTmpl     = item.merchant_shipping_group_name || (inBatch ? item.draft_shipping_template.trim() : '');
  const tmplDisplay = rawTmpl ? displayShippingTemplate(rawTmpl, amazonTemplates ?? null) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="bg-slate-800 border-l border-border-subtle shadow-2xl w-[400px] max-w-full h-full overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start gap-3 px-4 py-3 bg-slate-800 border-b border-border-subtle">
          {item.image_url
            ? <button type="button" onClick={onImageClick} className="shrink-0 rounded overflow-hidden bg-slate-800 hover:ring-2 hover:ring-blue-500/40 transition-shadow" title="View larger">
                <img src={item.image_url} alt="" className="w-14 h-14 object-contain block" />
              </button>
            : <div className="w-14 h-14 bg-slate-700/40 rounded shrink-0 flex items-center justify-center"><Package size={18} className="text-text-tertiary/40" /></div>}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary leading-snug line-clamp-3" title={item.product_name ?? item.asin}>
              {item.product_name || item.asin}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[10px] text-text-tertiary">
              <AsinLink asin={item.asin} className="font-mono text-blue-400 hover:text-blue-300 hover:underline" />
              <ChannelBadge channel={item.fulfillment_channel} />
              {liveStateBadge(item.amazon_status, item.amazon_qty)}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1 rounded hover:bg-bg-hover text-text-tertiary" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4 text-[11px]">
          {/* Identifiers */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Identifiers</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">ASIN</span><AsinLink asin={item.asin} className="font-mono text-text-secondary hover:text-blue-300 hover:underline" />
              {item.upc && (<><span className="text-text-tertiary">UPC</span><span className="font-mono text-text-secondary">{item.upc}</span></>)}
              <span className="text-text-tertiary">MSKU</span>
              <MskuLink sku={item.sku} className="font-mono text-text-secondary break-all hover:text-blue-300 hover:underline" />
            </div>
          </section>

          {/* Amazon snapshot */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Amazon (local snapshot)</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">Status</span><span className="text-text-secondary">{item.amazon_status ?? '—'}</span>
              <span className="text-text-tertiary">Amz qty</span><span className="font-mono text-text-secondary">{item.amazon_qty ?? '—'}</span>
              {item.amazon_list_price_cents != null && (<><span className="text-text-tertiary">Amz price</span><span className="font-mono text-text-secondary">{formatCurrency(item.amazon_list_price_cents)}</span></>)}
            </div>
          </section>

          {/* Receive */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Receive</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3 mb-2">
              <span className="text-text-tertiary">Received</span><span className="font-mono text-text-secondary">{item.quantity_received ?? '—'}</span>
              <span className="text-text-tertiary">Order qty</span><span className="font-mono text-text-secondary">{item.parsed_order_qty ?? '—'}</span>
              <span className="text-text-tertiary" title="Sellable units remaining in inventory — not the same as 'remaining to receive'">Unsold qty</span><span className="font-mono text-text-secondary">{item.quantity_remaining ?? '—'}</span>
              <span className="text-text-tertiary">Inspected</span><span className="text-text-secondary">{item.inspected_at ? '✓ ' + item.inspected_at.slice(0, 10) : '—'}</span>
            </div>
            {progress && <ReceiveProgressBar progress={progress} variant="full" />}
          </section>

          {/* Money — only for items in the batch with draft fields */}
          {inBatch && profit && profit.listCents != null && profit.costCents != null && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Profit estimate</div>
              <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
                <span className="text-text-tertiary">List</span><span className="font-mono text-text-secondary">{formatCurrency(profit.listCents)}</span>
                <span className="text-text-tertiary">Cost</span><span className="font-mono text-text-secondary">{formatCurrency(profit.costCents)}</span>
                <span className="text-text-tertiary">Ship est</span><span className="font-mono text-text-secondary">{formatCurrency(profit.shipCents)}</span>
                <span className="text-text-tertiary">{profit.referralRate != null ? `Referral (${(profit.referralRate * 100).toFixed(0)}%)` : 'Fee'}</span>
                <span className="font-mono text-text-secondary">
                  {profit.referralCents != null ? formatCurrency(profit.referralCents) : <span className="text-text-tertiary/50 italic">not cached</span>}
                </span>
                {profit.vcfCents > 0 && (<><span className="text-text-tertiary">VCF</span><span className="font-mono text-text-secondary">{formatCurrency(profit.vcfCents)}</span></>)}
                <span className="text-text-tertiary">Net</span>
                <span className={`font-mono font-medium ${
                  !profit.hasFee ? 'text-text-secondary' : profit.netCents != null && profit.netCents > 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {profit.netCents != null ? `${!profit.hasFee ? '~' : ''}${formatCurrency(profit.netCents)}` : '—'}
                </span>
                {profit.roiPct != null && profit.hasFee && (<><span className="text-text-tertiary">ROI</span>
                  <span className={`font-mono ${profit.roiPct > 0 ? 'text-green-400/90' : 'text-red-400/90'}`}>
                    {profit.roiPct.toFixed(1)}%
                  </span></>)}
                {profit.marginPct != null && profit.hasFee && (<><span className="text-text-tertiary">Margin</span>
                  <span className="font-mono text-text-secondary">
                    {profit.marginPct.toFixed(1)}%
                  </span></>)}
              </div>
              {!profit.hasFee && (
                <p className="text-[10px] text-text-tertiary/60 italic mt-1.5">Estimate — Amazon fee not cached. ROI/margin hidden until fee is available.</p>
              )}
            </section>
          )}

          {/* Saved fields */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Saved fields</div>
            <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
              <span className="text-text-tertiary">Condition</span><span className="text-text-secondary">{condDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Bin</span><span className="font-mono text-text-secondary">{binDisplay ?? '—'}</span>
              <span className="text-text-tertiary">Template</span>
              {rawTmpl
                ? resolveShippingTemplate(rawTmpl, amazonTemplates ?? null)
                  ? <span className="text-text-secondary text-[10px] break-all">Template: {tmplDisplay}</span>
                  : <span className="text-text-tertiary/60 text-[10px] break-all">Stored template: {rawTmpl} <span className="opacity-70">(not synced)</span></span>
                : <span className="text-text-tertiary/40 text-[10px]">No template selected</span>
              }
            </div>
          </section>

          {/* Warnings */}
          {chips.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary/70 mb-1.5">Warnings</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {chips.map(c => <WarningChip key={c.label} chip={c} />)}
              </div>
            </section>
          )}
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 px-4 py-3 bg-slate-800 border-t border-border-subtle flex items-center justify-end gap-2">
          {onPrintLabel && (
            <button
              onClick={onPrintLabel}
              className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <Printer size={12} /> Print label
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <Pencil size={12} /> Edit
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-slate-900/40 text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
