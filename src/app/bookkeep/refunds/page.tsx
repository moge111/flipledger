'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface RefundRow {
  refundDate: string;
  orderId: string;
  asin: string;
  sku: string;
  productName: string;
  refundAmount: number;
  reason: string;
  itemReturned: boolean;
  feeClawback: number;
  netImpact: number;
  marketplace?: string;
  settled?: boolean;
  disposition?: 'rtv' | 'restocked' | 'pending' | 'in-pipeline' | 'claim-due' | null;
  cashImpact?: 'held-fund' | 'real' | 'unknown';
  shipmentStatus?: string | null;
  shipmentMaturity?: string | null;
}

export default function RefundsPage() {
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/refunds?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<RefundRow, any>[]>(() => [
    { id: 'refundDate', header: 'Date', accessorKey: 'refundDate', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'marketplace', header: '', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = getValue() as string;
        return m === 'walmart'
          ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">WMT</span>
          : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amazon/15 text-amazon">AMZ</span>;
      }, size: 45,
    },
    { id: 'orderId', header: 'Order ID', accessorKey: 'orderId', cell: ({ getValue }) => <span className="font-mono text-sm text-accent">{getValue() as string}</span>, size: 180 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div><div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div><div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div></div>
      ), size: 230,
    },
    { id: 'refundAmount', header: 'Refund Amount', accessorKey: 'refundAmount', cell: ({ getValue }) => <span className="font-mono text-negative">{formatCurrency(getValue() as number)}</span>, size: 120 },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 150 },
    {
      id: 'itemReturned', header: 'Returned?', accessorKey: 'itemReturned',
      cell: ({ getValue }) => getValue() ? <span className="text-xs font-medium px-2 py-0.5 rounded bg-positive-muted text-positive">Yes</span> : <span className="text-xs font-medium px-2 py-0.5 rounded bg-negative-muted text-negative">No</span>,
      size: 80,
    },
    { id: 'feeClawback', header: 'Fee Clawback', accessorKey: 'feeClawback', cell: ({ getValue }) => <span className="font-mono text-positive">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'netImpact', header: 'Net Impact', accessorKey: 'netImpact',
      cell: ({ getValue }) => <span className="font-mono font-medium text-negative">{formatCurrency(getValue() as number)}</span>,
      size: 110,
    },
    {
      id: 'cashImpact', header: 'Cash Impact', accessorKey: 'cashImpact',
      cell: ({ row }) => {
        // Walmart rows: show settlement state. An unsettled record means
        // Walmart never deducted the seller (yet) — it is NOT in the P&L.
        if (row.original.marketplace === 'walmart') {
          return row.original.settled ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-negative-muted text-negative"
              title="Walmart deducted this refund in a settlement (recon). Counted in P&L.">
              SETTLED
            </span>
          ) : (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400"
              title="Walmart has NOT deducted you for this return — it's excluded from your P&L and Net Impact. ~30% of Walmart return records never settle (Walmart covers them). If Walmart does deduct it, this flips to SETTLED within 1-3 weeks.">
              NOT SETTLED
            </span>
          );
        }
        const c = row.original.cashImpact;
        if (c === 'held-fund') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-positive-muted text-positive"
              title={`Refund cancelled held funds — no real cash out. Shipment was still DEFERRED (DD7) when refunded${row.original.shipmentMaturity ? `, maturity ${row.original.shipmentMaturity.slice(0,10)}` : ''}.`}>
              HELD-FUND
            </span>
          );
        }
        if (c === 'real') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-negative-muted text-negative"
              title="Real cash deduction. Original shipment funds had already released/disbursed before the refund posted.">
              REAL CASH
            </span>
          );
        }
        return <span className="text-[10px] text-text-tertiary">—</span>;
      },
      size: 100,
    },
    {
      id: 'disposition', header: 'Disposition', accessorKey: 'disposition',
      cell: ({ row }) => {
        const d = row.original.disposition;
        if (d === 'rtv') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-500/15 text-blue-400"
              title="Walmart deemed this return unsellable and shipped it back to you (RTV fee found for this GTIN near the refund date).">
              RTV → YOU
            </span>
          );
        }
        if (d === 'pending') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-bg-elevated text-text-tertiary"
              title="Return initiated but not settled yet — Walmart hasn't inspected/deducted. Disposition resolves to RESTOCKED or RTV once it settles (or the record stays a ghost if Walmart covers it).">
              PENDING
            </span>
          );
        }
        if (d === 'in-pipeline') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-500/15 text-blue-400"
              title="Settled, but the unit hasn't reappeared in your stock and no RTV fee exists. Walmart's policy: lost returns auto-reimburse if not processed within 60 days. Flips to CLAIM DUE if still missing (and unreimbursed) 60 days after the refund.">
              IN PIPELINE
            </span>
          );
        }
        if (d === 'claim-due') {
          return (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-negative/20 text-negative"
              title="Settled 60+ days ago — past Walmart's own auto-reimbursement window for lost returns — and the unit never reappeared in stock, sales, RTV, or reimbursements. Open a Seller Support case referencing the return's RMA. Also listed on the Walmart Disputes page.">
              CLAIM DUE
            </span>
          );
        }
        if (d === 'restocked') {
          // A unit the buyer called defective/not-as-described going back into
          // sellable stock is the next return waiting to happen — flag it.
          const risky = /DEFECTIVE|NOT_AS_DESCRIBED|MISSING_PARTS|DAMAGED/.test(row.original.reason || '');
          return (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${risky ? 'bg-amber-500/15 text-amber-400' : 'bg-bg-elevated text-text-tertiary'}`}
              title={`Back in sellable stock (the SKU has current WFS inventory or sold again after this refund).${risky ? ' ⚠ Buyer reported a defect — this unit may resell as new and bounce again.' : ''} Note: RTV data comes from your Seller Center service-fee CSV imports; rows can flip to RTV after a fresh import.`}>
              {risky ? 'RESTOCKED ⚠' : 'RESTOCKED'}
            </span>
          );
        }
        return <span className="text-[10px] text-text-tertiary">—</span>;
      },
      size: 110,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-32" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Refunds" subtitle="Bookkeeping > Refunds" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Refunds" value={totals?.count || 0} format="number" />
        <StatCard label="Total Refund Amount" value={totals?.totalRefundAmount || 0} format="currency" accentColor="negative" />
        <StatCard label="Total Fee Clawbacks" value={totals?.totalClawback || 0} format="currency" accentColor="positive" />
        <StatCard label="Net Impact (settled)" value={totals?.totalNetImpact || 0} format="currency" accentColor="negative" />
      </div>
      {/* Unsettled Walmart return records: shown for visibility, NOT counted in
          P&L or the Net Impact card — Walmart hasn't actually deducted these. */}
      {totals?.unsettledWalmartCount > 0 && (
        <div className="mb-6 bg-bg-surface border border-amber-500/30 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-amber-400">Walmart returns not settled — excluded from P&L</div>
            <div className="text-[10px] text-text-tertiary">{totals.unsettledWalmartCount} record{totals.unsettledWalmartCount === 1 ? '' : 's'}</div>
          </div>
          <div className="text-2xl font-mono text-amber-400">{formatCurrency(totals?.unsettledWalmartImpact || 0)}</div>
          <div className="text-xs text-text-tertiary mt-1">
            Customer return records where Walmart has not deducted you. Roughly 30% of these never settle (Walmart covers the refund itself). If a deduction shows up in recon, the record flips to SETTLED and starts counting.
          </div>
        </div>
      )}
      {/* Cash-flow split: did the refund cancel held funds, or hit your bank? */}
      {(totals?.heldFundImpact || totals?.realCashImpact) && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Held-fund refunds</div>
              <div className="text-[10px] text-text-tertiary">No cash impact</div>
            </div>
            <div className="text-2xl font-mono text-positive">{formatCurrency(totals?.heldFundImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              Refunds that cancelled DD7-held funds before they released. Amazon balanced internally — no money left your account.
            </div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Real cash deductions</div>
              <div className="text-[10px] text-text-tertiary">Disbursed → reversed</div>
            </div>
            <div className="text-2xl font-mono text-negative">{formatCurrency(totals?.realCashImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              Refunds of orders whose funds had already released (and likely disbursed). Real cash out of your bank.
            </div>
          </div>
          <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] uppercase tracking-wider text-text-tertiary">Unknown (non-Amazon)</div>
              <div className="text-[10px] text-text-tertiary">WMT/eBay/PP</div>
            </div>
            <div className="text-2xl font-mono text-text-tertiary">{formatCurrency(totals?.unknownImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              DD7 cash-flow classification is Amazon-only. Walmart/eBay/PayPal refunds have their own timing rules.
            </div>
          </div>
        </div>
      )}
      {totals?.claimDueCount > 0 && (
        <div className="mb-6 bg-bg-surface border border-negative/40 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase tracking-wider text-negative">WFS claims to file — returns never returned to you</div>
            <div className="text-[10px] text-text-tertiary">{totals.claimDueCount} return{totals.claimDueCount === 1 ? '' : 's'}</div>
          </div>
          <div className="text-2xl font-mono text-negative">{formatCurrency(totals?.claimDueImpact || 0)}</div>
          <div className="text-xs text-text-tertiary mt-1">
            Walmart deducted you for these returns 60+ days ago — past their own auto-reimbursement window for lost returns — and the units never came back: no RTV, no restock, no resale, no reimbursement. Open a Seller Support case for each. They&apos;re also tracked with file/dismiss status on the Walmart Disputes page.
          </div>
        </div>
      )}
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, product, or reason..." />
    </div>
  );
}
