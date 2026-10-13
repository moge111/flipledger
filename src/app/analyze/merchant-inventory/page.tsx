'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { Search, Printer, X, RefreshCw, Download, Send, Loader2, Package } from 'lucide-react';
import { DEFAULT_MFN_SHIPPING_TEMPLATE, PrintModal } from '@/components/merchant-inventory/PrintModal';
import { ReceiveModal } from '@/components/merchant-inventory/ReceiveModal';
import { IdentifierChip, LiveStateBadge, ReceiveStatusBadge } from '@/components/merchant-inventory/badges';
import { getReceiveStatus, realFnsku, sellerCentralSkuUrl } from '@/components/merchant-inventory/helpers';
import { FilterView, MerchantRow } from '@/components/merchant-inventory/types';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function exportActivationCsv(rows: MerchantRow[]) {
  const readyRows = rows.filter(r => getReceiveStatus(r) === 'ready');
  if (readyRows.length === 0) {
    alert('No Ready rows to export.\n\nItems must be received, inspected, binned, and priced before export.');
    return;
  }

  const warnings: string[] = [];

  if (!DEFAULT_MFN_SHIPPING_TEMPLATE) {
    warnings.push('DEFAULT_MFN_SHIPPING_TEMPLATE is blank — merchant-shipping-group-name column will be empty. Verify the shipping template name in Seller Central before uploading.');
  }

  const csvLines: string[] = [
    // Column names match Amazon Inventory Loader flat file format exactly.
    // merchant-shipping-group-name sets the MFN shipping template per row.
    // handling-time is left blank to use the account-level default.
    ['sku', 'price', 'quantity', 'condition', 'handling-time', 'merchant-shipping-group-name'].join(','),
  ];

  for (const row of readyRows) {
    if (!row.sku) {
      warnings.push(`Row ${row.row_key}: no MSKU — skipped`);
      continue;
    }

    // Use the price the user explicitly set during receiving first
    const priceCents = row.il_list_price_cents ?? row.amazon_list_price_cents ?? row.parsed_list_price_cents;
    const priceStr   = priceCents != null ? (priceCents / 100).toFixed(2) : '';
    if (!priceStr) warnings.push(`${row.sku}: no list price set — price column will be blank`);

    // Prefer count from physical receive over ledger remaining
    const qty = (row.quantity_received ?? 0) > 0
      ? row.quantity_received!
      : (row.quantity_remaining ?? 0);
    if (qty <= 0) {
      warnings.push(`${row.sku}: quantity is 0 or missing — skipped`);
      continue;
    }

    const condition      = (row.condition || '').replace(/"/g, '""');
    const sku            = row.sku.replace(/"/g, '""');
    const shippingGroup  = DEFAULT_MFN_SHIPPING_TEMPLATE.replace(/"/g, '""');

    csvLines.push([
      `"${sku}"`,
      priceStr,
      String(qty),
      `"${condition}"`,
      '',               // handling-time: blank = use account default
      `"${shippingGroup}"`,
    ].join(','));
  }

  if (warnings.length > 0) {
    alert(`Export warnings:\n\n${warnings.join('\n')}\n\nCSV will still download for rows without errors.`);
  }
  if (csvLines.length <= 1) {
    alert('No valid rows to export after validation.');
    return;
  }

  const csv  = csvLines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `flipledger-activation-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export default function MerchantInventoryPage() {
  const [listedRows, setListedRows]     = useState<MerchantRow[]>([]);
  const [localOnlyRows, setLocalOnlyRows] = useState<MerchantRow[]>([]);
  const [lastSynced, setLastSynced]     = useState<string | null>(null);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState(false);
  const [syncError, setSyncError]       = useState<string | null>(null);
  const [search, setSearch]             = useState('');
  const [filterView, setFilterView]     = useState<FilterView>('live');
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [receiveRow, setReceiveRow]         = useState<MerchantRow | null>(null);
  const [receiveModalTitle, setReceiveModalTitle] = useState('Update Stock');
  const [refreshKey, setRefreshKey]         = useState(0);
  const [lightbox, setLightbox]             = useState<{ src: string; title: string; asin: string | null; sku: string | null } | null>(null);
  const [backfilling, setBackfilling]       = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; remaining: number } | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  async function handleBackfillImages() {
    setBackfilling(true);
    setBackfillProgress(null);
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch('/api/data/merchant-inventory/backfill-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 100 }),
        });
        const data = await res.json();
        if (!res.ok) break;
        done += data.updated ?? 0;
        setBackfillProgress({ done, remaining: data.remaining ?? 0 });
        if ((data.remaining ?? 0) <= 0 || (data.processed ?? 0) === 0) break;
      }
      setRefreshKey(k => k + 1);
    } catch {
      /* network error — stop the loop */
    } finally {
      setBackfilling(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetch('/api/data/merchant-inventory')
      .then(r => r.json())
      .then(d => {
        setListedRows(d.listed || []);
        setLocalOnlyRows(d.localOnly || []);
        setLastSynced(d.lastSynced ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [refreshKey]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch('/api/sync/merchant-listings', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setSyncError(data.error || 'Sync failed');
      } else {
        setRefreshKey(k => k + 1);
      }
    } catch {
      setSyncError('Network error');
    } finally {
      setSyncing(false);
    }
  }

  // Counts (always from full datasets, unaffected by filter/search)
  const liveCount      = useMemo(() => listedRows.filter(r => r.live_state === 'active').length,   [listedRows]);
  const oosCount       = useMemo(() => listedRows.filter(r => r.live_state === 'oos').length,      [listedRows]);
  const inactiveCount  = useMemo(() => listedRows.filter(r => r.live_state === 'inactive').length, [listedRows]);
  const localOnlyCount = localOnlyRows.length;
  const readyCount     = useMemo(() =>
    [...listedRows, ...localOnlyRows].filter(r => getReceiveStatus(r) === 'ready').length,
  [listedRows, localOnlyRows]);

  // Display rows based on active filter.
  // null = All Amazon listings (the broadest view).
  // Default on page load is 'live' so the working view is immediately useful.
  const baseRows = useMemo((): MerchantRow[] => {
    switch (filterView) {
      case 'live':      return listedRows.filter(r => r.live_state === 'active');
      case 'oos':       return listedRows.filter(r => r.live_state === 'oos');
      case 'inactive':  return listedRows.filter(r => r.live_state === 'inactive');
      case 'local_only':return localOnlyRows;
      case 'ready':     return [...listedRows, ...localOnlyRows].filter(r => getReceiveStatus(r) === 'ready');
      default:          return listedRows; // null = All Amazon listings
    }
  }, [listedRows, localOnlyRows, filterView]);

  const displayRows = useMemo(() => {
    if (!search.trim()) return baseRows;
    const q = search.toLowerCase();
    return baseRows.filter(r =>
      (r.product_name || '').toLowerCase().includes(q) ||
      r.asin.toLowerCase().includes(q) ||
      r.sku.toLowerCase().includes(q) ||
      (r.bin_location || '').toLowerCase().includes(q)
    );
  }, [baseRows, search]);

  function setFilter(v: FilterView) {
    setFilterView(prev => prev === v ? null : v);
    setSelected(new Set());
  }

  function toggleRow(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === displayRows.length) setSelected(new Set());
    else setSelected(new Set(displayRows.map(r => r.row_key)));
  }

  const selectedRows = displayRows.filter(r => selected.has(r.row_key));

  // Rows available for activation export: selection-scoped when rows are selected,
  // otherwise all displayed rows when the Ready filter is active.
  const readyForExport = useMemo(() => {
    if (selected.size > 0) return selectedRows.filter(r => getReceiveStatus(r) === 'ready');
    if (filterView === 'ready') return displayRows;
    return [];
  }, [selected, selectedRows, filterView, displayRows]);

  // Stock action — determines the Action column button for each row.
  // Rules:
  //   no il_id        → null (no local lot, can't edit)
  //   active (live)   → Edit Stock (neutral)
  //   oos             → Restock (amber — highest priority workflow)
  //   inactive        → Review (neutral, low priority)
  //   not_listed      → Receive / Inspect / Edit based on receive status
  function getStockAction(row: MerchantRow): {
    label: string;
    cls: string;
    modalTitle: string;
  } | null {
    if (row.il_id == null) return null;

    if (row.live_state === 'active') {
      // Live rows: only prompt action if local receive work is still needed
      const status = getReceiveStatus(row);
      if (!status) return null;
      return {
        label: status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          status === 'pending'
            ? 'text-text-primary border-border-strong hover:bg-bg-hover'
            : status === 'received'
              ? 'text-warning border-warning/40 hover:bg-warning-muted'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Update Stock',
      };
    }
    if (row.live_state === 'oos') {
      const status = getReceiveStatus(row);
      return {
        label: !status || status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          !status || status === 'pending'
            ? 'text-warning border-warning/40 hover:bg-warning-muted'
            : status === 'received'
              ? 'text-warning border-warning/40 hover:bg-warning-muted'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Restock Item',
      };
    }
    if (row.live_state === 'inactive') {
      const status = getReceiveStatus(row);
      return {
        label: !status || status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
        cls:
          !status || status === 'pending'
            ? 'text-text-primary border-border-strong hover:bg-bg-hover'
            : status === 'received'
              ? 'text-warning border-warning/40 hover:bg-warning-muted'
              : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
        modalTitle: 'Update Stock',
      };
    }
    // not_listed (local_only)
    const status = getReceiveStatus(row);
    if (!status) return null;
    return {
      label: status === 'pending' ? 'Receive' : status === 'received' ? 'Inspect' : 'Edit Local',
      cls:
        status === 'pending'
          ? 'text-text-primary border-border-strong hover:bg-bg-hover'
          : status === 'received'
            ? 'text-warning border-warning/40 hover:bg-warning-muted'
            : 'text-text-tertiary border-border-subtle hover:bg-bg-hover',
      modalTitle: 'Receive Inventory',
    };
  }

  const hasData = !loading && (listedRows.length > 0 || localOnlyRows.length > 0);

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="page-title">Merchant Inventory</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Read-only visibility · Amazon MFN listings (LV_ SKUs) enriched with local lot data · receive and push happen in <Link href="/list" className="text-link hover:underline">Batches</Link>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Sync */}
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 h-9 px-3 rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-semibold bg-bg-surface border-[1.5px] border-border-strong"
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync Amazon'}
            </button>
            {syncError && (
              <p className="text-[10px] text-negative max-w-[180px] text-right">{syncError}</p>
            )}
            {lastSynced && !syncError && (() => {
              const ageMs = Date.now() - new Date(lastSynced).getTime();
              const stale = ageMs > 2 * 3600 * 1000;
              return (
                <p className={`text-[10px] ${stale ? 'text-warning' : 'text-text-tertiary'}`}>
                  {stale && '⚠ Stale — '}Synced {new Date(lastSynced).toLocaleDateString()} {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              );
            })()}
            {!lastSynced && !syncError && (
              <p className="text-[10px] text-text-tertiary">Not yet synced</p>
            )}
          </div>
          {readyForExport.length > 0 && (
            <a
              href="/mfn/batch"
              className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-link/50 text-link text-sm font-medium hover:bg-link/10 transition-colors"
              title="Preview & push moved to MFN Batch Receive"
            >
              <Send size={14} />
              Preview &amp; Push moved to MFN Batch Receive →
            </a>
          )}
          {readyForExport.length > 0 && (
            <button
              onClick={() => exportActivationCsv(readyForExport)}
              className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-positive/50 text-positive text-sm font-medium hover:bg-positive/10 transition-colors"
            >
              <Download size={14} />
              Export Activation CSV ({readyForExport.length})
            </button>
          )}
          {selected.size > 0 && (
            <button
              onClick={() => setShowPrintModal(true)}
              className="flex items-center gap-1.5 h-9 px-3 rounded-md bg-accent text-text-inverse text-sm font-bold hover:bg-accent/90 transition-colors"
            >
              <Printer size={14} />
              Print Labels ({selected.size})
            </button>
          )}
          <button
            onClick={handleBackfillImages}
            disabled={backfilling}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60 font-semibold bg-bg-surface border-[1.5px] border-border-strong"
            title="Fetch missing product images from Amazon's catalog"
          >
            {backfilling ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {backfilling
              ? `Fetching images… ${backfillProgress ? `${backfillProgress.done} done, ${backfillProgress.remaining} left` : ''}`
              : 'Backfill Images'}
          </button>
          <button
            onClick={() => { setSelected(new Set()); setShowPrintModal(true); }}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors font-semibold bg-bg-surface border-[1.5px] border-border-strong"
          >
            <Printer size={14} />
            Custom Label
          </button>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search title, ASIN, SKU, or bin…"
              className="h-9 pl-9 pr-4 w-64 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:border-link focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Filter / stat cards — clicking selects the filter; clicking again returns to Live */}
      {hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-6">
          {([
            { id: null         as FilterView, label: 'All Listings',      count: listedRows.length, numColor: 'text-text-primary'   },
            { id: 'live'       as FilterView, label: 'Live on Amazon',    count: liveCount,         numColor: 'text-positive'      },
            { id: 'oos'        as FilterView, label: 'OOS',               count: oosCount,          numColor: 'text-warning'      },
            { id: 'inactive'   as FilterView, label: 'Inactive',          count: inactiveCount,     numColor: 'text-negative'        },
            { id: 'local_only' as FilterView, label: 'Local Not Listed',  count: localOnlyCount,    numColor: 'text-text-secondary' },
            { id: 'ready'      as FilterView, label: 'Ready to Activate', count: readyCount,        numColor: 'text-positive'      },
          ] as const).map(card => {
            const isActive = filterView === card.id;
            return (
              <button
                key={String(card.id)}
                onClick={() => setFilter(card.id)}
                aria-pressed={isActive}
                className={`panel text-left px-3.5 py-3 transition-colors ${
                  isActive ? 'bg-accent' : 'hover:bg-bg-hover'
                }`}
              >
                <div className={`text-[10px] label-caps mb-1 truncate ${isActive ? 'text-text-inverse/70' : 'text-text-tertiary'}`}>{card.label}</div>
                <div className={`stat-num text-xl sm:text-2xl ${isActive ? 'text-text-inverse' : card.numColor}`}>
                  {lastSynced || card.id === 'local_only' || card.id === 'ready' || card.id === null ? card.count : '—'}
                </div>
                {isActive && (
                  <div className="text-[10px] text-text-inverse/70 mt-1">active</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* OOS restock banner */}
      {filterView === 'oos' && !loading && (
        <div className="mb-4 flex items-start gap-2.5 px-3.5 py-2.5 attn-banner text-xs text-text-secondary">
          <RefreshCw size={13} className="text-warning shrink-0 mt-0.5" />
          <span>
            <span className="font-medium text-text-primary">Out of Stock on Amazon</span>{' '}
            — these listings are Active but Amazon quantity is 0.
            Click <span className="font-medium text-warning">Restock</span> to enter received quantity, bin location, condition, and list price.
            Once all fields are set, the row moves to <span className="font-medium text-text-primary">Ready to Activate</span>.
          </span>
        </div>
      )}

      {/* Activation workflow banner — shown only in Ready filter */}
      {filterView === 'ready' && !loading && (
        <div className="mb-4 flex items-start gap-2.5 px-3.5 py-2.5 bg-bg-elevated border border-border-subtle rounded-lg text-xs text-text-secondary">
          <Download size={13} className="text-positive shrink-0 mt-0.5" />
          <span>
            <span className="font-medium text-text-primary">Ready to Activate</span>{' '}
            means received, inspected, binned, and priced locally —{' '}
            <span className="text-text-tertiary">Seller Central has not been updated yet.</span>{' '}
            Select rows and click{' '}
            <span className="font-medium text-positive">Export Activation CSV</span>{' '}
            to generate a file you upload to Seller Central. The CSV sets{' '}
            quantity, price, handling time, and shipping template per row.
            Verify the shipping template name matches your Seller Central account before uploading.
          </span>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="panel p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full mb-1" />
          ))}
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-surface">
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={displayRows.length > 0 && selected.size === displayRows.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < displayRows.length; }}
                    onChange={toggleAll}
                    className="accent-accent cursor-pointer"
                  />
                </th>
                <th className="px-3 py-2.5 w-20" />
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-24">Amazon</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-28">Receive</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-24">Bin</th>
                <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-28">Condition</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-16">Amz Qty</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-16">Local</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">List</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Cost</th>
                <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-text-tertiary text-sm">
                    {!lastSynced
                      ? 'No Amazon data yet — click Sync Amazon to pull live MFN listings.'
                      : filterView === 'live'
                        ? 'No live Amazon listings found.'
                        : filterView === 'oos'
                          ? 'No out-of-stock Amazon listings.'
                          : filterView === 'inactive'
                            ? 'No inactive listings found.'
                            : filterView === 'local_only'
                              ? 'All local lots have a matching Amazon listing.'
                              : filterView === 'ready'
                                ? 'No lots are ready to activate yet.'
                                : search
                                  ? 'No items match your search.'
                                  : 'No MFN listings found.'}
                  </td>
                </tr>
              ) : (
                displayRows.map(row => {
                  const isSelected = selected.has(row.row_key);
                  const stockAction = getStockAction(row);
                  const localReceiveStatus = row.il_id != null ? getReceiveStatus(row) : null;
                  // List price: Amazon source of truth first, then parsed from MSKU, then ledger value.
                  const listPrice = row.amazon_list_price_cents ?? row.parsed_list_price_cents ?? row.il_list_price_cents;
                  // Cost: ledger buy_price is authoritative; fall back to MSKU-parsed cost.
                  const displayCost = row.buy_price ?? row.parsed_cost_cents;

                  return (
                    <tr
                      key={row.row_key}
                      onClick={() => toggleRow(row.row_key)}
                      className={`border-b border-border-subtle/50 cursor-pointer transition-colors ${
                        isSelected ? 'bg-accent/5 hover:bg-bg-hover' : 'hover:bg-bg-hover'
                      }`}
                    >
                      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(row.row_key)}
                          className="accent-accent cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-3">
                        {row.image_url
                          ? <button
                              onClick={e => { e.stopPropagation(); setLightbox({ src: row.image_url!, title: row.product_name || row.asin, asin: row.asin, sku: row.sku }); }}
                              className="block cursor-zoom-in"
                              title="View larger image"
                            >
                              <img src={row.image_url} alt="" className="w-16 h-16 object-contain rounded-lg bg-white border border-border-subtle p-1 hover:border-accent transition-colors" />
                            </button>
                          : <div className="w-16 h-16 bg-bg-elevated rounded-lg border border-border-subtle flex items-center justify-center"><Package size={20} className="text-text-tertiary/40" /></div>}
                      </td>
                      <td className="px-4 py-3 max-w-[360px]">
                        <a
                          href={`https://www.amazon.com/dp/${row.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-sm text-link font-medium leading-snug line-clamp-2 hover:underline"
                          title={row.product_name || row.asin}
                        >
                          {row.product_name || row.asin}
                        </a>
                        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
                          <IdentifierChip label="ASIN" value={row.asin} />
                          <IdentifierChip label="MSKU" value={row.sku} href={sellerCentralSkuUrl(row.sku)} />
                          {realFnsku(row.fnsku) && <IdentifierChip label="FNSKU" value={realFnsku(row.fnsku)} />}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <LiveStateBadge state={row.live_state} />
                      </td>
                      <td className="px-4 py-2">
                        {localReceiveStatus != null
                          ? <ReceiveStatusBadge status={localReceiveStatus} />
                          : row.il_id == null
                            ? <span className="text-text-tertiary text-[10px] italic">No local lot</span>
                            : <span className="text-text-tertiary text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2">
                        {row.bin_location
                          ? <span className="inline-flex items-center px-2 py-0.5 rounded bg-accent/10 text-text-primary text-xs font-mono font-medium">{row.bin_location}</span>
                          : <span className="text-text-tertiary text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {row.condition || <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-sm tabular-nums">
                        {row.amazon_qty != null
                          ? <span className={row.amazon_qty === 0 ? 'text-warning' : 'text-text-primary font-medium'}>{row.amazon_qty}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-sm tabular-nums">
                        {row.quantity_remaining != null
                          ? <span className="text-text-secondary">{row.quantity_remaining}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-sm tabular-nums">
                        {listPrice != null
                          ? <span className="text-text-primary">{formatCurrency(listPrice)}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right text-sm tabular-nums">
                        {displayCost != null
                          ? <span className={`${row.buy_price == null ? 'text-text-tertiary/70' : 'text-text-secondary'}`} title={row.buy_price == null ? 'Estimated from MSKU' : undefined}>
                              {formatCurrency(displayCost)}
                            </span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right" onClick={e => e.stopPropagation()}>
                        {stockAction ? (
                          <button
                            onClick={() => {
                              setReceiveModalTitle(stockAction.modalTitle);
                              setReceiveRow(row);
                            }}
                            className={`h-7 px-3 rounded-md text-xs font-medium border transition-colors ${stockAction.cls}`}
                          >
                            {stockAction.label}
                          </button>
                        ) : row.il_id == null ? (
                          <span className="text-text-tertiary text-[10px]">No local lot</span>
                        ) : (
                          <span className="text-text-tertiary text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {displayRows.length > 0 && (
            <div className="px-4 py-2 border-t border-border-subtle bg-bg-elevated/40 text-xs text-text-tertiary flex gap-4 items-center">
              <span>{displayRows.length} {displayRows.length === 1 ? 'listing' : 'listings'}</span>
              {filterView && (
                <button
                  onClick={() => setFilter(filterView)}
                  className="text-link hover:underline"
                >
                  Clear filter
                </button>
              )}
              {selected.size > 0 && (
                <span className="ml-auto text-accent">{selected.size} selected</span>
              )}
            </div>
          )}
        </div>
      )}

      {showPrintModal && (
        <PrintModal
          selected={selectedRows}
          onClose={() => setShowPrintModal(false)}
        />
      )}

      {receiveRow && (
        <ReceiveModal
          row={receiveRow}
          title={receiveModalTitle}
          onClose={() => setReceiveRow(null)}
          onSaved={() => { setRefreshKey(k => k + 1); setReceiveRow(null); }}
        />
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative flex flex-col bg-white rounded-xl overflow-hidden shadow-2xl max-w-[92vw] max-h-[92vh]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 bg-bg-elevated border-b border-border-subtle px-5 py-3.5">
              <div className="min-w-0">
                <div className="text-text-primary text-base font-semibold leading-snug line-clamp-2">{lightbox.title}</div>
                <div className="mt-1 flex gap-4 text-[11px] font-mono text-text-tertiary">
                  {lightbox.asin && <span>ASIN {lightbox.asin}</span>}
                  {lightbox.sku && (
                    sellerCentralSkuUrl(lightbox.sku)
                      ? <a href={sellerCentralSkuUrl(lightbox.sku)!} target="_blank" rel="noopener noreferrer" className="text-link hover:underline" title={`Open MSKU in Seller Central: ${lightbox.sku}`}>MSKU {lightbox.sku}</a>
                      : <span>MSKU {lightbox.sku}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setLightbox(null)}
                className="ml-auto shrink-0 flex items-center justify-center w-9 h-9 rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
                title="Close (Esc)"
              >
                <X size={20} />
              </button>
            </div>
            <img
              src={lightbox.src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1')}
              alt={lightbox.title}
              className="h-[80vh] w-auto max-w-[92vw] object-contain bg-white"
            />
          </div>
        </div>
      )}

    </div>
  );
}
