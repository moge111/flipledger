'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, AlertCircle } from 'lucide-react';

interface OrderDetail {
  order: {
    order_id: string;
    purchase_date: string;
    status: string;
    marketplace: string;
    fulfillment_channel: string;
    is_estimated: number;
    created_at: string;
  };
  replacement?: {
    isReplacement: boolean;
    replacesOrderId: string | null;
    reasonCode: number | null;
    reasonLabel: string | null;
    replacedBy: Array<{ orderId: string; status: string; reasonLabel: string | null }>;
  };
  items: Array<{
    id: number;
    asin: string;
    sku: string;
    quantity: number;
    price_per_unit: number;
    total_price: number;
    shipping_charged: number;
    shipping_cost: number;
    promotional_rebate: number;
    cogs_per_unit: number;
    product_name: string;
    image_url: string | null;
  }>;
  events: Array<{
    id: number;
    eventType: string;
    postedDate: string;
    amountCents: number;
    asin: string | null;
    sku: string | null;
    txType: string | null;
    amtType: string | null;
    txDesc: string | null;
  }>;
  fees: Array<{ id: number; fee_type: string; fee_category: string; amount: number; posted_date: string }>;
  refunds: Array<{ id: number; refund_date: string; sku: string | null; refund_amount: number; reason: string | null; quantity: number; marketplace: string }>;
  reimbursements: Array<{ id: number; reimbursement_id: string; reimbursement_date: string; sku: string | null; reason: string | null; amount: number; marketplace: string; status: string }>;
  amazonDisputes: Array<{ id: number; refund_id: number; eligibility: string; status: string; refund_amount_cents: number; return_reason: string | null }>;
  walmartDisputes: Array<{ id: number; refund_id: number; eligibility: string; status: string; refund_amount_cents: number; return_reason: string | null }>;
  summary: {
    netCents: number;
    totalCogsCents: number;
    profitCents: number;
    eventCount: number;
    feeCount: number;
    refundCount: number;
    reimbursementCount: number;
  };
}

function fmt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const marketplaceBadge: Record<string, { label: string; cls: string }> = {
  amazon: { label: 'AMZ', cls: 'mkt mkt-amazon' },
  walmart: { label: 'WMT', cls: 'mkt mkt-walmart' },
  ebay: { label: 'EBAY', cls: 'mkt mkt-ebay' },
  paypal: { label: 'PP', cls: 'mkt mkt-paypal' },
};

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/data/order/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (r.status === 404) {
          throw new Error('Order not found');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-8 text-text-tertiary">Loading…</div>;
  if (error) {
    return (
      <div className="p-8">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-4">
          <ArrowLeft size={14} /> Back
        </Link>
        <div className="flash flash-bad p-4 text-sm text-negative flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5" />
          <div>
            <div className="font-medium">{error}</div>
            <div className="text-text-tertiary mt-1 font-mono text-xs">order_id: {id}</div>
          </div>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { order, replacement, items, events, fees, refunds, reimbursements, amazonDisputes, walmartDisputes, summary } = data;
  const mb = marketplaceBadge[order.marketplace] || { label: order.marketplace.toUpperCase(), cls: 'mkt' };

  // Marketplace-specific external link
  const externalUrl = (() => {
    if (order.marketplace === 'amazon') return `https://sellercentral.amazon.com/orders-v3/order/${order.order_id}`;
    if (order.marketplace === 'walmart') return `https://seller.walmart.com/orders/details?purchaseOrderId=${order.order_id}`;
    return null;
  })();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-3">
          <ArrowLeft size={14} /> Back
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className={mb.cls}>{mb.label}</span>
              <span className="text-xs text-text-tertiary label-caps">{order.fulfillment_channel}</span>
              <span className="text-xs text-text-tertiary">·</span>
              <span className="text-xs text-text-tertiary">{order.status}</span>
            </div>
            <h1 className="page-title font-mono">{order.order_id}</h1>
            <div className="text-sm text-text-tertiary mt-1">Purchased {fmtDate(order.purchase_date)}</div>
            {replacement?.isReplacement && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="tag text-accent">Replacement</span>
                {replacement.replacesOrderId && (
                  <span className="text-text-secondary">
                    replaces{' '}
                    <Link href={`/lookup/${encodeURIComponent(replacement.replacesOrderId)}`} className="font-mono text-link hover:underline">
                      {replacement.replacesOrderId}
                    </Link>
                  </span>
                )}
                <span className="text-text-tertiary">
                  · {replacement.reasonLabel ? `Reason: ${replacement.reasonLabel}` : 'Reason pending — Amazon reports it 1–2 days after the replacement ships'}
                </span>
              </div>
            )}
            {replacement?.replacedBy.map((r) => (
              <div key={r.orderId} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="tag text-warning">Replaced</span>
                <span className="text-text-secondary">
                  free replacement sent as{' '}
                  <Link href={`/lookup/${encodeURIComponent(r.orderId)}`} className="font-mono text-link hover:underline">{r.orderId}</Link>
                </span>
                <span className="text-text-tertiary">· {r.reasonLabel ? `Reason: ${r.reasonLabel}` : `${r.status} — reason pending`}</span>
              </div>
            ))}
          </div>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              Open in {order.marketplace === 'amazon' ? 'Seller Central' : 'Seller Center'}
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Net (financial events)" value={fmt(summary.netCents)} accent={summary.netCents >= 0 ? 'positive' : 'negative'} />
        <SummaryCard label="COGS" value={fmt(-summary.totalCogsCents)} accent="neutral" />
        <SummaryCard label="Estimated profit" value={fmt(summary.profitCents)} accent={summary.profitCents >= 0 ? 'positive' : 'negative'} />
        <SummaryCard label="Records" value={`${summary.eventCount}e · ${summary.refundCount}r · ${summary.reimbursementCount}re`} accent="neutral" />
      </div>

      {/* Items */}
      <Section title={`Items (${items.length})`}>
        <table className="w-full text-sm">
          <thead className="text-text-tertiary text-xs label-caps">
            <tr>
              <th className="text-left py-2 px-3">Product</th>
              <th className="text-left py-2 px-3">SKU</th>
              <th className="text-right py-2 px-3">Qty</th>
              <th className="text-right py-2 px-3">Price</th>
              <th className="text-right py-2 px-3">Total</th>
              <th className="text-right py-2 px-3">COGS/u</th>
              <th className="text-right py-2 px-3">Ship</th>
              <th className="text-right py-2 px-3">Promo</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                <td className="py-2 px-3">
                  <div className="text-text-primary truncate max-w-[24rem]">{it.product_name}</div>
                  <div className="text-xs text-text-tertiary font-mono">{it.asin}</div>
                </td>
                <td className="py-2 px-3 text-text-secondary font-mono text-xs">{it.sku}</td>
                <td className="py-2 px-3 text-right">{it.quantity}</td>
                <td className="py-2 px-3 text-right">{fmt(it.price_per_unit)}</td>
                <td className="py-2 px-3 text-right">{fmt(it.total_price)}</td>
                <td className="py-2 px-3 text-right text-text-secondary">{it.cogs_per_unit ? fmt(it.cogs_per_unit) : '—'}</td>
                <td className="py-2 px-3 text-right text-text-secondary">{it.shipping_cost ? fmt(-it.shipping_cost) : '—'}</td>
                <td className="py-2 px-3 text-right text-text-secondary">{it.promotional_rebate ? fmt(it.promotional_rebate) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Financial events timeline */}
      <Section title={`Financial events (${events.length})`}>
        <table className="w-full text-sm">
          <thead className="text-text-tertiary text-xs label-caps">
            <tr>
              <th className="text-left py-2 px-3">Date</th>
              <th className="text-left py-2 px-3">Event</th>
              <th className="text-left py-2 px-3">Detail</th>
              <th className="text-right py-2 px-3">Amount</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{fmtDate(e.postedDate)}</td>
                <td className="py-2 px-3 font-mono text-xs">{e.eventType}</td>
                <td className="py-2 px-3 text-text-tertiary">
                  {e.txType && <span>{e.txType}</span>}
                  {e.amtType && <span> · {e.amtType}</span>}
                  {e.txDesc && <span> · {e.txDesc}</span>}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums ${e.amountCents < 0 ? 'text-negative' : 'text-positive'}`}>
                  {fmt(e.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Fees */}
      {fees.length > 0 && (
        <Section title={`Fees (${fees.length})`}>
          <table className="w-full text-sm">
            <thead className="text-text-tertiary text-xs label-caps">
              <tr>
                <th className="text-left py-2 px-3">Date</th>
                <th className="text-left py-2 px-3">Type</th>
                <th className="text-left py-2 px-3">Category</th>
                <th className="text-right py-2 px-3">Amount</th>
              </tr>
            </thead>
            <tbody>
              {fees.map((f) => (
                <tr key={f.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                  <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{fmtDate(f.posted_date)}</td>
                  <td className="py-2 px-3 font-mono text-xs">{f.fee_type}</td>
                  <td className="py-2 px-3 text-text-tertiary">{f.fee_category}</td>
                  <td className={`py-2 px-3 text-right tabular-nums ${f.amount < 0 ? 'text-negative' : 'text-positive'}`}>
                    {fmt(f.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Refunds */}
      {refunds.length > 0 && (
        <Section title={`Refunds (${refunds.length})`}>
          <table className="w-full text-sm">
            <thead className="text-text-tertiary text-xs label-caps">
              <tr>
                <th className="text-left py-2 px-3">Date</th>
                <th className="text-left py-2 px-3">SKU</th>
                <th className="text-left py-2 px-3">Reason</th>
                <th className="text-right py-2 px-3">Qty</th>
                <th className="text-right py-2 px-3">Amount</th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                  <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{fmtDate(r.refund_date)}</td>
                  <td className="py-2 px-3 font-mono text-xs">{r.sku || '—'}</td>
                  <td className="py-2 px-3 text-text-tertiary">{r.reason || '—'}</td>
                  <td className="py-2 px-3 text-right">{r.quantity}</td>
                  <td className="py-2 px-3 text-right text-negative tabular-nums">{fmt(-r.refund_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Reimbursements */}
      {reimbursements.length > 0 && (
        <Section title={`Reimbursements (${reimbursements.length})`}>
          <table className="w-full text-sm">
            <thead className="text-text-tertiary text-xs label-caps">
              <tr>
                <th className="text-left py-2 px-3">Date</th>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">SKU</th>
                <th className="text-left py-2 px-3">Reason</th>
                <th className="text-right py-2 px-3">Amount</th>
              </tr>
            </thead>
            <tbody>
              {reimbursements.map((r) => (
                <tr key={r.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                  <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{fmtDate(r.reimbursement_date)}</td>
                  <td className="py-2 px-3 font-mono text-xs truncate max-w-[16rem]">{r.reimbursement_id}</td>
                  <td className="py-2 px-3 font-mono text-xs">{r.sku || '—'}</td>
                  <td className="py-2 px-3 text-text-tertiary">{r.reason || '—'}</td>
                  <td className="py-2 px-3 text-right text-positive tabular-nums">{fmt(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Disputes */}
      {(amazonDisputes.length > 0 || walmartDisputes.length > 0) && (
        <Section title="Dispute candidates">
          <div className="space-y-2">
            {[...amazonDisputes, ...walmartDisputes].map((d) => (
              <div key={`${d.refund_id}-${d.id}`} className="flex items-center justify-between p-3 rounded-md bg-bg-elevated text-sm">
                <div className="flex items-center gap-3">
                  <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                    d.eligibility === 'eligible' ? 'tag text-positive' :
                    d.eligibility === 'maybe' ? 'tag text-warning' :
                    'tag text-text-tertiary'
                  }`}>
                    {d.eligibility}
                  </span>
                  <span className="text-text-tertiary text-xs label-caps">{d.status}</span>
                  <span className="text-text-secondary">{d.return_reason || '—'}</span>
                </div>
                <span className="text-text-secondary tabular-nums">{fmt(d.refund_amount_cents)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: 'positive' | 'negative' | 'neutral' }) {
  const cls = accent === 'positive' ? 'text-positive' : accent === 'negative' ? 'text-negative' : 'text-text-primary';
  return (
    <div className="panel p-3">
      <div className="text-[10px] label-caps text-text-tertiary mb-1.5">{label}</div>
      <div className={`text-lg tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm text-text-secondary label-caps mb-2">{title}</h2>
      <div className="panel overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
