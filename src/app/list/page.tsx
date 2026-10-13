'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { Plus, Package, Trash2 } from 'lucide-react';
import { useQuery } from '@/lib/useQuery';
import { StatusBadge } from '@/components/listing/BatchBadges';

interface BatchRow {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  isHolding: number;
  inboundPlanId: string | null;
  createdAt: string;
  updatedAt: string;
  totalUnits: number;
  skuCount: number;
  expectedRevenue: number;
  totalCost: number;
  estimatedFees: number;
}

const CHANNEL_LABEL: Record<string, string> = { FBA: 'FBA', MFN: 'MFN', WFS: 'Walmart WFS', WMT_SF: 'Walmart SF' };

export default function BatchesPage() {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'FBA' | 'MFN' | 'WFS' | 'WMT_SF'>('FBA');
  const walmart = channel === 'WFS' || channel === 'WMT_SF';
  const [creating, setCreating] = useState(false);

  const { data, loading, reload: fetchBatches } = useQuery<{ batches?: BatchRow[] }>('/api/list/batches');
  const batches: BatchRow[] = data?.batches || [];

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/list/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), channel }),
      });
      const data = await res.json();
      if (data.id) {
        window.location.href = `/list/${data.id}`;
      }
    } catch (err) {
      console.error(err);
    }
    setCreating(false);
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this draft batch? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/list/batches/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || `Delete failed (${res.status})`);
      fetchBatches();
    } catch (err) {
      console.error(err);
    }
  }

  async function openStockToSend() {
    const res = await fetch('/api/list/walmart/holding', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (data.id) window.location.href = `/list/${data.id}`;
  }

  function defaultName() {
    const d = new Date();
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} Batch`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title">Listing Batches</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Create, prep, and ship inventory to Amazon and Walmart</p>
        </div>
        <div className="flex items-center gap-2">
        <button
          onClick={openStockToSend}
          className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong text-text-primary rounded-md text-sm font-semibold hover:bg-bg-hover transition-colors"
          title="Units bought for Walmart WFS that aren't in a shipment yet"
        >
          <Package size={16} />
          Walmart stock to send
        </button>
        <button
          onClick={() => { setName(defaultName()); setShowNew(true); }}
          className="flex items-center gap-2 h-9 px-3 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 transition-colors"
        >
          <Plus size={16} />
          New Batch
        </button>
        </div>
      </div>

      {/* Batch list */}
      {loading ? (
        <div className="panel p-8 text-center text-text-tertiary">
          Loading batches…
        </div>
      ) : batches.length === 0 ? (
        <div className="panel p-12 text-center">
          <Package size={48} className="mx-auto text-text-tertiary mb-3" />
          <h3 className="text-base font-medium text-text-primary mb-1">No batches yet</h3>
          <p className="text-sm text-text-tertiary mb-4">Create your first batch to start listing inventory.</p>
          <button
            onClick={() => { setName(defaultName()); setShowNew(true); }}
            className="inline-flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 transition-colors"
          >
            <Plus size={16} />
            New Batch
          </button>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-surface">
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Name</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-24">Status</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-20">Channel</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-20">SKUs</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-20">Units</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Expected Rev</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Cost</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Updated</th>
                <th className="px-2 py-2.5 text-right w-10"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-2">
                    <Link href={`/list/${b.id}`} className="text-sm text-text-primary font-medium hover:text-link">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{b.isHolding ? <span className="tag">WAITING</span> : <StatusBadge status={b.status} />}</td>
                  <td className="px-4 py-2 text-sm text-text-secondary">{CHANNEL_LABEL[b.channel] ?? b.channel}</td>
                  <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{b.skuCount}</td>
                  <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{b.totalUnits}</td>
                  <td className="px-4 py-2 text-right text-sm text-text-primary tabular-nums">{formatCurrency(b.expectedRevenue)}</td>
                  <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{formatCurrency(b.totalCost)}</td>
                  <td className="px-4 py-2 text-right text-xs text-text-tertiary">{new Date(b.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td className="px-2 py-2 text-right">
                    {b.status === 'draft' && !b.isHolding && (
                      <button
                        onClick={() => handleDelete(b.id)}
                        className="p-1 text-text-tertiary hover:text-negative transition-colors"
                        title="Delete draft"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New Batch modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowNew(false)}>
          <div className="panel w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="panel-bar"><span className="flex items-center gap-2">New Batch</span></h2>
<div className="p-5">
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-tertiary label-caps">Batch Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="w-full mt-1 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-link"
                />
              </div>
              <div>
                <label className="text-xs text-text-tertiary label-caps">Marketplace</label>
                <div className="seg w-full mt-1" role="group" aria-label="Marketplace">
                  <button onClick={() => setChannel('FBA')} aria-current={!walmart ? 'true' : undefined} className="flex-1">Amazon</button>
                  <button onClick={() => setChannel('WFS')} aria-current={walmart ? 'true' : undefined} className="flex-1">Walmart</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-tertiary label-caps">Fulfillment</label>
                <div className="seg w-full mt-1" role="group" aria-label="Fulfillment">
                  {walmart ? (
                    <>
                      <button onClick={() => setChannel('WFS')} aria-current={channel === 'WFS' ? 'true' : undefined} className="flex-1">WFS</button>
                      <button onClick={() => setChannel('WMT_SF')} aria-current={channel === 'WMT_SF' ? 'true' : undefined} className="flex-1">Seller Fulfilled</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setChannel('FBA')} aria-current={channel === 'FBA' ? 'true' : undefined} className="flex-1">FBA</button>
                      <button onClick={() => setChannel('MFN')} aria-current={channel === 'MFN' ? 'true' : undefined} className="flex-1">Merchant Fulfilled</button>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setShowNew(false)}
                className="h-9 px-3 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || creating}
                className="h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? 'Creating…' : 'Create & Start'}
              </button>
            </div>
          </div>
</div>
        </div>
      )}
    </div>
  );
}
