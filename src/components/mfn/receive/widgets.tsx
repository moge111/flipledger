'use client';

import { useEffect, useRef, useState } from 'react';

import {Loader2 } from 'lucide-react';

import {Chip, InlineQtyEditProps, ReceiveProgress } from '@/components/mfn/receive/types';

export function WarningChip({ chip }: { chip: Chip }) {
  const cls = chip.tone === 'blocker'
    ? 'tag text-negative'
    : chip.tone === 'warn'
      ? 'tag text-warning'
      : 'tag text-text-tertiary';
  return (
    <span
      className={`inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border tabular-nums ${cls}`}
      title={chip.title}
    >
      {chip.label}
    </span>
  );
}

// Renders a flat list of WarningChip elements. Callers own the wrapping
// container (gap, flex, null-guard) so this stays layout-agnostic.

// Renders a flat list of WarningChip elements. Callers own the wrapping
// container (gap, flex, null-guard) so this stays layout-agnostic.
export function BatchItemChips({ chips }: { chips: Chip[] }) {
  return <>{chips.map(c => <WarningChip key={c.label} chip={c} />)}</>;
}

// Channel badge — DEFAULT = MFN, AMAZON_NA = FBA. Sourced from
// merchant_listings.fulfillment_channel. Display only.

// Channel badge — DEFAULT = MFN, AMAZON_NA = FBA. Sourced from
// merchant_listings.fulfillment_channel. Display only.
export function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  if (!channel) return null;
  const isFba = channel === 'AMAZON_NA';
  const label = isFba ? 'FBA' : channel === 'DEFAULT' ? 'MFN' : channel;
  const cls = isFba
    ? 'tag text-link'
    : 'tag text-text-secondary';
  return (
    <span className={`inline-flex items-center px-1.5 h-4 rounded text-[9px] font-medium border ${cls}`} title={`Fulfillment channel: ${channel}`}>
      {label}
    </span>
  );
}

// Receive progress derived from existing fields — display only.
// total    = parsed_order_qty (from MSKU) ?? quantity_received (best local proxy)
// received = quantity_received
// remaining = max(0, total - received)
// Returns null when there's no lot OR no usable signal for total.

export function ReceiveProgressBar({ progress, variant = 'compact' }: { progress: ReceiveProgress; variant?: 'compact' | 'full' }) {
  const fillCls = progress.isOver
    ? 'bg-warning'
    : progress.pct >= 100 ? 'bg-positive' : 'bg-chart-1';
  const recvCls = progress.isOver ? 'text-warning font-medium' : 'text-text-tertiary';
  const overTitle = progress.isOver
    ? `Over-received: ${progress.received - progress.total} extra (received ${progress.received} of ${progress.total})`
    : `Received ${progress.received} of ${progress.total} · ${progress.remaining} remaining`;

  if (variant === 'compact') {
    return (
      <span className="inline-flex items-center gap-1.5" title={overTitle}>
        <span className={`tabular-nums ${recvCls}`}>
          Recv {progress.received}/{progress.total}{progress.isOver ? ' · Over' : ''}
        </span>
        <span className="inline-block w-12 h-1 bg-border-subtle rounded-[1px] overflow-hidden">
          <span className={`block h-full rounded-[1px] transition-all ${fillCls}`} style={{ width: `${progress.pct}%` }} />
        </span>
      </span>
    );
  }
  return (
    <div className="mb-3 px-3 py-2 bg-bg-hover rounded-lg border border-border-subtle">
      <div className="flex items-center justify-between text-[11px] mb-1.5">
        <span className="text-text-tertiary">
          Receive progress
          {progress.isOver && (
            <span className="ml-2 text-warning/90 font-medium" title={overTitle}>
              · Over by {progress.received - progress.total}
            </span>
          )}
        </span>
        <span className="tabular-nums">
          <span className={`tabular-nums ${progress.isOver ? 'text-warning/90' : 'text-positive/90'}`}>
            Received {progress.received}
          </span>
          <span className="text-text-tertiary/50 mx-1.5">·</span>
          <span className={`tabular-nums ${progress.remaining > 0 ? 'text-warning/80' : 'text-text-tertiary'}`}>
            Remaining {progress.remaining}
          </span>
          <span className="text-text-tertiary/50 mx-1.5">/</span>
          <span className="text-text-secondary tabular-nums">{progress.total}</span>
        </span>
      </div>
      <div className="h-1.5 bg-border-subtle rounded-[1px] overflow-hidden">
        <div className={`h-full rounded-[1px] transition-all ${fillCls}`} style={{ width: `${progress.pct}%` }} />
      </div>
    </div>
  );
}

// Inline qty quick-edit for the saved row. Local UI state; commits via
// the parent's onSave (which only touches quantity_received via the
// existing inventory-lots PATCH route).

export function InlineQtyEdit({ value, onSave, forceOpen, onOpened }: InlineQtyEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  // Guards Enter + blur double-fire (and rapid clicks). Reset on each open.
  const committedRef = useRef(false);

  function start() {
    if (saving) return;
    setDraft(String(value ?? 0));
    committedRef.current = false;
    setError(null);
    setEditing(true);
  }

  function cancel() {
    committedRef.current = true;
    setEditing(false);
    setError(null);
  }

  async function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    // Strict whole-integer validation. Rejects blank, decimal, negative,
    // Infinity, NaN, scientific notation, signs, and any non-digit.
    const trimmed = draft.trim();
    if (!/^\d+$/.test(trimmed)) {
      setError('Whole number ≥ 0');
      committedRef.current = false; // keep open, allow retry
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) {
      setError('Whole number ≥ 0');
      committedRef.current = false;
      return;
    }
    if (n === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onSave(n);
    setSaving(false);
    if (result.ok) {
      setEditing(false);
    } else {
      setError(result.error ?? 'Save failed');
      // Allow retry — clear the guard so Enter/blur can re-fire on the next attempt.
      committedRef.current = false;
    }
  }

  // Opens the editor imperatively when the parent signals focusQty for this row.
  // autoFocus on the input handles actual DOM focus once editing=true renders.
  useEffect(() => {
    if (forceOpen) { start(); onOpened?.(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number" min="0" step={1} inputMode="numeric" autoFocus
          value={draft}
          onChange={e => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={e => {
            if (e.key === 'Enter')      { e.preventDefault(); commit(); }
            else if (e.key === 'Escape'){ e.preventDefault(); cancel(); }
          }}
          onBlur={() => commit()}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          className={`w-12 h-5 px-1.5 bg-bg-surface rounded text-[10px] text-text-primary focus:outline-none disabled:opacity-50 border tabular-nums ${
            error ? 'border-negative/60 focus:border-negative' : 'border-link/40 focus:border-link'
          }`}
        />
        {saving && <Loader2 size={9} className="animate-spin text-text-tertiary/70" />}
        {error && <span className="text-[9px] text-negative" title={error}>!</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className="inline-flex items-center hover:text-text-secondary px-1 -mx-1 rounded hover:bg-bg-hover transition-colors tabular-nums"
      title="Click to edit received qty"
    >
      Qty {value ?? '—'}
    </button>
  );
}

// Discriminator: a BatchItem has draft_* fields and save_state; a bare
// SearchResult does not. Used by the details drawer to render fewer
// sections when opened from a search result that hasn't been added.

function amazonAsinUrl(asin: string | null | undefined): string | null {
  const value = (asin ?? '').trim();
  return value ? `https://www.amazon.com/dp/${encodeURIComponent(value)}` : null;
}

function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  const value = (sku ?? '').trim();
  return value
    ? `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(value)}`
    : null;
}

export function AsinLink({ asin, className }: { asin: string | null | undefined; className?: string }) {
  const value = (asin ?? '').trim();
  const href = amazonAsinUrl(value);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={className}
      title={`Open ASIN on Amazon: ${value}`}
    >
      {value}
    </a>
  );
}

export function MskuLink({ sku, className }: { sku: string | null | undefined; className?: string }) {
  const value = (sku ?? '').trim();
  const href = sellerCentralSkuUrl(value);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={className}
      title={`Open MSKU in Seller Central: ${value}`}
    >
      {value}
    </a>
  );
}

// Read-only details flyout. No API calls; reuses ChannelBadge,
// WarningChip, ReceiveProgressBar, calcProfit, formatCurrency. Doesn't
// mutate save_state or touch any draft_* fields.
