'use client';

import { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { realFnsku } from '@/components/merchant-inventory/helpers';
import { LabelMode, LabelSpec, MerchantRow, PrintModalProps } from '@/components/merchant-inventory/types';

function openPrintWindow(specs: LabelSpec[]) {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Activation CSV export — Phase 1: generate file for manual Seller Central upload.
// No Amazon writes. No DB writes. Pure client-side computation.
//
// Column names match Amazon's Inventory Loader flat file template exactly:
//   merchant-shipping-group-name — shipping template name (Seller Central
//     Settings → Shipping Settings → Shipping Templates). Must match the exact
//     template name on the account. Update DEFAULT_MFN_SHIPPING_TEMPLATE below.
//
// Price priority: receive-modal price (il_list_price_cents)
//                → Amazon current price (amazon_list_price_cents)
//                → MSKU-parsed estimate (parsed_list_price_cents)
// Quantity: quantity_received (physically inspected count) → quantity_remaining
// ---------------------------------------------------------------------------

// Update this constant to match the exact shipping template name in Seller Central.
// Seller Central → Settings → Shipping Settings → Shipping Templates.
// The template name seen in synced listing data for this account was:
//   'DEFAULT MFN USE THIS ONE'
// Verify it in Seller Central before uploading any CSV.

// Update this constant to match the exact shipping template name in Seller Central.
// Seller Central → Settings → Shipping Settings → Shipping Templates.
// The template name seen in synced listing data for this account was:
//   'DEFAULT MFN USE THIS ONE'
// Verify it in Seller Central before uploading any CSV.
export const DEFAULT_MFN_SHIPPING_TEMPLATE = 'DEFAULT MFN USE THIS ONE';

const LABEL_MODES: { mode: LabelMode; label: string; desc: string }[] = [
  { mode: 'asin',      label: 'ASIN Label',              desc: 'Customer Safe' },
  { mode: 'warehouse', label: 'Internal Warehouse Label', desc: 'Internal use only' },
  { mode: 'fnsku',     label: 'FNSKU Label',              desc: 'Requires real FNSKU' },
  { mode: 'custom',    label: 'Custom Label',             desc: 'Free-text' },
];

export function PrintModal({ selected, onClose }: PrintModalProps) {
  const [labelMode, setLabelMode] = useState<LabelMode>('asin');
  const [size, setSize] = useState<'2x1' | '4x6'>('2x1');
  const [showPrice, setShowPrice] = useState(false);
  const [showBin, setShowBin] = useState(false);
  const [custom, setCustom] = useState({ title: '', subtitle: '', notes: '', sku: '', asin: '', bin: '' });

  const fnskuCount = selected.filter(r => realFnsku(r.fnsku)).length;
  const hasFnsku = fnskuCount > 0;

  function handlePrint() {
    if (labelMode === 'custom') {
      openPrintWindow([{
        labelMode: 'custom', size,
        title:    custom.title    || undefined,
        subtitle: custom.subtitle || undefined,
        notes:    custom.notes    || undefined,
        sku:      custom.sku      || undefined,
        asin:     custom.asin     || undefined,
        bin:      custom.bin      || undefined,
      }]);
      return;
    }

    if (labelMode === 'asin') {
      const specs: LabelSpec[] = selected.map(r => {
        const spec: LabelSpec = {
          labelMode: 'asin', size,
          title: r.product_name || r.asin,
          asin: r.asin,
          condition: r.condition || undefined,
        };
        if (showBin && r.bin_location) { spec.showBin = true; spec.bin = r.bin_location; }
        return spec;
      });
      openPrintWindow(specs);
      return;
    }

    if (labelMode === 'fnsku') {
      const rowsWithFnsku = selected
        .map(r => ({ row: r, fnsku: realFnsku(r.fnsku) }))
        .filter((e): e is { row: MerchantRow; fnsku: string } => Boolean(e.fnsku));
      if (rowsWithFnsku.length === 0) { alert('No selected items have a real FNSKU yet.'); return; }
      openPrintWindow(rowsWithFnsku.map(({ row, fnsku }) => ({
        labelMode: 'fnsku', size,
        title: row.product_name || row.asin,
        asin: row.asin, fnsku,
        condition: row.condition || undefined,
      })));
      return;
    }

    openPrintWindow(selected.map(r => ({
      labelMode: 'warehouse', size,
      title: r.product_name || r.asin,
      asin: r.asin, sku: r.sku || undefined,
      bin: r.bin_location || undefined,
      condition: r.condition || undefined,
      priceCents: r.buy_price ?? 0,
      showPrice,
    })));
  }

  const canPrint =
    labelMode === 'custom'
      ? !!(custom.title || custom.subtitle || custom.bin)
      : labelMode === 'fnsku'
        ? selected.length > 0 && selected.some(r => realFnsku(r.fnsku))
        : selected.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Printer size={15} className="text-text-tertiary" />
            Print Labels
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-tertiary">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Label Type</div>
            <div className="space-y-1.5">
              {LABEL_MODES.map(({ mode, label, desc }) => {
                const disabled = mode === 'fnsku' && !hasFnsku;
                return (
                  <label
                    key={mode}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors cursor-pointer ${
                      disabled
                        ? 'opacity-40 cursor-not-allowed border-border-subtle'
                        : labelMode === mode
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-border-subtle hover:border-border-default hover:bg-bg-hover'
                    }`}
                  >
                    <input
                      type="radio" name="labelMode" value={mode}
                      checked={labelMode === mode} disabled={disabled}
                      onChange={() => setLabelMode(mode)} className="accent-accent shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-text-primary">{label}</div>
                      <div className="text-[11px] text-text-tertiary">{desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {labelMode === 'asin' && (
              <p className="text-[11px] text-text-tertiary mt-2 pl-1">
                Customer Safe — excludes MSKU, cost, supplier, and purchase details.
              </p>
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Label Size</div>
            <div className="flex gap-2">
              {(['2x1', '4x6'] as const).map(s => (
                <button
                  key={s} onClick={() => setSize(s)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    size === s
                      ? 'bg-accent/10 text-accent border-accent/40'
                      : 'bg-bg-elevated text-text-secondary border-border-subtle hover:border-border-default'
                  }`}
                >
                  {s === '2x1' ? '2" × 1" (thermal)' : '4" × 6" (bin/shelf)'}
                </button>
              ))}
            </div>
          </div>

          {labelMode === 'asin' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showBin} onChange={e => setShowBin(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-text-secondary">Include bin location (for internal picking)</span>
            </label>
          )}
          {labelMode === 'warehouse' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={showPrice} onChange={e => setShowPrice(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-text-secondary">Show buy price on label</span>
            </label>
          )}
          {labelMode === 'fnsku' && hasFnsku && (
            <p className="text-[11px] text-text-tertiary">
              {fnskuCount} of {selected.length} selected item{selected.length !== 1 ? 's' : ''} have a real FNSKU.
              Items without FNSKU will be skipped.
            </p>
          )}

          {labelMode === 'custom' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  {size === '4x6' ? 'Large Text (e.g. bin name)' : 'Title'}
                </label>
                <input type="text" value={custom.title}
                  onChange={e => setCustom(c => ({ ...c, title: e.target.value }))}
                  placeholder={size === '4x6' ? 'S1-B3' : 'Label title'}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Subtitle</label>
                <input type="text" value={custom.subtitle}
                  onChange={e => setCustom(c => ({ ...c, subtitle: e.target.value }))}
                  placeholder="Optional subtitle"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Notes</label>
                <input type="text" value={custom.notes}
                  onChange={e => setCustom(c => ({ ...c, notes: e.target.value }))}
                  placeholder="Optional notes"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Bin / Location</label>
                  <input type="text" value={custom.bin}
                    onChange={e => setCustom(c => ({ ...c, bin: e.target.value }))}
                    placeholder="e.g. S1-B3"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">SKU (optional)</label>
                  <input type="text" value={custom.sku}
                    onChange={e => setCustom(c => ({ ...c, sku: e.target.value }))}
                    placeholder="SKU for barcode"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {labelMode !== 'custom' && selected.length > 0 && (
            <div className="space-y-1 max-h-36 overflow-y-auto">
              <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-1.5">
                {selected.length} item{selected.length !== 1 ? 's' : ''} selected
              </div>
              {selected.map(r => (
                <div key={r.row_key} className="flex items-center gap-2 py-1 border-b border-border-subtle/50 last:border-0">
                  {r.image_url
                    ? <img src={r.image_url} alt="" className="w-7 h-7 object-contain rounded shrink-0" />
                    : <div className="w-7 h-7 bg-bg-elevated rounded shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary truncate">{r.product_name || r.asin}</div>
                    <div className="text-[10px] font-mono text-text-tertiary">{r.asin}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {r.bin_location && (
                      <span className="text-[10px] font-mono font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                        {r.bin_location}
                      </span>
                    )}
                    {realFnsku(r.fnsku) && (
                      <span className="text-[10px] font-mono text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                        FNSKU
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 px-5 pb-4">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handlePrint}
            disabled={!canPrint}
            className="flex-1 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            <Printer size={14} />
            Print
          </button>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
