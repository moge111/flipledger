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

interface ReimbRow {
  reimbursementDate: string;
  reimbursementId: string;
  asin: string;
  sku: string;
  productName: string;
  reason: string;
  amount: number;
  quantity: number;
  status: string;
  // Searchable but not displayed — see DataTable's globalFilterFn
  orderId?: string | null;
  customerOrderId?: string | null;
}

export default function ReimbursementsPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ items?: ReimbRow[]; rows?: ReimbRow[]; totals?: any }>(`/api/data/reimbursements?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: ReimbRow[] = data?.items || data?.rows || [];
  const totals: any = data?.totals || null;

  const columns = useMemo<ColumnDef<ReimbRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => { const v = getValue() as string; return <span className="text-sm text-text-secondary whitespace-nowrap tabular-nums">{v ? formatDate(v) : '—'}</span>; }, size: 110 },
    {
      id: 'marketplace', header: '', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = getValue() as string;
        return m === 'walmart'
          ? <span className="mkt mkt-walmart text-[10px]">WMT</span>
          : <span className="mkt mkt-amazon text-[10px]">AMZ</span>;
      }, size: 45,
    },
    { id: 'reimbursementId', header: 'Reimb. ID', accessorKey: 'reimbursementId', cell: ({ getValue }) => {
      const id = getValue() as string;
      return <span className="font-mono text-sm text-text-primary">{id}</span>;
    }, size: 120 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div><div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div><div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div></div>
      ), size: 220,
    },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 180 },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="font-medium text-positive tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 110 },
    { id: 'quantity', header: 'Qty', accessorKey: 'quantity', cell: ({ getValue }) => <span className="tabular-nums">{getValue() as number}</span>, size: 60 },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        const styles = v === 'Paid' ? 'tag-green' : v === 'Approved' ? 'tag-blue' : '';
        return <span className={`tag ${styles}`}>{v}</span>;
      }, size: 90,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Reimbursements" subtitle="Bookkeeping > Reimbursements" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Reimbursements" value={totals?.count || 0} format="number" />
        <StatCard label="Total Amount" value={totals?.totalAmount || 0} format="currency" accentColor="positive" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by ID, product, reason, order #, SKU…" />
    </div>
  );
}
