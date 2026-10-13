'use client';

import {useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatPercent, formatDate } from '@/lib/formatters';

interface SaleRow {
  date: string;
  orderId: string;
  asin: string;
  sku: string;
  productName: string;
  quantity: number;
  salePrice: number;
  buyCost: number;
  fees: number;
  refunded: number;
  incentives: number;
  profit: number;
  profitPercent: number;
  roiPercent: number;
  isEstimated: boolean;
}

export default function FBASalesPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ averages?: any; items?: SaleRow[]; rows?: SaleRow[] }>(`/api/data/wfs-sales?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: SaleRow[] = data?.items || data?.rows || [];
  const averages: any = data?.averages || null;

  const totalRevenue = rows.reduce((s, r) => s + r.salePrice, 0);
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);

  const columns = useMemo<ColumnDef<SaleRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="text-sm text-text-secondary whitespace-nowrap tabular-nums">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'status', header: 'Status', accessorKey: 'isEstimated',
      cell: ({ getValue }) => getValue() ? <span className="tag text-warning">Estimated</span> : <span className="tag text-positive">Reconciled</span>,
      size: 90,
    },
    {
      id: 'order', header: 'Order Details', accessorFn: (row) => row.productName || row.orderId,
      cell: ({ row }) => (
        <div className="min-w-[200px]">
          <div className="text-sm font-mono text-text-primary">{row.original.orderId}</div>
          <div className="text-sm text-text-secondary truncate max-w-[250px]">{row.original.productName || row.original.asin}</div>
        </div>
      ), size: 280,
    },
    {
      id: 'quantity', header: 'Qty', accessorKey: 'quantity',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`tabular-nums ${v > 1 ? 'text-text-primary font-medium' : 'text-text-tertiary'}`}>{v}</span>;
      }, size: 60,
    },
    { id: 'salePrice', header: 'Order Price', accessorKey: 'salePrice', cell: ({ getValue }) => <span className="text-text-primary tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'buyCost', header: 'Buy Cost', accessorKey: 'buyCost',
      cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(-(getValue() as number))}</span>,
      size: 100,
    },
    { id: 'fees', header: 'Fees', accessorKey: 'fees', cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 90 },
    {
      id: 'incentives', header: 'Incentive', accessorKey: 'incentives',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return v > 0
          ? <span className="text-positive tabular-nums" title="Walmart-funded incentive / commission incentive income for this order">{formatCurrency(v)}</span>
          : <span className="text-text-tertiary tabular-nums">—</span>;
      }, size: 90,
    },
    {
      id: 'refunded', header: 'Refunded', accessorKey: 'refunded',
      cell: ({ getValue }) => { const v = getValue() as number; return v ? <span className="text-negative tabular-nums">{formatCurrency(-v)}</span> : <span className="text-text-tertiary tabular-nums">—</span>; },
      size: 100,
    },
    {
      id: 'profit', header: 'Net Profit', accessorKey: 'profit',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`font-medium tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>;
      }, size: 110,
    },
    {
      id: 'profitPercent', header: 'Margin', accessorKey: 'profitPercent',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      }, size: 80,
    },
    {
      id: 'roiPercent', header: 'ROI', accessorKey: 'roiPercent',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        return <span className={`tabular-nums ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatPercent(v)}</span>;
      }, size: 80,
    },
  ], []);

  function handleExport() {
    const headers = ['Date', 'Order ID', 'ASIN', 'SKU', 'Product', 'Qty', 'Sale Price', 'Buy Cost', 'Fees', 'Incentive', 'Refunded', 'Profit', 'Margin %', 'ROI %'];
    const csvRows = rows.map(r => [
      r.date.split('T')[0], r.orderId, r.asin, r.sku, `"${r.productName}"`, r.quantity,
      (r.salePrice / 100).toFixed(2), (r.buyCost / 100).toFixed(2), (r.fees / 100).toFixed(2),
      ((r.incentives || 0) / 100).toFixed(2),
      (r.refunded / 100).toFixed(2), (r.profit / 100).toFixed(2), r.profitPercent.toFixed(1), r.roiPercent.toFixed(1),
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'wfs-sales.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="WFS Sales" subtitle="Bookkeeping > WFS Sales" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="Total Sales" value={rows.length} format="number" />
        <StatCard label="Total Revenue" value={totalRevenue} format="currency" />
        <StatCard label="Total Profit" value={totalProfit} format="currency" accentColor={totalProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Avg Profit/Sale" value={averages?.avgProfit || 0} format="currency" />
        <StatCard label="Avg ROI" value={averages?.avgRoi || 0} format="percent" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, ASIN, or product name..." />
    </div>
  );
}
