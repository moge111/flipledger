'use client';

import {useState, useMemo } from 'react';
import StatCard from '@/components/ui/StatCard';
import DateRangePicker, {type DateRange } from '@/components/ui/DateRangePicker';
import MarketplaceFilter from '@/components/ui/MarketplaceFilter';
import { useFilters } from '@/lib/useFilters';
import { formatCurrency, centsToDollars, formatNumber } from '@/lib/formatters';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { useQuery } from '@/lib/useQuery';
import { Money, Seg } from '@/components/ui/Paper';
import ChartTooltip from '@/components/charts/ChartTooltip';

interface DashboardData {
  stats: {
    totalRevenue: number;
    totalProfit: number;
    totalUnits: number;
    totalOrders: number;
    totalCogs: number;
    totalFees: number;
    serviceFees: number;
    roi: number;
    prevRevenue: number;
    prevProfit: number;
    prevUnits: number;
    prevRoi: number;
  };
  dailyRevenue: { day: string; revenue: number; profit: number; grouping?: string }[];
  topProducts: { name: string; asin: string; category: string; revenue: number; unitsSold: number; cogs: number; fees?: number }[];
  worstProducts: { name: string; asin: string; category: string; revenue: number; unitsSold: number; cogs: number; fees?: number }[];
  expenseBreakdown: { category: string; total: number }[];
  inventoryValue: { totalValue: number; totalUnits: number };
  inFlight?: {
    pending: { orders: number; revenueReported: number; revenueEstimate: number; avgOrderValue: number };
    shippedNotPosted: { orders: number; revenue: number; cogs: number; projectedProfit: number; earliestRelease: string | null; latestRelease: string | null };
  };
}

interface TxRow {
  time: string;
  type: 'sale' | 'refund' | 'fee' | 'reimbursement';
  marketplace: string;
  title: string;
  subtitle: string;
  orderId: string | null;
  amount: number;
  profit?: number;
  cogs?: number;
  shippingCost?: number;
  deferred?: boolean;
  releaseDate?: string | null;
  settled?: boolean;
}

interface TxSummary {
  count: number;
  salesNet: number;
  salesProfit?: number;
  refunds: number;
  fees: number;
  reimbursements: number;
  net: number;
}

interface DayDetail {
  order_id: string;
  marketplace: string;
  product_name: string;
  sku: string;
  quantity: number;
  revenue: number;
  cogs: number;
  net_profit: number;
  posted_date: string;
}

export default function Dashboard() {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showInFlight, setShowInFlight] = useState(false);
  const [inFlightItems, setInFlightItems] = useState<any[]>([]);
  const [inFlightLoading, setInFlightLoading] = useState(false);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam, dateBasis, setDateBasis, dateBasisParam } = useFilters();

  // Single-day view (Today / Yesterday / a clicked day): show the exact
  // transaction feed for that day automatically.
  const singleDay = dateRange.startDate === dateRange.endDate;

  const txUrl = singleDay
    ? `/api/data/transactions?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`
    : null;
  const { data: txData, loading: txLoading } = useQuery<{ transactions?: TxRow[]; summary?: TxSummary | null }>(txUrl);
  const transactions: TxRow[] = txData?.transactions || [];
  const txSummary: TxSummary | null = txData?.summary || null;

  const { data, loading, reload: fetchData } = useQuery<DashboardData>(
    `/api/data/dashboard?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`
  );

  // Day drill-down. Three modes for selectedDay:
  //   '__range__' = use the current dateRange filter (Today / Yesterday / This Week / etc)
  //   'YYYY-MM-DD' single day clicked from chart with daily grouping
  //   'YYYY-MM-01' clicked from chart with monthly grouping → expand to full month
  //   'YYYY-MM-DD' clicked from chart with weekly grouping → expand to 7 days
  let dayUrl: string | null = null;
  if (selectedDay) {
    let fetchStart = selectedDay;
    let fetchEnd = selectedDay;
    if (selectedDay === '__range__') {
      fetchStart = dateRange.startDate;
      fetchEnd = dateRange.endDate;
    } else {
      const grouping = data?.dailyRevenue?.[0]?.grouping || 'daily';
      if (grouping === 'monthly') {
        const d = new Date(selectedDay + 'T00:00:00');
        fetchStart = selectedDay;
        fetchEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
      } else if (grouping === 'weekly') {
        const d = new Date(selectedDay + 'T00:00:00');
        const end = new Date(d.getTime() + 6 * 86400000);
        fetchEnd = end.toISOString().split('T')[0];
      }
    }
    dayUrl = `/api/data/profitloss?startDate=${fetchStart}&endDate=${fetchEnd}${marketplaceParam}${dateBasisParam}`;
  }
  const { data: dayData, loading: dayDetailsLoading } = useQuery<{ salesDetail?: any[]; refundDetail?: any[] }>(dayUrl);
  // Group by product (sku + marketplace), sum quantities and amounts
  const dayDetails: DayDetail[] = useMemo(() => {
    const grouped: Record<string, any> = {};
    for (const item of (dayData?.salesDetail || [])) {
      const key = `${item.sku || item.asin}-${item.marketplace}`;
      if (!grouped[key]) {
        grouped[key] = { ...item };
      } else {
        grouped[key].quantity += item.quantity;
        grouped[key].revenue += item.revenue;
        grouped[key].cogs += item.cogs;
        grouped[key].net_profit += item.net_profit;
      }
    }
    return Object.values(grouped).sort((a: any, b: any) => b.net_profit - a.net_profit);
  }, [dayData]);
  const dayRefunds: any[] = dayData?.refundDetail || [];

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  const { stats, dailyRevenue, topProducts, worstProducts, expenseBreakdown, inventoryValue } = data;

  const chartGrouping = dailyRevenue[0]?.grouping || 'daily';
  const chartData = dailyRevenue.map(d => {
    const date = new Date(d.day + 'T00:00:00');
    let label: string;
    if (chartGrouping === 'monthly') {
      label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else if (chartGrouping === 'weekly') {
      label = 'Wk ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return {
      day: label,
      rawDate: d.day,
      revenue: centsToDollars(d.revenue),
      profit: centsToDollars(d.profit),
    };
  });

  const donutData = expenseBreakdown
    .filter(e => e.total > 0)
    .map(e => ({
      name: e.category,
      value: centsToDollars(e.total),
    }))
    .sort((a, b) => b.value - a.value);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-6">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Overview of your business performance</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            ariaLabel="Date basis"
            value={dateBasis === 'purchase' ? 'purchase' : 'posted'}
            onChange={setDateBasis}
            options={[{ value: 'posted', label: 'Cash' }, { value: 'purchase', label: 'Accrual' }]}
          />
          <MarketplaceFilter value={marketplace} onChange={setMarketplace} />
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
          />
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard
          label="Total Revenue"
          value={stats.totalRevenue}
          previousValue={stats.prevRevenue}
          format="currency"
          accentColor="default"
        />
        <StatCard
          label="Total Profit"
          value={stats.totalProfit}
          previousValue={stats.prevProfit}
          format="currency"
          accentColor={stats.totalProfit >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Units Sold"
          value={stats.totalUnits}
          previousValue={stats.prevUnits}
          format="number"
        />
        <StatCard
          label="ROI"
          value={stats.roi}
          previousValue={stats.prevRoi}
          format="percent"
          accentColor={stats.roi >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Total COGS"
          value={stats.totalCogs}
          format="currency"
        />
      </div>

      {/* In-flight: orders earned but not yet in Cash-basis P&L */}
      {data.inFlight && (data.inFlight.pending.orders > 0 || data.inFlight.shippedNotPosted.orders > 0) && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="panel px-4 py-3.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="label-caps text-text-tertiary">Pending (estimated)</div>
              <div className="text-[11px] text-text-tertiary tabular-nums">{data.inFlight.pending.orders} orders</div>
            </div>
            <div className="stat-num text-[18px] sm:text-[22px] text-text-primary">
              ~<Money cents={data.inFlight.pending.revenueEstimate} />
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              {data.inFlight.pending.orders} × {formatCurrency(data.inFlight.pending.avgOrderValue)} (30d AOV).
              Amazon withholds line items until payment clears.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !showInFlight;
              setShowInFlight(next);
              if (next && inFlightItems.length === 0) {
                setInFlightLoading(true);
                fetch(`/api/data/in-flight-orders?marketplace=${marketplace === 'all' ? 'amazon' : marketplace}`)
                  .then(r => r.json())
                  .then(j => { setInFlightItems(j.items || []); setInFlightLoading(false); })
                  .catch(() => setInFlightLoading(false));
              }
            }}
            aria-expanded={showInFlight}
            className="panel px-4 py-3.5 text-left hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="label-caps text-text-tertiary">Held under Delivery Date Policy</div>
              <div className="text-[11px] font-semibold text-link tabular-nums">{data.inFlight.shippedNotPosted.orders} orders {showInFlight ? '▾' : '›'}</div>
            </div>
            <div className="stat-num text-[18px] sm:text-[22px] text-link">
              <Money cents={data.inFlight.shippedNotPosted.revenue} />
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              ≈ {formatCurrency(data.inFlight.shippedNotPosted.projectedProfit)} projected profit
              {data.inFlight.shippedNotPosted.earliestRelease && data.inFlight.shippedNotPosted.latestRelease && (
                <> · releases {new Date(data.inFlight.shippedNotPosted.earliestRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–{new Date(data.inFlight.shippedNotPosted.latestRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
              )}
            </div>
          </button>
          <div className="panel px-4 py-3.5">
            <div className="label-caps text-text-tertiary mb-1.5">Total expected to post</div>
            <div className="stat-num text-[18px] sm:text-[22px] text-text-primary">
              <Money cents={data.inFlight.pending.revenueEstimate + data.inFlight.shippedNotPosted.revenue} />
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Revenue not yet in Cash view; will appear as orders settle
            </div>
          </div>
        </div>
      )}

      {/* Inline drill: per-order list of orders held under DDP */}
      {showInFlight && (
        <div className="panel overflow-hidden mb-6">
          <div className="panel-bar">
            <span>Orders held under Delivery Date Policy</span>
            <span className="flex items-center gap-3">
              <span className="panel-bar-caption">{inFlightItems.length} orders · by release date</span>
              <button onClick={() => setShowInFlight(false)} className="opacity-70 hover:opacity-100">✕ Close</button>
            </span>
          </div>
          {inFlightLoading ? (
            <div className="p-4 text-sm text-text-tertiary">Loading...</div>
          ) : inFlightItems.length === 0 ? (
            <div className="p-4 text-sm text-text-tertiary">No orders held.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-surface">
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-32">Order</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-20">FC</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-24">Shipped</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-32">Est. Release</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-14">Qty</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-24">Revenue</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-24">Proj. Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {inFlightItems.map((item, i) => (
                    <tr key={`${item.orderId}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[280px] flex items-center gap-2">
                          {item.productName}
                          {item.cogsSource === 'missing' && (
                            <span className="tag tag-attn text-[9.5px]" title="No COGS entered for this SKU yet">
                              No COGS
                            </span>
                          )}
                          {item.cogsSource === 'fallback' && (
                            <span className="tag text-[9.5px]" title="COGS estimated from last known buy price (FIFO lot depleted)">
                              Est. COGS
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku || item.asin}</div>
                      </td>
                      <td className="px-4 py-2 text-[11px] font-mono text-text-tertiary">{item.orderId}</td>
                      <td className="px-4 py-2 text-[11px] text-text-secondary">{item.fulfillment}</td>
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {item.shippedAt ? new Date(item.shippedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className={item.daysUntilRelease === 0 ? 'text-positive font-medium' : 'text-text-secondary'}>
                          {new Date(item.expectedRelease).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="text-text-tertiary ml-1">
                          ({item.daysUntilRelease === 0 ? 'releasing' : `${item.daysUntilRelease}d`})
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm text-text-primary tabular-nums">{formatCurrency(item.revenue)}</td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${item.projectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.projectedProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Single-day transaction feed: every transaction that posted this day */}
      {singleDay && (
        <div className="panel overflow-hidden mb-6">
          <div className="panel-bar">
            <span>
              Transactions · {new Date(dateRange.startDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {txSummary && (
                <span className="panel-bar-caption ml-2">
                  {txSummary.count} transaction{txSummary.count !== 1 ? 's' : ''}
                </span>
              )}
            </span>
            {txSummary && txSummary.count > 0 && (
              <span className={`tabular-nums ${txSummary.net >= 0 ? 'text-positive' : 'text-negative'}`}>
                Net {txSummary.net >= 0 ? '+' : ''}{formatCurrency(txSummary.net)}
              </span>
            )}
          </div>
          {txLoading ? (
            <div className="p-4 text-sm text-text-tertiary">Loading transactions...</div>
          ) : transactions.length === 0 ? (
            <div className="p-4 text-sm text-text-tertiary">
              Nothing has posted for this day yet. On Cash basis, Amazon sales post 1–3 days after shipment
              (and sit in the DD7 hold — see the in-flight cards above); Walmart fees settle via recon 1–3 weeks later.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-surface">
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-20">Time</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-24">Type</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary">Details</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-16">Mkt</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-44">Order</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-28">Amount</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-28">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={i} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-xs text-text-tertiary whitespace-nowrap tabular-nums">
                        {t.time && t.time.length > 10
                          ? new Date(t.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                          : '—'}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`tag ${
                          t.type === 'sale' ? 'tag-green' :
                          t.type === 'refund' ? 'tag-red' :
                          t.type === 'fee' ? 'text-text-tertiary' :
                          'text-text-primary'
                        }`}>
                          {t.type === 'reimbursement' ? 'REIMB' : t.type.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm">
                        <div className="flex items-center gap-1.5">
                          <span className="text-text-primary font-medium truncate max-w-[320px]">{t.title}</span>
                          {t.deferred && (
                            <span className="tag tag-blue"
                              title="Held under Amazon's Delivery Date Policy — not in your available balance yet">
                              DD7{t.releaseDate ? ` · rel ${new Date(t.releaseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                            </span>
                          )}
                          {t.type === 'refund' && t.settled === false && (
                            <span className="tag text-text-tertiary"
                              title="Walmart hasn't settled this deduction yet — excluded from P&L and the net total until it appears in recon">
                              NOT SETTLED
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-text-tertiary truncate max-w-[380px]">{t.subtitle}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`${
                          t.marketplace === 'amazon' ? 'mkt mkt-amazon' :
                          t.marketplace === 'walmart' ? 'mkt mkt-walmart' :
                          t.marketplace === 'ebay' ? 'mkt mkt-ebay' :
                          t.marketplace === 'paypal' ? 'mkt mkt-paypal' :
                          'mkt'
                        }`}>
                          {t.marketplace === 'amazon' ? 'AMZ' : t.marketplace === 'walmart' ? 'WMT' : t.marketplace === 'ebay' ? 'EBAY' : t.marketplace === 'paypal' ? 'PP' : (t.marketplace || '').toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs font-mono">
                        {t.orderId ? (
                          <a href={`/lookup/${encodeURIComponent(t.orderId)}`} className="text-link hover:underline">{t.orderId}</a>
                        ) : (
                          <span className="text-text-tertiary">—</span>
                        )}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${t.amount >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {t.amount >= 0 ? '+' : ''}{formatCurrency(t.amount)}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${t.profit === undefined ? 'text-text-tertiary' : t.profit >= 0 ? 'text-positive' : 'text-negative'}`}
                        title={t.profit === undefined ? undefined : `Amount − COGS${(t.shippingCost || 0) > 0 ? ' − label cost' : ''}`}>
                        {t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${formatCurrency(t.profit)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {txSummary && (
                  <tfoot>
                    <tr className="bg-bg-surface">
                      <td colSpan={5} className="px-4 py-2 text-xs text-text-tertiary">
                        Sales net {formatCurrency(txSummary.salesNet)}
                        {txSummary.refunds !== 0 && <> · Refunds {formatCurrency(txSummary.refunds)}</>}
                        {txSummary.fees !== 0 && <> · Fees {formatCurrency(txSummary.fees)}</>}
                        {txSummary.reimbursements !== 0 && <> · Reimb {formatCurrency(txSummary.reimbursements)}</>}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-semibold tabular-nums ${txSummary.net >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {txSummary.net >= 0 ? '+' : ''}{formatCurrency(txSummary.net)}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-semibold tabular-nums ${(txSummary.salesProfit ?? 0) >= 0 ? 'text-positive' : 'text-negative'}`}
                        title="Sales profit: revenue − fees − COGS − MFN label cost. Refunds, service fees and reimbursements are in the Net column only.">
                        {(txSummary.salesProfit ?? 0) >= 0 ? '+' : ''}{formatCurrency(txSummary.salesProfit ?? 0)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      )}

      {/* Settlement fee note */}
      {stats.serviceFees > stats.totalRevenue * 0.3 && stats.serviceFees > 10000 && (
        <div className="flash mb-6 flex items-start gap-2">
          <span className="text-sm">⚠</span>
          <p className="text-xs text-text-secondary">
            <span className="font-semibold text-text-primary">Settlement fees posted this period.</span>{' '}
            {formatCurrency(stats.serviceFees)} in service fees (storage, subscriptions, inbound shipping) posted in this date range.
            These fees may cover prior months and are batched by Amazon into settlement periods, making short date ranges appear less profitable than they actually are.
          </p>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Revenue & Profit Chart */}
        <div className="panel lg:col-span-2">
          <div className="panel-bar">
            <span>Revenue &amp; Profit <span className="panel-bar-caption ml-1">per {chartGrouping === 'monthly' ? 'month' : chartGrouping === 'weekly' ? 'week' : 'day'} · click a bar to open it</span></span>
            <button
              type="button"
              onClick={() => setSelectedDay(selectedDay === '__range__' ? null : '__range__')}
              aria-pressed={selectedDay === '__range__'}
              className={`px-2 py-0.5 rounded-md border-[1.5px] transition-colors ${
                selectedDay === '__range__'
                  ? 'bg-bar-fg text-bar-bg border-bar-fg'
                  : 'border-bar-fg/40 hover:border-bar-fg'
              }`}
              title="View sales grouped by product for the selected date range"
            >
              {selectedDay === '__range__' ? '✕ Hide breakdown' : 'Sales by product'}
            </button>
          </div>
          <div className="px-4 pt-4 pb-2">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} barGap={2} style={{ cursor: 'pointer' }}>
                <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border-strong)', strokeWidth: 1.5 }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
                <Tooltip
                  content={<ChartTooltip format={(v) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />}
                  cursor={{ fill: 'var(--color-accent-muted)' }}
                />
                <Bar dataKey="revenue" fill="var(--color-chart-1)" radius={[1, 1, 0, 0]} name="Revenue"
                  onClick={(data: any) => { if (data?.rawDate) setSelectedDay(data.rawDate); }}
                />
                <Bar dataKey="profit" fill="var(--color-positive)" radius={[1, 1, 0, 0]} name="Profit"
                  onClick={(data: any) => { if (data?.rawDate) setSelectedDay(data.rawDate); }}
                >
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.profit < 0 ? 'var(--color-negative)' : 'var(--color-positive)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center justify-center gap-4 text-[11px] text-text-tertiary pb-1">
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[1px] bg-chart-1" />Revenue</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[1px] bg-positive" />Profit</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[1px] bg-negative" />Loss</span>
            </div>
          </div>
        </div>

        {/* Expense breakdown: a ranked meter list (name + amount + share over a 4px bar) */}
        <div className="panel">
          <div className="panel-bar">
            <span>Expense breakdown</span>
            <span className="panel-bar-caption">share of costs</span>
          </div>
          <ol className="py-1.5 max-h-[340px] overflow-y-auto">
            {(() => {
              const total = donutData.reduce((s, d) => s + (d.value || 0), 0);
              if (donutData.length === 0) return <li className="px-4 py-6 text-sm text-text-tertiary text-center">No expenses in this range.</li>;
              return donutData.map((d, i) => {
                const pct = total > 0 ? (d.value / total) * 100 : 0;
                return (
                  <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 px-4 py-1.5">
                    <span className="truncate text-[13px] font-semibold text-text-primary">{d.name}</span>
                    <span className="text-[13px] font-semibold tabular-nums text-text-primary">
                      ${d.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}{' '}
                      <span className="font-normal text-text-tertiary">{pct.toFixed(0)}%</span>
                    </span>
                    <span className="meter col-span-2"><b style={{ width: `${pct}%` }} /></span>
                  </li>
                );
              });
            })()}
          </ol>
        </div>
      </div>

      {/* Day Detail Panel */}
      {selectedDay && (
        <div className="panel overflow-hidden mb-6">
          <div className="panel-bar">
            <span>
              <span>
                {selectedDay === '__range__'
                  ? (() => {
                      // "All transactions: <preset label or date range>"
                      const fmt = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: dateRange.startDate.slice(0, 4) !== dateRange.endDate.slice(0, 4) ? 'numeric' : undefined });
                      return dateRange.startDate === dateRange.endDate
                        ? new Date(dateRange.startDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        : `${fmt(dateRange.startDate)} – ${fmt(dateRange.endDate)}`;
                    })()
                  : chartGrouping === 'monthly'
                  ? new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                  : chartGrouping === 'weekly'
                  ? `Week of ${new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="panel-bar-caption ml-2">
                {dayDetails.length} sale{dayDetails.length !== 1 ? 's' : ''}{dayRefunds.length > 0 ? ` · ${dayRefunds.length} return${dayRefunds.length !== 1 ? 's' : ''}` : ''}
              </span>
            </span>
            <button onClick={() => setSelectedDay(null)} className="opacity-70 hover:opacity-100">✕ Close</button>
          </div>
          {dayDetailsLoading ? (
            <div className="p-4 text-sm text-text-tertiary">Loading...</div>
          ) : dayDetails.length === 0 ? (
            <div className="p-4 text-sm text-text-tertiary">No sales on this day.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-surface">
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                    <th className="px-4 py-2 text-left text-[11px] label-caps text-text-tertiary w-16">Mkt</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-14">Qty</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-24">Revenue</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-24">COGS</th>
                    <th className="px-4 py-2 text-right text-[11px] label-caps text-text-tertiary w-24">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {dayDetails.map((item, i) => (
                    <tr key={`${item.order_id}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]">{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`${
                          item.marketplace === 'amazon' ? 'mkt mkt-amazon' :
                          item.marketplace === 'walmart' ? 'mkt mkt-walmart' :
                          item.marketplace === 'ebay' ? 'mkt mkt-ebay' :
                          item.marketplace === 'paypal' ? 'mkt mkt-paypal' :
                          'mkt'
                        }`}>
                          {item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm text-text-primary tabular-nums">{formatCurrency(item.revenue)}</td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{formatCurrency(-item.cogs)}</td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${item.net_profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.net_profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Refunds for this day */}
          {dayRefunds.length > 0 && (
            <div className="border-t border-border-subtle">
              <div className="px-4 py-2 border-b-[1.5px] border-border-strong">
                <span className="label-caps text-negative">Returns ({dayRefunds.length})</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <tbody>
                    {dayRefunds.map((item: any, i: number) => (
                      <tr key={`refund-${item.order_id}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                        <td className="px-4 py-2 text-sm">
                          <div className="text-text-primary font-medium truncate max-w-[300px]">{item.product_name || item.asin || item.order_id}</div>
                          <div className="text-[11px] text-text-tertiary font-mono">{item.reason}</div>
                        </td>
                        <td className="px-4 py-2">
                          <span className={`${
                            item.marketplace === 'amazon' ? 'mkt mkt-amazon' :
                            item.marketplace === 'walmart' ? 'mkt mkt-walmart' :
                            item.marketplace === 'ebay' ? 'mkt mkt-ebay' :
                            item.marketplace === 'paypal' ? 'mkt mkt-paypal' :
                            'mkt'
                          }`}>
                            {item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">{item.quantity}</td>
                        <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">{formatCurrency(-item.refund_amount)}</td>
                        <td className="px-4 py-2 text-right text-sm text-positive tabular-nums">{formatCurrency(item.fee_clawback)}</td>
                        <td className={`px-4 py-2 text-right text-sm font-medium text-negative tabular-nums`}>
                          {formatCurrency(-(item.refund_amount - item.fee_clawback))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bottom Row: Top/Worst Products + Inventory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Top Products */}
        <div className="panel">
          <div className="panel-bar"><span>Top 5 profitable</span></div>
          <div className="px-4 py-2">
            {topProducts.map((p, i) => {
              const profit = p.revenue - p.cogs - (p.fees || 0);
              return (
                <div key={`top-${i}`} className="flex items-center gap-3 py-2 border-t border-border-subtle first:border-t-0">
                  <span className="text-xs text-text-tertiary w-4 tabular-nums">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{p.name || p.asin}</div>
                    <div className="text-xs text-text-tertiary font-mono">{p.asin}</div>
                  </div>
                  <span className="text-sm font-semibold text-positive shrink-0 tabular-nums">
                    {formatCurrency(profit)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Worst Products */}
        <div className="panel">
          <div className="panel-bar"><span>Bottom 5 performers</span></div>
          <div className="px-4 py-2">
            {worstProducts.map((p, i) => {
              const profit = p.revenue - p.cogs - (p.fees || 0);
              return (
                <div key={`worst-${i}`} className="flex items-center gap-3 py-2 border-t border-border-subtle first:border-t-0">
                  <span className="text-xs text-text-tertiary w-4 tabular-nums">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{p.name || p.asin}</div>
                    <div className="text-xs text-text-tertiary font-mono">{p.asin}</div>
                  </div>
                  <span className={`text-sm font-semibold shrink-0 tabular-nums ${profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {formatCurrency(profit)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Inventory Value */}
        <div className="panel">
          <div className="panel-bar"><span>Inventory on hand</span><span className="panel-bar-caption">fulfillable</span></div>
          <div className="px-4 py-4 space-y-4">
            <div>
              <div className="label-caps text-text-tertiary mb-1">Total value (COGS)</div>
              <div className="stat-num text-[22px] sm:text-[26px] text-text-primary"><Money cents={inventoryValue.totalValue} /></div>
            </div>
            <div>
              <div className="label-caps text-text-tertiary mb-1">Total units</div>
              <div className="stat-num text-[22px] sm:text-[26px] text-text-primary">{formatNumber(inventoryValue.totalUnits)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="skeleton h-6 w-32 mb-2" />
          <div className="skeleton h-4 w-56" />
        </div>
        <div className="skeleton h-9 w-40" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="panel px-4 py-3.5">
            <div className="skeleton h-3 w-20 mb-3" />
            <div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="panel lg:col-span-2 p-5">
          <div className="skeleton h-4 w-32 mb-4" />
          <div className="skeleton h-[280px] w-full" />
        </div>
        <div className="panel p-5">
          <div className="skeleton h-4 w-36 mb-4" />
          <div className="skeleton h-[280px] w-full" />
        </div>
      </div>
    </div>
  );
}
