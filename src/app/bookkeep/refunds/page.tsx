'use client';

import { useState, useCallback, useMemo, Fragment } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { useQuery } from '@/lib/useQuery';

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
  disposition?: 'rtv' | 'restocked' | 'pending' | 'in-pipeline' | 'claim-due' | 'reimbursed' | null;
  cashImpact?: 'held-fund' | 'real' | 'unknown';
  shipmentStatus?: string | null;
  shipmentMaturity?: string | null;
  returnOrderId?: string | null;
  customerOrderId?: string | null;
  walmartItemId?: string | null;
  refundId?: number;
  claimId?: number | null;
  claimStatus?: string | null;
  claimFiledAt?: string | null;
}

export default function RefundsPage() {
  // Optimistic claim-status edits, keyed by claimId; cleared when a re-fetch lands.
  const [patches, setPatches] = useState<Record<string, Partial<RefundRow>>>({});
  const [showClaimDue, setShowClaimDue] = useState(false);
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [savingClaim, setSavingClaim] = useState<number | null>(null);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const { data, loading, reload: fetchData } = useQuery<{ items?: RefundRow[]; rows?: RefundRow[]; totals?: any }>(`/api/data/refunds?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
  const rows: RefundRow[] = (data?.items || data?.rows || []).map(x =>
    x.claimId != null && patches[String(x.claimId)] ? { ...x, ...patches[String(x.claimId)] } : x
  );
  const totals: any = data?.totals || null;

  // The claim-due banner totals are computed by the API over this same `items`
  // array, so filtering here yields exactly the rows behind the headline number.
  const claimDueRows = useMemo(() => rows.filter(r => r.disposition === 'claim-due'), [rows]);
  const claimFiled = useMemo(
    () => claimDueRows.filter(r => r.claimStatus === 'filed' || r.claimStatus === 'received'), [claimDueRows]);
  const claimOutstanding = useMemo(
    () => claimDueRows.filter(r => !(r.claimStatus === 'filed' || r.claimStatus === 'received')), [claimDueRows]);

  // Walmart publishes NO deep link that opens a pre-filled support case — its
  // own WFS dispute guide says only "contact Seller Support to create a case".
  // So the closest thing to a direct link is: open the exact order in Seller
  // Center, and put every identifier the case form asks for on the clipboard.
  const sellerCenterOrderUrl = (orderId: string) =>
    `https://seller.walmart.com/orders/details?purchaseOrderId=${encodeURIComponent(orderId)}`;

  // Walmart's "Seller Has Not Received Return" case form has DISCRETE fields —
  // Subject, Purchase order number*, RMA, Item ID, Description* — so a single
  // blob is the wrong shape. Each field is offered separately, and the
  // description carries only the argument (the identifiers have their own
  // fields and repeating them just eats the description limit).
  const buildDescription = useCallback((r: RefundRow) => {
    const days = Math.floor((Date.now() - new Date(r.refundDate).getTime()) / 86400000);
    const amt = formatCurrency(r.refundAmount);
    return `Walmart deducted ${amt} from me for this WFS customer return on ${formatDate(r.refundDate)} (${days} days ago), but the returned unit was never received back into my sellable inventory. There is no RTV fee for it, it never reappeared in my WFS inventory, it has not resold, and no reimbursement has been issued. Requesting reimbursement of ${amt}.`;
  }, []);

  const caseFields = useCallback((r: RefundRow) => ([
    { key: 'subject', label: 'Subject line', required: true, value: 'Seller Has Not Received Return' },
    { key: 'po', label: 'Purchase order number', required: true, value: r.orderId },
    { key: 'rma', label: 'RMA', required: false, value: r.returnOrderId || '' },
    { key: 'item', label: 'Item ID', required: false, value: r.walmartItemId || '' },
    { key: 'desc', label: 'Description of the issue', required: true, value: buildDescription(r) },
  ]), [buildDescription]);

  const copyField = useCallback(async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(id);
      setTimeout(() => setCopiedField(c => (c === id ? null : c)), 2000);
    } catch { setCopiedField(null); }
  }, []);

  // Writes through to walmart_dispute_candidates — the same record the Walmart
  // Disputes page reads — so a claim marked filed here shows as filed there.
  const setClaimStatus = useCallback(async (r: RefundRow, action: 'file' | 'reopen' | 'received') => {
    if (!r.claimId) return;
    setSavingClaim(r.claimId);
    try {
      const res = await fetch('/api/data/walmart-dispute-candidates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.claimId, action }),
      });
      if (!res.ok) throw new Error('save failed');
      const nextStatus = action === 'file' ? 'filed' : action === 'received' ? 'received' : 'pending';
      setPatches(prev => ({ ...prev, [String(r.claimId)]: { claimStatus: nextStatus, claimFiledAt: action === 'file' ? new Date().toISOString() : null } }));
    } catch {
      // Re-pull rather than leave the checkbox lying about what was saved.
      fetchData();
    } finally {
      setSavingClaim(null);
    }
  }, [fetchData]);

  const columns = useMemo<ColumnDef<RefundRow, any>[]>(() => [
    { id: 'refundDate', header: 'Date', accessorKey: 'refundDate', cell: ({ getValue }) => <span className="text-sm text-text-secondary tabular-nums">{formatDate(getValue() as string)}</span>, size: 110 },
    {
      id: 'marketplace', header: '', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = getValue() as string;
        return m === 'walmart'
          ? <span className="mkt mkt-walmart text-[10px]">WMT</span>
          : <span className="mkt mkt-amazon text-[10px]">AMZ</span>;
      }, size: 45,
    },
    { id: 'orderId', header: 'Order ID', accessorKey: 'orderId', cell: ({ getValue }) => <span className="font-mono text-sm text-text-primary">{getValue() as string}</span>, size: 180 },
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.productName || row.asin,
      cell: ({ row }) => (
        <div><div className="text-sm text-text-primary truncate max-w-[200px]">{row.original.productName || row.original.asin}</div><div className="text-xs text-text-tertiary font-mono">{row.original.asin}</div></div>
      ), size: 230,
    },
    { id: 'refundAmount', header: 'Refund Amount', accessorKey: 'refundAmount', cell: ({ getValue }) => <span className="text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 120 },
    { id: 'reason', header: 'Reason', accessorKey: 'reason', cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string}</span>, size: 150 },
    {
      id: 'itemReturned', header: 'Returned?', accessorKey: 'itemReturned',
      cell: ({ getValue }) => getValue() ? <span className="tag text-positive">Yes</span> : <span className="tag text-negative">No</span>,
      size: 80,
    },
    { id: 'feeClawback', header: 'Fee Clawback', accessorKey: 'feeClawback', cell: ({ getValue }) => <span className="text-positive tabular-nums">{formatCurrency(getValue() as number)}</span>, size: 110 },
    {
      id: 'netImpact', header: 'Net Impact', accessorKey: 'netImpact',
      cell: ({ getValue }) => <span className="font-medium text-negative tabular-nums">{formatCurrency(getValue() as number)}</span>,
      size: 110,
    },
    {
      id: 'cashImpact', header: 'Cash Impact', accessorKey: 'cashImpact',
      cell: ({ row }) => {
        // Walmart rows: show settlement state. An unsettled record means
        // Walmart never deducted the seller (yet) — it is NOT in the P&L.
        if (row.original.marketplace === 'walmart') {
          return row.original.settled ? (
            <span className="tag text-negative"
              title="Walmart deducted this refund in a settlement (recon). Counted in P&L.">
              SETTLED
            </span>
          ) : (
            <span className="tag text-warning"
              title="Walmart has NOT deducted you for this return — it's excluded from your P&L and Net Impact. ~30% of Walmart return records never settle (Walmart covers them). If Walmart does deduct it, this flips to SETTLED within 1-3 weeks.">
              NOT SETTLED
            </span>
          );
        }
        const c = row.original.cashImpact;
        if (c === 'held-fund') {
          return (
            <span className="tag text-positive"
              title={`Refund cancelled held funds — no real cash out. Shipment was still DEFERRED (DD7) when refunded${row.original.shipmentMaturity ? `, maturity ${row.original.shipmentMaturity.slice(0,10)}` : ''}.`}>
              HELD-FUND
            </span>
          );
        }
        if (c === 'real') {
          return (
            <span className="tag text-negative"
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
            <span className="tag text-link"
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
            <span className="tag text-link"
              title="Settled, but the unit hasn't reappeared in your stock and no RTV fee exists. Walmart's policy: lost returns auto-reimburse if not processed within 60 days. Flips to CLAIM DUE if still missing (and unreimbursed) 60 days after the refund.">
              IN PIPELINE
            </span>
          );
        }
        if (d === 'claim-due') {
          return (
            <span className="tag tag-attn"
              title="Settled 60+ days ago — past Walmart's own auto-reimbursement window for lost returns — and the unit never reappeared in stock, sales, RTV, or reimbursements. Open a Seller Support case referencing the return's RMA. Also listed on the Walmart Disputes page.">
              CLAIM DUE
            </span>
          );
        }
        if (d === 'reimbursed') {
          return (
            <span className="tag text-positive"
              title="Walmart already paid you for this loss (lost-return adjustment, WFS lost inventory, or a dispute settlement). Claiming again would be a duplicate.">
              REIMBURSED
            </span>
          );
        }
        if (d === 'restocked') {
          // A unit the buyer called defective/not-as-described going back into
          // sellable stock is the next return waiting to happen — flag it.
          const risky = /DEFECTIVE|NOT_AS_DESCRIBED|MISSING_PARTS|DAMAGED/.test(row.original.reason || '');
          return (
            <span className={`tag ${risky ? 'text-warning' : 'text-text-tertiary'}`}
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
        <div className="mb-6 bg-bg-surface border border-warning/30 rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] label-caps text-warning">Walmart returns not settled — excluded from P&L</div>
            <div className="text-[10px] text-text-tertiary">{totals.unsettledWalmartCount} record{totals.unsettledWalmartCount === 1 ? '' : 's'}</div>
          </div>
          <div className="text-2xl text-warning tabular-nums">{formatCurrency(totals?.unsettledWalmartImpact || 0)}</div>
          <div className="text-xs text-text-tertiary mt-1">
            Customer return records where Walmart has not deducted you. Roughly 30% of these never settle (Walmart covers the refund itself). If a deduction shows up in recon, the record flips to SETTLED and starts counting.
          </div>
        </div>
      )}
      {/* Cash-flow split: did the refund cancel held funds, or hit your bank? */}
      {(totals?.heldFundImpact || totals?.realCashImpact) && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] label-caps text-text-tertiary">Held-fund refunds</div>
              <div className="text-[10px] text-text-tertiary">No cash impact</div>
            </div>
            <div className="text-2xl text-positive tabular-nums">{formatCurrency(totals?.heldFundImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              Refunds that cancelled DD7-held funds before they released. Amazon balanced internally — no money left your account.
            </div>
          </div>
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] label-caps text-text-tertiary">Real cash deductions</div>
              <div className="text-[10px] text-text-tertiary">Disbursed → reversed</div>
            </div>
            <div className="text-2xl text-negative tabular-nums">{formatCurrency(totals?.realCashImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              Refunds of orders whose funds had already released (and likely disbursed). Real cash out of your bank.
            </div>
          </div>
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] label-caps text-text-tertiary">Unknown (non-Amazon)</div>
              <div className="text-[10px] text-text-tertiary">WMT/eBay/PP</div>
            </div>
            <div className="text-2xl text-text-tertiary tabular-nums">{formatCurrency(totals?.unknownImpact || 0)}</div>
            <div className="text-xs text-text-tertiary mt-1">
              DD7 cash-flow classification is Amazon-only. Walmart/eBay/PayPal refunds have their own timing rules.
            </div>
          </div>
        </div>
      )}
      {totals?.claimDueCount > 0 && (
        <div className="mb-6 attn-banner overflow-hidden">
          <button
            type="button"
            onClick={() => setShowClaimDue(v => !v)}
            className="w-full text-left p-4 hover:bg-black/5 transition-colors"
            aria-expanded={showClaimDue}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-[11px] label-caps text-text-primary">WFS claims to file — returns never returned to you</div>
              <div className="text-[10px] text-text-tertiary">
                {claimOutstanding.length} to file{claimFiled.length > 0 ? ` · ${claimFiled.length} filed` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Headline counts only what's still outstanding — a filed claim
                  is no longer a to-do, so leaving it in the number would keep
                  the banner shouting after the work is done. */}
              <div className="stat-num text-xl sm:text-2xl text-text-primary">
                {formatCurrency(claimOutstanding.reduce((a, r) => a + r.refundAmount, 0))}
              </div>
              {claimFiled.length > 0 && (
                <span className="tag">
                  {formatCurrency(claimFiled.reduce((a, r) => a + r.refundAmount, 0))} FILED
                </span>
              )}
              <span className="tag text-text-primary">
                {showClaimDue ? 'HIDE' : 'SHOW'} {claimDueRows.length} RETURN{claimDueRows.length === 1 ? '' : 'S'}
                <span className="ml-1">{showClaimDue ? '\u25B2' : '\u25BC'}</span>
              </span>
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Walmart deducted you for these returns 60+ days ago and the unit never came back: no return-to-vendor, no restock, no resale, and no matching loss reimbursement. Returned units are matched per-GTIN and allocated one-to-one, so if Walmart sent back 1 of 2 returns of the same item, only the other one is listed. Tracked with file/dismiss status on the Walmart Disputes page.
            </div>
            <div className="text-[11px] text-warning/80 mt-1">
              RTV evidence comes from the Seller Center → Payments → Services Fees export (RC_InventoryRTVFee) in data/walmart-service-fees/ — the recon feed&apos;s RTV rows are period totals with no item attribution. Re-export and re-import before filing; a return sent back after your last export still shows here. Recon-sourced WFS Refund / Lost Inventory credits carry no SKU either, so they cannot clear a claim automatically.
            </div>
          </button>
          {showClaimDue && (
            <div className="border-t border-negative/30">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] label-caps text-text-tertiary">
                      <th className="text-left px-3 py-2 w-10">Filed</th>
                      <th className="text-left px-4 py-2">Refund date</th>
                      <th className="text-left px-4 py-2">Order</th>
                      <th className="text-left px-4 py-2">RMA / Customer order #</th>
                      <th className="text-left px-4 py-2">Product</th>
                      <th className="text-left px-4 py-2">Reason</th>
                      <th className="text-right px-4 py-2">Refund</th>
                      <th className="text-right px-4 py-2">Days</th>
                      <th className="text-right px-4 py-2">File case</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claimDueRows.map((r, i) => {
                      const days = Math.floor((Date.now() - new Date(r.refundDate).getTime()) / 86400000);
                      const rowKey = `${r.orderId}-${r.sku}-${i}`;
                      const filed = r.claimStatus === 'filed' || r.claimStatus === 'received';
                      return (
                      <Fragment key={rowKey}>
                        <tr className={`border-b border-border-subtle/60 hover:bg-bg-elevated/30 ${filed ? 'opacity-50' : ''}`}>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={filed}
                              disabled={!r.claimId || savingClaim === r.claimId}
                              onChange={() => setClaimStatus(r, filed ? 'reopen' : 'file')}
                              title={filed
                                ? `Filed${r.claimFiledAt ? ` ${formatDate(r.claimFiledAt)}` : ''} — uncheck to reopen`
                                : 'Mark this claim as filed with Walmart'}
                              className="w-4 h-4 accent-current text-negative cursor-pointer disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className={`px-4 py-2 whitespace-nowrap tabular-nums ${filed ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}>{formatDate(r.refundDate)}</td>
                          <td className="px-4 py-2 font-mono whitespace-nowrap">
                            <a href={sellerCenterOrderUrl(r.orderId)} target="_blank" rel="noopener noreferrer"
                              className="text-link hover:underline" title="Open this order in Walmart Seller Center">
                              {r.orderId} ↗
                            </a>
                            <div>
                              <a href={`/lookup/${r.orderId}`} className="text-xs text-text-tertiary hover:text-text-secondary">
                                view in FlipLedger
                              </a>
                            </div>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">
                            {r.returnOrderId
                              ? <div className="text-text-primary" title="Return Order ID — Walmart's RMA number for this return">{r.returnOrderId}</div>
                              : <div className="text-text-tertiary" title="Not captured — this return predates Walmart's ~6-month Returns API window">RMA n/a</div>}
                            <div className="text-text-tertiary">{r.customerOrderId || '—'}</div>
                          </td>
                          <td className="px-4 py-2">
                            <div className="text-text-primary truncate max-w-[240px]">{r.productName || r.asin || r.sku}</div>
                            <div className="text-xs text-text-tertiary font-mono">{r.sku}</div>
                          </td>
                          <td className="px-4 py-2 text-text-secondary">{r.reason}</td>
                          <td className="px-4 py-2 text-right text-negative whitespace-nowrap tabular-nums">{formatCurrency(r.refundAmount)}</td>
                          <td className="px-4 py-2 text-right text-text-secondary whitespace-nowrap tabular-nums">{days}d</td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setOpenCase(c => (c === rowKey ? null : rowKey))}
                              title="Show the exact values for Walmart's case form fields"
                              className={`text-[10px] font-semibold px-2 py-1 rounded transition-colors ${
                                openCase === rowKey
                                  ? 'bg-accent text-text-inverse'
                                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary'
                              }`}
                            >
                              CASE FIELDS {openCase === rowKey ? '\u25B2' : '\u25BC'}
                            </button>
                            <a
                              href="https://seller.walmart.com/help"
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open Walmart Seller Support to create the case"
                              className="ml-1 inline-block text-[10px] font-bold px-2 py-1 rounded-md border-[1.5px] border-border-strong bg-bg-surface text-text-primary hover:bg-bg-hover transition-colors"
                            >
                              OPEN ↗
                            </a>
                          </td>
                        </tr>
                        {openCase === rowKey && (
                          <tr className="border-b border-border-subtle/60 bg-bg-elevated/20">
                            <td colSpan={9} className="px-4 py-3">
                              <div className="text-[11px] label-caps text-text-tertiary mb-2">
                                Walmart case form — &quot;Seller Has Not Received Return&quot;
                              </div>
                              <div className="space-y-2">
                                {caseFields(r).map(f => {
                                  const id = `${rowKey}-${f.key}`;
                                  const empty = !f.value;
                                  return (
                                    <div key={f.key} className="flex items-start gap-2">
                                      <div className="w-44 shrink-0 text-xs text-text-tertiary pt-1">
                                        {f.label}{f.required && <span className="text-negative">*</span>}
                                      </div>
                                      <div className={`flex-1 text-xs rounded px-2 py-1 border border-border-subtle ${empty ? 'text-text-tertiary italic' : 'text-text-primary font-mono'}`}>
                                        {empty ? 'not available — optional field, leave blank' : f.value}
                                      </div>
                                      <button
                                        type="button"
                                        disabled={empty}
                                        onClick={() => copyField(id, f.value)}
                                        className={`text-[10px] font-semibold px-2 py-1 rounded shrink-0 transition-colors ${
                                          empty ? 'bg-bg-elevated/50 text-text-tertiary cursor-not-allowed'
                                            : copiedField === id ? 'text-positive ring-1 ring-current'
                                            : 'bg-bg-elevated text-text-secondary hover:text-text-primary'
                                        }`}
                                      >
                                        {copiedField === id ? 'COPIED ✓' : 'COPY'}
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="text-xs text-text-tertiary mt-2">
                                Leave &quot;What best describes your Issue?&quot; on the option matching <span className="text-text-secondary">returned item not processed / not received</span>. Attach the Customer Returns Report as evidence.
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-negative/30">
                      <td className="px-4 py-2 text-[11px] label-caps text-text-tertiary" colSpan={6}>
                        {claimOutstanding.length} still to file
                        {claimFiled.length > 0 && (
                          <span className="ml-2 text-positive normal-case tracking-normal">
                            · {claimFiled.length} filed ({formatCurrency(claimFiled.reduce((a, r) => a + r.refundAmount, 0))})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-negative tabular-nums">
                        {formatCurrency(claimOutstanding.reduce((a, r) => a + r.refundAmount, 0))}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-border-subtle">
                <div className="flex flex-wrap items-center gap-2">
                  <a href="/bookkeep/walmart-disputes" className="text-xs px-3 py-1.5 rounded text-text-primary hover:text-text-primary transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong">
                    Track file/dismiss status →
                  </a>
                  <a href="https://seller.walmart.com/help" target="_blank" rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-md border-[1.5px] border-border-strong bg-bg-surface font-semibold text-text-primary hover:bg-bg-hover transition-colors">
                    Help → Contact Support ↗
                  </a>
                  <a href="https://seller.walmart.com/wfsLite/reports" target="_blank" rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded text-text-primary hover:text-text-primary transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong">
                    Customer Returns Report ↗
                  </a>
                  <a href="https://seller.walmart.com/returns-reimbursements/dashboard" target="_blank" rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded text-text-primary hover:text-text-primary transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong">
                    Returns dashboard ↗
                  </a>
                </div>
                <div className="text-xs text-text-tertiary mt-2">
                  Walmart has no URL that opens a pre-filled case — their WFS dispute guide only says &quot;contact Seller Support to create a case,&quot; so OPEN drops you at Help → Contact Support. Pick the <span className="text-text-secondary">&quot;Seller Has Not Received Return&quot;</span> topic, then use CASE FIELDS on a row to copy each form field individually. Walmart allows <span className="text-text-secondary">one case per order</span>, and asks you to attach the Customer Returns Report as evidence.
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by order ID, product, or reason..." />
    </div>
  );
}
