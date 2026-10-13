'use client';

import { useMemo, useState } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import DataTable from '@/components/tables/DataTable';
import { useQuery } from '@/lib/useQuery';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface Row {
  key: string; marketplace: string; asin: string | null; skus: string[]; productName: string | null;
  unitsWindow: number; units90: number; perDay: number; fulfillable: number; inbound: number; onHand: number; daysOfCover: number;
  avgPrice: number; profitPerUnit: number; roi: number;
  lastBuyPrice: number | null; lastBuyDate: string | null; supplier: string | null; reorderQty: number; lastSale: string;
}
interface Opts { windowDays: number; minUnits: number; minRoi: number; maxCoverDays: number; targetCoverDays: number }

const MKT: Record<string, string> = { amazon: 'mkt mkt-amazon', walmart: 'mkt mkt-walmart', ebay: 'mkt mkt-ebay' };
const listingUrl = (r: Row) => r.marketplace === 'amazon' && r.asin ? `https://www.amazon.com/dp/${r.asin}` : null;

export default function RestockPage() {
  const [opts, setOpts] = useState<Opts>({ windowDays: 30, minUnits: 3, minRoi: 25, maxCoverDays: 7, targetCoverDays: 30 });
  const qs = new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)])).toString();
  const { data, loading } = useQuery<{ rows: Row[] }>(`/api/data/restock?${qs}`);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const reorderCost = rows.reduce((s, r) => s + (r.lastBuyPrice ?? 0) * r.reorderQty, 0);
  const reorderProfit = rows.reduce((s, r) => s + r.profitPerUnit * r.reorderQty, 0);

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: 'product', header: 'Product', accessorFn: r => r.productName ?? r.key, size: 320,
      cell: ({ row }) => {
        const r = row.original; const url = listingUrl(r);
        return (
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-[9.5px] ${MKT[r.marketplace] ?? 'mkt'}`}>{r.marketplace}</span>
              {url ? <a href={url} target="_blank" rel="noreferrer" className="text-sm text-text-primary hover:text-link">{r.productName ?? r.key}</a>
                : <span className="text-sm text-text-primary">{r.productName ?? r.key}</span>}
            </div>
            <div className="text-xs font-mono text-text-tertiary">{r.skus.join(', ')}</div>
          </div>
        );
      },
    },
    { id: 'units', header: `Sold ${opts.windowDays}d`, accessorKey: 'unitsWindow', size: 80, cell: ({ row }) => <span className="tabular-nums">{row.original.unitsWindow} <span className="text-text-tertiary text-xs">({row.original.perDay.toFixed(1)}/day)</span></span> },
    {
      id: 'stock', header: 'Stock', accessorFn: r => r.fulfillable + r.inbound + r.onHand, size: 110,
      cell: ({ row }) => {
        const r = row.original;
        return <span className="tabular-nums">{r.fulfillable + r.inbound + r.onHand}
          {(r.inbound > 0 || r.onHand > 0) && <span className="text-text-tertiary text-xs"> ({[r.inbound && `${r.inbound} inbound`, r.onHand && `${r.onHand} at home`].filter(Boolean).join(', ')})</span>}</span>;
      },
    },
    {
      id: 'cover', header: 'Days left', accessorKey: 'daysOfCover', size: 80,
      cell: ({ getValue }) => { const d = getValue() as number; return <span className={`tabular-nums ${d < 1 ? 'text-negative' : 'text-text-primary'}`}>{d < 1 ? 'out' : d.toFixed(1)}</span>; },
    },
    { id: 'roi', header: 'ROI (90d)', accessorKey: 'roi', size: 80, cell: ({ getValue }) => <span className="text-positive tabular-nums">{Math.round(getValue() as number)}%</span> },
    { id: 'ppu', header: 'Profit / unit', accessorKey: 'profitPerUnit', size: 90, cell: ({ getValue }) => <span className="tabular-nums">{formatCurrency(getValue() as number)}</span> },
    { id: 'price', header: 'Avg price', accessorKey: 'avgPrice', size: 90, cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{formatCurrency(getValue() as number)}</span> },
    {
      id: 'buy', header: 'Last buy', accessorFn: r => r.lastBuyPrice ?? 0, size: 140,
      cell: ({ row }) => {
        const r = row.original;
        return r.lastBuyPrice == null ? <span className="text-text-tertiary">—</span> : (
          <div><span className="tabular-nums">{formatCurrency(r.lastBuyPrice)}</span>
            <div className="text-xs text-text-tertiary">{r.supplier ?? 'unknown'}{r.lastBuyDate ? ` · ${formatDate(r.lastBuyDate)}` : ''}</div></div>
        );
      },
    },
    { id: 'reorder', header: `Buy for ${opts.targetCoverDays}d`, accessorKey: 'reorderQty', size: 90, cell: ({ getValue }) => <span className="font-medium text-text-primary tabular-nums">{getValue() as number}</span> },
  ], [opts.windowDays, opts.targetCoverDays]);

  const num = (k: keyof Opts, label: string, suffix = '') => (
    <label className="flex items-center gap-2 text-xs text-text-secondary">
      {label}
      <input type="number" value={opts[k]} onChange={e => setOpts({ ...opts, [k]: Number(e.target.value) })}
        className="w-16 bg-bg-elevated border border-border-default rounded px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-link tabular-nums" />
      {suffix}
    </label>
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="page-title">Restock Watch</h1>
        <p className="text-sm text-text-secondary mt-1">Products selling fast at a good return, with little stock left. Stock counts marketplace fulfillable + inbound + merchant-fulfilled stock at home.</p>
      </div>

      <div className="panel flex flex-wrap items-center gap-5 mb-5 px-4 py-3">
        {num('minUnits', 'At least', 'sold in')}
        {num('windowDays', '', 'days')}
        {num('minRoi', 'ROI ≥', '%')}
        {num('maxCoverDays', 'Under', 'days of stock')}
        {num('targetCoverDays', 'Reorder to', 'days')}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Products to restock" value={rows.length} format="number" />
        <StatCard label="Out of stock" value={rows.filter(r => r.daysOfCover < 1).length} format="number" accentColor="negative" />
        <StatCard label="Reorder cost (last buy price)" value={reorderCost} format="currency" />
        <StatCard label="Profit on that reorder (90d rate)" value={reorderProfit} format="currency" accentColor="positive" />
      </div>

      {loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-12 bg-bg-surface rounded animate-pulse" />)}</div>
      ) : (
        <DataTable data={rows} columns={columns} searchPlaceholder="Search products or SKUs…" pageSize={50} />
      )}
      <p className="text-xs text-text-tertiary mt-3">
        ROI and profit per unit are over the last 90 days after fees, cost, shipping labels and settled refunds. Products are grouped by ASIN on Amazon,
        so every buy-price SKU of one product counts together. Suggested quantities assume sales keep their {opts.windowDays}-day pace.
      </p>
    </div>
  );
}
