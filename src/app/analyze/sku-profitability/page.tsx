'use client';

import {useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';

interface ProfitRow {
  groupKey: string;
  productName: string;
  asin: string;
  category: string;
  supplierName: string;
  orders: number;
  unitsSold: number;
  unitsPerOrder: number;
  refunds: number;
  unitsPerRefund: number;
  revenue: number;
  fees: number;
  refunded: number;
  cogs: number;
  costPerUnit: number;
  profit: number;
  roi: number;
  margin: number;
  onHand: number;
  inventoryValue: number;
  shippingCharged: number;
  shippingCost: number;
}

interface Totals {
  orders: number;
  unitsSold: number;
  revenue: number;
  fees: number;
  refunded: number;
  cogs: number;
  profit: number;
  refunds: number;
  onHand: number;
  inventoryValue: number;
  inventoryUnits: number;
  roi: number;
  margin: number;
  costPerUnit: number;
}

export default function SKUProfitabilityPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ rows?: ProfitRow[]; totals?: Totals }>(`/api/data/profitability?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}&groupBy=sku`);
  const rows: ProfitRow[] = data?.rows || [];
  const totals: Totals | null = data?.totals || null;

  const columns = useMemo<ColumnDef<ProfitRow, any>[]>(() => [
    {
      id: 'sku',
      header: 'SKU',
      accessorKey: 'groupKey',
      cell: ({ getValue }) => <span className="font-mono text-text-primary text-sm">{getValue() as string}</span>,
      size: 140,
    },
    {
      id: 'productName',
      header: 'Product',
      accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div className="min-w-[250px]">
          <div className="text-sm text-text-primary" title={row.original.productName}>{row.original.productName || row.original.asin}</div>
          <div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div>
        </div>
      ),
      size: 400,
    },
    {
      id: 'supplier',
      header: 'Supplier',
      accessorKey: 'supplierName',
      cell: ({ getValue }) => <span className="text-text-secondary text-sm">{getValue() as string || '—'}</span>,
      size: 100,
    },
    {
      id: 'orders',
      header: 'Orders',
      accessorKey: 'orders',
      cell: ({ getValue }) => <span className="text-text-primary tabular-nums">{formatNumber(getValue() as number)}</span>,
      size: 80,
    },
    {
      id: 'unitsSold',
      header: 'Units Sold',
      accessorKey: 'unitsSold',
      cell: ({ getValue }) => <span className="text-text-primary tabular-nums">{formatNumber(getValue() as number)}</span>,
      size: 90,
    },
    {
      id: 'refunds',
      header: 'Refunds',
      accessorKey: 'refunds',
      cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{getValue() as number}</span>,
      size: 70,
    },
    {
      id: 'revenue',
      header: 'Revenue',
      accessorKey: 'revenue',
      cell: ({ getValue }) => <span className="text-text-primary tabular-nums">{formatCurrency(getValue() as number)}</span>,
      size: 110,
    },
    {
      id: 'costPerUnit',
      header: 'Cost/Unit',
      accessorKey: 'costPerUnit',
      cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{formatCurrency(getValue() as number)}</span>,
      size: 100,
    },
    {
      id: 'fees',
      header: 'Fees',
      accessorKey: 'fees',
      cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>,
      size: 100,
    },
    {
      id: 'refunded',
      header: 'Refunded',
      accessorKey: 'refunded',
      cell: ({ getValue }) => { const v = getValue() as number; return v ? <span className="text-negative tabular-nums">{formatCurrency(-v)}</span> : <span className="text-text-tertiary tabular-nums">—</span>; },
      size: 100,
    },
    {
      id: 'onHand',
      header: 'On Hand',
      accessorKey: 'onHand',
      cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{formatNumber(getValue() as number)}</span>,
      size: 80,
    },
    {
      id: 'profit',
      header: 'Profit',
      accessorKey: 'profit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-medium tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      },
      size: 110,
    },
    {
      id: 'roi',
      header: 'ROI %',
      accessorKey: 'roi',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      },
      size: 80,
    },
    {
      id: 'margin',
      header: 'Margin %',
      accessorKey: 'margin',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      },
      size: 80,
    },
  ], []);

  function handleExport() {
    const headers = ['SKU', 'Product', 'ASIN', 'Supplier', 'Orders', 'Units Sold', 'Refunds', 'Revenue', 'Cost/Unit', 'Fees', 'Refunded', 'On Hand', 'Profit', 'ROI %', 'Margin %'];
    const csvRows = rows.map(r => [
      `"${r.groupKey}"`, `"${r.productName}"`, r.asin, r.supplierName, r.orders, r.unitsSold, r.refunds,
      (r.revenue / 100).toFixed(2), (r.costPerUnit / 100).toFixed(2), (r.fees / 100).toFixed(2),
      (r.refunded / 100).toFixed(2), r.onHand, (r.profit / 100).toFixed(2), r.roi.toFixed(1), r.margin.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sku-profitability.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <ProfitSkeleton />;

  const footerRow = totals ? {
    sku: <span className="text-text-primary font-semibold">Totals</span>,
    orders: <span className="tabular-nums">{formatNumber(totals.orders)}</span>,
    unitsSold: <span className="tabular-nums">{formatNumber(totals.unitsSold)}</span>,
    refunds: <span className="tabular-nums">{totals.refunds}</span>,
    revenue: <span className="tabular-nums">{formatCurrency(totals.revenue)}</span>,
    costPerUnit: <span className="tabular-nums">{formatCurrency(totals.costPerUnit)}</span>,
    fees: <span className="text-negative tabular-nums">{formatCurrency(totals.fees)}</span>,
    refunded: <span className="text-negative tabular-nums">{formatCurrency(-totals.refunded)}</span>,
    onHand: <span className="tabular-nums">{formatNumber(totals.onHand)}</span>,
    profit: <span className={`font-medium tabular-nums ${totals.profit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(totals.profit)}</span>,
    roi: <span className={`tabular-nums ${totals.roi >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.roi)}</span>,
    margin: <span className={`tabular-nums ${totals.margin >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(totals.margin)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader
        title="SKU Profitability"
        subtitle="Analyze > SKU Profitability"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace}
        onExport={handleExport}
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Total Revenue" value={totals?.revenue || 0} format="currency" />
        <StatCard label="Total Profit" value={totals?.profit || 0} format="currency" accentColor={(totals?.profit || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Units Sold" value={totals?.unitsSold || 0} format="number" />
        <StatCard label="Avg ROI" value={totals?.roi || 0} format="percent" accentColor={(totals?.roi || 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Inventory Value" value={totals ? totals.inventoryValue : 0} format="currency" accentColor="amazon" />
      </div>

      <DataTable
        data={rows}
        columns={columns}
        searchPlaceholder="Search by SKU, product name, or supplier..."
        footerRow={footerRow}
      />
    </div>
  );
}

function ProfitSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><div className="skeleton h-6 w-48 mb-2" /><div className="skeleton h-4 w-64" /></div>
        <div className="flex gap-2"><div className="skeleton h-9 w-40" /><div className="skeleton h-9 w-24" /></div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="skeleton h-3 w-20 mb-3" /><div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="panel p-4">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-10 w-full mb-1" />)}
      </div>
    </div>
  );
}
