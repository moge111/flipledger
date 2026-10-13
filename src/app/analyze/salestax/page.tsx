'use client';

import {useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import {formatCurrency } from '@/lib/formatters';

interface TaxRow {
  state: string;
  orderCount: number;
  taxCollected: number;
  facilitatorTax: number;
  owed: number;
}

interface SalesTaxTotals {
  stateCount: number;
  orderCount: number;
  totalCollected: number;
  totalFacilitator: number;
  totalOwed: number;
}

export default function SalesTaxPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading } = useQuery<{ items?: TaxRow[]; totals?: SalesTaxTotals }>(`/api/data/salestax?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: TaxRow[] = data?.items || [];
  const totals: SalesTaxTotals | null = data?.totals || null;

  const columns = useMemo<ColumnDef<TaxRow, any>[]>(() => [
    { id: 'state', header: 'State', accessorKey: 'state', cell: ({ getValue }) => <span className="text-text-primary font-medium">{getValue() as string}</span>, size: 100 },
    { id: 'orderCount', header: 'Orders', accessorKey: 'orderCount', cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{(getValue() as number).toLocaleString()}</span>, size: 100 },
    { id: 'taxCollected', header: 'Tax Collected', accessorKey: 'taxCollected', cell: ({ getValue }) => <span className="text-text-primary tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 140 },
    { id: 'facilitatorTax', header: 'Remitted by Marketplace', accessorKey: 'facilitatorTax', cell: ({ getValue }) => <span className="text-text-secondary tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 200 },
    { id: 'owed', header: 'You Owe', accessorKey: 'owed', cell: ({ getValue }) => <span className="font-medium text-text-primary tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 140 },
  ], []);

  function handleExport() {
    const headers = ['State', 'Orders', 'Tax Collected', 'Remitted by Marketplace', 'You Owe'];
    const csvRows = rows.map(r => [r.state, r.orderCount, (r.taxCollected / 100).toFixed(2), (r.facilitatorTax / 100).toFixed(2), (r.owed / 100).toFixed(2)].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'sales-tax.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  const footerRow = totals ? {
    state: <span className="text-text-primary font-semibold">Totals</span>,
    taxCollected: <span className="tabular-nums">{formatCurrency(totals.totalCollected)}</span>,
    orderCount: <span className="tabular-nums">{totals.orderCount.toLocaleString()}</span>,
    facilitatorTax: <span className="tabular-nums">{formatCurrency(totals.totalFacilitator)}</span>,
    owed: <span className="font-semibold tabular-nums">{formatCurrency(totals.totalOwed)}</span>,
  } : undefined;

  return (
    <div>
      <PageHeader title="Sales Tax" subtitle="Analyze > Sales Tax" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} onExport={handleExport} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Tax Collected" value={totals?.totalCollected || 0} format="currency" />
        <StatCard label="Remitted by Marketplaces" value={totals?.totalFacilitator || 0} format="currency" />
        <StatCard label="You Owe" value={totals?.totalOwed || 0} format="currency" />
        <StatCard label="States" value={totals?.stateCount || 0} format="number" />
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Amazon, Walmart and eBay collect and remit sales tax as marketplace facilitators. It is not your income and you file nothing for it.
        &quot;Unknown&quot; is tax on orders whose shipping state never synced; &quot;Intl&quot; is tax on orders shipped outside the US.
      </p>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by state..." footerRow={footerRow} />
    </div>
  );
}
