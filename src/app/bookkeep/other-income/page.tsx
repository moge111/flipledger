'use client';

import {useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface IncomeRow { date: string; incomeType: string; amount: number; description: string; }

export default function OtherIncomePage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ items?: IncomeRow[]; rows?: IncomeRow[]; totalIncome?: number }>(`/api/data/other-income?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: IncomeRow[] = data?.items || data?.rows || [];
  const total = data?.totalIncome || 0;

  const columns = useMemo<ColumnDef<IncomeRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary whitespace-nowrap">{formatDate(getValue() as string)}</span>, size: 120 },
    { id: 'incomeType', header: 'Type', accessorKey: 'incomeType', cell: ({ getValue }) => <span className="text-sm text-text-primary">{getValue() as string}</span>, size: 180 },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="font-mono text-positive">{formatCurrency(getValue() as number)}</span>, size: 120 },
    { id: 'description', header: 'Description', accessorKey: 'description', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 300 },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[300px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Other Income" subtitle="Bookkeeping > Other Income" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Entries" value={rows.length} format="number" />
        <StatCard label="Total Other Income" value={total} format="currency" accentColor="positive" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by type or description..." />
    </div>
  );
}
