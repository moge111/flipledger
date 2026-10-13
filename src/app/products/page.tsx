'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate } from '@/lib/formatters';
import { Save, X, AlertTriangle, Plus, Trash2, Layers } from 'lucide-react';

interface ProductRow {
  asin: string;
  name: string;
  category: string;
  sku: string;
  costPerUnit: number | null;
  purchaseQty: number;
  qtyRemaining: number;
  datePurchased: string | null;
  supplierName: string | null;
  supplierId: number | null;
  marketplace: string | null;
  hasLedger: number;          // 1 if in inventory_ledger, 0 if sold-only
  unitsSold: number;          // # sold with no ledger backing
  unitsZeroCogs: number;      // # of historical sales currently sitting at $0 COGS
  intentionalZeroCogs: number; // 1 = $0 COGS is deliberate (self-pulled / gift)
  autoCostNote: string | null; // set when the cost was copied from a same-named product (unconfirmed)
  lotId: number | null;        // the inventory_ledger lot this row shows (null = sold, no lot)
}

interface EditState {
  lotId: number | null;
  sku: string;
  asin: string;
  buyPrice: string;
  supplier: string;
  datePurchased: string;
  intentionalZeroCogs: boolean;
}

interface Lot {
  id: number;
  sku: string | null;
  asin: string | null;
  quantity: number;
  quantity_remaining: number;
  buy_price: number;
  date_purchased: string;
  supplier_name: string | null;
  units_consumed: number;
  notes: string | null;
}

interface LotSummary {
  lotCount: number;
  totalUnitsBought: number;
  totalUnitsRemaining: number;
  totalUnitsSold: number;
  totalCogsConsumedCents: number;
  avgCogsPerUnitSoldCents: number;
}

interface LotsViewState {
  sku: string;
  asin: string;
  productName: string;
  lots: Lot[];
  summary: LotSummary | null;
  loading: boolean;
}

interface NewLotForm {
  quantity: string;
  buyPrice: string;
  supplier: string;
  datePurchased: string;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  // Filters
  const [marketplaceFilter, setMarketplaceFilter] = useState<'all' | 'amazon' | 'walmart' | 'ebay'>('all');
  const [onlyMissingCogs, setOnlyMissingCogs] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/data/products');
    const data = await res.json();
    setProducts(data.products || []);
    setSuppliers(data.suppliers || []);
    setLoading(false);
  }, []);

  // Multi-lot view
  const [lotsView, setLotsView] = useState<LotsViewState | null>(null);
  const [newLot, setNewLot] = useState<NewLotForm>({ quantity: '', buyPrice: '', supplier: '', datePurchased: '' });
  const [savingLot, setSavingLot] = useState(false);

  const openLotsView = useCallback(async (sku: string, asin: string, productName: string) => {
    setLotsView({ sku, asin, productName, lots: [], summary: null, loading: true });
    setNewLot({ quantity: '', buyPrice: '', supplier: '', datePurchased: new Date().toISOString().slice(0, 10) });
    try {
      const r = await fetch(`/api/data/inventory-lots?sku=${encodeURIComponent(sku)}`);
      const d = await r.json();
      setLotsView({ sku, asin, productName, lots: d.lots || [], summary: d.summary || null, loading: false });
    } catch {
      setLotsView({ sku, asin, productName, lots: [], summary: null, loading: false });
    }
  }, []);

  const refreshLotsView = useCallback(async () => {
    if (!lotsView) return;
    const r = await fetch(`/api/data/inventory-lots?sku=${encodeURIComponent(lotsView.sku)}`);
    const d = await r.json();
    setLotsView({ ...lotsView, lots: d.lots || [], summary: d.summary || null });
  }, [lotsView]);

  const handleAddLot = useCallback(async () => {
    if (!lotsView) return;
    const qty = parseFloat(newLot.quantity);
    const price = parseFloat(newLot.buyPrice);
    if (!Number.isFinite(qty) || qty <= 0) return alert('Quantity must be a positive number');
    if (!Number.isFinite(price) || price < 0) return alert('Buy price must be a non-negative number');
    setSavingLot(true);
    try {
      const r = await fetch('/api/data/inventory-lots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: lotsView.sku,
          asin: lotsView.asin,
          quantity: qty,
          buyPrice: price,
          supplier: newLot.supplier || undefined,
          datePurchased: newLot.datePurchased ? new Date(newLot.datePurchased).toISOString() : undefined,
        }),
      });
      if (!r.ok) {
        const e = await r.json();
        alert(`Failed: ${e.error || 'unknown'}`);
        return;
      }
      setNewLot({ quantity: '', buyPrice: '', supplier: '', datePurchased: new Date().toISOString().slice(0, 10) });
      await refreshLotsView();
      fetchData();
    } finally {
      setSavingLot(false);
    }
  }, [lotsView, newLot, refreshLotsView, fetchData]);

  const handleDeleteLot = useCallback(async (lotId: number) => {
    if (!confirm('Delete this lot? FIFO will be recomputed and COGS may shift on past sales.')) return;
    await fetch(`/api/data/inventory-lots?id=${lotId}`, { method: 'DELETE' });
    await refreshLotsView();
    fetchData();
  }, [refreshLotsView, fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─── Filtered rows + missing-COGS counts ──────────────────────────────
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (marketplaceFilter !== 'all' && (p.marketplace || 'amazon') !== marketplaceFilter) return false;
      if (onlyMissingCogs) {
        // Three flavors of "missing COGS":
        //   1. No inventory_ledger row (hasLedger=0)
        //   2. Ledger row but buy_price=0
        //   3. Ledger row with buy_price set, BUT lot is depleted and sales
        //      are stuck at $0 COGS — same effect as truly missing.
        // EXCEPT: intentionalZeroCogs=1 means the user marked this SKU as
        // self-pulled / gift / no cost basis. $0 is correct, not missing.
        const intentional = (p.intentionalZeroCogs ?? 0) === 1;
        const missing = !intentional && (p.hasLedger === 0 || !p.costPerUnit || p.costPerUnit === 0 || (p.unitsZeroCogs ?? 0) > 0);
        if (!missing) return false;
      }
      return true;
    });
  }, [products, marketplaceFilter, onlyMissingCogs]);

  const missingCogsCounts = useMemo(() => {
    const counts: Record<string, number> = { amazon: 0, walmart: 0, ebay: 0, all: 0 };
    for (const p of products) {
      // Use the SAME predicate as the row badge + the filter so the banner
      // count never disagrees with what's actually flagged. Self-pulled /
      // intentional-$0 SKUs are NOT missing (the badge already excludes them);
      // depleted lots (unitsZeroCogs > 0) ARE.
      const intentional = (p.intentionalZeroCogs ?? 0) === 1;
      const missing = !intentional && (p.hasLedger === 0 || !p.costPerUnit || p.costPerUnit === 0 || (p.unitsZeroCogs ?? 0) > 0);
      if (!missing) continue;
      const mkt = p.marketplace || 'amazon';
      counts[mkt] = (counts[mkt] || 0) + 1;
      counts.all += 1;
    }
    return counts;
  }, [products]);

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    const res = await fetch('/api/data/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lotId: editing.lotId,
        sku: editing.sku,
        asin: editing.asin,
        buyPrice: parseFloat(editing.buyPrice) || 0,
        supplier: editing.supplier,
        datePurchased: editing.datePurchased || null,
        intentionalZeroCogs: editing.intentionalZeroCogs,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.alert(`Cost not saved: ${err.error || `HTTP ${res.status}`}`);
      setSaving(false);
      return;
    }
    setEditing(null);
    setSaving(false);
    fetchData();
  }

  const columns = useMemo<ColumnDef<ProductRow, any>[]>(() => [
    {
      id: 'product', header: 'Product', accessorFn: (row) => row.name || row.asin,
      cell: ({ row }) => {
        const p = row.original;
        // Three flavors of "missing COGS":
        //   1. No inventory_ledger row (hasLedger=0)
        //   2. Ledger row but buy_price=0
        //   3. Ledger row with buy_price set, BUT lot is depleted and sales
        //      are stuck at $0 COGS — same effect as truly missing.
        // EXCEPT: intentionalZeroCogs=1 means the user marked this SKU as
        // self-pulled / gift / no cost basis. $0 is correct, not missing.
        const intentional = (p.intentionalZeroCogs ?? 0) === 1;
        const missing = !intentional && (p.hasLedger === 0 || !p.costPerUnit || p.costPerUnit === 0 || (p.unitsZeroCogs ?? 0) > 0);
        return (
          <div className="min-w-[250px]">
            <div className="flex items-center gap-2">
              <div className="text-sm text-text-primary">{p.name || p.asin}</div>
              {missing && (
                <span
                  className="tag tag-attn text-[9px]"
                  title={
                    p.hasLedger === 0
                      ? `${p.unitsSold} unit${p.unitsSold === 1 ? '' : 's'} sold with no COGS — no inventory entry exists`
                      : (p.unitsZeroCogs ?? 0) > 0
                      ? `Lot depleted — ${p.unitsZeroCogs} sale${p.unitsZeroCogs === 1 ? '' : 's'} stuck at $0 COGS. Edit to bump quantity or add a new lot.`
                      : 'COGS not entered'
                  }
                >
                  {(p.unitsZeroCogs ?? 0) > 0 && p.hasLedger === 1 ? 'DEPLETED LOT' : 'MISSING COGS'}
                </span>
              )}
              {p.autoCostNote && (
                <span
                  className="tag text-[9px] text-accent"
                  title={p.autoCostNote.replace('[auto-cost] ', '')}
                >
                  COST COPIED
                </span>
              )}
              {intentional && (
                <span
                  className="tag text-[9px] text-link"
                  title="Marked as self-pulled / no-cost-basis. $0 COGS is intentional — full sale price counts as profit."
                >
                  SELF-PULLED
                </span>
              )}
            </div>
            <div className="text-xs text-text-tertiary font-mono">{p.asin}</div>
          </div>
        );
      }, size: 350,
    },
    {
      id: 'sku', header: 'SKU', accessorKey: 'sku',
      cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{getValue() as string || '—'}</span>,
      size: 130,
    },
    {
      id: 'marketplace', header: 'Mkt', accessorKey: 'marketplace',
      cell: ({ getValue }) => {
        const m = (getValue() as string) || 'amazon';
        const label = m === 'amazon' ? 'AMZ' : m === 'walmart' ? 'WMT' : m === 'ebay' ? 'EBAY' : m.toUpperCase();
        const color = m === 'amazon' ? 'mkt mkt-amazon'
          : m === 'walmart' ? 'mkt mkt-walmart'
          : m === 'ebay' ? 'mkt mkt-ebay'
          : 'mkt';
        return <span className={color}>{label}</span>;
      },
      size: 60,
    },
    {
      id: 'category', header: 'Category', accessorKey: 'category',
      cell: ({ getValue }) => <span className="text-sm text-text-secondary">{getValue() as string || '—'}</span>,
      size: 150,
    },
    {
      id: 'supplier', header: 'Supplier', accessorKey: 'supplierName',
      cell: ({ getValue }) => <span className="text-sm text-text-primary">{getValue() as string || '—'}</span>,
      size: 120,
    },
    {
      id: 'costPerUnit', header: 'Cost/Unit', accessorKey: 'costPerUnit',
      cell: ({ row }) => {
        const cost = row.original.costPerUnit;
        return cost !== null && cost > 0
          ? <span className="text-text-primary tabular-nums">{formatCurrency(Math.round(cost * 100))}</span>
          : <span className="text-text-tertiary text-sm italic">Not set</span>;
      },
      size: 100,
    },
    {
      id: 'datePurchased', header: 'Purchase Date', accessorKey: 'datePurchased',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return v ? <span className="text-sm text-text-secondary tabular-nums">{formatDate(v)}</span> : <span className="text-text-tertiary">—</span>;
      },
      size: 120,
    },
    {
      id: 'actions', header: '', enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEditing({
              lotId: row.original.lotId ?? null,
              sku: row.original.sku || '',
              asin: row.original.asin,
              buyPrice: row.original.costPerUnit?.toString() || '',
              supplier: row.original.supplierName || '',
              datePurchased: row.original.datePurchased?.split('T')[0] || '',
              intentionalZeroCogs: (row.original.intentionalZeroCogs ?? 0) === 1,
            })}
            className="text-xs text-accent hover:text-text-primary transition-colors"
          >
            Edit
          </button>
          {row.original.sku && (
            <button
              onClick={() => openLotsView(row.original.sku, row.original.asin, row.original.name || row.original.asin)}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1"
              title="View / add purchase lots"
            >
              <Layers size={12} /> Lots
            </button>
          )}
        </div>
      ),
      size: 110,
    },
  ], [openLotsView]);

  if (loading) return (
    <div>
      <div className="mb-6"><div className="skeleton h-6 w-32 mb-2" /><div className="skeleton h-4 w-48" /></div>
      <div className="panel p-4">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-10 w-full mb-1" />)}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="page-title">Products & COGS</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Manage buy prices, suppliers, and product costs</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Marketplace filter */}
          <div className="seg" role="group" aria-label="Marketplace">
            {(['all', 'amazon', 'walmart', 'ebay'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMarketplaceFilter(m)}
                aria-current={marketplaceFilter === m ? 'true' : undefined}
              >
                {m === 'all' ? 'All' : m === 'amazon' ? 'AMZ' : m === 'walmart' ? 'WMT' : 'eBay'}
              </button>
            ))}
          </div>
          {/* Missing-COGS toggle */}
          <button
            onClick={() => setOnlyMissingCogs(!onlyMissingCogs)}
            aria-pressed={onlyMissingCogs}
            className={`flex items-center gap-2 h-9 px-3 rounded-md border-[1.5px] transition-colors text-sm font-semibold ${
              onlyMissingCogs
                ? 'bg-accent text-text-inverse border-accent'
                : 'bg-bg-surface text-text-primary border-border-strong hover:bg-bg-hover'
            }`}
          >
            <AlertTriangle size={14} />
            Missing COGS only
          </button>
        </div>
      </div>

      {/* Missing-COGS banner — only visible when there's exposure */}
      {missingCogsCounts.all > 0 && !onlyMissingCogs && (
        <div className="mb-4 flex items-center justify-between attn-banner p-3">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle size={16} className="text-warning shrink-0" />
            <span className="text-text-primary">
              <b className="text-warning">{missingCogsCounts.all}</b> product{missingCogsCounts.all === 1 ? '' : 's'} missing COGS
            </span>
            <span className="text-text-tertiary text-xs">
              ({missingCogsCounts.amazon || 0} Amazon · {missingCogsCounts.walmart || 0} Walmart · {missingCogsCounts.ebay || 0} eBay)
            </span>
          </div>
          <button
            onClick={() => setOnlyMissingCogs(true)}
            className="h-7 px-2.5 rounded-md bg-highlight-fg text-text-inverse text-xs font-bold hover:opacity-90"
          >
            Show them →
          </button>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditing(null)}>
          <div className="bg-bg-elevated border-[1.5px] border-border-strong rounded-lg p-6 w-full max-w-md shadow-lg" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-md font-medium text-text-primary">Edit COGS</h3>
              <button onClick={() => setEditing(null)} className="p-1 hover:bg-bg-hover rounded-md"><X size={16} className="text-text-tertiary" /></button>
            </div>
            <div className="text-xs text-text-tertiary font-mono mb-4">
              {editing.asin} {editing.sku && `/ ${editing.sku}`}
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs label-caps text-text-tertiary mb-1">Buy Price ($)</label>
                <input
                  type="number" step="0.01" value={editing.buyPrice}
                  onChange={e => setEditing({ ...editing, buyPrice: e.target.value })}
                  disabled={editing.intentionalZeroCogs}
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  autoFocus
                />
              </div>
              <div className="bg-bg-elevated border border-border-subtle rounded-md p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editing.intentionalZeroCogs}
                    onChange={e => setEditing({ ...editing, intentionalZeroCogs: e.target.checked, buyPrice: e.target.checked ? '0' : editing.buyPrice })}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-text-primary">Self-pulled / no cost basis</div>
                    <div className="text-xs text-text-tertiary mt-0.5">
                      Mark this SKU as having $0 COGS on purpose (e.g. trading cards you pulled from packs, gifts, items inherited). Suppresses the &quot;missing COGS&quot; warning. Full sale price will count as profit.
                    </div>
                  </div>
                </label>
              </div>
              <div>
                <label className="block text-xs label-caps text-text-tertiary mb-1">Supplier</label>
                <input
                  type="text" value={editing.supplier} list="suppliers"
                  onChange={e => setEditing({ ...editing, supplier: e.target.value })}
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none"
                  placeholder="e.g. Walmart, Target, Best Buy"
                />
                <datalist id="suppliers">
                  {suppliers.map(s => <option key={s.id} value={s.name} />)}
                </datalist>
              </div>
              <div>
                <label className="block text-xs label-caps text-text-tertiary mb-1">Purchase Date</label>
                <input
                  type="date" value={editing.datePurchased}
                  onChange={e => setEditing({ ...editing, datePurchased: e.target.value })}
                  className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditing(null)} className="h-9 px-4 rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors font-semibold bg-bg-surface border-[1.5px] border-border-strong">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors disabled:opacity-50">
                <Save size={14} />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-lot view modal */}
      {lotsView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setLotsView(null)}>
          <div
            className="bg-bg-elevated border-[1.5px] border-border-strong rounded-lg w-full max-w-3xl shadow-lg max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-border-subtle shrink-0">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Layers size={16} className="text-text-secondary" />
                  <h3 className="text-md font-medium text-text-primary">Purchase Lots</h3>
                </div>
                <div className="text-sm text-text-secondary truncate max-w-md">{lotsView.productName}</div>
                <div className="text-xs text-text-tertiary font-mono">
                  {lotsView.asin}{lotsView.sku && lotsView.sku !== lotsView.asin && ` · ${lotsView.sku}`}
                </div>
              </div>
              <button onClick={() => setLotsView(null)} className="p-1 hover:bg-bg-hover rounded-md">
                <X size={16} className="text-text-tertiary" />
              </button>
            </div>

            {/* Summary */}
            {lotsView.summary && (
              <div className="grid grid-cols-4 gap-3 px-6 py-3 border-b border-border-subtle bg-bg-surface/40 shrink-0">
                <div>
                  <div className="text-[10px] label-caps text-text-tertiary">Lots</div>
                  <div className="text-sm text-text-primary mt-0.5 tabular-nums">{lotsView.summary.lotCount}</div>
                </div>
                <div>
                  <div className="text-[10px] label-caps text-text-tertiary">Bought</div>
                  <div className="text-sm text-text-primary mt-0.5 tabular-nums">{lotsView.summary.totalUnitsBought}</div>
                </div>
                <div>
                  <div className="text-[10px] label-caps text-text-tertiary">Sold</div>
                  <div className="text-sm text-text-primary mt-0.5 tabular-nums">{lotsView.summary.totalUnitsSold}</div>
                </div>
                <div>
                  <div className="text-[10px] label-caps text-text-tertiary">Avg COGS / unit sold</div>
                  <div className="text-sm text-positive mt-0.5 tabular-nums">
                    {lotsView.summary.avgCogsPerUnitSoldCents > 0 ? formatCurrency(lotsView.summary.avgCogsPerUnitSoldCents) : '—'}
                  </div>
                </div>
              </div>
            )}

            {/* Lot table (scrollable) */}
            <div className="flex-1 overflow-y-auto">
              {lotsView.loading ? (
                <div className="p-6 text-text-tertiary text-sm">Loading…</div>
              ) : lotsView.lots.length === 0 ? (
                <div className="p-6 text-text-tertiary text-sm">No lots yet — add the first one below.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-text-tertiary text-xs label-caps sticky top-0 bg-bg-elevated">
                    <tr>
                      <th className="text-left py-2 px-4">Date</th>
                      <th className="text-right py-2 px-3">Qty</th>
                      <th className="text-right py-2 px-3">Sold</th>
                      <th className="text-right py-2 px-3">Remaining</th>
                      <th className="text-right py-2 px-3">Cost / unit</th>
                      <th className="text-left py-2 px-3">Supplier</th>
                      <th className="text-right py-2 px-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lotsView.lots.map((lot) => (
                      <tr key={lot.id} className="border-b border-border-subtle/60 hover:bg-bg-hover">
                        <td className="py-2 px-4 text-text-secondary whitespace-nowrap text-xs tabular-nums">{formatDate(lot.date_purchased)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{lot.quantity}</td>
                        <td className="py-2 px-3 text-right text-text-secondary tabular-nums">{lot.units_consumed}</td>
                        <td className={`py-2 px-3 text-right tabular-nums ${lot.quantity_remaining === 0 ? 'text-text-tertiary' : 'text-text-primary'}`}>{lot.quantity_remaining}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(lot.buy_price)}</td>
                        <td className="py-2 px-3 text-text-secondary truncate max-w-[10rem]">{lot.supplier_name || '—'}</td>
                        <td className="py-2 px-4 text-right">
                          <button
                            onClick={() => handleDeleteLot(lot.id)}
                            className="text-text-tertiary hover:text-negative transition-colors"
                            title="Delete lot"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Add new lot form */}
            <div className="px-6 py-4 border-t border-border-subtle bg-bg-surface/40 shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <Plus size={14} className="text-accent" />
                <h4 className="text-xs label-caps text-text-secondary">Add new buy lot</h4>
              </div>
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-3">
                  <label className="block text-[10px] label-caps text-text-tertiary mb-1">Date</label>
                  <input
                    type="date" value={newLot.datePurchased}
                    onChange={e => setNewLot({ ...newLot, datePurchased: e.target.value })}
                    className="w-full h-9 px-2 bg-bg-input border border-border-default rounded-md text-sm focus:border-link focus:outline-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] label-caps text-text-tertiary mb-1">Qty</label>
                  <input
                    type="number" min="1" step="1" value={newLot.quantity}
                    onChange={e => setNewLot({ ...newLot, quantity: e.target.value })}
                    placeholder="e.g. 10"
                    className="w-full h-9 px-2 bg-bg-input border border-border-default rounded-md text-sm focus:border-link focus:outline-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] label-caps text-text-tertiary mb-1">Cost ($)</label>
                  <input
                    type="number" step="0.01" min="0" value={newLot.buyPrice}
                    onChange={e => setNewLot({ ...newLot, buyPrice: e.target.value })}
                    placeholder="e.g. 12.50"
                    className="w-full h-9 px-2 bg-bg-input border border-border-default rounded-md text-sm focus:border-link focus:outline-none"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-[10px] label-caps text-text-tertiary mb-1">Supplier</label>
                  <input
                    type="text" value={newLot.supplier} list="suppliers"
                    onChange={e => setNewLot({ ...newLot, supplier: e.target.value })}
                    placeholder="optional"
                    className="w-full h-9 px-2 bg-bg-input border border-border-default rounded-md text-sm focus:border-link focus:outline-none"
                  />
                </div>
                <div className="col-span-2 flex items-end">
                  <button
                    onClick={handleAddLot}
                    disabled={savingLot}
                    className="w-full h-9 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    {savingLot ? 'Saving…' : 'Add lot'}
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-text-tertiary mt-2">
                FIFO is recomputed automatically. Older lots are consumed first; new lots fill in once older ones run out.
              </div>
            </div>
          </div>
        </div>
      )}

      <DataTable data={filteredProducts} columns={columns} searchPlaceholder="Search by product name, ASIN, SKU, or supplier..." />
    </div>
  );
}
