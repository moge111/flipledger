'use client';

import { useState, Fragment } from 'react';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import {type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import {formatCurrency, formatCurrencyParens } from '@/lib/formatters';
import { ChevronDown, ChevronRight, Package } from 'lucide-react';
import { useQuery } from '@/lib/useQuery';

interface SaleItem {
  order_id: string;
  marketplace: string;
  fulfillment_channel: string;
  product_name: string;
  asin: string;
  sku: string;
  quantity: number;
  revenue: number;
  product_revenue: number;
  shippingCredit: number;
  cogs: number;
  fees: number;
  shippingCost: number;
  net_profit: number;
  posted_date: string;
  purchase_date: string;
}

interface PLData {
  income: { sales: number; shippingCredits: number; otherIncome: number; total: number };
  expenses: {
    cogs: number;
    feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }>;
    shippingCosts: number;
    otherExpenses: number;
    otherExpensesByCategory: { category: string; total: number }[];
    totalFees: number;
    total: number;
  };
  refunds: { total: number; clawback: number; net: number };
  reimbursements: number;
  salesTax: { collected: number; facilitator: number };
  netProfit: number;
  margin: number;
  salesDetail?: SaleItem[];
  refundDetail?: RefundItem[];
}

interface RefundItem {
  order_id: string;
  marketplace: string;
  product_name: string;
  asin: string;
  sku: string;
  quantity: number;
  refund_amount: number;
  fee_clawback: number;
  reason: string;
  refund_date: string;
}

export default function ProfitLossPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam, dateBasis, setDateBasis, dateBasisParam } = useFilters();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const { data, loading } = useQuery<PLData>(`/api/data/profitloss?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`);

  function toggleSection(key: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function expandAll() {
    if (!data) return;
    const allKeys = new Set([
      ...Object.keys(data.expenses.feeHierarchy),
      'otherExpenses',
    ]);
    setExpandedSections(allKeys);
  }

  function collapseAll() {
    setExpandedSections(new Set());
  }

  if (loading || !data) return <PLSkeleton />;

  return (
    <div>
      <PageHeader
        title="Profit & Loss"
        subtitle="Analyze > Profit & Loss"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace}
        dateBasis={dateBasis}
        onDateBasisChange={setDateBasis}
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Revenue" value={data.income.total} format="currency" accentColor="default" />
        <StatCard label="Total Expenses" value={data.expenses.total} format="currency" accentColor="negative" />
        <StatCard label="Net Profit" value={data.netProfit} format="currency" accentColor={data.netProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Margin" value={data.margin} format="percent" accentColor={data.margin >= 0 ? 'positive' : 'negative'} />
      </div>

      {/* P&L Table */}
      <div className="panel overflow-hidden">
        {/* Controls */}
        <div className="panel-bar">
          <span>Profit &amp; loss statement</span>
          <span className="flex items-center gap-2">
            <button onClick={expandAll} className="opacity-70 hover:opacity-100 transition-opacity">Expand all</button>
            <span className="opacity-40">|</span>
            <button onClick={collapseAll} className="opacity-70 hover:opacity-100 transition-opacity">Collapse all</button>
          </span>
        </div>

        <table className="w-full">
          <thead>
            <tr className="bg-bg-surface">
              <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Category</th>
              <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-40">Amount</th>
            </tr>
          </thead>
          <tbody>
            {/* ─── INCOME SECTION ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs label-caps text-text-primary">Income</td>
            </tr>
            <PLRow label="Sales" amount={data.income.sales} />
            <PLRow label="Shipping Credits" amount={data.income.shippingCredits} />
            {data.income.otherIncome !== 0 && <PLRow label="Other Income" amount={data.income.otherIncome} />}
            <PLRow label="Total Income" amount={data.income.total} bold />

            {/* ─── EXPENSES SECTION ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs label-caps text-negative">Expenses</td>
            </tr>
            <PLRow label="Cost of Goods Sold" amount={-data.expenses.cogs} />

            {/* Fee categories — expandable; grouped by marketplace in the All view */}
            {groupFeeCategories(data.expenses.feeHierarchy, !marketplace || marketplace === 'all').map(group => (
              <Fragment key={group.label}>
                {group.label && (
                  <tr className="border-b border-border-subtle/50">
                    <td className="px-4 pt-3 pb-1 text-[11px] label-caps text-text-tertiary">{group.label}</td>
                    <td className="px-4 pt-3 pb-1 text-right text-xs text-text-tertiary tabular-nums">{formatCurrencyParens(-group.total)}</td>
                  </tr>
                )}
                {group.entries.map(([category, { total, children }]) => (
                  <ExpandableSection
                    key={category}
                    label={category}
                    total={-total}
                    rows={children.map(c => ({ label: c.name, amount: -c.amount }))}
                    expanded={expandedSections.has(category)}
                    onToggle={() => toggleSection(category)}
                  />
                ))}
              </Fragment>
            ))}

            <PLRow label="MFN Shipping Costs" amount={-data.expenses.shippingCosts} />

            <ExpandableSection
              label="Other Expenses"
              total={-data.expenses.otherExpenses}
              rows={data.expenses.otherExpensesByCategory.map(c => ({ label: c.category, amount: -c.total }))}
              expanded={expandedSections.has('otherExpenses')}
              onToggle={() => toggleSection('otherExpenses')}
            />

            <PLRow label="Total Expenses" amount={-data.expenses.total} bold negative />

            {/* ─── ADJUSTMENTS ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs label-caps text-text-tertiary">Adjustments</td>
            </tr>
            <PLRow label="Refunds Issued" amount={-data.refunds.total} negative />
            <PLRow label="Fee Clawbacks (on refunds)" amount={data.refunds.clawback} />
            <PLRow label="Reimbursements" amount={data.reimbursements} />

            {/* ─── SALES TAX ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs label-caps text-text-tertiary">Sales Tax</td>
            </tr>
            <PLRow label="Tax Collected" amount={data.salesTax.collected} />
            <PLRow label="Marketplace Facilitator Tax" amount={-data.salesTax.facilitator} />

            {/* ─── NET PROFIT ─── */}
            <tr className="border-t-[1.5px] border-border-strong bg-bg-surface">
              <td className="px-4 py-3 text-md font-extrabold text-text-primary">Net Profit</td>
              <td className={`px-4 py-3 text-right stat-num text-lg ${data.netProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                {formatCurrency(data.netProfit)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Sales Detail */}
      {data.salesDetail && data.salesDetail.length > 0 && (
        <div className="panel mt-6 overflow-hidden">
          <div className="panel-bar">
            <span className="flex items-center gap-2"><Package size={13} />Sales detail</span>
            <span className="panel-bar-caption">{data.salesDetail.length} items</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-surface">
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-20">Mkt</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Revenue</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">COGS</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Fees</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Ship</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Net Profit</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-20">Margin</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Settled</th>
                </tr>
              </thead>
              <tbody>
                {data.salesDetail.map((item, i) => {
                  const margin = item.revenue > 0 ? (item.net_profit / item.revenue) * 100 : 0;
                  const fees = -item.fees; // fees are stored as negative, display as positive cost
                  const settledTime = new Date(item.posted_date);
                  const timeStr = settledTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                  const dateStr = settledTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  const mktLabel = item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase();
                  const mktColor = item.marketplace === 'amazon' ? 'mkt mkt-amazon' : item.marketplace === 'walmart' ? 'mkt mkt-walmart' : item.marketplace === 'ebay' ? 'mkt mkt-ebay' : item.marketplace === 'paypal' ? 'mkt mkt-paypal' : 'mkt';
                  return (
                    <tr key={`${item.order_id}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={mktColor}>
                          {mktLabel}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm text-text-primary tabular-nums">
                        <div>{formatCurrency(item.revenue)}</div>
                        {item.shippingCredit > 0 && (
                          <div className="text-[11px] text-text-tertiary" title="Shipping the buyer paid, counted as income">
                            {formatCurrency(item.product_revenue)} + {formatCurrency(item.shippingCredit)} ship
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{item.cogs > 0 ? formatCurrency(-item.cogs) : '-'}</td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{fees > 0 ? formatCurrency(-fees) : '-'}</td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{item.shippingCost > 0 ? formatCurrency(-item.shippingCost) : '-'}</td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${item.net_profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.net_profit)}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm tabular-nums ${margin >= 20 ? 'text-positive' : margin >= 0 ? 'text-text-secondary' : 'text-negative'}`}>
                        {margin.toFixed(1)}%
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-text-tertiary">
                        <div>{dateStr}</div>
                        <div>{timeStr}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Refund Detail */}
      {data?.refundDetail && data.refundDetail.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="panel-bar">
            <span>Returns</span>
            <span className="panel-bar-caption">{data.refundDetail.length} items</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-surface">
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-20">Mkt</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Refund</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Fee Clawback</th>
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-40">Reason</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Date</th>
                </tr>
              </thead>
              <tbody>
                {data.refundDetail.map((item, i) => {
                  const refundTime = new Date(item.refund_date);
                  const timeStr = refundTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                  const dateStr = refundTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  const mktLabel = item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase();
                  const mktColor = item.marketplace === 'amazon' ? 'mkt mkt-amazon' : item.marketplace === 'walmart' ? 'mkt mkt-walmart' : item.marketplace === 'ebay' ? 'mkt mkt-ebay' : item.marketplace === 'paypal' ? 'mkt mkt-paypal' : 'mkt';
                  return (
                    <tr key={`refund-${item.order_id}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={mktColor}>
                          {mktLabel}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{formatCurrency(-item.refund_amount)}</td>
                      <td className="px-4 py-2 text-right text-sm text-positive tabular-nums">{item.fee_clawback > 0 ? formatCurrency(item.fee_clawback) : '-'}</td>
                      <td className="px-4 py-2 text-left text-sm text-text-secondary">{item.reason || '-'}</td>
                      <td className="px-4 py-2 text-right text-xs text-text-tertiary">
                        <div>{dateStr}</div>
                        <div>{timeStr}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

type FeeEntry = [string, { total: number; children: { name: string; amount: number }[] }];

/** Which marketplace a fee_category belongs to — used only to group the All-Marketplaces view. */
function marketplaceOfCategory(category: string): string {
  if (category.startsWith('eBay')) return 'eBay';
  if (category.startsWith('Walmart') || category.startsWith('WFS')) return 'Walmart';
  if (category === 'Payment Processing Fees') return 'PayPal';
  return 'Amazon';
}

function groupFeeCategories(
  feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }>,
  grouped: boolean,
): { label: string | null; total: number; entries: FeeEntry[] }[] {
  const entries = Object.entries(feeHierarchy) as FeeEntry[];
  if (!grouped) return [{ label: null, total: 0, entries }];
  const order = ['Amazon', 'Walmart', 'eBay', 'PayPal'];
  const byMkt = new Map<string, FeeEntry[]>();
  for (const e of entries) {
    const m = marketplaceOfCategory(e[0]);
    if (!byMkt.has(m)) byMkt.set(m, []);
    byMkt.get(m)!.push(e);
  }
  return order
    .filter(m => byMkt.has(m))
    .map(m => {
      const es = byMkt.get(m)!.sort((a, b) => b[1].total - a[1].total);
      return { label: m, total: es.reduce((s, e) => s + e[1].total, 0), entries: es };
    });
}

function PLRow({ label, amount, bold, negative, indent }: {
  label: string;
  amount: number;
  bold?: boolean;
  negative?: boolean;
  indent?: boolean;
}) {
  amount = amount === 0 ? 0 : amount; // normalise −0 (from `-x` on a zero total)
  const isNeg = amount < 0;
  return (
    <tr className="border-b border-border-subtle hover:bg-bg-hover transition-colors">
      <td className={`px-4 py-2 text-sm ${bold ? 'font-semibold text-text-primary' : 'text-text-secondary'} ${indent ? 'pl-10' : ''}`}>
        {label}
      </td>
      <td className={`px-4 py-2 text-right text-sm tabular-nums ${
        bold ? 'font-semibold' : ''
      } ${isNeg ? 'text-negative' : 'text-text-primary'}`}>
        {isNeg ? formatCurrencyParens(amount) : formatCurrency(amount)}
      </td>
    </tr>
  );
}

function ExpandableSection({ label, total, rows, expanded, onToggle }: {
  label: string;
  total: number;
  rows: { label: string; amount: number }[];
  expanded: boolean;
  onToggle: () => void;
}) {
  total = total === 0 ? 0 : total; // normalise −0
  const isNeg = total < 0;
  return (
    <>
      <tr className="border-b border-border-subtle hover:bg-bg-hover transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2 text-sm font-medium text-text-primary">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
            {label}
          </div>
        </td>
        <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${isNeg ? 'text-negative' : 'text-text-primary'}`}>
          {isNeg ? formatCurrencyParens(total) : formatCurrency(total)}
        </td>
      </tr>
      {expanded && rows.map((child, i) => (
        <PLRow key={i} label={child.label} amount={child.amount} indent />
      ))}
    </>
  );
}

function PLSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><div className="skeleton h-6 w-32 mb-2" /><div className="skeleton h-4 w-48" /></div>
        <div className="skeleton h-9 w-40" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="panel p-5">
            <div className="skeleton h-3 w-20 mb-3" /><div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="panel p-4">
        {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton h-8 w-full mb-1" />)}
      </div>
    </div>
  );
}
