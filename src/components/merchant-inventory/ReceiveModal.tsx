'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/formatters';
import { X, Check, CheckCircle2 } from 'lucide-react';

import { ReceiveStatusBadge } from '@/components/merchant-inventory/badges';
import { getReceiveStatus, sellerCentralSkuUrl } from '@/components/merchant-inventory/helpers';
import { ReceiveModalProps } from '@/components/merchant-inventory/types';

const CONDITIONS = [
  'New',
  'Used - Like New',
  'Used - Very Good',
  'Used - Good',
  'Used - Acceptable',
];

export function ReceiveModal({ row, title = 'Update Stock', onClose, onSaved }: ReceiveModalProps) {
  const status = getReceiveStatus(row) ?? 'pending';
  const isReceived = status !== 'pending';
  const isInspected = status === 'inspected' || status === 'ready';

  const [qtyReceived, setQtyReceived] = useState(
    row.quantity_received != null
      ? String(row.quantity_received)
      : String(row.quantity_remaining ?? 0)
  );
  const [receiveNotes, setReceiveNotes] = useState(row.receive_notes ?? '');
  const [listPrice, setListPrice] = useState(
    row.il_list_price_cents != null ? (row.il_list_price_cents / 100).toFixed(2) : ''
  );
  const [bin, setBin] = useState(row.bin_location ?? '');
  const [condition, setCondition] = useState(row.condition ?? '');
  const [markInspected, setMarkInspected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyNum = Number(qtyReceived);
  const listPriceNum = parseFloat(listPrice);
  const willBeReceived = isReceived || (Number.isFinite(qtyNum) && qtyNum > 0);

  const preview = {
    qty:       Number.isFinite(qtyNum) && qtyNum > 0,
    inspected: isInspected || (willBeReceived && markInspected),
    bin:       !!(bin.trim()),
    condition: !!(condition.trim()),
    price:     !!(listPrice.trim()) && Number.isFinite(listPriceNum) && listPriceNum > 0,
  };
  const allReady = Object.values(preview).every(Boolean);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (qtyReceived.trim() !== '' && (!Number.isFinite(qtyNum) || qtyNum < 0)) {
        setError('Quantity received must be a non-negative number');
        return;
      }
      if (listPrice.trim() !== '' && (!Number.isFinite(listPriceNum) || listPriceNum < 0)) {
        setError('List price must be a non-negative number');
        return;
      }

      const body: Record<string, unknown> = { id: row.il_id };

      if (qtyReceived.trim() !== '') body.quantityReceived = qtyNum;
      body.receiveNotes = receiveNotes.trim() || null;
      if (listPrice.trim() !== '') body.listPriceCents = Math.round(listPriceNum * 100);
      body.binLocation = bin.trim() || null;
      body.condition = condition.trim() || null;

      if (!isReceived && qtyNum > 0) body.markReceived = true;
      if (markInspected && !isInspected && willBeReceived) body.markInspected = true;

      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || 'Save failed');
        return;
      }

      onSaved();
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[480px] max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <p className="text-[11px] text-text-tertiary mt-0.5 truncate">
              {row.product_name || row.asin}
            </p>
          </div>
          <button onClick={onClose} className="ml-3 p-1 rounded hover:bg-bg-hover text-text-tertiary shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Lot summary */}
          <div className="flex items-center gap-3 py-2.5 px-3 bg-bg-elevated rounded-lg border border-border-subtle">
            {row.image_url
              ? <img src={row.image_url} alt="" className="w-10 h-10 object-contain rounded shrink-0" />
              : <div className="w-10 h-10 bg-bg-surface rounded shrink-0" />}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="text-[11px] font-mono text-text-tertiary">{row.asin}</div>
              {sellerCentralSkuUrl(row.sku)
                ? <a
                    href={sellerCentralSkuUrl(row.sku)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="block text-[11px] font-mono text-accent truncate hover:underline"
                    title={`Open MSKU in Seller Central: ${row.sku}`}
                  >
                    {row.sku}
                  </a>
                : <div className="text-[11px] font-mono text-text-tertiary truncate">{row.sku}</div>}
              {row.quantity != null && row.buy_price != null && (
                <div className="text-[11px] text-text-secondary">
                  {row.quantity} purchased · {formatCurrency(row.buy_price)}/unit
                </div>
              )}
            </div>
            <ReceiveStatusBadge status={status} />
          </div>

          {allReady && (
            <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs font-medium">
              <CheckCircle2 size={14} />
              Ready to Activate — all required fields set
            </div>
          )}

          {/* Receive */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Receive</div>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">
                  Quantity Received
                  <span className="ml-1 text-text-tertiary/60">
                    (default: {row.quantity_remaining ?? 0} in stock)
                  </span>
                </label>
                <input
                  type="number" min="0" step="1"
                  value={qtyReceived}
                  onChange={e => setQtyReceived(e.target.value)}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
                {row.quantity_received != null && row.quantity != null && row.quantity_received !== row.quantity && (
                  <p className="text-[11px] text-amber-400 mt-1">
                    Previously received {row.quantity_received} of {row.quantity} purchased
                  </p>
                )}
                {isReceived && row.received_at && (
                  <p className="text-[11px] text-text-tertiary mt-1">
                    Received on {new Date(row.received_at).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Receive Notes (optional)</label>
                <input
                  type="text"
                  value={receiveNotes}
                  onChange={e => setReceiveNotes(e.target.value)}
                  placeholder="e.g. 2 units damaged, 1 missing"
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Details */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Details</div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">List Price ($)</label>
                  <input
                    type="number" min="0" step="0.01"
                    value={listPrice}
                    onChange={e => setListPrice(e.target.value)}
                    placeholder="e.g. 29.99"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-tertiary mb-1">Bin Location</label>
                  <input
                    type="text"
                    value={bin}
                    onChange={e => setBin(e.target.value)}
                    placeholder="e.g. S1-B3"
                    className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-text-tertiary mb-1">Condition</label>
                <select
                  value={condition}
                  onChange={e => setCondition(e.target.value)}
                  className="w-full h-8 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">— select condition —</option>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Inspection */}
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2.5">Inspection</div>
            {isInspected && row.inspected_at ? (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <Check size={13} />
                Inspected on {new Date(row.inspected_at).toLocaleDateString()}
              </div>
            ) : (
              <label className={`flex items-center gap-2.5 ${willBeReceived ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
                <input
                  type="checkbox"
                  checked={markInspected}
                  disabled={!willBeReceived}
                  onChange={e => setMarkInspected(e.target.checked)}
                  className="accent-accent"
                />
                <span className="text-xs text-text-secondary">
                  Mark as inspected
                  {!willBeReceived && <span className="text-text-tertiary ml-1">— receive first</span>}
                </span>
              </label>
            )}
          </div>

          {/* Readiness checklist */}
          {!allReady && (
            <div>
              <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">
                Required for Ready to Activate
              </div>
              <div className="space-y-1.5">
                {[
                  { label: 'Quantity received', met: preview.qty },
                  { label: 'Inspected',         met: preview.inspected },
                  { label: 'Bin location',       met: preview.bin },
                  { label: 'Condition',          met: preview.condition },
                  { label: 'List price',         met: preview.price },
                ].map(({ label, met }) => (
                  <div key={label} className={`flex items-center gap-2 text-[11px] ${met ? 'text-green-400' : 'text-text-tertiary'}`}>
                    {met
                      ? <Check size={11} />
                      : <span className="w-[11px] h-[11px] rounded-full border border-text-tertiary/40 inline-block shrink-0" />}
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            className="flex-1 h-9 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrintModal
// ---------------------------------------------------------------------------
