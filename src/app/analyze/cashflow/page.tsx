'use client';

import {useMemo, useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { Banknote, Download, Info, PiggyBank, TimerReset } from 'lucide-react';
import { useQuery } from '@/lib/useQuery';

interface MonthRow {
  month: string;
  salesIncome: number;
  mfnShippingCredits: number;
  otherIncome: number;
  reimbursements: number;
  cashIn: number;
  cogs: number;
  orderFees: number;
  serviceFees: number;
  refunds: number;
  shippingCosts: number;
  expenses: number;
  cashOut: number;
  net: number;
  partial: boolean;
}

interface Summary {
  lastCompleteMonth: MonthRow | null;
  avgNet3: number;
  avgNet3Months: string[];
  burnRate: number | null;
  runwayMonths: number | null;
  expectedToPost: {
    pendingOrders: number;
    pendingEstimate: number;
    shippedOrders: number;
    shippedRevenue: number;
    expectedPayout: number;
    feeRate: number;
  };
  inventory: { atCost: number; units: number };
  fixedMonthly: number;
  cashOnHand: number | null;
  cashUpdatedAt: string | null;
}

function fmt(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function fmtSigned(cents: number): string {
  return (cents >= 0 ? '+' : '−') + fmt(Math.abs(cents));
}

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export default function CashFlowPage() {
  const [windowMonths, setWindowMonths] = useState(12);
  // Cash-on-hand field: user edits win until a save; otherwise mirror the server value.
  const [cashEdit, setCashEdit] = useState<string | null>(null);
  const [savingCash, setSavingCash] = useState(false);

  const { data, loading, reload: load } = useQuery<{ months?: MonthRow[]; summary?: Summary | null }>(`/api/data/cashflow?months=${windowMonths}`);
  const months: MonthRow[] = useMemo(() => data?.months || [], [data]);
  const summary: Summary | null = data?.summary || null;
  const cashInput = cashEdit ?? (summary?.cashOnHand != null ? (summary.cashOnHand / 100).toFixed(2) : '');

  async function saveCash() {
    const dollars = parseFloat(cashInput);
    if (isNaN(dollars) || dollars < 0) return;
    setSavingCash(true);
    try {
      await fetch('/api/data/cashflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashOnHandCents: Math.round(dollars * 100) }),
      });
      setCashEdit(null);
      load();
    } finally {
      setSavingCash(false);
    }
  }

  const chartData = useMemo(() => months.map((m) => ({
    name: monthLabel(m.month),
    cashIn: m.cashIn / 100,
    cashOut: m.cashOut / 100,
    net: m.net / 100,
    partial: m.partial,
  })), [months]);

  const totals = useMemo(() => months.reduce((acc, m) => ({
    cashIn: acc.cashIn + m.cashIn,
    cogs: acc.cogs + m.cogs,
    fees: acc.fees + m.orderFees + m.serviceFees,
    refunds: acc.refunds + m.refunds,
    shipping: acc.shipping + m.shippingCosts,
    expenses: acc.expenses + m.expenses,
    cashOut: acc.cashOut + m.cashOut,
    net: acc.net + m.net,
  }), { cashIn: 0, cogs: 0, fees: 0, refunds: 0, shipping: 0, expenses: 0, cashOut: 0, net: 0 }), [months]);

  function exportCsv() {
    const header = 'Month,Sales Income,MFN Ship Credits,Reimbursements,Other Income,Cash In,COGS,Order Fees,Service Fees,Refunds,Shipping,Expenses,Cash Out,Net';
    const lines = months.map((m) => [
      m.month + (m.partial ? ' (partial)' : ''),
      m.salesIncome, m.mfnShippingCredits, m.reimbursements, m.otherIncome, m.cashIn,
      m.cogs, m.orderFees, m.serviceFees, m.refunds, m.shippingCosts, m.expenses, m.cashOut, m.net,
    ].map((v, i) => (i === 0 ? v : ((v as number) / 100).toFixed(2))).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cashflow.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const s = summary;
  const selfFunding = s ? s.avgNet3 >= 0 : true;

  const cards = s ? [
    {
      label: 'Last full month net',
      value: s.lastCompleteMonth ? fmtSigned(s.lastCompleteMonth.net) : '—',
      sub: s.lastCompleteMonth ? monthLabel(s.lastCompleteMonth.month) : 'no complete month in window',
      tone: s.lastCompleteMonth && s.lastCompleteMonth.net >= 0 ? 'text-positive' : 'text-negative',
    },
    {
      label: '3-month avg net',
      value: fmtSigned(s.avgNet3),
      sub: s.avgNet3Months.length ? s.avgNet3Months.map(monthLabel).join(' · ') : '—',
      tone: s.avgNet3 >= 0 ? 'text-positive' : 'text-negative',
    },
    {
      label: 'Expected to post',
      value: fmt(s.expectedToPost.expectedPayout),
      sub: `${s.expectedToPost.shippedOrders} shipped + ${s.expectedToPost.pendingOrders} pending orders · net of ~${Math.round(s.expectedToPost.feeRate * 100)}% fees`,
      tone: 'text-info',
    },
    {
      label: 'Cash tied up in inventory',
      value: fmt(s.inventory.atCost),
      sub: `${s.inventory.units} units at cost — converts back to cash as it sells`,
      tone: 'text-text-primary',
    },
    {
      label: 'Fixed monthly costs',
      value: fmt(s.fixedMonthly),
      sub: 'active recurring expenses',
      tone: 'text-text-secondary',
    },
  ] : [];

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Cash Flow</h1>
          <p className="text-sm text-text-tertiary">Money in vs money out by month, what&apos;s still in flight, and how long your cash lasts</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border-default bg-bg-surface p-0.5">
            {[6, 12, 24].map((w) => (
              <button
                key={w}
                onClick={() => setWindowMonths(w)}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  windowMonths === w ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {w}mo
              </button>
            ))}
          </div>
          <button
            onClick={exportCsv}
            className="flex h-9 items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-secondary hover:bg-bg-elevated"
          >
            <Download size={14} />
            CSV
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {loading && !s
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-[92px] animate-pulse rounded-lg border border-border-subtle bg-bg-surface" />
            ))
          : cards.map((c) => (
              <div key={c.label} className="rounded-lg border border-border-default bg-bg-surface p-4">
                <div className="text-xs uppercase tracking-wide text-text-tertiary">{c.label}</div>
                <div className={`mt-1 font-mono text-xl font-semibold ${c.tone}`}>{c.value}</div>
                <div className="mt-0.5 text-xs text-text-tertiary">{c.sub}</div>
              </div>
            ))}
      </div>

      {/* Runway panel */}
      {s && (
        <div className={`rounded-lg border p-4 ${selfFunding ? 'border-positive/30 bg-positive-muted/30' : 'border-warning/30 bg-warning-muted/20'}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {selfFunding ? <PiggyBank size={22} className="text-positive" /> : <TimerReset size={22} className="text-warning" />}
              <div>
                {selfFunding ? (
                  <>
                    <div className="text-md font-semibold text-positive">Self-funding — no runway limit</div>
                    <div className="text-xs text-text-tertiary">
                      Trailing 3-month average is {fmtSigned(s.avgNet3)}/mo. The business generates cash instead of burning it.
                    </div>
                  </>
                ) : s.cashOnHand == null ? (
                  <>
                    <div className="text-md font-semibold text-warning">Burning {fmt(s.burnRate!)}/mo — enter cash on hand to see runway</div>
                    <div className="text-xs text-text-tertiary">Trailing 3-month average net is negative. Runway = (cash + expected payouts) ÷ monthly burn.</div>
                  </>
                ) : (
                  <>
                    <div className="font-mono text-2xl font-bold text-warning">
                      {s.runwayMonths} months of runway
                    </div>
                    <div className="text-xs text-text-tertiary">
                      ({fmt(s.cashOnHand)} cash + {fmt(s.expectedToPost.expectedPayout)} expected payouts) ÷ {fmt(s.burnRate!)}/mo burn
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Cash on hand input */}
            <div className="flex items-center gap-2">
              <Banknote size={16} className="text-text-tertiary" />
              <label className="text-xs uppercase tracking-wide text-text-tertiary">Cash on hand</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-text-tertiary">$</span>
                <input
                  value={cashInput}
                  onChange={(e) => setCashEdit(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveCash()}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="h-9 w-32 rounded-md border border-border-default bg-bg-input pl-6 pr-2 text-right font-mono text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
                />
              </div>
              <button
                onClick={saveCash}
                disabled={savingCash}
                className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {savingCash ? 'Saving…' : 'Save'}
              </button>
              {s.cashUpdatedAt && (
                <span className="text-xs text-text-tertiary">updated {new Date(s.cashUpdatedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="rounded-lg border border-border-default bg-bg-surface p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Monthly cash in vs out</div>
        {loading && months.length === 0 ? (
          <div className="h-[280px] animate-pulse rounded-md bg-bg-elevated" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e24" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: '#606070', fontSize: 11 }} axisLine={{ stroke: '#2a2a33' }} tickLine={false} />
              <YAxis
                tick={{ fill: '#606070', fontSize: 11, fontFamily: 'var(--font-mono, monospace)' }}
                axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `$${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{ background: '#18181c', border: '1px solid #2a2a33', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#a0a0b0' }}
                formatter={(value, name) => [
                  (value as number).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
                  name === 'cashIn' ? 'Cash in' : name === 'cashOut' ? 'Cash out' : 'Net',
                ]}
              />
              <ReferenceLine y={0} stroke="#3a3a44" />
              <Bar dataKey="cashIn" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={26} />
              <Bar dataKey="cashOut" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={26} />
              <Line dataKey="net" stroke="#6366f1" strokeWidth={2} dot={false} type="monotone" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div className="mt-1 flex gap-4 text-xs text-text-tertiary">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-positive" /> Cash in (sales + reimbursements)</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-negative" /> Cash out (COGS + fees + refunds + expenses)</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-accent" /> Net</span>
        </div>
      </div>

      {/* Monthly table */}
      <div className="overflow-x-auto rounded-lg border border-border-default bg-bg-surface">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border-default bg-bg-elevated text-xs font-medium uppercase tracking-wide text-text-tertiary">
              <th className="px-4 py-2.5 text-left">Month</th>
              <th className="px-3 py-2.5 text-right">Sales</th>
              <th className="px-3 py-2.5 text-right">Reimb</th>
              <th className="px-3 py-2.5 text-right">Cash In</th>
              <th className="px-3 py-2.5 text-right">COGS</th>
              <th className="px-3 py-2.5 text-right">Fees</th>
              <th className="px-3 py-2.5 text-right">Refunds</th>
              <th className="px-3 py-2.5 text-right">Ship</th>
              <th className="px-3 py-2.5 text-right">Expenses</th>
              <th className="px-3 py-2.5 text-right">Cash Out</th>
              <th className="px-4 py-2.5 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className={`border-b border-border-subtle hover:bg-bg-hover ${m.net < 0 ? 'bg-negative-muted/20' : ''}`}>
                <td className="px-4 py-2 text-text-secondary">
                  {monthLabel(m.month)}
                  {m.partial && <span className="ml-1.5 text-xs text-text-tertiary">(partial)</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.salesIncome + m.mfnShippingCredits)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.reimbursements + m.otherIncome)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">{fmt(m.cashIn)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.cogs)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.orderFees + m.serviceFees)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.refunds)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.shippingCosts)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{fmt(m.expenses)}</td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">{fmt(m.cashOut)}</td>
                <td className={`px-4 py-2 text-right font-mono font-semibold ${m.net >= 0 ? 'text-positive' : 'text-negative'}`}>{fmtSigned(m.net)}</td>
              </tr>
            ))}
            {months.length === 0 && !loading && (
              <tr><td colSpan={11} className="px-4 py-12 text-center text-text-tertiary">No cash activity in this window.</td></tr>
            )}
          </tbody>
          {months.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-bg-elevated font-semibold">
                <td className="px-4 py-2.5 text-text-primary">Total</td>
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5 text-right font-mono text-text-primary">{fmt(totals.cashIn)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{fmt(totals.cogs)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{fmt(totals.fees)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{fmt(totals.refunds)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{fmt(totals.shipping)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-secondary">{fmt(totals.expenses)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-text-primary">{fmt(totals.cashOut)}</td>
                <td className={`px-4 py-2.5 text-right font-mono ${totals.net >= 0 ? 'text-positive' : 'text-negative'}`}>{fmtSigned(totals.net)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Method notes */}
      <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-bg-elevated/40 px-3 py-2.5 text-xs text-text-tertiary">
        <Info size={14} className="mt-0.5 shrink-0" />
        <div>
          <span className="text-text-secondary">How this is calculated:</span> Cash basis — income counts when the marketplace posts it
          (matches the P&L; each month&apos;s Net equals that month&apos;s P&L net profit). COGS is recognized at sale (FIFO), not when you
          bought the inventory, so Net is steady-state operating cash flow rather than a bank-statement reconstruction — a heavy buying month
          will feel tighter than this shows, and a sell-down month looser. Card payments, interest, and owner draws aren&apos;t tracked.
          &quot;Expected to post&quot; is Amazon revenue in the DD+7 pipeline, net of ~13% estimated fees. Cash on hand is manually entered
          (no bank feed).
        </div>
      </div>
    </div>
  );
}
