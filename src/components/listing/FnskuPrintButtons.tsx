'use client';

import { useEffect, useState, useRef } from 'react';
import { Package, Loader2, ChevronDown } from 'lucide-react';

// ─── PrintRowButton ─────────────────────────────────────────────────────────
// Per-row FNSKU print picker. Click the package icon → small popover opens
// with a quantity input + "Print all (N)" / "Print 1" shortcuts. Defaults to
// the row's full quantity; user can type any number for partial reprints.
export function PrintRowButton({
  defaultQty,
  isPrinting,
  onPrint,
  onDownload,
}: {
  defaultQty: number;
  isPrinting: boolean;
  onPrint: (copies: number) => void;
  onDownload: (copies: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(defaultQty));
  // Smart positioning: flip the popover above the trigger when the row is
  // near the bottom of the viewport and the default below-positioning would
  // get cut off. Decided on open via getBoundingClientRect().
  const [openAbove, setOpenAbove] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Decide direction on open: flip the popover above the trigger when the row
  // is near the bottom of the viewport (popover is ~150-200px tall).
  function toggleOpen() {
    if (open) { setOpen(false); return; }
    setQty(String(defaultQty));
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenAbove(spaceBelow < 220 && spaceAbove > spaceBelow);
    }
    setOpen(true);
  }

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function go(action: 'print' | 'download') {
    const n = parseInt(qty);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      alert('Quantity must be 1–200');
      return;
    }
    setOpen(false);
    if (action === 'print') onPrint(n);
    else onDownload(n);
  }

  // Show the "All (N)" / "1 (replacement)" shortcuts only when they're
  // actually useful (i.e., qty > 1). For qty=1 rows the input already
  // contains 1 and both shortcuts are no-ops.
  const showShortcuts = defaultQty > 1;

  return (
    <div ref={ref} className="relative inline-flex justify-end">
      <button
        ref={triggerRef}
        onClick={toggleOpen}
        disabled={isPrinting}
        className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors disabled:opacity-50"
        title={`Print FNSKU label (${defaultQty} unit${defaultQty === 1 ? '' : 's'})`}
      >
        {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
      </button>
      {open && (
        <div className={`absolute right-0 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl p-3 text-sm ${openAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Print FNSKU labels</div>
          <div className="flex items-center gap-2 mb-2">
            <input
              autoComplete="off"
              type="number"
              min="1"
              max="200"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') go('print'); }}
              autoFocus
              className="w-20 h-8 px-2 bg-bg-surface border border-border-default rounded text-sm font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-text-tertiary">label{parseInt(qty) === 1 ? '' : 's'}</span>
          </div>
          {showShortcuts && (
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setQty(String(defaultQty))}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title={`Reset to all ${defaultQty} units`}
              >
                All ({defaultQty})
              </button>
              <button
                onClick={() => setQty('1')}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title="Print just 1 — useful for replacing a damaged label"
              >
                1 (replacement)
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle">
            <button
              onClick={() => go('download')}
              className="text-[11px] px-2 py-1.5 text-text-secondary hover:text-text-primary transition-colors"
            >
              Download PDF
            </button>
            <button
              onClick={() => go('print')}
              disabled={isPrinting}
              className="h-7 px-3 bg-accent text-white rounded text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              Print to Rollo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FnskuPrintButton ───────────────────────────────────────────────────────
// Split-button: primary action prints 1 label per SKU (Rollo dialog handles
// quantity). Caret opens a small menu for the other mode (1 per unit) plus
// PDF download options.

// ─── FnskuPrintButton ───────────────────────────────────────────────────────
// Split-button: primary action prints 1 label per SKU (Rollo dialog handles
// quantity). Caret opens a small menu for the other mode (1 per unit) plus
// PDF download options.
export function FnskuPrintButton({
  printing,
  onPrint,
  onDownload,
}: {
  printing: boolean;
  onPrint: (mode: 'per-sku' | 'per-unit') => void;
  onDownload: (mode: 'per-sku' | 'per-unit') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => onPrint('per-sku')}
        disabled={printing}
        className="flex items-center gap-2 h-9 pl-3 pr-2 bg-bg-elevated border border-border-default rounded-l-md border-r-0 text-sm text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="Print 1 FNSKU label per unique SKU. Set the copy count at the Rollo print dialog."
      >
        {printing ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
        {printing ? 'Printing…' : 'Print FNSKU (1/SKU)'}
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={printing}
        className="flex items-center justify-center h-9 px-1.5 bg-bg-elevated border border-border-default rounded-r-md text-sm text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="More label options"
        aria-label="More options"
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl py-1 text-sm">
          <button
            onClick={() => { setOpen(false); onPrint('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-primary">Print all units (pre-counted)</div>
            <div className="text-[11px] text-text-tertiary">One label per unit. No Rollo qty dialog.</div>
          </button>
          <div className="my-1 border-t border-border-subtle"></div>
          <button
            onClick={() => { setOpen(false); onDownload('per-sku'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (1/SKU)</div>
          </button>
          <button
            onClick={() => { setOpen(false); onDownload('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (all units)</div>
          </button>
        </div>
      )}
    </div>
  );
}
