'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Package, ExternalLink, ImageOff, Info } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

interface StageBreakdown {
  fulfillable: number;
  inboundWorking: number;
  inboundShipped: number;
  inboundReceiving: number;
  reservedCustomerOrder: number;
  reservedFcTransfer: number;
  reservedFcProcessing: number;
  unfulfillable: number;
  local: number;
}

interface InventoryItem {
  key: string;
  asin: string | null;
  sku: string | null;
  marketplace: string;
  location: string;
  productName: string;
  imageUrl: string | null;
  walmartItemId: string | null;
  stages: StageBreakdown;
  totalQty: number;
  cogsPerUnit: number;
  totalCostValue: number;
  listPrice: number;
  estResaleValue: number;
  lastUpdated: string;
}

interface Totals {
  totalUnits: number;
  totalCostValue: number;
  totalEstResale: number;
  skuCount: number;
  missingCogs: number;
  stageTotals: Record<string, { units: number; value: number }>;
  locationTotals: Record<string, { units: number; value: number; skus: number }>;
}

type StageKey = keyof StageBreakdown;
type LocationFilter = 'all' | 'amazon' | 'walmart' | 'local';
type SortKey = 'value' | 'units' | 'resale' | 'name';

// Order matches the physical journey: on your shelf → in transit → at the FC → sold.
const STAGE_META: { key: StageKey; label: string; short: string; chip: string; bar: string }[] = [
  { key: 'local',                 label: 'On hand (local)',      short: 'Local',        chip: 'bg-slate-500/10 text-slate-300 border-slate-500/30',   bar: 'bg-slate-400' },
  { key: 'inboundWorking',        label: 'Shipment created',     short: 'Working',      chip: 'bg-info/10 text-info border-info/30',                   bar: 'bg-sky-600' },
  { key: 'inboundShipped',        label: 'In transit',           short: 'In transit',   chip: 'bg-info/10 text-info border-info/30',                   bar: 'bg-sky-500' },
  { key: 'inboundReceiving',      label: 'Checking in',          short: 'Checking in',  chip: 'bg-accent/10 text-accent border-accent/30',             bar: 'bg-sky-400' },
  { key: 'fulfillable',           label: 'Fulfillable',          short: 'Fulfillable',  chip: 'bg-positive/10 text-positive border-positive/30',       bar: 'bg-emerald-500' },
  { key: 'reservedFcTransfer',    label: 'FC transfer',          short: 'FC transfer',  chip: 'bg-purple-500/10 text-purple-400 border-purple-500/30', bar: 'bg-purple-500' },
  { key: 'reservedFcProcessing',  label: 'FC processing',        short: 'FC processing',chip: 'bg-purple-500/10 text-purple-400 border-purple-500/30', bar: 'bg-purple-400' },
  { key: 'reservedCustomerOrder', label: 'Sold — awaiting ship', short: 'Sold',         chip: 'bg-teal-500/10 text-teal-400 border-teal-500/30',       bar: 'bg-teal-400' },
  { key: 'unfulfillable',         label: 'Unfulfillable',        short: 'Unfulfillable',chip: 'bg-negative/10 text-negative border-negative/30',       bar: 'bg-red-500' },
];

const MARKETPLACE_BADGE: Record<string, { tone: 'amazon' | 'walmart' | 'neutral'; label: string }> = {
  amazon: { tone: 'amazon', label: 'AMZ' },
  walmart: { tone: 'walmart', label: 'WMT' },
  local: { tone: 'neutral', label: 'LOCAL' },
};

function fmt(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function listingUrl(item: InventoryItem): string | null {
  if (item.marketplace === 'amazon' && item.asin) return `https://www.amazon.com/dp/${item.asin}`;
  if (item.marketplace === 'walmart' && item.walmartItemId) return `https://www.walmart.com/ip/${item.walmartItemId}`;
  return null;
}

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [location, setLocation] = useState<LocationFilter>('all');
  const [stageFilter, setStageFilter] = useState<StageKey | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [sortDesc, setSortDesc] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/data/inventory-overview');
      const data = await res.json();
      setItems(data.items || []);
      setTotals(data.totals || null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (location !== 'all' && it.marketplace !== location) return false;
      if (stageFilter !== 'all' && it.stages[stageFilter] <= 0) return false;
      if (!q) return true;
      return (
        (it.productName || '').toLowerCase().includes(q) ||
        (it.sku || '').toLowerCase().includes(q) ||
        (it.asin || '').toLowerCase().includes(q)
      );
    });
    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      switch (sortKey) {
        case 'units': return dir * (a.totalQty - b.totalQty);
        case 'resale': return dir * (a.estResaleValue - b.estResaleValue);
        case 'name': return dir * (a.productName || '').localeCompare(b.productName || '');
        default: return dir * (a.totalCostValue - b.totalCostValue);
      }
    });
    return filtered;
  }, [items, location, stageFilter, search, sortKey, sortDesc]);

  // Totals for the CURRENT filter selection (so filtering shows its own value).
  const visibleTotals = useMemo(() => ({
    units: visible.reduce((s, i) => s + i.totalQty, 0),
    cost: visible.reduce((s, i) => s + i.totalCostValue, 0),
    resale: visible.reduce((s, i) => s + i.estResaleValue, 0),
  }), [visible]);

  const st = totals?.stageTotals;
  const inTransitUnits = st ? st.inboundWorking.units + st.inboundShipped.units + st.inboundReceiving.units : 0;
  const inTransitValue = st ? st.inboundWorking.value + st.inboundShipped.value + st.inboundReceiving.value : 0;
  const reservedUnits = st ? st.reservedCustomerOrder.units + st.reservedFcTransfer.units + st.reservedFcProcessing.units : 0;
  const reservedValue = st ? st.reservedCustomerOrder.value + st.reservedFcTransfer.value + st.reservedFcProcessing.value : 0;

  const cards = totals ? [
    { label: 'Total inventory at cost', value: fmt(totals.totalCostValue), sub: `${totals.totalUnits} units · ${totals.skuCount} SKUs`, tone: 'text-text-primary' },
    { label: 'Sellable now', value: fmt(st!.fulfillable.value), sub: `${st!.fulfillable.units} units fulfillable`, tone: 'text-positive' },
    { label: 'In transit / checking in', value: fmt(inTransitValue), sub: `${inTransitUnits} units inbound`, tone: 'text-info' },
    { label: 'Reserved', value: fmt(reservedValue), sub: `${st!.reservedCustomerOrder.units} sold · ${st!.reservedFcTransfer.units + st!.reservedFcProcessing.units} FC moves`, tone: 'text-purple-400' },
    { label: 'On hand (local)', value: fmt(st!.local.value), sub: `${st!.local.units} units not sent anywhere`, tone: 'text-text-secondary' },
  ] : [];

  const barSegments = st
    ? STAGE_META.filter((m) => st[m.key]?.units > 0).map((m) => ({ ...m, units: st[m.key].units, value: st[m.key].value }))
    : [];
  const barTotal = barSegments.reduce((s, seg) => s + seg.units, 0);

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Inventory</h1>
          <p className="text-sm text-text-tertiary">Every unit you own — where it is, what stage it&apos;s in, and what it&apos;s worth</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-elevated"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border-default bg-bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-tertiary">{c.label}</div>
            <div className={`mt-1 text-xl font-semibold ${c.tone}`}>{c.value}</div>
            <div className="mt-0.5 text-xs text-text-tertiary">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Pipeline bar */}
      {barTotal > 0 && (
        <div className="rounded-lg border border-border-default bg-bg-surface p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Pipeline — units by stage</div>
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-bg-elevated">
            {barSegments.map((seg) => (
              <div
                key={seg.key}
                className={`${seg.bar} h-full`}
                style={{ width: `${Math.max((seg.units / barTotal) * 100, 1.5)}%` }}
                title={`${seg.label}: ${seg.units} units · ${fmt(seg.value)}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {barSegments.map((seg) => (
              <button
                key={seg.key}
                onClick={() => setStageFilter(stageFilter === seg.key ? 'all' : seg.key)}
                className={`flex items-center gap-1.5 text-xs transition-opacity ${stageFilter !== 'all' && stageFilter !== seg.key ? 'opacity-40' : ''}`}
                title={`${fmt(seg.value)} at cost — click to filter`}
              >
                <span className={`h-2.5 w-2.5 rounded-sm ${seg.bar}`} />
                <span className="text-text-secondary">{seg.label}</span>
                <span className="font-mono text-text-tertiary">{seg.units}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, SKU, or ASIN…"
            className="h-9 w-full rounded-md border border-border-default bg-bg-input pl-9 pr-3 text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div className="flex rounded-md border border-border-default bg-bg-surface p-0.5">
          {([
            { value: 'all', label: 'All' },
            { value: 'amazon', label: 'Amazon FBA' },
            { value: 'walmart', label: 'Walmart WFS' },
            { value: 'local', label: 'Local' },
          ] as { value: LocationFilter; label: string }[]).map((t) => (
            <button
              key={t.value}
              onClick={() => setLocation(t.value)}
              className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                location === t.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as StageKey | 'all')}
          className="h-9 rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-secondary focus:border-accent focus:outline-none"
        >
          <option value="all">All stages</option>
          {STAGE_META.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Filtered subtotal strip */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border-subtle bg-bg-elevated/50 px-3 py-2 text-xs text-text-tertiary">
        <span>Showing <span className="font-mono text-text-secondary">{visible.length}</span> products</span>
        <span>Units <span className="font-mono text-text-secondary">{visibleTotals.units}</span></span>
        <span>Cost <span className="font-mono text-text-secondary">{fmt(visibleTotals.cost)}</span></span>
        <span>Est. resale <span className="font-mono text-text-secondary">{fmt(visibleTotals.resale)}</span></span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
        <div className="grid grid-cols-[1fr_260px_70px_90px_110px_110px] gap-3 border-b border-border-default px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          <button onClick={() => { setSortKey('name'); setSortDesc(sortKey === 'name' ? !sortDesc : false); }} className="text-left hover:text-text-secondary">
            Product{sortKey === 'name' ? (sortDesc ? ' ↓' : ' ↑') : ''}
          </button>
          <div>Stage</div>
          <button onClick={() => { setSortKey('units'); setSortDesc(sortKey === 'units' ? !sortDesc : true); }} className="text-right hover:text-text-secondary">
            Units{sortKey === 'units' ? (sortDesc ? ' ↓' : ' ↑') : ''}
          </button>
          <div className="text-right">Unit Cost</div>
          <button onClick={() => { setSortKey('value'); setSortDesc(sortKey === 'value' ? !sortDesc : true); }} className="text-right hover:text-text-secondary">
            Value @ Cost{sortKey === 'value' ? (sortDesc ? ' ↓' : ' ↑') : ''}
          </button>
          <button onClick={() => { setSortKey('resale'); setSortDesc(sortKey === 'resale' ? !sortDesc : true); }} className="text-right hover:text-text-secondary">
            Est. Resale{sortKey === 'resale' ? (sortDesc ? ' ↓' : ' ↑') : ''}
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="py-16 text-center text-sm text-text-tertiary">Loading inventory…</div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
              <Package size={28} className="mb-2 opacity-50" />
              <div className="text-sm">Nothing matches this view.</div>
            </div>
          ) : (
            visible.map((it) => {
              const url = listingUrl(it);
              const badge = MARKETPLACE_BADGE[it.marketplace] || { tone: 'neutral' as const, label: it.marketplace.toUpperCase() };
              return (
                <div
                  key={it.key}
                  className="grid grid-cols-[1fr_260px_70px_90px_110px_110px] items-center gap-3 border-b border-border-subtle px-4 py-2.5 hover:bg-bg-elevated/50"
                >
                  {/* Product */}
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-border-subtle bg-bg-elevated">
                      {it.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.imageUrl} alt="" className="h-full w-full object-contain" />
                      ) : (
                        <ImageOff size={14} className="text-text-tertiary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusBadge tone={badge.tone} size="xs">{badge.label}</StatusBadge>
                        {url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="truncate text-sm text-text-primary hover:text-accent hover:underline" title={it.productName}>
                            {it.productName || it.sku}
                            <ExternalLink size={11} className="ml-1 inline opacity-60" />
                          </a>
                        ) : (
                          <span className="truncate text-sm text-text-primary" title={it.productName}>{it.productName || it.sku}</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-text-tertiary">
                        {it.sku}{it.asin && it.asin !== it.sku ? ` · ${it.asin}` : ''}
                      </div>
                    </div>
                  </div>

                  {/* Stage chips */}
                  <div className="flex flex-wrap gap-1">
                    {STAGE_META.filter((m) => it.stages[m.key] > 0).map((m) => (
                      <span key={m.key} className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${m.chip}`} title={m.label}>
                        {it.stages[m.key]} {m.short}
                      </span>
                    ))}
                  </div>

                  <div className="text-right font-mono text-sm text-text-primary">{it.totalQty}</div>
                  <div className="text-right font-mono text-sm text-text-secondary">
                    {it.cogsPerUnit > 0 ? fmt(it.cogsPerUnit) : <span className="text-warning">—</span>}
                  </div>
                  <div className="text-right font-mono text-sm font-semibold text-text-primary">{fmt(it.totalCostValue)}</div>
                  <div className="text-right font-mono text-sm text-text-secondary">
                    {it.estResaleValue > 0 ? fmt(it.estResaleValue) : '—'}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Known blind spots */}
      <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-bg-elevated/40 px-3 py-2.5 text-xs text-text-tertiary">
        <Info size={14} className="mt-0.5 shrink-0" />
        <div>
          <span className="text-text-secondary">Known gaps:</span> Walmart WFS shipments that are mid-receiving are invisible to the Walmart API
          (they appear once fully received). Local stock is estimated from purchase lots ({'≤'}20-unit lots with remaining quantity)
          and may include items already sold outside synced marketplaces. Est. resale uses your set list price or historical average
          sale price — items never sold show &quot;—&quot;.
        </div>
      </div>
    </div>
  );
}
