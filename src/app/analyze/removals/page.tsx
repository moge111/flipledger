'use client';

import {useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import {formatCurrency, formatDate } from '@/lib/formatters';

interface RemovalRow {
  removalOrderId: string;
  asin: string;
  sku: string;
  productName: string;
  quantity: number;
  removalType: string;
  reason: string;
  status: string;
  dateRequested: string;
  dateCompleted: string | null;
  fee: number;
}

export default function RemovalsPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ items?: RemovalRow[]; rows?: RemovalRow[]; totals?: { totalRemovals: number; totalFee: number; totalQuantity: number } }>(`/api/data/removals?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: RemovalRow[] = data?.items || data?.rows || [];
  const totals: { totalRemovals: number; totalFee: number; totalQuantity: number } | null = data?.totals || null;

  const columns = useMemo<ColumnDef<RemovalRow, any>[]>(() => [
    { id: 'dateRequested', header: 'Date', accessorKey: 'dateRequested', cell: ({ getValue }) => <span className="text-sm text-text-secondary tabular-nums">{formatDate(getValue() as string)}</span>, size: 120 },
    { id: 'removalOrderId', header: 'Removal ID', accessorKey: 'removalOrderId', cell: ({ getValue }) => <span className="text-sm text-text-primary tabular-nums">{getValue() as string}</span>, size: 140 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div>
          <div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div>
          <div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div>
        </div>
      ), size: 220,
    },
    { id: 'quantity', header: 'Qty', accessorKey: 'quantity', cell: ({ getValue }) => <span className="tabular-nums">{getValue() as number}</span>, size: 60 },
    {
      id: 'removalType', header: 'Type', accessorKey: 'removalType',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`tag ${v === 'Return' ? '' : 'tag-red'}`}>{v}</span>;
      }, size: 90,
    },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 130 },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`tag ${v === 'Completed' ? 'text-positive' : 'text-warning'}`}>{v}</span>;
      }, size: 100,
    },
    { id: 'fee', header: 'Fee', accessorKey: 'fee', cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 90 },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Removals" subtitle="Analyze > Removals" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Removals" value={totals?.totalRemovals || 0} format="number" />
        <StatCard label="Total Units Removed" value={totals?.totalQuantity || 0} format="number" />
        <StatCard label="Total Fees" value={totals?.totalFee || 0} format="currency" accentColor="negative" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by product, ASIN, or removal ID..." />
    </div>
  );
}
