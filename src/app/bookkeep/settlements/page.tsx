'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';

interface SettlementRow {
  settlementId: string;
  startDate: string;
  endDate: string;
  depositDate: string;
  currency: string;
  payoutCents: number;
  salesCents: number;
  orderFeesCents: number;
  serviceFeesCents: number;
  refundsCents: number;
  reimbursementsCents: number;
  cogsCents: number;
  units: number;
  orders: number;
  netProfitCents: number;
  reconDeltaCents: number;
}

interface Summary {
  settlementCount: number;
  totalPayoutCents: number;
  totalCogsCents: number;
  totalNetProfitCents: number;
  totalUnits: number;
}

export default function SettlementsPage() {
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  // Settlement reports are available ~90 days back, so default to that window.
  const { dateRange, setDateRange } = useFilters('90d');

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/settlements?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`);
    const data = await res.json();
    setRows(data.settlements || []);
    setSummary(data.summary || null);
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<SettlementRow, any>[]>(() => [
    {
      id: 'period', header: 'Settlement period', accessorFn: (r) => r.startDate,
      cell: ({ row }) => (
        <div>
          <div className="text-sm text-text-primary font-mono">
            {row.original.startDate ? formatDate(row.original.startDate) : '—'} → {row.original.endDate ? formatDate(row.original.endDate) : '—'}
          </div>
          <div className="text-xs text-text-tertiary font-mono">{row.original.settlementId}</div>
        </div>
      ), size: 220,
    },
    {
      id: 'depositDate', header: 'Deposited', accessorKey: 'depositDate',
      cell: ({ getValue }) => { const v = getValue() as string; return <span className="font-mono text-sm text-text-secondary">{v ? formatDate(v) : '—'}</span>; }, size: 110,
    },
    {
      id: 'payout', header: 'Payout', accessorKey: 'payoutCents',
      cell: ({ getValue }) => <span className="font-mono font-semibold text-accent">{formatCurrency(getValue() as number)}</span>, size: 120,
    },
    {
      id: 'sales', header: 'Sales', accessorKey: 'salesCents',
      cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatCurrency(getValue() as number)}</span>, size: 110,
    },
    {
      id: 'fees', header: 'Fees', accessorFn: (r) => r.orderFeesCents + r.serviceFeesCents,
      cell: ({ getValue }) => <span className="font-mono text-sm text-negative">{formatCurrency(getValue() as number)}</span>, size: 110,
    },
    {
      id: 'refunds', header: 'Refunds', accessorKey: 'refundsCents',
      cell: ({ getValue }) => { const v = getValue() as number; return <span className="font-mono text-sm text-text-secondary">{v ? '-' + formatCurrency(v).replace('-', '') : formatCurrency(0)}</span>; }, size: 100,
    },
    {
      id: 'reimb', header: 'Reimb.', accessorKey: 'reimbursementsCents',
      cell: ({ getValue }) => { const v = getValue() as number; return <span className="font-mono text-sm text-positive">{v ? formatCurrency(v) : formatCurrency(0)}</span>; }, size: 100,
    },
    {
      id: 'cogs', header: 'COGS', accessorKey: 'cogsCents',
      cell: ({ getValue }) => <span className="font-mono text-sm text-negative">{formatCurrency(getValue() as number)}</span>, size: 110,
    },
    {
      id: 'net', header: 'Net Profit', accessorKey: 'netProfitCents',
      cell: ({ getValue }) => { const v = getValue() as number; return <span className={`font-mono font-semibold ${v >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(v)}</span>; }, size: 120,
    },
    {
      id: 'recon', header: 'Recon Δ', accessorKey: 'reconDeltaCents',
      cell: ({ getValue }) => {
        const v = getValue() as number;
        const ok = Math.abs(v) < 100; // within $1 = matched
        return <span className={`font-mono text-sm ${ok ? 'text-text-tertiary' : 'text-warning'}`} title="Payout − (sales + fees − refunds + reimbursements). Near $0 = books explain the deposit; large = reserve/DD7 or timing across the window edge.">{formatCurrency(v)}</span>;
      }, size: 110,
    },
    {
      id: 'orders', header: 'Orders', accessorKey: 'orders',
      cell: ({ getValue }) => <span className="font-mono text-sm">{formatNumber(getValue() as number)}</span>, size: 80,
    },
    {
      id: 'units', header: 'Units', accessorKey: 'units',
      cell: ({ getValue }) => <span className="font-mono text-sm">{formatNumber(getValue() as number)}</span>, size: 70,
    },
  ], []);

  return (
    <div>
      <PageHeader title="Settlements" subtitle="Bookkeeping > Settlements" dateRange={dateRange} onDateRangeChange={setDateRange} />

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Settlements" value={summary?.settlementCount || 0} format="number" />
        <StatCard label="Total Payout" value={summary?.totalPayoutCents || 0} format="currency" accentColor="amazon" />
        <StatCard label="COGS (attributed)" value={summary?.totalCogsCents || 0} format="currency" accentColor="negative" />
        <StatCard label="Net Profit" value={summary?.totalNetProfitCents || 0} format="currency" accentColor="positive" />
      </div>

      {!loading && rows.length === 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6 text-sm text-text-secondary">
          No settlements found in this range. Settlement headers populate from Amazon&apos;s settlement reports
          (available ~90 days back) on the next sync — try a wider date range or run a sync from Settings.
        </div>
      )}

      <DataTable data={rows} columns={columns} searchPlaceholder="Search by settlement ID…" />

      <p className="text-xs text-text-tertiary mt-3 max-w-3xl">
        <b>Payout</b> is Amazon&apos;s actual disbursement for the settlement (ground truth). The other columns are
        FlipLedger&apos;s order activity attributed to the settlement&apos;s date window.
        <b> Net Profit</b> = Sales + Fees − Refunds + Reimbursements − COGS.
        <b> Recon Δ</b> = Payout − (Sales + Fees − Refunds + Reimbursements); near $0 means your books explain the
        deposit, while a larger value is normally reserve (DD7) held/released or a sale settling across the window edge.
      </p>
    </div>
  );
}
