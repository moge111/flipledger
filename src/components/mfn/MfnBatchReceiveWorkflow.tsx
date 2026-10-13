'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { formatCurrency, formatRelativeTime } from '@/lib/formatters';
import { Search, ScanBarcode, X, AlertCircle, Loader2, Save, Printer, Send, Image as ImageIcon, Lock } from 'lucide-react';
import { PreviewModal, type ActivationPreviewRow } from '@/components/activation/PreviewModal';
import { BatchItemCard } from '@/components/mfn/receive/BatchItemCard';

import { ItemDetailDrawer } from '@/components/mfn/receive/ItemDetailDrawer';
import { SearchResultCard } from '@/components/mfn/receive/SearchResultCard';
import { calcProfit, chipsForBatchItem, getReceiveProgress, isBatchItem, resolveShippingTemplate } from '@/components/mfn/receive/helpers';
import { BatchItem, BatchSummary, FilterKey, LabelSpec, MfnBatchReceiveWorkflowProps, SearchResult, ShippingTemplate, WarnLabel } from '@/components/mfn/receive/types';
import {AsinLink, MskuLink } from '@/components/mfn/receive/widgets';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function storageShippingTemplate(value: string, templates: ShippingTemplate[] | null): string {
  if (!value) return '';
  return resolveShippingTemplate(value, templates)?.key ?? value;
}

// ---------------------------------------------------------------------------
// Label printing
// ---------------------------------------------------------------------------

function openLabelPrint(items: BatchItem[]): void {
  // One label per saved item by default. The print preview tab still has
  // browser-native controls to print multiple copies if the user needs more.
  const specs: LabelSpec[] = items.map(item => {
    const bin = item.draft_bin.trim() || item.bin_location || undefined;
    return {
      labelMode: 'asin',
      size: '2x1',
      asin: item.asin || undefined,
      title: item.product_name || undefined,
      condition: item.draft_condition.trim() || item.condition || undefined,
      bin,
      showBin: !!bin,
    };
  });
  if (specs.length === 0) return;
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(specs))));
  window.open(`/api/labels/print?d=${encodeURIComponent(encoded)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listingFreshness(results: SearchResult[]) {
  const latest = results.reduce<number | null>((max, result) => {
    if (!result.last_synced) return max;
    const time = new Date(result.last_synced).getTime();
    if (!Number.isFinite(time)) return max;
    return max == null || time > max ? time : max;
  }, null);

  if (latest == null) return null;

  const ageMs = Date.now() - latest;
  const syncedAt = new Date(latest);
  const stale = ageMs > 2 * 3600 * 1000;

  return {
    stale,
    label: `${stale ? 'Stale - ' : ''}Synced ${formatRelativeTime(syncedAt.toISOString())}`,
    title: `Merchant listing data last synced ${syncedAt.toLocaleString()}`,
  };
}

function makeBatchItem(r: SearchResult): BatchItem {
  const costCents = r.buy_price ?? r.parsed_cost_cents;
  const priceCents = r.il_list_price_cents ?? r.amazon_list_price_cents ?? r.parsed_list_price_cents;
  return {
    ...r,
    draft_qty:               String(r.quantity_received ?? r.quantity_remaining ?? 1),
    draft_bin:               r.bin_location ?? '',
    draft_condition:         r.condition ?? '',
    draft_list_price:        priceCents != null ? (priceCents / 100).toFixed(2) : '',
    draft_buy_price:         costCents   != null ? (costCents  / 100).toFixed(2) : '',
    draft_shipping_template: r.merchant_shipping_group_name ?? '',
    draft_shipping_est:      '8.00',
    save_state:              'idle',
    save_error:              null,
    slow_save:               false,
    create_lot_state:        'idle',
    create_lot_error:        null,
    slow_create_lot:         false,
    marking_inspected:       false,
    mark_inspect_error:      null,
  };
}

// ---------------------------------------------------------------------------
// Profit calculator (display only — no DB writes)
// ---------------------------------------------------------------------------

const WARN_LABELS: WarnLabel[] = ['Not inspected', 'Stale status', 'No price', 'Fee unknown'];

function isOverReceived(item: BatchItem): boolean {
  const p = getReceiveProgress(item);
  return p != null && p.isOver;
}

// Complete = saved row whose receive progress hit 100% and is not over.
// Can overlap with Ready to push — that's intentional.
function isComplete(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return false;
  const p = getReceiveProgress(item);
  return p != null && p.pct >= 100 && !p.isOver;
}

// Ready to push = saved + has a saved record + quantity_received > 0 +
// inspected_at + valid price. Stale local Amazon status does NOT
// disqualify. A 100%-received row is still Ready (overlaps with Complete).
function isReadyToPush(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return false;
  if (item.il_id == null) return false;
  const qty = item.quantity_received != null ? Number(item.quantity_received) : 0;
  if (qty <= 0) return false;
  if (!item.inspected_at) return false;
  const priceNum = parseFloat(item.draft_list_price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) return false;
  return true;
}

// Needs work = unsaved (needs a Save click before Print All / Preview &
// Push will include it), OR a hard blocker chip (missing price is the
// main blocker). Not inspected is amber/warn — it gates push eligibility
// but does not trigger needs-work. Missing condition is soft metadata.
function needsWork(item: BatchItem): boolean {
  if (item.save_state !== 'saved') return true;
  const chips = chipsForBatchItem(item);
  if (chips.some(c => c.tone === 'blocker')) return true;
  return false;
}

function summarizeBatch(items: BatchItem[]): BatchSummary {
  let totalQty = 0;
  let totalListCents = 0;
  let totalCostCents = 0;
  let totalShipCents = 0;
  let totalFeeCents = 0;
  let totalNetCents = 0;
  let feeIncomplete = false;
  let priceOrCostIncomplete = false;
  let saved = 0;
  const warnCounts: Record<WarnLabel, number> = {
    'Not inspected': 0, 'Stale status': 0,
    'No price': 0, 'Fee unknown': 0,
  };

  for (const item of items) {
    if (item.save_state === 'saved') saved++;

    const p = calcProfit(item);
    // Saved items: use the persisted quantity_received. Otherwise the draft qty.
    const qty = (item.quantity_received ?? parseInt(item.draft_qty, 10)) || 0;
    totalQty += Math.max(qty, 0);

    if (qty > 0) {
      // Track WHICH inputs are missing so the footnote can be specific.
      if (p.listCents == null || p.costCents == null || p.netCents == null) {
        priceOrCostIncomplete = true;
      } else if (!p.hasFee) {
        feeIncomplete = true;
      }

      if (p.listCents != null) totalListCents += p.listCents * qty;
      if (p.costCents != null) totalCostCents += p.costCents * qty;
      totalShipCents += p.shipCents * qty;
      if (p.feeCents != null) totalFeeCents += p.feeCents * qty;
      if (p.netCents != null) totalNetCents += p.netCents * qty;
    }

    for (const c of chipsForBatchItem(item)) {
      if ((WARN_LABELS as string[]).includes(c.label)) {
        warnCounts[c.label as WarnLabel]++;
      }
    }
  }

  const roiPct    = totalCostCents > 0 ? (totalNetCents / totalCostCents) * 100 : null;
  const marginPct = totalListCents > 0 ? (totalNetCents / totalListCents) * 100 : null;
  const profitIncomplete = feeIncomplete || priceOrCostIncomplete;

  return {
    total: items.length, saved, unsaved: items.length - saved,
    totalQty, totalListCents, totalCostCents, totalShipCents, totalFeeCents,
    totalNetCents, roiPct, marginPct,
    feeIncomplete, priceOrCostIncomplete, profitIncomplete,
    warnCounts,
  };
}

export default function MfnBatchReceiveWorkflow({ batchId = null, locked = false }: MfnBatchReceiveWorkflowProps = {}) {
  const searchInputRef     = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const multiMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [multiMatchNote, setMultiMatchNote] = useState(false);
  const [batch, setBatch]           = useState<Map<string, BatchItem>>(new Map());
  const [savingAll, setSavingAll]   = useState(false);
  const [focusQtySku, setFocusQtySku] = useState<string | null>(null);
  const [printAllMsg, setPrintAllMsg] = useState<string | null>(null);
  // Client-only receive-state filter for the visible batch list. Defaults
  // to 'all' so newly added items are never accidentally hidden.
  const [receiveFilter, setReceiveFilter] = useState<'all' | FilterKey>('all');
  const [lightbox, setLightbox] = useState<{ src: string; title: string; asin: string; sku: string } | null>(null);
  // Read-only details flyout. Keyed by sku + source so a re-render uses the
  // current state of the item from the right collection.
  const [detailDrawer, setDetailDrawer] = useState<{ sku: string; source: 'batch' | 'search' } | null>(null);
  const [previewOpen, setPreviewOpen]       = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRows, setPreviewRows]       = useState<ActivationPreviewRow[]>([]);
  const [previewTemplate, setPreviewTemplate] = useState('');
  const [previewError, setPreviewError]     = useState<string | null>(null);
  const [amazonTemplates, setAmazonTemplates] = useState<ShippingTemplate[] | null>(null);
  const [backfillingImages, setBackfillingImages] = useState(false);
  const [backfillProgress, setBackfillProgress]   = useState<{ done: number; remaining: number } | null>(null);

  // Fetch missing product images for this batch's ASINs from the catalog, then
  // merge the fresh image_url onto the items already in the tray.
  async function handleBackfillImages() {
    if (batchId == null || batchId <= 0) return;
    setBackfillingImages(true);
    setBackfillProgress(null);
    let done = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const res = await fetch('/api/data/mfn-batch-items/backfill-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId, limit: 100 }),
        });
        const data = await res.json();
        if (!res.ok) break;
        done += data.updated ?? 0;
        setBackfillProgress({ done, remaining: data.remaining ?? 0 });
        if ((data.remaining ?? 0) <= 0 || (data.processed ?? 0) === 0) break;
      }
      // Re-pull items and merge the new images onto existing tray rows.
      const refetch = await fetch(`/api/data/mfn-batch-items?batchId=${batchId}`);
      if (refetch.ok) {
        const d = await refetch.json();
        const rows: SearchResult[] = Array.isArray(d.items) ? d.items : [];
        const bySku = new Map(rows.map(r => [r.sku, r]));
        setBatch(prev => {
          const next = new Map(prev);
          for (const [sku, item] of next) {
            const fresh = bySku.get(sku);
            if (fresh?.image_url && fresh.image_url !== item.image_url) {
              next.set(sku, { ...item, image_url: fresh.image_url });
            }
          }
          return next;
        });
      }
    } catch {
      /* network error — stop the loop */
    } finally {
      setBackfillingImages(false);
    }
  }

  // Auto-focus search on mount
  useEffect(() => { searchInputRef.current?.focus(); }, []);

  // Fetch Amazon shipping templates once on mount (cached 24h server-side)
  useEffect(() => {
    fetch('/api/sync/shipping-templates')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => setAmazonTemplates(Array.isArray(d.templates) ? d.templates : []))
      .catch(() => setAmazonTemplates([]));
  }, []);

  // Hydration: when mounted inside a persisted batch (batchId set), pull saved
  // lots tagged with this batch_id and seed the tray as `saved` items. Without
  // this, refreshing /list/<mfn-batch-id> would show an empty tray even though
  // lots persist. Standalone /mfn/batch (batchId == null) skips this — its
  // tray is intentionally session-only.
  useEffect(() => {
    if (batchId == null || batchId <= 0) return;
    let cancelled = false;
    fetch(`/api/data/mfn-batch-items?batchId=${batchId}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => {
        if (cancelled) return;
        const rows: SearchResult[] = Array.isArray(d.items) ? d.items : [];
        if (rows.length === 0) return;
        setBatch(prev => {
          const next = new Map(prev);
          for (const r of rows) {
            if (next.has(r.sku)) continue; // never overwrite an in-flight draft
            const item = makeBatchItem(r);
            item.save_state = 'saved';
            next.set(r.sku, item);
          }
          return next;
        });
      })
      .catch(err => console.error('[mfn-batch] hydration failed', err));
    return () => { cancelled = true; };
  }, [batchId]);

  // Close search dropdown when clicking outside the search container
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Cleanup multi-match note timer on unmount
  useEffect(() => () => { if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current); }, []);

  // Esc closes the lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Esc closes the details drawer
  useEffect(() => {
    if (!detailDrawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailDrawer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailDrawer]);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/data/mfn-search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(query), 220);
    return () => clearTimeout(t);
  }, [query, doSearch]);

  function addToBatch(result: SearchResult, focusOnAdd = false) {
    setBatch(prev => {
      if (prev.has(result.sku)) return prev;
      const next = new Map(prev);
      next.set(result.sku, makeBatchItem(result));
      return next;
    });
    setReceiveFilter('all');
    if (focusOnAdd) setFocusQtySku(result.sku);
  }

  function updateBatchItem(sku: string, updates: Partial<BatchItem>) {
    setBatch(prev => {
      const item = prev.get(sku);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(sku, { ...item, ...updates });
      return next;
    });
  }

  function removeFromBatch(sku: string) {
    setBatch(prev => {
      const next = new Map(prev);
      next.delete(sku);
      return next;
    });
  }

  async function saveItem(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return;

    const t0 = Date.now();
    console.log(`[saveItem] start sku=${sku} il_id=${item.il_id}`);

    updateBatchItem(sku, { save_state: 'saving', save_error: null, slow_save: false });

    const slowTimer = setTimeout(() => {
      console.warn(`[saveItem] slow >3s sku=${sku}`);
      updateBatchItem(sku, { slow_save: true });
    }, 3000);

    const qtyNum    = parseInt(item.draft_qty, 10);
    const priceNum  = parseFloat(item.draft_list_price);

    const body: Record<string, unknown> = { id: item.il_id };
    if (Number.isFinite(qtyNum) && qtyNum >= 0)  body.quantityReceived = qtyNum;
    if (item.draft_bin.trim())                    body.binLocation      = item.draft_bin.trim();
    if (item.draft_condition.trim())              body.condition        = item.draft_condition.trim();
    if (Number.isFinite(priceNum) && priceNum > 0) body.listPriceCents  = Math.round(priceNum * 100);
    const templateStorage = storageShippingTemplate(item.draft_shipping_template.trim(), amazonTemplates);
    if (templateStorage)                           body.merchantShippingGroupName = templateStorage;
    if (Number.isFinite(qtyNum) && qtyNum > 0) { body.markReceived = true; body.markInspected = true; }

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        let errMsg = 'Save failed';
        try { errMsg = JSON.parse(bodyText).error || errMsg; } catch { /* keep default */ }
        console.error(`[saveItem] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${bodyText}`);
        updateBatchItem(sku, { save_state: 'error', save_error: `${errMsg} (HTTP ${res.status})` });
      } else {
        console.log(`[saveItem] ok sku=${sku} elapsed=${elapsed}ms`);
        // Mirror just-saved drafts back onto the local row so the
        // collapsed view and batch summary reflect the new values
        // without waiting for a refetch. Only mirror fields that were
        // actually sent (same conditionals as the PATCH body above).
        const mirror: Partial<BatchItem> = { save_state: 'saved', save_error: null };
        if (Number.isFinite(qtyNum) && qtyNum >= 0) {
          mirror.quantity_received = qtyNum;
          if (qtyNum > 0) {
            const now = new Date().toISOString();
            if (!item.received_at)  mirror.received_at  = now;
            if (!item.inspected_at) mirror.inspected_at = now;
          }
        }
        if (item.draft_bin.trim())       mirror.bin_location = item.draft_bin.trim();
        if (item.draft_condition.trim()) mirror.condition    = item.draft_condition.trim();
        if (Number.isFinite(priceNum) && priceNum > 0) {
          mirror.il_list_price_cents = Math.round(priceNum * 100);
        }
        if (templateStorage) {
          mirror.merchant_shipping_group_name = templateStorage;
          mirror.draft_shipping_template      = templateStorage;
        }
        updateBatchItem(sku, mirror);
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[saveItem] network sku=${sku} elapsed=${elapsed}ms err=${msg}`);
      updateBatchItem(sku, { save_state: 'error', save_error: `Network error: ${msg}` });
    } finally {
      clearTimeout(slowTimer);
      // Defense-in-depth: never leave the slow indicator on
      updateBatchItem(sku, { slow_save: false });
    }
  }

  async function createLot(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id != null) return;

    const t0 = Date.now();
    console.log(`[createLot] start sku=${sku} asin=${item.asin}`);

    updateBatchItem(sku, { create_lot_state: 'creating', create_lot_error: null, slow_create_lot: false });

    const slowTimer = setTimeout(() => {
      console.warn(`[createLot] slow >3s sku=${sku}`);
      updateBatchItem(sku, { slow_create_lot: true });
    }, 3000);

    const qtyNum      = parseInt(item.draft_qty, 10);
    const buyNum      = parseFloat(item.draft_buy_price);
    const priceNum    = parseFloat(item.draft_list_price);

    const body: Record<string, unknown> = {
      sku,
      asin:         item.asin || undefined,
      quantity:     Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1,
      buyCents:     Number.isFinite(buyNum) && buyNum >= 0 ? Math.round(buyNum * 100) : 0,
      markReceived:  true,
      markInspected: true,
    };
    if (Number.isFinite(priceNum) && priceNum > 0) body.listPriceCents = Math.round(priceNum * 100);
    if (item.draft_condition.trim())               body.condition      = item.draft_condition.trim();
    if (item.draft_bin.trim())                     body.binLocation    = item.draft_bin.trim();
    if (batchId != null && batchId > 0)            body.batchId        = batchId;
    const templateStorageLot = storageShippingTemplate(item.draft_shipping_template.trim(), amazonTemplates);
    if (templateStorageLot)                        body.merchantShippingGroupName = templateStorageLot;

    try {
      const res = await fetch('/api/data/inventory-lots/create-mfn-local-lot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elapsed = Date.now() - t0;
      const bodyText = await res.text().catch(() => '');
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(bodyText) as Record<string, unknown>; } catch { /* leave empty */ }

      if (!res.ok) {
        const errMsg = (d.error as string | undefined) || 'Create failed';
        console.error(`[createLot] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${bodyText}`);
        updateBatchItem(sku, {
          create_lot_state: 'error',
          create_lot_error: `${errMsg} (HTTP ${res.status})`,
        });
        return;
      }
      console.log(`[createLot] ok sku=${sku} elapsed=${elapsed}ms existingLotUsed=${d.existingLotUsed}`);
      const lot = d.lot as Record<string, unknown>;
      updateBatchItem(sku, {
        il_id:                        Number(lot.id),
        buy_price:                    lot.buy_price != null ? Number(lot.buy_price) : item.buy_price,
        il_list_price_cents:          lot.list_price_cents != null ? Number(lot.list_price_cents) : item.il_list_price_cents,
        bin_location:                 lot.bin_location != null ? String(lot.bin_location) : item.bin_location,
        condition:                    lot.condition != null ? String(lot.condition) : item.condition,
        quantity_received:            lot.quantity_received != null ? Number(lot.quantity_received) : item.quantity_received,
        quantity_remaining:           lot.quantity_remaining != null ? Number(lot.quantity_remaining) : item.quantity_remaining,
        received_at:                  lot.received_at != null ? String(lot.received_at) : item.received_at,
        inspected_at:                 lot.inspected_at != null ? String(lot.inspected_at) : item.inspected_at,
        merchant_shipping_group_name: lot.merchant_shipping_group_name != null ? String(lot.merchant_shipping_group_name) : item.merchant_shipping_group_name,
        create_lot_state:             'idle',
        create_lot_error:             null,
        save_state:                   'saved',
      });
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[createLot] network sku=${sku} elapsed=${elapsed}ms err=${msg}`);
      updateBatchItem(sku, { create_lot_state: 'error', create_lot_error: `Network error: ${msg}` });
    } finally {
      clearTimeout(slowTimer);
      // Defense-in-depth: never leave the slow indicator on
      updateBatchItem(sku, { slow_create_lot: false });
    }
  }

  async function saveAll() {
    const toSave = Array.from(batch.values()).filter(i => i.il_id != null && i.save_state !== 'saved');
    if (toSave.length === 0) return;
    setSavingAll(true);
    await Promise.all(toSave.map(i => saveItem(i.sku)));
    setSavingAll(false);
  }

  // Inline qty edit on saved rows — narrow PATCH that only updates
  // quantity_received (and received_at once if missing). Does NOT touch
  // save_state, so the row stays collapsed. Bin/condition/price/template
  // are not sent — the route's per-field `!== undefined` gate leaves
  // those columns alone. Returns { ok, error? } so InlineQtyEdit can
  // restore the previous value on failure.
  async function saveQtyOnly(sku: string, newQty: number): Promise<{ ok: boolean; error?: string }> {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return { ok: false, error: 'Save this item before preview/push' };

    const t0 = Date.now();
    console.log(`[saveQtyOnly] start sku=${sku} il_id=${item.il_id} qty=${newQty}`);

    const body: Record<string, unknown> = {
      id: item.il_id,
      quantityReceived: newQty,
      markReceived: newQty > 0,
    };

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errMsg = 'Save failed';
        try { errMsg = JSON.parse(text).error || errMsg; } catch { /* keep default */ }
        console.error(`[saveQtyOnly] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${text}`);
        return { ok: false, error: `${errMsg} (HTTP ${res.status})` };
      }
      console.log(`[saveQtyOnly] ok sku=${sku} elapsed=${elapsed}ms`);

      // Mirror the just-saved qty back onto the local row so the saved
      // row, summary, progress, and warning chips reflect the new value
      // immediately. Keep draft_qty in sync too so a later Edit opens
      // with the right number.
      const mirror: Partial<BatchItem> = {
        quantity_received: newQty,
        draft_qty: String(newQty),
      };
      if (newQty > 0 && !item.received_at) {
        mirror.received_at = new Date().toISOString();
      }
      updateBatchItem(sku, mirror);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[saveQtyOnly] network sku=${sku} err=${msg}`);
      return { ok: false, error: `Network error: ${msg}` };
    }
  }

  async function markInspected(sku: string) {
    const item = batch.get(sku);
    if (!item || item.il_id == null) return;

    updateBatchItem(sku, { marking_inspected: true, mark_inspect_error: null });

    const t0 = Date.now();
    console.log(`[markInspected] start sku=${sku} il_id=${item.il_id}`);

    try {
      const res = await fetch('/api/data/inventory-lots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.il_id, markReceived: true, markInspected: true }),
      });
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errMsg = 'Mark inspected failed';
        try { errMsg = JSON.parse(text).error || errMsg; } catch { /* keep default */ }
        console.error(`[markInspected] fail sku=${sku} status=${res.status} elapsed=${elapsed}ms body=${text}`);
        updateBatchItem(sku, { marking_inspected: false, mark_inspect_error: errMsg });
        return;
      }
      console.log(`[markInspected] ok sku=${sku} elapsed=${elapsed}ms`);

      const now = new Date().toISOString();
      const mirror: Partial<BatchItem> = {
        marking_inspected: false,
        mark_inspect_error: null,
        inspected_at: now,
      };
      if (!item.received_at) mirror.received_at = now;
      updateBatchItem(sku, mirror);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[markInspected] network sku=${sku} err=${msg}`);
      updateBatchItem(sku, { marking_inspected: false, mark_inspect_error: `Network error: ${msg}` });
    }
  }

  function printAll() {
    const all    = Array.from(batch.values());
    const saved  = all.filter(i => i.save_state === 'saved' && i.asin);
    const skipped = all.length - saved.length;
    if (saved.length === 0) return;
    openLabelPrint(saved);
    if (skipped > 0) {
      const msg = `Skipped ${skipped} unsaved item${skipped !== 1 ? 's' : ''}`;
      setPrintAllMsg(msg);
      setTimeout(() => setPrintAllMsg(null), 4000);
    }
  }

  async function previewAndPush() {
    const savedSkus = Array.from(batch.values())
      .filter(i => i.save_state === 'saved' && i.il_id != null)
      .map(i => i.sku);
    if (savedSkus.length === 0) return;

    setPreviewLoading(true);
    setPreviewError(null);
    const t0 = Date.now();
    console.log(`[previewAndPush] start skus=${savedSkus.length}`);
    try {
      const res = await fetch('/api/data/merchant-inventory/activation-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: savedSkus }),
      });
      const data = await res.json();
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        console.error(`[previewAndPush] fail status=${res.status} elapsed=${elapsed}ms`, data);
        setPreviewError((data as { error?: string }).error || `Preview failed (HTTP ${res.status})`);
        return;
      }
      console.log(`[previewAndPush] ok elapsed=${elapsed}ms rows=${(data.rows ?? []).length}`);
      setPreviewRows(data.rows || []);
      setPreviewTemplate(data.shippingTemplate || '');
      setPreviewOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[previewAndPush] network', msg);
      setPreviewError(`Network error: ${msg}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  const batchArray   = Array.from(batch.values());
  const savedCount   = batchArray.filter(i => i.save_state === 'saved').length;
  const summary      = summarizeBatch(batchArray);
  const saveable     = batchArray.filter(i => i.il_id != null && i.save_state !== 'saved');
  const hasUnsaved   = saveable.length > 0;

  // Receive-state counts — independent predicates, may overlap (e.g. a
  // clean 1/1 saved row is counted under both Complete and Ready to push).
  // Always from the full batch — counts don't change with the active filter.
  const stateCounts: Record<FilterKey, number> = {
    'needs-work': batchArray.filter(needsWork).length,
    ready:        batchArray.filter(isReadyToPush).length,
    complete:     batchArray.filter(isComplete).length,
    over:         batchArray.filter(isOverReceived).length,
  };

  // Apply the active filter only to the visible card list.
  const predicateFor: Record<FilterKey, (i: BatchItem) => boolean> = {
    'needs-work': needsWork,
    ready:        isReadyToPush,
    complete:     isComplete,
    over:         isOverReceived,
  };
  const visibleBatch = receiveFilter === 'all'
    ? batchArray
    : batchArray.filter(predicateFor[receiveFilter]);
  const searchFreshness = !searching && results.length > 0 ? listingFreshness(results) : null;

  return (
    <div className="flex flex-col h-full bg-bg-root">
      {/* Workbench header — title, actions, search (visually unified) */}
      <div className="flex items-center justify-between px-4 py-2 bg-bg-surface border border-border-subtle rounded-t-lg border-b border-border-subtle/60">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold text-text-primary shrink-0">MFN Receive</h1>
          {batchArray.length > 0 && (
            <span className="text-xs text-text-tertiary truncate">
              {batchArray.length} in batch
              {savedCount > 0 && <> · <span className="text-positive/90">{savedCount} saved</span></>}
              {summary.unsaved > 0 && <> · <span className="text-text-tertiary">{summary.unsaved} unsaved</span></>}
              {stateCounts['ready'] > 0 && <> · <span className="text-positive font-medium">Ready {stateCounts['ready']}</span></>}
            </span>
          )}
          {printAllMsg && <span className="text-[10px] text-text-tertiary/70 shrink-0">{printAllMsg}</span>}
        </div>
        {batchArray.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0 ml-4">
            {savedCount > 0 && (
              <button onClick={printAll} className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-text-primary hover:bg-bg-hover hover:text-text-primary transition-colors font-semibold bg-bg-surface border-[1.5px] border-border-strong">
                <Printer size={13} />Print All ({savedCount})
              </button>
            )}
            {!locked && savedCount > 0 && (
              <button onClick={previewAndPush} disabled={previewLoading} className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-link/50 text-link text-xs font-medium hover:bg-link/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {previewLoading ? 'Loading…' : `Preview & Push (${savedCount})`}
              </button>
            )}
            {!locked && hasUnsaved && (
              <button onClick={saveAll} disabled={savingAll} className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-text-inverse text-xs font-bold hover:bg-accent-hover transition-colors disabled:opacity-50">
                {savingAll ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {savingAll ? 'Saving…' : `Save All (${saveable.length})`}
              </button>
            )}
            {!locked && batchId != null && batchId > 0 && [...batch.values()].some(i => !i.image_url) && (
              <button onClick={handleBackfillImages} disabled={backfillingImages} className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs text-text-primary hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-50 font-semibold bg-bg-surface border-[1.5px] border-border-strong" title="Fetch missing product images from Amazon's catalog">
                {backfillingImages ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />}
                {backfillingImages
                  ? `Fetching… ${backfillProgress ? `${backfillProgress.done}/${backfillProgress.remaining + backfillProgress.done}` : ''}`
                  : 'Get Photos'}
              </button>
            )}
            {!locked && (
              <button onClick={() => { setBatch(new Map()); setReceiveFilter('all'); }} className="h-8 px-3 rounded-md text-xs text-text-primary hover:bg-bg-hover transition-colors font-semibold bg-bg-surface border-[1.5px] border-border-strong">
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {locked && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-3 bg-bg-surface border-x border-b border-border-subtle rounded-b-lg text-xs text-text-tertiary">
          <Lock size={13} className="text-text-tertiary shrink-0" />
          This batch is closed and in History — locked for auditing. Restore it from the header to make changes or re-push.
        </div>
      )}

      {/* Search — lower half of unified header block */}
      {!locked && (
      <div ref={searchContainerRef} className="relative bg-bg-surface border-x border-b border-border-subtle rounded-b-lg mb-3">
        <div className="relative px-3 py-2">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          {searching && (
            <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary animate-spin" />
          )}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={e => {
              setQuery(e.target.value);
              setSearchOpen(true);
              if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
              setMultiMatchNote(false);
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (results.length > 1) {
                if (multiMatchTimerRef.current) clearTimeout(multiMatchTimerRef.current);
                setMultiMatchNote(true);
                multiMatchTimerRef.current = setTimeout(() => setMultiMatchNote(false), 2000);
                return;
              }
              if (results.length !== 1) return;
              const sole = results[0];
              if (batch.has(sole.sku)) {
                // Clear any active filter so the row is visible before focus fires.
                setReceiveFilter('all');
                // Both expanded and saved/collapsed: setFocusQtySku drives focus.
                // Expanded cards use qtyRef; saved cards use InlineQtyEdit forceOpen.
                setFocusQtySku(sole.sku);
              } else {
                addToBatch(sole, true);
              }
              setQuery('');
              setResults([]);
            }}
            placeholder="Scan barcode, ASIN, MSKU, or title…"
            className="w-full h-11 pl-9 pr-9 bg-bg-surface border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:border-link focus:outline-none"
          />
        </div>

        {/* Dropdown — visible when query ≥ 2 chars */}
        {searchOpen && query.trim().length >= 2 && (
          <div className="panel absolute top-full left-0 right-0 z-50 mt-1 shadow-xl overflow-hidden">
            {/* Helper / status line */}
            <div className="px-3 py-1.5 border-b border-border-subtle">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-xs text-text-tertiary">
                  {searching
                    ? 'Searching…'
                    : results.length === 1
                      ? batch.has(results[0].sku)
                        ? 'Press Enter to focus this item in the batch.'
                        : 'Press Enter to add this item.'
                      : results.length > 1
                        ? 'Refine search or click the correct item.'
                        : `No results for "${query}"`}
                  {multiMatchNote && (
                    <span className="ml-2 text-warning">Multiple matches — choose an item.</span>
                  )}
                </p>
                {searchFreshness && (
                  <span
                    className={`shrink-0 text-[10px] ${searchFreshness.stale ? 'text-warning' : 'text-text-tertiary/70'}`}
                    title={searchFreshness.title}
                  >
                    {searchFreshness.label}
                  </span>
                )}
              </div>
            </div>
            {/* Results list */}
            {results.length > 0 && (
              <div className="overflow-y-auto max-h-80 p-1.5 space-y-1">
                {results.map(r => (
                  <SearchResultCard
                    key={r.sku}
                    result={r}
                    inBatch={batch.has(r.sku)}
                    onAdd={() => addToBatch(r)}
                    onImageClick={() => r.image_url && setLightbox({
                      src: r.image_url,
                      title: r.product_name || r.asin || r.sku,
                      asin: r.asin || '',
                      sku: r.sku,
                    })}
                    onShowDetail={() => setDetailDrawer({ sku: r.sku, source: batch.has(r.sku) ? 'batch' : 'search' })}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Filter strip + KPI — flat tab-strip below the header */}
      {batchArray.length > 0 && (
        <div className="flex items-start justify-between gap-4 px-3 py-1.5 mb-2 border-b border-border-subtle/60">
          {/* Filter pills — left */}
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            {([
              { key: 'all' as const,         label: 'All',           count: batchArray.length },
              { key: 'needs-work' as const,  label: 'Needs work',    count: stateCounts['needs-work'] },
              { key: 'ready' as const,       label: 'Ready to push', count: stateCounts['ready'] },
              { key: 'complete' as const,    label: 'Complete',      count: stateCounts['complete'] },
              { key: 'over' as const,        label: 'Over received', count: stateCounts['over'] },
            ]).map(f => {
              const active = receiveFilter === f.key;
              const isOver = f.key === 'over';
              const isNeeds = f.key === 'needs-work';
              const accentCls = active
                ? isOver
                  ? 'bg-bg-surface text-negative border-current'
                  : isNeeds
                    ? 'bg-bg-surface text-warning border-current'
                    : f.key === 'complete'
                      ? 'bg-bg-surface text-positive border-current'
                      : 'bg-bg-surface text-link border-current'
                : 'bg-bg-surface text-text-tertiary border-border-subtle hover:text-text-secondary hover:bg-bg-hover';
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setReceiveFilter(f.key)}
                  disabled={f.count === 0 && f.key !== 'all'}
                  className={`flex items-center gap-1.5 h-6 px-2 rounded-md border font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${accentCls}`}
                >
                  {f.label}
                  <span className="tabular-nums text-[10px] opacity-80">{f.count}</span>
                </button>
              );
            })}
            {receiveFilter !== 'all' && (
              <span className="ml-1 text-text-tertiary/80 italic text-[11px]">
                Showing {visibleBatch.length} of {batchArray.length}
              </span>
            )}
          </div>
          {/* KPI line — right */}
          <div className="shrink-0 text-right">
            <div className="flex items-center gap-x-4 text-xs text-text-secondary flex-wrap justify-end">
              <span className="text-text-tertiary">Qty <span className="text-text-primary text-base tabular-nums">{summary.totalQty}</span></span>
              <span className="text-text-tertiary">Rev <span className="text-text-primary text-base tabular-nums">{formatCurrency(summary.totalListCents)}</span></span>
              <span className="text-text-tertiary">Cost <span className="text-text-primary text-base tabular-nums">{formatCurrency(summary.totalCostCents)}</span></span>
              <span className="text-text-tertiary">Ship <span className="text-text-primary text-base tabular-nums">{formatCurrency(summary.totalShipCents)}</span></span>
              <span className="text-text-tertiary">
                Fees <span className="text-text-primary text-base tabular-nums">{formatCurrency(summary.totalFeeCents)}</span>
              </span>
              <span className="text-text-tertiary">
                Net <span className={`font-semibold text-base tabular-nums ${
                  summary.profitIncomplete
                    ? 'text-text-secondary'
                    : summary.totalNetCents > 0 ? 'text-positive' : 'text-negative'
                }`}>
                  {summary.profitIncomplete ? '~' : ''}{formatCurrency(summary.totalNetCents)}
                </span>
              </span>
              {summary.roiPct != null && !summary.profitIncomplete && (
                <span className="text-text-tertiary">
                  ROI <span className={`tabular-nums ${summary.roiPct > 0 ? 'text-positive/90' : 'text-negative/90'}`}>
                    {summary.roiPct.toFixed(1)}%
                  </span>
                </span>
              )}
              {summary.marginPct != null && !summary.profitIncomplete && (
                <span className="text-text-tertiary">
                  Margin <span className="text-text-secondary tabular-nums">
                    {summary.marginPct.toFixed(1)}%
                  </span>
                </span>
              )}
            </div>
            {summary.profitIncomplete && (
              <div className="text-[10px] text-text-tertiary/60 mt-1 italic">
                {summary.priceOrCostIncomplete
                  ? 'Estimate — some items missing price or cost.'
                  : 'Estimate — Amazon fee not cached. ROI/margin hidden.'}
              </div>
            )}
          </div>
        </div>
      )}

      {receiveFilter !== 'all' && batchArray.length > 0 && (
        <div className="mb-2 -mt-1 text-[10px] text-text-tertiary/60 italic">
          Filters only change visible rows; Print All and Preview &amp; Push use the full saved batch.
        </div>
      )}

      {/* Batch area — full width */}
      <div className="flex-1 flex flex-col min-h-0">
        {batchArray.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center border border-dashed border-border-subtle rounded-xl py-10">
            {!(searchOpen && query.trim().length >= 2) && (
              <>
                <div className="panel flex items-center justify-center w-14 h-14 mb-4">
                  <ScanBarcode size={28} className="text-text-tertiary opacity-60" />
                </div>
                <p className="text-sm font-semibold text-text-secondary">Scan or search to start receiving</p>
                <p className="text-xs text-text-tertiary mt-1.5 max-w-[240px]">
                  Use the search bar above for UPC, ASIN, MSKU, or title.
                </p>
                <p className="text-[11px] text-text-tertiary/60 mt-3 font-mono">
                  Enter adds a single match
                </p>
              </>
            )}
          </div>
          ) : (
            <>
            {/* Table column header — widths match BatchItemRow zones exactly */}
            <div className="flex items-center gap-2 px-3 pr-1 pb-1 mb-0.5 text-[10px] text-text-tertiary/50 label-caps select-none border-b border-border-subtle/50">
              <div className="w-8 shrink-0" />
              <div className="min-w-0 flex-1">Item</div>
              <div className="w-32 shrink-0">Qty</div>
              <div className="w-20 shrink-0 text-right">COGS</div>
              <div className="w-20 shrink-0 text-right">List</div>
              <div className="w-24 shrink-0 text-right">Actions</div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 min-h-0 pr-1">
              {receiveFilter !== 'all' && visibleBatch.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center text-text-tertiary">
                  <p className="text-sm">No items match this filter.</p>
                  <button
                    type="button"
                    onClick={() => setReceiveFilter('all')}
                    className="mt-2 text-xs text-link hover:underline"
                  >
                    Show all
                  </button>
                </div>
              )}
              {visibleBatch.map(item => (
                <BatchItemCard
                  key={item.sku}
                  item={item}
                  onChange={updates => updateBatchItem(item.sku, updates)}
                  onRemove={() => removeFromBatch(item.sku)}
                  onSave={() => saveItem(item.sku)}
                  onCreateLot={() => createLot(item.sku)}
                  onPrintLabel={() => openLabelPrint([item])}
                  onEdit={() => updateBatchItem(item.sku, { save_state: 'idle', save_error: null })}
                  onSaveQty={(q) => saveQtyOnly(item.sku, q)}
                  onMarkInspected={() => markInspected(item.sku)}
                  onImageClick={() => item.image_url && setLightbox({
                    src: item.image_url,
                    title: item.product_name || item.asin || item.sku,
                    asin: item.asin || '',
                    sku: item.sku,
                  })}
                  onShowDetail={() => setDetailDrawer({ sku: item.sku, source: 'batch' })}
                  focusQty={focusQtySku === item.sku}
                  onQtyFocused={() => setFocusQtySku(null)}
                  amazonTemplates={amazonTemplates}
                  locked={locked}
                />
              ))}
            </div>
            </>
          )}
        </div>

      {previewError && (
        <div className="fixed bottom-4 right-4 z-40 max-w-md px-4 py-3 flash flash-bad text-sm text-negative shadow-lg flex items-start gap-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">{previewError}</span>
          <button onClick={() => setPreviewError(null)} className="shrink-0 p-1 hover:bg-negative/10 rounded">
            <X size={12} />
          </button>
        </div>
      )}

      {previewOpen && previewRows.length > 0 && (
        <PreviewModal
          rows={previewRows}
          shippingTemplate={previewTemplate}
          onClose={() => setPreviewOpen(false)}
          onPushComplete={() => { setPreviewOpen(false); }}
          onAllEligibleAccepted={
            batchId != null && batchId > 0
              ? async () => {
                  // Every eligible SKU was accepted → finalize this batch and
                  // send it to History. Partial pushes never reach here, so the
                  // batch only closes when nothing is left to push.
                  try {
                    await fetch(`/api/list/batches/${batchId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status: 'closed' }),
                    });
                  } catch (err) {
                    console.warn('batch auto-close failed:', err);
                  }
                  window.location.href = '/list/history';
                }
              : undefined
          }
        />
      )}

      {detailDrawer && (() => {
        const di: SearchResult | BatchItem | null = detailDrawer.source === 'batch'
          ? batch.get(detailDrawer.sku) ?? null
          : results.find(r => r.sku === detailDrawer.sku) ?? null;
        if (!di) { return null; }
        const isBatch = isBatchItem(di);
        return (
          <ItemDetailDrawer
            item={di}
            onClose={() => setDetailDrawer(null)}
            onImageClick={() => di.image_url && setLightbox({
              src: di.image_url,
              title: di.product_name || di.asin || di.sku,
              asin: di.asin || '',
              sku: di.sku,
            })}
            onPrintLabel={isBatch && di.asin ? () => openLabelPrint([di]) : undefined}
            onEdit={isBatch && di.save_state === 'saved' ? () => {
              updateBatchItem(di.sku, { save_state: 'idle', save_error: null });
              setDetailDrawer(null);
            } : undefined}
            amazonTemplates={amazonTemplates}
          />
        );
      })()}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setLightbox(null)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white/90"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
            <img
              src={lightbox.src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1')}
              alt={lightbox.title}
              className="block h-[85vh] w-auto max-w-[92vw] object-contain"
            />
            <div className="absolute bottom-0 inset-x-0 px-4 py-2.5 bg-black/70">
              <div className="text-sm font-medium text-white leading-snug line-clamp-2" title={lightbox.title}>
                {lightbox.title}
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-white/70">
                {lightbox.asin && <AsinLink asin={lightbox.asin} className="text-link hover:text-link hover:underline" />}
                <MskuLink sku={lightbox.sku} className="truncate hover:text-link hover:underline" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
