'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import StatCard from '@/components/ui/StatCard';
import { useQuery } from '@/lib/useQuery';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

interface ItemResult {
  itemId: number; sku: string; asin: string; productName: string | null;
  sent: number; received: number | null; sold: number; returned: number; remaining: number; soldExact: boolean;
  plannedProfitPerUnit: number; actualProfitPerUnit: number | null; plannedProfit: number; actualProfit: number; revenue: number;
  daysTo50: number | null; daysTo80: number | null; lastSale: string | null;
}
interface BatchResult {
  batchId: number; name: string; channel: string; status: string; sentAt: string;
  sent: number; received: number | null; sold: number; returned: number; sellThrough: number;
  plannedProfit: number; plannedProfitSold: number; actualProfit: number; revenue: number;
  daysTo50: number | null; daysTo80: number | null; receiptsCheckedAt: string | null; items: ItemResult[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const daysCell = (d: number | null) => d == null ? <span className="text-text-tertiary">—</span> : <span className="tabular-nums">{d}d</span>;
const profitCls = (v: number) => `tabular-nums ${v < 0 ? 'text-negative' : 'text-text-primary'}`;

/** Actual vs planned profit on the units that sold. */
function Variance({ actual, planned }: { actual: number; planned: number }) {
  if (!planned && !actual) return <span className="text-text-tertiary">—</span>;
  const d = actual - planned;
  return <span className={`text-xs tabular-nums ${d < 0 ? 'text-negative' : 'text-positive'}`}>{d >= 0 ? '+' : ''}{formatCurrency(d)}</span>;
}

export default function BatchResultsPage() {
  const [channel, setChannel] = useState<'all' | 'FBA' | 'MFN'>('all');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, reload } = useQuery<{ batches: BatchResult[] }>('/api/data/batch-results');

  const batches = useMemo(() => (data?.batches ?? []).filter(b => channel === 'all' || b.channel === channel), [data, channel]);
  const t = useMemo(() => batches.reduce((a, b) => ({
    sent: a.sent + b.sent, sold: a.sold + b.sold, returned: a.returned + b.returned,
    actual: a.actual + b.actualProfit, plannedSold: a.plannedSold + b.plannedProfitSold,
  }), { sent: 0, sold: 0, returned: 0, actual: 0, plannedSold: 0 }), [batches]);

  async function refreshReceipts(batchId: number) {
    setRefreshing(batchId); setError(null);
    try {
      const res = await fetch(`/api/data/batch-results?batchId=${batchId}`, { method: 'POST' });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error || `Refresh failed (HTTP ${res.status})`);
      reload(true);
    } finally {
      setRefreshing(null);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="page-title">Batch Results</h1>
          <p className="text-sm text-text-secondary mt-1">What each batch did after it was sent: received, sold, returned, how fast, and profit against plan.</p>
        </div>
        <div className="seg" role="group" aria-label="Channel">
          {(['all', 'FBA', 'MFN'] as const).map(c => (
            <button key={c} onClick={() => setChannel(c)} aria-current={channel === c ? 'true' : undefined}>
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-negative flash flash-bad px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Units sent" value={t.sent} format="number" />
        <StatCard label="Units sold" value={t.sold} format="number" />
        <StatCard label="Sell-through" value={t.sent ? (t.sold / t.sent) * 100 : 0} format="percent" />
        <StatCard label="Actual profit (sold units)" value={t.actual} format="currency" accentColor={t.actual >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Planned profit (sold units)" value={t.plannedSold} format="currency" />
      </div>

      {loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 bg-bg-surface rounded animate-pulse" />)}</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs label-caps text-text-tertiary">
                <th className="text-left px-3 py-2">Batch</th>
                <th className="text-right px-3 py-2">Sent</th>
                <th className="text-right px-3 py-2">Received</th>
                <th className="text-right px-3 py-2">Sold</th>
                <th className="text-right px-3 py-2">Returned</th>
                <th className="text-right px-3 py-2">Sell-through</th>
                <th className="text-right px-3 py-2">50% sold</th>
                <th className="text-right px-3 py-2">80% sold</th>
                <th className="text-right px-3 py-2">Actual profit</th>
                <th className="text-right px-3 py-2">vs plan</th>
                <th className="text-right px-3 py-2">Plan, all units</th>
              </tr>
            </thead>
            <tbody>
              {batches.map(b => {
                const isOpen = open.has(b.batchId);
                const short = b.received != null && b.received < b.sent;
                return (
                  <Fragment key={b.batchId}>
                    <tr className="border-b border-border-default hover:bg-bg-elevated cursor-pointer"
                      onClick={() => setOpen(s => { const n = new Set(s); if (n.has(b.batchId)) n.delete(b.batchId); else n.add(b.batchId); return n; })}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <Link href={`/list/${b.batchId}`} onClick={e => e.stopPropagation()} className="text-text-primary hover:text-link">{b.name}</Link>
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary">{b.channel}</span>
                        </div>
                        <div className="text-xs text-text-tertiary ml-6">sent {formatDate(b.sentAt)}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.sent}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${short ? 'text-negative' : ''}`} title={b.receiptsCheckedAt ? `Checked ${formatDate(b.receiptsCheckedAt)}` : undefined}>
                        {b.received ?? <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.sold}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.returned || <span className="text-text-tertiary">—</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(b.sellThrough)}</td>
                      <td className="px-3 py-2 text-right">{daysCell(b.daysTo50)}</td>
                      <td className="px-3 py-2 text-right">{daysCell(b.daysTo80)}</td>
                      <td className={`px-3 py-2 text-right ${profitCls(b.actualProfit)}`}>{formatCurrency(b.actualProfit)}</td>
                      <td className="px-3 py-2 text-right"><Variance actual={b.actualProfit} planned={b.plannedProfitSold} /></td>
                      <td className="px-3 py-2 text-right text-text-secondary tabular-nums">{formatCurrency(b.plannedProfit)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border-default bg-bg-elevated/40">
                        <td colSpan={11} className="px-3 py-3">
                          {b.channel === 'FBA' && (
                            <button onClick={() => refreshReceipts(b.batchId)} disabled={refreshing === b.batchId}
                              className="mb-2 text-xs text-link inline-flex items-center gap-1 hover:underline disabled:opacity-50">
                              <RefreshCw size={12} className={refreshing === b.batchId ? 'animate-spin' : ''} />
                              {refreshing === b.batchId ? 'Checking Amazon…' : 'Refresh received counts'}
                            </button>
                          )}
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-text-tertiary">
                                <th className="text-left py-1">Product</th>
                                <th className="text-right py-1">Sent</th>
                                <th className="text-right py-1">Recv</th>
                                <th className="text-right py-1">Sold</th>
                                <th className="text-right py-1">Ret</th>
                                <th className="text-right py-1">Left</th>
                                <th className="text-right py-1">50% / 80%</th>
                                <th className="text-right py-1">Plan / unit</th>
                                <th className="text-right py-1">Actual / unit</th>
                                <th className="text-right py-1">Actual profit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.items.map(i => (
                                <tr key={i.itemId} className="border-t border-border/50">
                                  <td className="py-1.5 pr-3">
                                    <div className="text-text-primary">{i.productName || i.sku}</div>
                                    <div className="font-mono text-text-tertiary">{i.sku}{!i.soldExact && <span title="No linked cost lot: sold = this SKU's sales since the send date, capped at units sent"> · est.</span>}</div>
                                  </td>
                                  <td className="text-right tabular-nums">{i.sent}</td>
                                  <td className={`text-right tabular-nums ${i.received != null && i.received < i.sent ? 'text-negative' : ''}`}>{i.received ?? '—'}</td>
                                  <td className="text-right tabular-nums">{i.sold}</td>
                                  <td className="text-right tabular-nums">{i.returned || '—'}</td>
                                  <td className="text-right tabular-nums">{i.remaining}</td>
                                  <td className="text-right tabular-nums">{i.daysTo50 ?? '—'} / {i.daysTo80 ?? '—'}</td>
                                  <td className="text-right tabular-nums">{formatCurrency(i.plannedProfitPerUnit)}</td>
                                  <td className={`text-right ${i.actualProfitPerUnit == null ? 'text-text-tertiary' : profitCls(i.actualProfitPerUnit)}`}>
                                    {i.actualProfitPerUnit == null ? '—' : formatCurrency(i.actualProfitPerUnit)}
                                  </td>
                                  <td className={`text-right ${profitCls(i.actualProfit)}`}>{formatCurrency(i.actualProfit)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {batches.length === 0 && <div className="p-8 text-center text-sm text-text-secondary">No sent batches yet.</div>}
        </div>
      )}
      <p className="text-xs text-text-tertiary mt-3">
        Actual profit is after fees, cost, shipping labels and settled refunds, on the units that sold. Sold is exact for items that own a cost lot;
        items marked &ldquo;est.&rdquo; count the SKU&apos;s sales since the send date. Received counts come from Amazon and refresh daily until a shipment closes.
      </p>
    </div>
  );
}
