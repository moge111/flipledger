'use client';

import { useState, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { useQuery } from '@/lib/useQuery';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { Plus } from 'lucide-react';
import { marketToday } from '@/lib/market-day';

interface ExpenseRow { id: number; date: string; category: string; amount: number; description: string; recurring: string; }

export default function OtherExpensesPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();
  const [showAddForm, setShowAddForm] = useState(false);
  // marketToday(), not the UTC day: after ~6 PM Mountain the UTC date is already tomorrow.
  const blankExpense = () => ({ date: marketToday(), category: 'Supplies', amount: '', description: '' });
  const [newExpense, setNewExpense] = useState(blankExpense);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data, loading, reload: fetchData } = useQuery<{ items?: ExpenseRow[]; rows?: ExpenseRow[]; totals?: any }>(`/api/data/other-expenses?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: ExpenseRow[] = data?.items || data?.rows || [];
  const totals: any = data?.totals || null;

  async function handleAddExpense() {
    const cents = Math.round(parseFloat(newExpense.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setSaveError('Enter an amount greater than $0.'); return; }
    setSaveError(null);
    try {
      const res = await fetch('/api/data/other-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newExpense, amount: cents }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.error || `Save failed (HTTP ${res.status})`);
        return;
      }
    } catch {
      setSaveError('Network error: the expense was not saved.');
      return;
    }
    setShowAddForm(false);
    setNewExpense(blankExpense());
    fetchData();
  }

  const categories = ['Supplies', 'Mileage', 'Subscriptions', 'Storage', 'Packaging', 'Labels', 'Equipment', 'Insurance', 'Other'];

  const columns = useMemo<ColumnDef<ExpenseRow, any>[]>(() => [
    { id: 'date', header: 'Date', accessorKey: 'date', cell: ({ getValue }) => <span className="text-sm text-text-secondary whitespace-nowrap tabular-nums">{formatDate(getValue() as string)}</span>, size: 120 },
    {
      id: 'category', header: 'Category', accessorKey: 'category',
      cell: ({ getValue }) => <span className="text-sm font-medium text-text-primary">{getValue() as string}</span>, size: 130,
    },
    { id: 'amount', header: 'Amount', accessorKey: 'amount', cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 110 },
    { id: 'description', header: 'Description', accessorKey: 'description', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 300 },
    {
      id: 'recurring', header: 'Recurring', accessorKey: 'recurring',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return <span className={`tag ${v === 'monthly' ? 'text-text-primary' : ''}`}>{v === 'monthly' ? 'Monthly' : 'One-time'}</span>;
      }, size: 90,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-36" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Other Expenses" subtitle="Bookkeeping > Other Expenses" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />

      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Expenses" value={totals?.totalExpenses || 0} format="currency" accentColor="negative" />
        <StatCard label="Total Entries" value={rows.length} format="number" />
      </div>

      {/* Add Expense Button */}
      <div className="mb-4">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors"
        >
          <Plus size={14} />
          Add Expense
        </button>
      </div>

      {/* Add Expense Form */}
      {showAddForm && (
        <div className="panel p-4 mb-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <input type="date" value={newExpense.date} onChange={e => setNewExpense(p => ({ ...p, date: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary" />
            <select value={newExpense.category} onChange={e => setNewExpense(p => ({ ...p, category: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary">
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" step="0.01" placeholder="Amount" value={newExpense.amount} onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary" />
            <input type="text" placeholder="Description" value={newExpense.description} onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))} className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary" />
            <button onClick={handleAddExpense} className="h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors">Save</button>
          </div>
          {saveError && <p className="text-xs text-negative mt-2">{saveError}</p>}
        </div>
      )}

      <DataTable data={rows} columns={columns} searchPlaceholder="Search by category or description..." />
    </div>
  );
}
