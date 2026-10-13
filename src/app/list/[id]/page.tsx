'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { generateMSKU } from '@/lib/listing-msku';
import { ArrowLeft, Search, Plus, Trash2, Package, TrendingUp, DollarSign, Percent, Send, ExternalLink, CheckCircle, AlertCircle, AlertTriangle, Loader2, Archive, Box as BoxIcon, Pencil, X as XIcon, Check, RefreshCw } from 'lucide-react';
import { gatedLabel, PreflightChip, SendStatusCard, StatusBadge } from '@/components/listing/BatchBadges';
import { BoxingWorkflow } from '@/components/listing/BoxingWorkflow';
import { FnskuPrintButton, PrintRowButton } from '@/components/listing/FnskuPrintButtons';
import { Batch, BatchItem, Box, CatalogResult, PackGroup, PlacementOption } from '@/components/listing/types';
import { WfsBatchView } from '@/components/listing/WfsBatchView';
import { useQuery } from '@/lib/useQuery';
/**
 * Parse a Qty input. MFN batches allow 0 (register the SKU on Amazon before
 * any stock is bought, Oct 4 2026); FBA needs at least 1. Blank or invalid
 * falls back to 1, as before.
 */
function parseQty(raw: string, channel: string | undefined): number {
  const n = parseInt(raw, 10);
  const min = channel === 'MFN' ? 0 : 1;
  return Number.isFinite(n) && n >= min ? n : 1;
}

/**
 * WFS (Walmart) batches have their own page; everything else is an Amazon
 * batch. The choice is made before the Amazon page mounts, so its draft-time
 * Amazon checks never run for a Walmart batch.
 */
export default function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading } = useQuery<{ batch?: { channel: string } }>(`/api/list/batches/${id}`);
  if (loading || !data) return <div className="text-text-tertiary">Loading batch…</div>;
  if (data.batch?.channel === 'WFS' || data.batch?.channel === 'WMT_SF') return <WfsBatchView batchId={id} />;
  return <AmazonBatchDetailPage id={id} />;
}

function AmazonBatchDetailPage({ id }: { id: string }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Scan form state
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [scanned, setScanned] = useState<CatalogResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Item entry state
  const [sku, setSku] = useState('');
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(false);
  const [buyPrice, setBuyPrice] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [shipCost, setShipCost] = useState(''); // MFN outbound shipping cost
  const [quantity, setQuantity] = useState('1');
  const [supplier, setSupplier] = useState('');
  // MFN "Qty → Amazon": on = Amazon gets the SKU's stock in FlipLedger; off =
  // the offer is created at 0 and stock is managed in Seller Central.
  const [sendQtyToAmazon, setSendQtyToAmazon] = useState(true);
  const [condition, setCondition] = useState('NewItem');
  const [saving, setSaving] = useState(false);

  // Phase 2: Send to Amazon state
  const [showSendModal, setShowSendModal] = useState(false);
  const [sending, setSending] = useState(false);

  // Phase 3: Boxing + placement state
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [packGroups, setPackGroups] = useState<PackGroup[]>([]);
  const [initializingBoxing, setInitializingBoxing] = useState(false);
  const [syncingFromAmazon, setSyncingFromAmazon] = useState(false);
  const [savingBoxes, setSavingBoxes] = useState(false);
  const [packing, setPacking] = useState(false);
  const [placementOptions, setPlacementOptions] = useState<PlacementOption[]>([]);
  const [loadingPlacement, setLoadingPlacement] = useState(false);
  const [confirmingPlacementId, setConfirmingPlacementId] = useState<string | null>(null);

  // FNSKU label printing — works at the 'ready' state, no shipment ID needed
  const [printingFnsku, setPrintingFnsku] = useState(false);
  const [printingItemId, setPrintingItemId] = useState<number | null>(null);

  // Cancel & edit — undoes the inbound plan and resets to draft so the user
  // can add items / fix mistakes and re-send. Listings stay on Amazon.
  const [cancelling, setCancelling] = useState(false);

  // Auto-generate MSKU whenever supplier / buyPrice / productName changes,
  // unless the user has manually typed into the MSKU field.
  useEffect(() => {
    if (!scanned || skuManuallyEdited) return;
    const autoMsku = generateMSKU(supplier, scanned.name, buyPrice, scanned.asin, batch?.channel === 'MFN' ? 'MFN' : 'FBA');
    setSku(autoMsku);
  }, [scanned, supplier, buyPrice, skuManuallyEdited, batch?.channel]);

  const fetchBatch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/list/batches/${id}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBatch(data.batch);
      setItems(data.items || []);
      setBoxes(data.boxes || []);
      setPackGroups(data.packGroups || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchBatch(); }, [fetchBatch]);

  // Phase 2: poll /status while the batch is in 'sending' (or 'ready' briefly).
  // Cheap for other states — the backend short-circuits for draft/failed/ready.
  // Resilient to tab visibility: pauses polling when hidden, immediately re-polls
  // on refocus so users don't come back to a stale "sending…" state.
  //
  // Phase 3 note: pack + placement ops are awaited server-side, so we don't
  // need to poll during boxing/placement/shipping. The handlers refetch the
  // batch themselves on completion.
  useEffect(() => {
    if (!batch) return;
    if (batch.status !== 'sending') return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/list/batches/${id}/status`);
        const data = await res.json();
        if (cancelled) return;
        if (data.batch) setBatch(data.batch);
        if (data.items) setItems(data.items);
      } catch (err) {
        console.warn('status poll error:', err);
      }
    };

    const startPolling = () => {
      if (interval) return;
      interval = setInterval(tick, 6000);
    };
    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Tab just came back — poll immediately and resume the interval.
        tick();
        startPolling();
      } else {
        // Tab is hidden — stop the background polling. setInterval in a
        // background tab is throttled anyway, and we want to re-poll the
        // moment the user returns rather than wait on a stale interval.
        stopPolling();
      }
    };

    // Kick off an immediate poll, then start the interval if we're visible.
    tick();
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [id, batch?.status, batch]);

  // Pre-flight polling: while the batch is a draft with items that aren't
  // READY yet, run the server-side preflight (gating / FNSKU / catalog /
  // prep) every 45s so problems surface as badges NOW instead of at send.
  // Stops on its own once every priced item is READY (or hard-blocked).
  const preflightRunning = useRef(false);
  const needsPreflight =
    batch?.status === 'draft' &&
    items.some((it) =>
      it.listPriceCents > 0 &&
      it.preflightStatus !== 'READY' &&
      it.preflightStatus !== 'GATED' &&
      it.preflightStatus !== 'FAILED' &&
      it.preflightStatus !== 'CATALOG_ISSUE'
    );
  useEffect(() => {
    if (!needsPreflight) return;
    let cancelled = false;

    const run = async () => {
      if (preflightRunning.current || document.visibilityState !== 'visible') return;
      preflightRunning.current = true;
      try {
        const res = await fetch(`/api/list/batches/${id}/preflight`, { method: 'POST' });
        const data = await res.json();
        if (!cancelled && data.ran) {
          // Pull the persisted statuses/badges into the table.
          const bres = await fetch(`/api/list/batches/${id}`);
          const bdata = await bres.json();
          if (!cancelled && !bdata.error) {
            setBatch(bdata.batch);
            setItems(bdata.items || []);
          }
        }
      } catch { /* best-effort — next tick retries */ }
      preflightRunning.current = false;
    };

    run();
    const interval = setInterval(run, 45_000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, needsPreflight]);

  // Manual re-check — the poll above stops once every item is hard-blocked
  // (e.g. NEEDS APPROVAL), so an approval granted later needs a click.
  const [rechecking, setRechecking] = useState(false);
  async function handleRecheck() {
    if (preflightRunning.current) return;
    preflightRunning.current = true;
    setRechecking(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/preflight`, { method: 'POST' });
      const data = await res.json();
      if (!data.ran && data.reason) alert(`Re-check failed: ${data.reason}`);
      const bres = await fetch(`/api/list/batches/${id}`);
      const bdata = await bres.json();
      if (!bdata.error) {
        setBatch(bdata.batch);
        setItems(bdata.items || []);
      }
    } catch (err) {
      alert(`Re-check failed: ${err}`);
    } finally {
      preflightRunning.current = false;
      setRechecking(false);
    }
  }

  async function handleSendToAmazon(allowPartial: boolean = false) {
    if (!batch) return;
    setSending(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowPartial }),
      });
      const data = await res.json();
      if (res.status === 409 && data.blockedItems?.length) {
        // Some items can't ship — batch reverted to draft, nothing committed.
        // Ask the user: ship without them, or stop and fix them first.
        const list = data.blockedItems
          .map((b: { sku: string; reason: string }) => `  • ${b.sku}\n    ${b.reason}`)
          .join('\n\n');
        const proceed = window.confirm(
          `${data.blockedItems.length} item(s) can't ship yet:\n\n${list}\n\n` +
          `OK = send the shipment WITHOUT these items (they stay in the batch, marked with the error, and can be re-sent later once fixed).\n\n` +
          `Cancel = batch stays in draft so you can fix or remove them first.`
        );
        await fetchBatch();
        if (proceed) {
          setSending(false);
          return handleSendToAmazon(true);
        }
      } else if (data.error) {
        alert(`Send failed: ${data.error}`);
        await fetchBatch();
      } else {
        setShowSendModal(false);
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSending(false);
  }

  async function handleCancelAndEdit() {
    if (!batch) return;
    const isFailedReset = batch.status === 'failed';
    const confirmMsg = isFailedReset
      ? `Reset this failed batch to draft?\n\n`
        + `WHAT STAYS:\n`
        + `  • Listings that already got created on Amazon stay\n`
        + `  • No money lost — send failed before any plan was committed\n\n`
        + `WHAT YOU CAN DO IN DRAFT:\n`
        + `  • Remove the items that caused the error\n`
        + `  • Edit quantities or add new items\n`
        + `  • Click Send again — items that already worked will skip straight through`
      : `Cancel the inbound plan and unlock this batch for editing?\n\n`
        + `WHAT STAYS:\n`
        + `  • All ${items.length} listings stay live on Amazon (with FNSKUs)\n`
        + `  • Prep classifications stay\n`
        + `  • No money lost — no shipments were committed\n\n`
        + `WHAT GETS UNDONE:\n`
        + `  • The inbound plan record is cancelled on Amazon\n`
        + `  • Any boxes you saved are wiped\n`
        + `  • Batch goes back to draft so you can add items + re-send\n\n`
        + `Re-sending will be much faster since listings already exist (~30s).`;
    if (!confirm(confirmMsg)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/cancel-and-edit`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Cancel failed: ${data.error}`);
      } else {
        await fetchBatch();
        if (!data.amazonCancelled) {
          console.warn('[cancel-and-edit] Amazon-side cancellation failed but local batch was reset:', data.amazonError);
        }
      }
    } catch (err) {
      alert(String(err));
    }
    setCancelling(false);
  }

  async function handleCloseBatch() {
    if (!batch) return;
    if (!confirm('Close this batch? You won\'t be able to make changes, but all the data (COGS, listings, stats) stays in FlipLedger.')) return;
    try {
      const res = await fetch(`/api/list/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Close failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
  }

  // ─── "Labeled" tracking — purely local UI state, helps Parker keep track
  // while physically applying FNSKU stickers. Toggle = mark/unmark a row as
  // done. When set, the row gets a green tint so the unlabeled ones stand out.
  async function handleToggleLabeled(itemId: number, currentlyLabeled: boolean) {
    try {
      const res = await fetch(`/api/list/batches/${id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelsPrintedAt: currentlyLabeled ? null : true }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Toggle failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      console.error(err);
    }
  }

  // ─── FNSKU labels (print BEFORE packing — works at 'ready' state) ───────
  // mode='per-sku': 1 label per SKU; user sets copy count at the Rollo dialog.
  // mode='per-unit': 1 label per individual unit; pre-counted, no Rollo dialog.
  // itemId: optional — print just one row's label instead of the whole batch.
  // copies: optional — explicit pre-counted N labels for a single item. Use
  //   this for "print 1 replacement" or "print 6 of 12" partial cases. Forces
  //   pre-counted output (Rollo just spools N labels, no copy dialog).
  async function handlePrintFnskuLabels(
    action: 'print' | 'download',
    mode: 'per-sku' | 'per-unit' = 'per-sku',
    itemId?: number,
    copies?: number
  ) {
    if (!batch) return;

    // Items whose listing hasn't registered yet have no FNSKU, so the server
    // silently skips them. On a draft that's the "came up short at the printer"
    // failure mode — name them up front and let the user decide.
    const inScope = itemId ? items.filter((i) => i.id === itemId) : items;
    const notReady = inScope.filter((i) => !i.fnsku);
    if (notReady.length > 0) {
      const readyUnits = inScope
        .filter((i) => i.fnsku)
        .reduce((sum, i) => sum + i.quantity, 0);
      if (readyUnits === 0) {
        alert(
          `No labels to print yet — ${notReady.length === 1 ? 'this item is' : 'these items are'} still registering with Amazon:\n\n` +
          notReady.map((i) => `  • ${i.sku}`).join('\n') +
          `\n\nFNSKUs usually land a minute or two after scanning. The item shows FBA READY once it's printable.`
        );
        return;
      }
      const ok = confirm(
        `${notReady.length} item${notReady.length === 1 ? '' : 's'} still registering with Amazon and will be SKIPPED:\n\n` +
        notReady.map((i) => `  • ${i.sku} (${i.quantity} unit${i.quantity === 1 ? '' : 's'})`).join('\n') +
        `\n\nContinue with the ${readyUnits} unit${readyUnits === 1 ? '' : 's'} that are ready? ` +
        `You'll need to print the rest once they show FBA READY.`
      );
      if (!ok) return;
    }

    const params = new URLSearchParams({ action, mode });
    if (itemId) params.set('itemId', String(itemId));
    if (copies && copies > 0) params.set('copies', String(copies));
    const qs = params.toString();
    if (action === 'download') {
      window.open(`/api/list/batches/${id}/fnsku-labels?${qs}`, '_blank');
      return;
    }
    if (itemId) {
      setPrintingItemId(itemId);
    } else {
      setPrintingFnsku(true);
    }
    try {
      const res = await fetch(`/api/list/batches/${id}/fnsku-labels?${qs}`);
      const data = await res.json();
      if (data.success) {
        const missing = data.missingFnsku?.length
          ? `\n\n⚠ ${data.missingFnsku.length} item(s) missing FNSKU (still propagating): ${data.missingFnsku.join(', ')}`
          : '';
        const isSingle = !!itemId;
        const summary = copies
          ? `✓ Spooled ${data.labelCount} label${data.labelCount === 1 ? '' : 's'} (pre-counted) to ${data.printer}${data.jobId ? ' — job ' + data.jobId : ''}.`
          : isSingle
            ? `✓ Sent label for this item to ${data.printer}. Set the copy count at the Rollo dialog: ${data.totalUnits} unit${data.totalUnits === 1 ? '' : 's'}.`
            : mode === 'per-sku'
              ? `✓ Sent ${data.labelCount} unique label${data.labelCount === 1 ? '' : 's'} to ${data.printer} (1 per SKU). Set the copy count at the Rollo dialog: ${data.totalUnits} total unit${data.totalUnits === 1 ? '' : 's'} need labeling.`
              : `✓ Printed ${data.labelCount} FNSKU labels (one per unit, pre-counted) to ${data.printer}${data.jobId ? ' — job ' + data.jobId : ''}.`;
        alert(summary + missing);
      } else {
        const hint = data.hint ? `\n\n${data.hint}` : '';
        alert(`Print failed: ${data.error}${hint}\n\nTry "PDF" instead and print manually.`);
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    }
    setPrintingItemId(null);
    setPrintingFnsku(false);
  }

  // ─── Phase 3: Boxing + placement handlers ───────────────────────────────

  // Initialize boxing: hits /initialize-boxing on the backend to generate
  // packing options on Amazon and learn which items belong to which pack
  // group. Then seeds one EMPTY default box per group — the user adds items
  // to each box as they physically pack them.
  async function initializeDefaultBoxes() {
    if (boxes.length > 0) return; // already boxed
    setInitializingBoxing(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/initialize-boxing`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Initialize boxing failed: ${data.error}`);
        setInitializingBoxing(false);
        return;
      }
      const groups: PackGroup[] = data.packGroups || [];
      setPackGroups(groups);

      // Seed one EMPTY default box per pack group. User assigns items as they pack.
      const seededBoxes: Box[] = groups.map((g) => ({
        lengthIn: 18,
        widthIn: 14,
        heightIn: 12,
        weightLb: 20,
        packingGroupId: g.packingGroupId,
        items: [],
      }));
      setBoxes(seededBoxes);
    } catch (err) {
      alert(`Initialize boxing error: ${err}`);
    }
    setInitializingBoxing(false);
  }

  async function handleSyncFromAmazon() {
    if (!batch) return;
    if (!confirm(
      'Pull the current batch state from Amazon? Use this if you finished packing/placement in Seller Central. The batch will move to "Shipping" if Amazon shows shipments are created.'
    )) return;
    setSyncingFromAmazon(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/sync-from-amazon`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Sync failed: ${data.error}`);
      } else {
        alert(data.message || 'Synced.');
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSyncingFromAmazon(false);
  }

  function addEmptyBox(packingGroupId?: string) {
    setBoxes((prev) => [
      ...prev,
      {
        lengthIn: 18,
        widthIn: 14,
        heightIn: 12,
        weightLb: 20,
        packingGroupId: packingGroupId || null,
        items: [],
      },
    ]);
  }

  // Copy a packed box (dimensions, weight, contents) for identical boxes.
  // Contents are capped at what's still unassigned so a copy can never
  // over-allocate an item; the copy lands right after the last box in the
  // same pack group.
  function duplicateBoxAt(idx: number) {
    setBoxes((prev) => {
      const source = prev[idx];
      if (!source) return prev;
      const assigned = new Map<number, number>();
      for (const b of prev) for (const bi of b.items) assigned.set(bi.itemId, (assigned.get(bi.itemId) ?? 0) + bi.quantity);
      const copiedItems = source.items
        .map((bi) => {
          const total = items.find((it) => it.id === bi.itemId)?.quantity ?? 0;
          const remaining = Math.max(0, total - (assigned.get(bi.itemId) ?? 0));
          return { itemId: bi.itemId, quantity: Math.min(bi.quantity, remaining) };
        })
        .filter((bi) => bi.quantity > 0);
      const copy: Box = { ...source, id: undefined, boxIndex: undefined, items: copiedItems };
      let insertAt = idx;
      prev.forEach((b, i) => { if ((b.packingGroupId ?? null) === (source.packingGroupId ?? null)) insertAt = i; });
      return [...prev.slice(0, insertAt + 1), copy, ...prev.slice(insertAt + 1)];
    });
  }

  function removeBoxAt(idx: number) {
    setBoxes((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateBoxField(idx: number, field: keyof Box, value: number) {
    setBoxes((prev) => prev.map((b, i) => (i === idx ? { ...b, [field]: value } : b)));
  }

  // Set the quantity of itemId in boxIdx. If qty=0, remove the assignment.
  function setBoxItemQty(boxIdx: number, itemId: number, qty: number) {
    setBoxes((prev) =>
      prev.map((b, i) => {
        if (i !== boxIdx) return b;
        const existing = b.items.find((bi) => bi.itemId === itemId);
        if (qty <= 0) {
          return { ...b, items: b.items.filter((bi) => bi.itemId !== itemId) };
        }
        if (existing) {
          return { ...b, items: b.items.map((bi) => (bi.itemId === itemId ? { ...bi, quantity: qty } : bi)) };
        }
        return { ...b, items: [...b.items, { itemId, quantity: qty }] };
      })
    );
  }

  async function handleSaveBoxes() {
    if (!batch) return;
    setSavingBoxes(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/boxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Save failed: ${data.error}`);
      } else {
        lastSavedBoxesJson.current = null; // re-baseline against the refetched state
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setSavingBoxes(false);
  }

  // ── Boxing auto-save ──────────────────────────────────────────────────
  // All box state used to live only in React state until an explicit "Save
  // draft" — a Chrome crash on July 8, 2026 wiped ~10 boxes of packing work.
  // Debounce-save every edit to the server so a crash/tab-close never loses
  // box work again. Silent + no refetch (a refetch mid-edit would clobber
  // keystrokes); the explicit Save/Confirm buttons still behave as before.
  const lastSavedBoxesJson = useRef<string | null>(null);
  const boxesJson = JSON.stringify(boxes);
  useEffect(() => {
    if (!batch) return;
    if (batch.status !== 'ready' && batch.status !== 'boxing') return;
    if (batch.packingStatus === 'SUCCESS') return;
    if (boxes.length === 0) return;
    if (lastSavedBoxesJson.current === null) {
      // First observation (initial load / post-save refetch) — baseline only.
      lastSavedBoxesJson.current = boxesJson;
      return;
    }
    if (lastSavedBoxesJson.current === boxesJson) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/list/batches/${id}/boxes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ boxes }),
        });
        const data = await res.json();
        if (!data.error) lastSavedBoxesJson.current = boxesJson;
        // On validation errors stay quiet — the user is likely mid-edit; the
        // explicit Save/Confirm surface errors.
      } catch { /* transient — next edit retries */ }
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxesJson, batch?.status, batch?.packingStatus, id]);

  async function handleConfirmPacking() {
    if (!batch) return;
    if (!confirm(
      'Confirm packing with Amazon? This sends your box dimensions/weight and item assignments to Amazon. After this step, the boxes are locked and Amazon generates placement options.'
    )) return;
    setPacking(true);
    try {
      // Save boxes first in case the user tweaked anything
      const saveRes = await fetch(`/api/list/batches/${id}/boxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boxes }),
      });
      const saveData = await saveRes.json();
      if (saveData.error) {
        alert(`Save failed: ${saveData.error}`);
        setPacking(false);
        return;
      }
      // Now push to Amazon
      const res = await fetch(`/api/list/batches/${id}/pack`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Confirm packing failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setPacking(false);
  }

  async function handleGeneratePlacement() {
    if (!batch) return;
    setLoadingPlacement(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Generate placement options failed: ${data.error}`);
      } else if (data.options) {
        setPlacementOptions(data.options);
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setLoadingPlacement(false);
  }

  async function handleLoadPlacement() {
    if (!batch) return;
    setLoadingPlacement(true);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`);
      const data = await res.json();
      if (data.error) {
        alert(`Load placement options failed: ${data.error}`);
      } else if (data.options) {
        setPlacementOptions(data.options);
      }
    } catch (err) {
      alert(String(err));
    }
    setLoadingPlacement(false);
  }

  async function handleConfirmPlacement(optionId: string) {
    if (!batch) return;
    const chosen = placementOptions.find((o) => o.placementOptionId === optionId);
    const feeCents = chosen?.fees.reduce((sum, f) => sum + Math.round((f.value?.amount || 0) * 100), 0) || 0;
    if (!confirm(
      `Lock in this placement option? The ${formatCurrency(feeCents)} placement fee will be charged to your Amazon account. This creates real shipments.`
    )) return;
    setConfirmingPlacementId(optionId);
    try {
      const res = await fetch(`/api/list/batches/${id}/placement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', placementOptionId: optionId }),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Confirm placement failed: ${data.error}`);
      } else {
        await fetchBatch();
      }
    } catch (err) {
      alert(String(err));
    }
    setConfirmingPlacementId(null);
  }

  async function handleScan(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setScanned(null);
    setScanError(null);
    try {
      const channelParam = `&channel=${batch?.channel || 'FBA'}`;
      const res = await fetch(`/api/list/catalog/search?q=${encodeURIComponent(query.trim())}${channelParam}`);
      const data = await res.json();
      if (data.error) {
        setScanError(data.error);
      } else if (data.items && data.items.length > 0) {
        const first = data.items[0] as CatalogResult;
        setScanned(first);
        // If already in catalog, DEFAULT to restocking the existing MSKU so a stray
        // "Add to Batch" can't split inventory into a duplicate SKU. New items fall
        // through to the auto-generator (skuManuallyEdited = false).
        // Only restock into an MSKU on THIS batch's fulfillment channel — reusing an
        // FBA MSKU on an MFN batch flips the live listing's channel (see catalog search).
        const existing = (first.existingMskus || []).find((m) => m.compatible !== false) || null;
        if (existing) {
          setSku(existing.msku);
          setSkuManuallyEdited(true); // lock — stops the generator from minting a new SKU
        } else {
          setSkuManuallyEdited(false); // new item — let the effect autofill the MSKU
        }
        // Pre-fill from historical data (existing lot's cost wins when restocking)
        if (existing && existing.lastBuyPriceCents > 0) {
          setBuyPrice((existing.lastBuyPriceCents / 100).toFixed(2));
        } else if (first.lastBuyPrice) {
          setBuyPrice((first.lastBuyPrice / 100).toFixed(2));
        }
        // An existing SKU sells at its live Amazon price; else use past sales.
        if (existing?.currentPriceCents) setListPrice((existing.currentPriceCents / 100).toFixed(2));
        else if (first.avgSalePrice) setListPrice((first.avgSalePrice / 100).toFixed(2));
        // MFN-only: pre-fill ship cost from historical average
        if (first.shippingEstimate && first.shippingEstimate.costCents > 0) {
          setShipCost((first.shippingEstimate.costCents / 100).toFixed(2));
        } else {
          setShipCost('');
        }
      } else {
        setScanError('No matches found');
      }
    } catch (err) {
      setScanError(String(err));
    }
    setSearching(false);
  }

  // Re-estimate fees when the user changes the list price on a scanned item.
  // Debounced via a timeout so we don't hit the API on every keystroke.
  useEffect(() => {
    if (!scanned) return;
    const parsedListPrice = parseFloat(listPrice);
    if (!Number.isFinite(parsedListPrice) || parsedListPrice <= 0) return;
    const cents = Math.round(parsedListPrice * 100);
    // Only re-estimate if the list price is materially different from what we already have
    if (scanned.feeEstimatePriceCents && Math.abs(cents - scanned.feeEstimatePriceCents) < 50) return;

    const timer = setTimeout(async () => {
      try {
        const channelParam = `&channel=${batch?.channel || 'FBA'}`;
        const res = await fetch(`/api/list/catalog/search?q=${scanned.asin}&priceCents=${cents}${channelParam}`);
        const data = await res.json();
        if (data.items?.[0]) {
          setScanned((prev) => prev ? { ...prev, feeEstimate: data.items[0].feeEstimate, feeEstimatePriceCents: data.items[0].feeEstimatePriceCents } : prev);
        }
      } catch {
        // Leave the old estimate in place on failure
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPrice, scanned?.asin, batch?.channel]);

  async function handleAddItem() {
    if (!scanned || !sku || !buyPrice) return;
    setSaving(true);
    try {
      // Use the real per-unit fee estimate if available.
      // The backend returns a total for the list price we queried — that IS the
      // per-unit fee (the estimate was computed for a single unit at that price).
      // Scale it to the actual listPrice the user entered (linear scaling is OK
      // because referral fees are a percentage of price).
      let perUnitFeeCents = 0;
      if (scanned.feeEstimate && scanned.feeEstimatePriceCents) {
        const enteredCents = Math.round((parseFloat(listPrice) || 0) * 100);
        if (enteredCents > 0) {
          const scale = enteredCents / scanned.feeEstimatePriceCents;
          // Referral part scales; FBA part is flat
          perUnitFeeCents = Math.round(scanned.feeEstimate.referralFeeCents * scale) + scanned.feeEstimate.fbaFeeCents;
        } else {
          perUnitFeeCents = scanned.feeEstimate.totalFeeCents;
        }
      } else if (scanned.avgFeeRate && listPrice) {
        // Secondary fallback: historical rate
        perUnitFeeCents = Math.round(parseFloat(listPrice) * 100 * scanned.avgFeeRate);
      }

      const perUnitShipCents = Math.round((parseFloat(shipCost) || 0) * 100);

      const res = await fetch(`/api/list/batches/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asin: scanned.asin,
          sku: sku.trim(),
          productName: scanned.name,
          imageUrl: scanned.imageUrl,
          condition,
          quantity: parseQty(quantity, batch?.channel),
          listPrice: parseFloat(listPrice) || 0,
          buyPrice: parseFloat(buyPrice) || 0,
          supplier: supplier.trim() || null,
          purchaseDate: new Date().toISOString(),
          estimatedFeeCents: perUnitFeeCents,
          estimatedShipCents: perUnitShipCents,
          ...(batch?.channel === 'MFN' ? { sendQtyToAmazon } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        // Kick off the Amazon listing creation for this item NOW, in the
        // background, so its FNSKU starts propagating while you keep scanning.
        // Fire-and-forget (don't block the next scan); refetch when it lands so
        // the per-item status chip updates. Best-effort — failure just shows a
        // FAILED chip and the Send flow will retry.
        // ONLY auto-create when a list price was entered — never push a $0 offer
        // to Amazon (it's silently accepted, becomes unsellable, and corrupts the
        // packing/placement flow). Unpriced items get created at Send instead.
        if (data.id && parseFloat(listPrice) > 0) {
          fetch(`/api/list/batches/${id}/items/${data.id}/create-listing`, { method: 'POST' })
            .then(() => fetchBatch())
            .catch(() => {});
        }
        // Clear form for next scan
        setQuery('');
        setScanned(null);
        setScanError(null);
        setSku('');
        setSkuManuallyEdited(false);
        setBuyPrice('');
        setListPrice('');
        setShipCost('');
        setQuantity('1');
        setSupplier('');
        setCondition('NewItem');
        await fetchBatch();
      } else {
        alert(`Failed to add item: ${data.error}`);
      }
    } catch (err) {
      alert(String(err));
    }
    setSaving(false);
  }

  const [togglingQtyId, setTogglingQtyId] = useState<number | null>(null);
  async function handleToggleAmazonQty(item: BatchItem) {
    const turnOn = item.sendQtyToAmazon === 0;
    const stock = item.skuStock ?? 0;
    if (turnOn && !confirm(`Set Amazon to ${stock} available for ${item.sku}? That's your stock in FlipLedger (bought minus sold).`)) return;
    setTogglingQtyId(item.id);
    try {
      const res = await fetch(`/api/list/batches/${id}/items/${item.id}/amazon-qty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ send: turnOn }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) alert(`Qty → Amazon failed: ${data.error || res.status}`);
      else if (data.reason) alert(data.reason);
      await fetchBatch();
    } catch (err) {
      alert(String(err));
    }
    setTogglingQtyId(null);
  }

  async function handleRemoveItem(itemId: number) {
    if (!confirm('Remove this item from the batch?')) return;
    try {
      const res = await fetch(`/api/list/batches/${id}/items/${itemId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || `Remove failed (${res.status})`);
      fetchBatch();
    } catch (err) {
      console.error(err);
    }
  }

  // ─── Inline edit state for batch items ──────────────────────────────────
  // Click the pencil → row enters edit mode. Save → PATCH the API. Cancel → revert.
  // PATCH only touches the batch_item row; it does NOT re-touch inventory_ledger
  // (per server behavior) so qty edits here just change the listing qty, not COGS.
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{
    condition: string;
    quantity: string;
    buyPrice: string;
    listPrice: string;
  }>({ condition: 'NewItem', quantity: '1', buyPrice: '', listPrice: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  function handleStartEdit(item: BatchItem) {
    setEditingItemId(item.id);
    setEditForm({
      condition: item.condition,
      quantity: String(item.quantity),
      buyPrice: (item.buyPriceCents / 100).toFixed(2),
      listPrice: (item.listPriceCents / 100).toFixed(2),
    });
  }

  function handleCancelEdit() {
    setEditingItemId(null);
  }

  async function handleSaveEdit(itemId: number) {
    if (!batch) return;
    setSavingEdit(true);
    try {
      // Edit scope mirrors the backend rules:
      //   draft: all fields
      //   ready/boxing/placement: only qty + buy (the FlipLedger-local fields)
      // condition + listPrice are locked post-draft to avoid silent divergence
      // from the live Amazon listing.
      const isDraft = batch.status === 'draft';
      const payload: Record<string, unknown> = {
        quantity: parseQty(editForm.quantity, batch.channel),
        buyPrice: parseFloat(editForm.buyPrice) || 0,
      };
      if (isDraft) {
        payload.condition = editForm.condition;
        payload.listPrice = parseFloat(editForm.listPrice) || 0;
      }

      const res = await fetch(`/api/list/batches/${id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Edit failed: ${data.error}`);
      } else {
        setEditingItemId(null);
        await fetchBatch();
        // If the list price changed on a draft item, re-push it to Amazon so the
        // live offer stays in sync (otherwise the DB and Amazon diverge — the
        // root of the "$45 in FlipLedger but $0 on Amazon" bug). force=1 updates
        // an already-created listing in place; the route skips $0 prices.
        if (isDraft && (parseFloat(editForm.listPrice) || 0) > 0) {
          fetch(`/api/list/batches/${id}/items/${itemId}/create-listing?force=1`, { method: 'POST' })
            .then(() => fetchBatch())
            .catch(() => {});
        }
      }
    } catch (err) {
      alert(String(err));
    }
    setSavingEdit(false);
  }

  // ─── Live profit ticker math ──────────────────────────────────────
  const totalRevenue = items.reduce((sum, i) => sum + i.listPriceCents * i.quantity, 0);
  const totalCost = items.reduce((sum, i) => sum + i.buyPriceCents * i.quantity, 0);
  const totalFees = items.reduce((sum, i) => sum + i.estimatedFeeCents * i.quantity, 0);
  const totalShip = items.reduce((sum, i) => sum + (i.estimatedShipCents || 0) * i.quantity, 0);
  const expectedProfit = totalRevenue - totalCost - totalFees - totalShip;
  const roi = totalCost > 0 ? (expectedProfit / totalCost) * 100 : 0;
  const margin = totalRevenue > 0 ? (expectedProfit / totalRevenue) * 100 : 0;
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);
  // MFN Publish: what actually reaches Amazon depends on each item's
  // Qty → Amazon switch — ON items set Amazon to the SKU's FlipLedger stock
  // (counted once per SKU), OFF items leave Amazon's quantity alone.
  const mfnOnItems = items.filter((i) => i.sendQtyToAmazon !== 0);
  const mfnOffCount = items.length - mfnOnItems.length;
  const mfnUnitsToAmazon = Array.from(new Map(mfnOnItems.map((i) => [i.sku, i.skuStock ?? 0])).values())
    .reduce((sum, n) => sum + n, 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const mfnPublishMessage = [
    mfnOnItems.length > 0
      ? `Amazon will be set to ${plural(mfnUnitsToAmazon, 'available unit', 'available units')} for the ${plural(mfnOnItems.length, 'item', 'items')} with Qty → Amazon on (your FlipLedger stock: bought minus sold).` +
        (mfnUnitsToAmazon > 0 ? ' Once Amazon verifies them, customers can buy them and you ship each order yourself.' : '')
      : 'No stock is sent to Amazon.',
    mfnOffCount > 0
      ? `${plural(mfnOffCount, 'item has', 'items have')} Qty → Amazon off: ${mfnOffCount === 1 ? 'its' : 'their'} Amazon quantity isn't changed (a listing that doesn't exist yet is created at 0).`
      : '',
    'Unpublishing must be done from Seller Central.',
  ].filter(Boolean).join(' ');

  // ─── Single-item preview (what the user is about to add) ─────────
  const previewQty = parseQty(quantity, batch?.channel);
  const previewBuy = parseFloat(buyPrice) || 0;
  const previewList = parseFloat(listPrice) || 0;

  // Use real fee estimate if we have one, otherwise fall back to historical rate,
  // otherwise 15% default.
  let previewPerUnitFeeCents = 0;
  let feeSourceLabel = '';
  if (scanned?.feeEstimate && scanned.feeEstimatePriceCents) {
    const enteredCents = Math.round(previewList * 100);
    if (enteredCents > 0) {
      const scale = enteredCents / scanned.feeEstimatePriceCents;
      previewPerUnitFeeCents = Math.round(scanned.feeEstimate.referralFeeCents * scale) + scanned.feeEstimate.fbaFeeCents;
    } else {
      previewPerUnitFeeCents = scanned.feeEstimate.totalFeeCents;
    }
    feeSourceLabel = scanned.feeEstimate.source === 'sp-api' ? 'Amazon fees API'
      : scanned.feeEstimate.source === 'cache' ? 'cached estimate'
      : 'category fallback';
  } else if (scanned?.avgFeeRate) {
    previewPerUnitFeeCents = Math.round(previewList * 100 * scanned.avgFeeRate);
    feeSourceLabel = `${(scanned.avgFeeRate * 100).toFixed(1)}% historical rate`;
  } else {
    previewPerUnitFeeCents = Math.round(previewList * 100 * 0.15);
    feeSourceLabel = '15% default';
  }
  const previewFees = (previewPerUnitFeeCents * previewQty) / 100;
  const previewShipTotal = (parseFloat(shipCost) || 0) * previewQty;
  const previewProfit = previewList * previewQty - previewBuy * previewQty - previewFees - previewShipTotal;
  const previewRoi = previewBuy * previewQty > 0 ? (previewProfit / (previewBuy * previewQty)) * 100 : 0;

  if (loading || !batch) {
    return (
      <div className="text-text-tertiary">Loading batch…</div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <Link href="/list" className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title">{batch.name}</h1>
              <StatusBadge status={batch.status} />
              <span className="text-xs text-text-tertiary label-caps">{batch.channel}</span>
            </div>
            <p className="text-xs text-text-tertiary mt-0.5">Created {new Date(batch.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
          </div>
        </div>

        {/* Right-side actions */}
        <div className="flex flex-wrap items-center gap-2">
          {batch.status === 'draft' && (
            <Link
              href={`/list/${batch.id}/import`}
              className="flex items-center gap-2 h-9 px-4 text-text-primary rounded-md text-sm font-semibold hover:bg-bg-hover transition-colors bg-bg-surface border-[1.5px] border-border-strong"
            >
              <Plus size={14} />
              Import items
            </Link>
          )}
          {batch.status === 'draft' && batch.channel === 'FBA' && items.some((i) => i.fnsku) && (
            /* Print labels BEFORE sending: once a batch is sent, item quantities
               are locked, so coming up short on labels is expensive to fix. */
            <FnskuPrintButton
              printing={printingFnsku}
              onPrint={(mode) => handlePrintFnskuLabels('print', mode)}
              onDownload={(mode) => handlePrintFnskuLabels('download', mode)}
            />
          )}
          {batch.status === 'draft' && items.length > 0 && (
            <button
              onClick={() => setShowSendModal(true)}
              className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 transition-colors"
            >
              <Send size={14} />
              {batch.channel === 'FBA' ? 'Send to Amazon' : 'Publish to Amazon'}
            </button>
          )}
          {batch.status === 'ready' && batch.channel === 'FBA' && batch.inboundPlanId && (
            <>
              {/* FNSKU labels — split-button: per-SKU (default) + dropdown for per-unit */}
              <div className="relative">
                <FnskuPrintButton
                  printing={printingFnsku}
                  onPrint={(mode) => handlePrintFnskuLabels('print', mode)}
                  onDownload={(mode) => handlePrintFnskuLabels('download', mode)}
                />
              </div>
              <button
                onClick={initializeDefaultBoxes}
                disabled={initializingBoxing}
                className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors"
                title="Box the items and generate Amazon placement options in FlipLedger. Asks Amazon how to split items into pack groups (~5-30s)."
              >
                {initializingBoxing ? <Loader2 size={14} className="animate-spin" /> : <BoxIcon size={14} />}
                {initializingBoxing ? 'Loading pack groups…' : 'Box & Ship'}
              </button>
              <a
                href={batch.inboundPlanId
                  ? `https://sellercentral.amazon.com/fba/sendtoamazon/pack_mixed_unit_step?wf=${batch.inboundPlanId}`
                  : 'https://sellercentral.amazon.com/fba/inboundshipments'}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                title="Alternative: finish in Seller Central instead"
              >
                <ExternalLink size={14} /> Seller Central
              </a>
            </>
          )}
          {(batch.status === 'boxing' || batch.status === 'placement' || batch.status === 'sending') && batch.channel === 'FBA' && batch.inboundPlanId && (
            <>
              <button
                onClick={handleSyncFromAmazon}
                disabled={syncingFromAmazon}
                className="flex items-center gap-2 h-9 px-3 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors"
                title="Pull the current batch state from Amazon. Use after finishing packing/placement in Seller Central."
              >
                {syncingFromAmazon ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {syncingFromAmazon ? 'Syncing…' : 'Sync from Amazon'}
              </button>
              <a
                href={`https://sellercentral.amazon.com/fba/sendtoamazon/pack_mixed_unit_step?wf=${batch.inboundPlanId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                title="Finish in Seller Central instead"
              >
                <ExternalLink size={14} /> Seller Central
              </a>
            </>
          )}
          {batch.status === 'ready' && batch.channel === 'MFN' && (
            <a
              href="https://sellercentral.amazon.com/inventory"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors"
            >
              <ExternalLink size={14} /> View in Seller Central
            </a>
          )}
          {/* Cancel & Edit — unlocks ready/boxing/placement/failed batches for re-editing.
              For ready+ states: cancels the inbound plan on Amazon (listings stay).
              For failed state: just resets local DB (no plan was created). */}
          {['ready', 'boxing', 'placement', 'failed', 'shipping'].includes(batch.status) && batch.channel === 'FBA' && (
            <button
              onClick={handleCancelAndEdit}
              disabled={cancelling}
              className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm font-semibold text-warning hover:bg-bg-hover disabled:opacity-50 transition-colors"
              title={batch.status === 'failed'
                ? 'Reset to draft so you can fix issues (remove items, edit qty) and try sending again.'
                : 'Cancel the inbound plan on Amazon and reset this batch to draft so you can add items / fix mistakes and re-send. Listings stay live on Amazon — no money lost.'}
            >
              {cancelling ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
              {cancelling ? 'Cancelling…' : (batch.status === 'failed' ? 'Reset & Edit' : 'Cancel & Edit')}
            </button>
          )}
          {(batch.status === 'ready' || batch.status === 'failed' || batch.status === 'shipping' || batch.status === 'shipped') && (
            <button
              onClick={handleCloseBatch}
              className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Archive this batch — no more changes, but all data is preserved"
            >
              <Archive size={14} /> Close Batch
            </button>
          )}
        </div>
      </div>

      {/* Send status card — visible while sending or after send */}
      {(batch.status === 'sending' || batch.status === 'ready' || batch.status === 'failed') && (
        <SendStatusCard batch={batch} items={items} />
      )}

      {/* Phase 3: Boxing workflow — visible while boxing/placement/shipping */}
      {(batch.status === 'boxing' || batch.status === 'placement' || batch.status === 'shipping' || (batch.status === 'ready' && boxes.length > 0)) && (
        <BoxingWorkflow
          batch={batch}
          items={items}
          boxes={boxes}
          packGroups={packGroups}
          placementOptions={placementOptions}
          savingBoxes={savingBoxes}
          packing={packing}
          loadingPlacement={loadingPlacement}
          confirmingPlacementId={confirmingPlacementId}
          onAddBox={addEmptyBox}
          onRemoveBox={removeBoxAt}
          onDuplicateBox={duplicateBoxAt}
          onUpdateBoxField={updateBoxField}
          onSetBoxItemQty={setBoxItemQty}
          onSaveBoxes={handleSaveBoxes}
          onConfirmPacking={handleConfirmPacking}
          onGeneratePlacement={handleGeneratePlacement}
          onLoadPlacement={handleLoadPlacement}
          onConfirmPlacement={handleConfirmPlacement}
        />
      )}

      {/* Live profit ticker */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary">
            <Package size={12} /> Units
          </div>
          <div className="stat-num text-lg sm:text-xl text-text-primary mt-1">{totalUnits}</div>
          <div className="text-[11px] text-text-tertiary">{items.length} SKU{items.length === 1 ? '' : 's'}</div>
        </div>
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary">
            <DollarSign size={12} /> Expected Revenue
          </div>
          <div className="stat-num text-lg sm:text-xl text-text-primary mt-1">{formatCurrency(totalRevenue)}</div>
        </div>
        <div className="panel p-3">
          <div className="text-[10px] label-caps text-text-tertiary">Cost + Fees{totalShip > 0 ? ' + Ship' : ''}</div>
          <div className="stat-num text-lg sm:text-xl text-text-secondary mt-1">{formatCurrency(totalCost + totalFees + totalShip)}</div>
          <div className="text-[11px] text-text-tertiary">
            {formatCurrency(totalCost)} cost · {formatCurrency(totalFees)} fees
            {totalShip > 0 && <> · {formatCurrency(totalShip)} ship</>}
          </div>
        </div>
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[10px] label-caps text-accent">
            <TrendingUp size={12} /> Expected Profit
          </div>
          <div className={`stat-num text-lg sm:text-xl mt-1 ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
            {formatCurrency(expectedProfit)}
          </div>
          <div className="text-[11px] text-text-tertiary">{margin.toFixed(1)}% margin</div>
        </div>
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary">
            <Percent size={12} /> ROI
          </div>
          <div className={`stat-num text-lg sm:text-xl mt-1 ${roi >= 30 ? 'text-positive' : roi >= 0 ? 'text-text-primary' : 'text-negative'}`}>
            {roi.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Scan / add item form */}
      {batch.status === 'draft' && (
        <div className="panel overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-border-subtle">
            <h2 className="text-sm font-medium">Scan / Search Product</h2>
            <p className="text-[11px] text-text-tertiary mt-0.5">Enter ASIN, UPC/EAN, or keywords</p>
          </div>
          <div className="p-4 space-y-4">
            <form onSubmit={handleScan} className="flex gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                  autoComplete="off"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="B0CNJ7G8CP or 045496597818"
                  autoFocus
                  className="w-full h-10 pl-9 pr-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-link font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={!query.trim() || searching}
                className="h-10 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                {searching ? 'Searching…' : 'Scan'}
              </button>
            </form>

            {scanError && (
              <div className="text-sm text-negative">{scanError}</div>
            )}

            {scanned && (
              <div className="border border-border-subtle rounded-lg overflow-hidden">
                {/* Product header */}
                <div className="flex items-start gap-4 p-4 bg-bg-elevated">
                  {scanned.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={scanned.imageUrl} alt={scanned.name || ''} className="w-16 h-16 rounded object-contain bg-white" />
                  ) : (
                    <div className="w-16 h-16 rounded bg-bg-hover flex items-center justify-center">
                      <Package size={24} className="text-text-tertiary" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary line-clamp-2">{scanned.name}</div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-text-tertiary font-mono">
                      <a
                        href={`https://www.amazon.com/dp/${scanned.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-link transition-colors"
                        title="Open Amazon listing in a new tab"
                      >
                        {scanned.asin}
                        <ExternalLink size={11} className="opacity-60" />
                      </a>
                      {scanned.brand && <span>· {scanned.brand}</span>}
                      <span className={`ml-auto tag ${scanned.source === 'local' ? 'text-positive' : 'text-text-primary'}`}>
                        {scanned.source === 'local' ? 'IN YOUR CATALOG' : 'FROM AMAZON'}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 text-[11px]">
                      <div>
                        <span className="text-text-tertiary">Avg sale: </span>
                        <span className="text-text-primary tabular-nums">{scanned.avgSalePrice ? formatCurrency(scanned.avgSalePrice) : '—'}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">Est. fees: </span>
                        {scanned.feeEstimate ? (
                          <span className="text-text-primary tabular-nums" title={`Referral: ${formatCurrency(scanned.feeEstimate.referralFeeCents)}${scanned.feeEstimate.fbaFeeCents ? ' · FBA: ' + formatCurrency(scanned.feeEstimate.fbaFeeCents) : ''} · ${scanned.feeEstimate.source}`}>
                            {formatCurrency(scanned.feeEstimate.totalFeeCents)}
                          </span>
                        ) : (
                          <span className="text-text-tertiary tabular-nums">—</span>
                        )}
                      </div>
                      <div>
                        <span className="text-text-tertiary">Sold 30d: </span>
                        <span className="text-text-primary tabular-nums">{scanned.unitsSoldLast30d ?? 0}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">FBA stock: </span>
                        <span className="text-text-primary tabular-nums">{scanned.currentFbaStock ?? 0}</span>
                      </div>
                    </div>
                    {(() => {
                      const all = scanned.existingMskus || [];
                      const usable = all.filter((m) => m.compatible !== false);
                      const blocked = all.filter((m) => m.compatible === false);
                      if (all.length === 0) return null;
                      return (
                        <div className="mt-2 space-y-1">
                          {usable.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="text-text-tertiary mr-1">Restock as:</span>
                              {usable.slice(0, 4).map((m) => (
                                <button
                                  key={m.msku}
                                  type="button"
                                  onClick={() => {
                                    setSku(m.msku);
                                    setSkuManuallyEdited(true);
                                    if (m.lastBuyPriceCents > 0) {
                                      setBuyPrice((m.lastBuyPriceCents / 100).toFixed(2));
                                    }
                                    if (m.currentPriceCents) {
                                      setListPrice((m.currentPriceCents / 100).toFixed(2));
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-text-primary hover:bg-bg-hover transition-colors font-mono"
                                  title={`Use this MSKU (no new Amazon listing will be created). Buy price ${m.lastBuyPriceCents > 0 ? '$' + (m.lastBuyPriceCents / 100).toFixed(2) : 'unknown'} from ${m.source}${m.currentPriceCents ? ` · selling at $${(m.currentPriceCents / 100).toFixed(2)} on Amazon` : ''}${m.unitsInStock ? ` · ${m.unitsInStock} in FBA` : ''}`}
                                >
                                  {m.msku}
                                  {m.unitsInStock ? <span className="text-text-tertiary">·{m.unitsInStock}</span> : null}
                                </button>
                              ))}
                            </div>
                          )}
                          {blocked.length > 0 && (
                            <div className="flex flex-wrap items-start gap-1.5 text-[11px]">
                              <AlertTriangle size={11} className="text-warning mt-0.5 shrink-0" />
                              <span className="text-text-tertiary">
                                {blocked.slice(0, 3).map((m) => (
                                  <span key={m.msku} className="font-mono text-text-secondary mr-1">{m.msku}</span>
                                ))}
                                {blocked.length === 1 ? 'is' : 'are'} on the{' '}
                                <span className="text-text-secondary">{blocked[0].channel}</span> channel — this is
                                {' '}{batch.channel}, so it needs its own SKU. Reusing it would move the existing
                                listing to {batch.channel}
                                {blocked.some((m) => (m.unitsInStock || 0) > 0) ? ' and strand its FBA units' : ''}.
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Entry grid */}
                <div className="p-4 grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <div className="col-span-2">
                    <label className="text-[10px] label-caps text-text-tertiary flex items-center gap-1">
                      MSKU
                      {scanned?.existingMskus?.some((m) => m.msku === sku && m.compatible !== false) ? (
                        <span className="text-[9px] text-positive normal-case tracking-normal">restock · no new SKU</span>
                      ) : !skuManuallyEdited && supplier && buyPrice ? (
                        <span className="text-[9px] text-accent/70 normal-case tracking-normal">auto · new SKU</span>
                      ) : null}
                    </label>
                    <input
                      autoComplete="off"
                      value={sku}
                      onChange={(e) => { setSku(e.target.value); setSkuManuallyEdited(true); }}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-link"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] label-caps text-text-tertiary">Condition</label>
                    <select
                      value={condition}
                      onChange={(e) => setCondition(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link"
                    >
                      <option value="NewItem">New</option>
                      <option value="UsedLikeNew">Used - Like New</option>
                      <option value="UsedVeryGood">Used - Very Good</option>
                      <option value="UsedGood">Used - Good</option>
                      <option value="UsedAcceptable">Used - Acceptable</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] label-caps text-text-tertiary">Qty</label>
                    <input
                      autoComplete="off"
                      type="number"
                      min={batch.channel === 'MFN' ? 0 : 1}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] label-caps text-text-tertiary">Buy Price ($)</label>
                    <input
                      autoComplete="off"
                      type="number"
                      step="0.01"
                      value={buyPrice}
                      onChange={(e) => setBuyPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] label-caps text-text-tertiary">List Price ($)</label>
                    <input
                      autoComplete="off"
                      type="number"
                      step="0.01"
                      value={listPrice}
                      onChange={(e) => setListPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link tabular-nums"
                    />
                  </div>
                  {batch.channel === 'MFN' && (
                    <div>
                      <label className="text-[10px] label-caps text-text-tertiary flex items-center gap-1">
                        Ship Cost ($)
                        {scanned.shippingEstimate && scanned.shippingEstimate.source !== 'none' && (
                          <span className="text-[9px] text-accent/70 normal-case tracking-normal">
                            {scanned.shippingEstimate.source === 'per-asin' ? 'asin avg' : 'mkt avg'}
                          </span>
                        )}
                      </label>
                      <input
                        autoComplete="off"
                        type="number"
                        step="0.01"
                        value={shipCost}
                        onChange={(e) => setShipCost(e.target.value)}
                        placeholder="0.00"
                        className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link tabular-nums"
                      />
                    </div>
                  )}
                  <div className={batch.channel === 'MFN' ? 'col-span-1' : 'col-span-2'}>
                    <label className="text-[10px] label-caps text-text-tertiary">Supplier</label>
                    <input
                      autoComplete="off"
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      placeholder="Walmart, Target, …"
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-link"
                    />
                  </div>

                  {batch.channel === 'MFN' && (
                    <label className="col-span-6 flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={sendQtyToAmazon}
                        onChange={(e) => setSendQtyToAmazon(e.target.checked)}
                      />
                      <span>
                        <span className="font-bold text-text-primary">Qty → Amazon</span>
                        {' '}— on: Amazon shows the units you have in FlipLedger. Off: the offer is created at 0 and you manage stock in Seller Central. The cost is recorded either way.
                      </span>
                    </label>
                  )}

                  {/* Per-item preview */}
                  <div className="col-span-6 border-t border-border-subtle pt-3 mt-1 flex items-center justify-between">
                    <div className="text-xs text-text-tertiary">
                      Projected: <span className={`tabular-nums ${previewProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(Math.round(previewProfit * 100))}</span>{' '}
                      profit · <span className="text-text-primary tabular-nums">{previewRoi.toFixed(1)}%</span> ROI{' '}
                      · fees <span className="text-text-primary tabular-nums">{formatCurrency(previewPerUnitFeeCents * previewQty)}</span>
                      {previewShipTotal > 0 && (
                        <> · ship <span className="text-text-primary tabular-nums">{formatCurrency(Math.round(previewShipTotal * 100))}</span></>
                      )}
                      <span className="ml-1 text-text-tertiary">({feeSourceLabel})</span>
                    </div>
                    <button
                      onClick={handleAddItem}
                      disabled={!sku || !buyPrice || saving}
                      className="h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      <Plus size={14} />
                      {saving ? 'Adding…' : 'Add to Batch'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Items table */}
      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">Batch Items</span>
            <span className="text-xs text-text-tertiary">({items.length})</span>
            {/* Pre-flight shape of the batch — know BEFORE hitting Send */}
            {batch.status === 'draft' && items.length > 0 && (() => {
              const count = (s: string) => items.filter((i) => i.preflightStatus === s).length;
              const ready = count('READY');
              const pending = count('PENDING') + items.filter((i) => !i.preflightStatus && i.listPriceCents > 0).length;
              const gatedItems = items.filter((i) => i.preflightStatus === 'GATED');
              const needsApproval = gatedItems.filter((i) => gatedLabel(i) === 'NEEDS APPROVAL').length;
              const notOnAmazon = gatedItems.filter((i) => gatedLabel(i) === 'ASIN NOT ON AMAZON').length;
              const notEligible = gatedItems.length - needsApproval - notOnAmazon;
              const catalog = count('CATALOG_ISSUE');
              const stuck = count('STUCK');
              const failed = count('FAILED');
              const unpriced = count('UNPRICED') + items.filter((i) => !i.preflightStatus && (!i.listPriceCents || i.listPriceCents <= 0)).length;
              const parts: { label: string; cls: string }[] = [];
              if (ready > 0) parts.push({ label: `${ready} ready`, cls: 'text-positive' });
              if (pending > 0) parts.push({ label: `${pending} registering`, cls: 'text-accent' });
              if (needsApproval > 0) parts.push({ label: `${needsApproval} needs approval`, cls: 'text-negative' });
              if (notOnAmazon > 0) parts.push({ label: `${notOnAmazon} ASIN not on Amazon`, cls: 'text-negative' });
              if (notEligible > 0) parts.push({ label: `${notEligible} not eligible`, cls: 'text-negative' });
              if (catalog > 0) parts.push({ label: `${catalog} catalog issue`, cls: 'text-warning' });
              if (stuck > 0) parts.push({ label: `${stuck} not registered`, cls: 'text-warning' });
              if (failed > 0) parts.push({ label: `${failed} failed`, cls: 'text-negative' });
              if (unpriced > 0) parts.push({ label: `${unpriced} no price`, cls: 'text-text-tertiary' });
              if (parts.length === 0) return null;
              return (
                <span className="text-[11px] flex items-center gap-1.5 ml-2 tabular-nums">
                  {parts.map((p, i) => (
                    <span key={p.label} className={p.cls}>
                      {i > 0 && <span className="text-text-tertiary/50 mr-1.5">·</span>}
                      {p.label}
                    </span>
                  ))}
                </span>
              );
            })()}
            {batch.status === 'draft' && items.length > 0 && (
              <button
                onClick={handleRecheck}
                disabled={rechecking}
                title="Re-check every item with Amazon (approvals, FNSKU, catalog issues)"
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${rechecking ? 'animate-spin' : ''}`} />
                {rechecking ? 'Checking…' : 'Refresh'}
              </button>
            )}
          </div>
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-text-tertiary text-sm">
            No items yet. Scan a product above to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-surface">
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] label-caps text-text-tertiary w-28">Condition</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Buy</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">List</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-24">Est. Fees</th>
                  <th className="px-4 py-2.5 text-right text-[11px] label-caps text-text-tertiary w-28">Est. Profit</th>
                  <th className="px-2 py-2.5 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isEditing = editingItemId === item.id;
                  // Use either committed values or in-flight edit values for the math.
                  const editQty = isEditing ? (parseInt(editForm.quantity) || 0) : item.quantity;
                  const editBuy = isEditing ? Math.round((parseFloat(editForm.buyPrice) || 0) * 100) : item.buyPriceCents;
                  const editList = isEditing ? Math.round((parseFloat(editForm.listPrice) || 0) * 100) : item.listPriceCents;
                  const rev = editList * editQty;
                  const cost = editBuy * editQty;
                  const fees = item.estimatedFeeCents * editQty;
                  const ship = (item.estimatedShipCents || 0) * editQty;
                  const profit = rev - cost - fees - ship;
                  return (
                    <tr
                      key={item.id}
                      className={`border-b border-border-subtle/50 transition-colors ${
                        isEditing
                          ? 'bg-accent/5'
                          : item.labelsPrintedAt
                            ? 'bg-positive/10 hover:bg-positive/15'  // labeled = green tint
                            : 'hover:bg-bg-hover'
                      }`}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-3">
                          {item.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.imageUrl} alt="" className="w-8 h-8 rounded object-contain bg-white shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded bg-bg-hover shrink-0 flex items-center justify-center">
                              <Package size={14} className="text-text-tertiary" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <a
                              href={`https://www.amazon.com/dp/${item.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-text-primary hover:text-link hover:underline truncate max-w-[400px] block"
                              title={item.productName || ''}
                            >
                              {item.productName || item.asin}
                            </a>
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-tertiary font-mono">
                              <span className="whitespace-nowrap">{item.sku}</span>
                              {item.fnsku && (
                                <span className="text-[10px] text-text-tertiary/70">· {item.fnsku}</span>
                              )}
                              {batch.channel === 'MFN' && (
                                <button
                                  role="switch"
                                  aria-checked={item.sendQtyToAmazon !== 0}
                                  onClick={() => handleToggleAmazonQty(item)}
                                  disabled={togglingQtyId === item.id}
                                  className={`tag text-[9px] font-sans disabled:opacity-50 ${item.sendQtyToAmazon !== 0 ? 'text-positive' : 'text-text-tertiary'}`}
                                  title={item.sendQtyToAmazon !== 0
                                    ? `On: Amazon is set to your FlipLedger stock for this SKU (${item.skuStock ?? 0}). Click to stop sending.`
                                    : 'Off: FlipLedger never changes the Amazon quantity (manage it in Seller Central). Click to send your stock.'}
                                >
                                  {togglingQtyId === item.id ? 'QTY → AMAZON …' : `QTY → AMAZON: ${item.sendQtyToAmazon !== 0 ? 'ON' : 'OFF'}`}
                                </button>
                              )}
                              {batch.status === 'draft' && item.preflightStatus ? (
                                // Draft: pre-flight badge (gating / catalog / FNSKU state)
                                <PreflightChip item={item} channel={batch.channel} />
                              ) : (
                                // Post-send: listing lifecycle chips
                                <>
                                  {item.listingStatus === 'ACTIVE' && (
                                    <span className="tag text-[9px] text-positive">LIVE</span>
                                  )}
                                  {item.listingStatus === 'PROCESSING' && (
                                    <span className="tag tag-blue text-[9px]">PROCESSING</span>
                                  )}
                                  {item.listingStatus === 'FAILED' && (
                                    <span className="tag text-[9px] text-negative">FAILED</span>
                                  )}
                                  {item.listingStatus === 'NOT_INBOUND_READY' && (
                                    <span className="tag text-[9px] text-warning">EXCLUDED</span>
                                  )}
                                </>
                              )}
                            </div>
                            {/* Inline warning / error message — always visible, not a tooltip */}
                            {item.listingError && (
                              <div
                                className={`text-[11px] mt-0.5 leading-snug ${
                                  item.listingStatus === 'FAILED' ? 'text-negative' : 'text-warning'
                                }`}
                              >
                                {item.listingStatus === 'FAILED' ? '⛔ ' : '⚠ '}
                                {item.listingError}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      {/* Condition — only editable in draft (post-draft would silently diverge from live Amazon listing) */}
                      <td className="px-4 py-2 text-xs text-text-secondary">
                        {isEditing && batch.status === 'draft' ? (
                          <select
                            value={editForm.condition}
                            onChange={(e) => setEditForm({ ...editForm, condition: e.target.value })}
                            className="w-full h-7 px-1 bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-link"
                          >
                            <option value="NewItem">New</option>
                            <option value="UsedLikeNew">Used - Like New</option>
                            <option value="UsedVeryGood">Used - Very Good</option>
                            <option value="UsedGood">Used - Good</option>
                            <option value="UsedAcceptable">Used - Acceptable</option>
                          </select>
                        ) : (
                          item.condition.replace(/([A-Z])/g, ' $1').trim()
                        )}
                      </td>
                      {/* Qty */}
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">
                        {isEditing ? (
                          <input
                            autoComplete="off"
                            type="number"
                            min={batch.channel === 'MFN' ? 0 : 1}
                            value={editForm.quantity}
                            onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
                            className="w-14 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-link tabular-nums"
                          />
                        ) : item.quantity}
                      </td>
                      {/* Buy — editable, FlipLedger-local (affects FIFO/COGS, not Amazon) */}
                      <td className="px-4 py-2 text-right text-sm text-text-secondary tabular-nums">
                        {isEditing ? (
                          <input
                            autoComplete="off"
                            type="number"
                            step="0.01"
                            value={editForm.buyPrice}
                            onChange={(e) => setEditForm({ ...editForm, buyPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-link tabular-nums"
                          />
                        ) : (
                          <>
                            {formatCurrency(editBuy)}
                            {editQty > 1 && <div className="text-[10px] text-text-tertiary">{formatCurrency(cost)} total</div>}
                          </>
                        )}
                      </td>
                      {/* List — only editable in draft (post-draft would silently diverge from live Amazon listing) */}
                      <td className="px-4 py-2 text-right text-sm text-text-primary tabular-nums">
                        {isEditing && batch.status === 'draft' ? (
                          <input
                            autoComplete="off"
                            type="number"
                            step="0.01"
                            value={editForm.listPrice}
                            onChange={(e) => setEditForm({ ...editForm, listPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-link tabular-nums"
                          />
                        ) : (
                          <>
                            {formatCurrency(editList)}
                            {editQty > 1 && <div className="text-[10px] text-text-tertiary">{formatCurrency(rev)} total</div>}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-sm text-negative tabular-nums">
                        {fees + ship > 0 ? (
                          <>
                            {formatCurrency(-(fees + ship))}
                            {ship > 0 && (
                              <div className="text-[10px] text-text-tertiary font-normal">
                                {formatCurrency(-fees)} fees · {formatCurrency(-ship)} ship
                              </div>
                            )}
                          </>
                        ) : '—'}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-medium tabular-nums ${profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(profit)}
                      </td>
                      {/* Actions */}
                      <td className="px-2 py-2 text-right">
                        {batch.status === 'draft' ? (
                          isEditing ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                onClick={() => handleSaveEdit(item.id)}
                                disabled={savingEdit}
                                className="p-1 text-positive hover:bg-positive/10 rounded transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={savingEdit}
                                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <XIcon size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-0.5">
                              {/* Per-row FNSKU print — available as soon as the
                                  listing registers, so a draft can be fully
                                  labeled before Send locks the quantities. */}
                              {!!item.fnsku && batch.channel === 'FBA' && (
                                <PrintRowButton
                                  defaultQty={item.quantity}
                                  isPrinting={printingItemId === item.id}
                                  onPrint={(copies) => handlePrintFnskuLabels('print', 'per-unit', item.id, copies)}
                                  onDownload={(copies) => handlePrintFnskuLabels('download', 'per-unit', item.id, copies)}
                                />
                              )}
                              <button
                                onClick={() => handleStartEdit(item)}
                                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                                title="Edit"
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                onClick={() => handleRemoveItem(item.id)}
                                className="p-1 text-text-tertiary hover:text-negative hover:bg-negative/10 rounded transition-colors"
                                title="Remove"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )
                        ) : (
                          // Post-draft (ready/boxing/placement): allow quantity
                          // edits inline + per-row label printing.
                          //
                          // Quantity-only edit pencil is shown when the batch
                          // is still editable (ready/boxing/placement). Once
                          // the batch is in 'shipping'+ states, edits are
                          // locked. We use the SAME isEditing state — but
                          // when isEditing is true on a non-draft batch, the
                          // edit form below renders only the quantity field.
                          isEditing ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                onClick={() => handleSaveEdit(item.id)}
                                disabled={savingEdit}
                                className="p-1 text-positive hover:bg-positive/10 rounded transition-colors disabled:opacity-50"
                                title="Save"
                              >
                                {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={savingEdit}
                                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
                                title="Cancel"
                              >
                                <XIcon size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-0.5">
                              {/* "Labeled" toggle — green check when done.
                                  Helps physical labeling: click after each
                                  SKU is fully labeled, the row goes green so
                                  unlabeled rows stand out. */}
                              {item.listingStatus === 'ACTIVE' && batch.channel === 'FBA' && (
                                <button
                                  onClick={() => handleToggleLabeled(item.id, !!item.labelsPrintedAt)}
                                  className={`p-1 rounded transition-colors ${
                                    item.labelsPrintedAt
                                      ? 'text-positive bg-positive/10 hover:bg-positive/20'
                                      : 'text-text-tertiary hover:text-positive hover:bg-positive/10'
                                  }`}
                                  title={item.labelsPrintedAt
                                    ? `Labeled at ${new Date(item.labelsPrintedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} — click to unmark`
                                    : 'Mark this SKU as fully labeled'}
                                >
                                  {item.labelsPrintedAt ? <CheckCircle size={14} /> : <Check size={14} />}
                                </button>
                              )}
                              {/* Edit qty (only in ready/boxing/placement) */}
                              {['ready', 'boxing', 'placement'].includes(batch.status) && (
                                <button
                                  onClick={() => handleStartEdit(item)}
                                  className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                                  title="Edit quantity"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                              {/* Per-row FNSKU print */}
                              {!!item.fnsku && batch.channel === 'FBA' && (
                                <PrintRowButton
                                  defaultQty={item.quantity}
                                  isPrinting={printingItemId === item.id}
                                  onPrint={(copies) => handlePrintFnskuLabels('print', 'per-unit', item.id, copies)}
                                  onDownload={(copies) => handlePrintFnskuLabels('download', 'per-unit', item.id, copies)}
                                />
                              )}
                            </div>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation modal — real Amazon state! */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !sending && setShowSendModal(false)}>
          <div className="panel p-5 w-[480px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <AlertCircle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold">
                  {batch.channel === 'FBA' ? 'Send batch to Amazon?' : 'Publish batch to Amazon?'}
                </h2>
                <p className="text-sm text-text-tertiary mt-1">
                  {batch.channel === 'FBA' ? (
                    <>
                      This will create or update <b className="text-text-primary">{items.length}</b> listing{items.length === 1 ? '' : 's'} in your Seller Central account, and create a real inbound shipment plan for{' '}
                      <b className="text-text-primary">{totalUnits}</b> unit{totalUnits === 1 ? '' : 's'}. This action cannot be undone from FlipLedger — cancellation must happen in Seller Central.
                    </>
                  ) : (
                    <>
                      {mfnPublishMessage}
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="bg-bg-elevated border border-border-subtle rounded p-3 text-xs space-y-1.5 mb-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Channel:</span>
                <span className="text-text-primary">{batch.channel === 'FBA' ? 'Fulfilled by Amazon' : 'Merchant Fulfilled'}</span>
              </div>
              {batch.channel === 'FBA' && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-text-tertiary">Ship from:</span>
                  <span className="text-text-primary text-right">
                    {batch.shipFromCity && batch.shipFromState ? `${batch.shipFromCity}, ${batch.shipFromState}` : <span className="text-negative">missing</span>}
                  </span>
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Expected revenue:</span>
                <span className="text-text-primary tabular-nums">{formatCurrency(totalRevenue)}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Est. profit:</span>
                <span className={`tabular-nums ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                  {formatCurrency(expectedProfit)}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-text-tertiary mb-4">
              Amazon will take ~10–15 minutes to verify any new MSKUs. FlipLedger will poll the status automatically — you can close this page and come back.
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowSendModal(false)}
                disabled={sending}
                className="h-9 px-3 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSendToAmazon()}
                disabled={sending}
                className="h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sending
                  ? (batch.channel === 'FBA' ? 'Sending…' : 'Publishing…')
                  : (batch.channel === 'FBA' ? 'Yes, send to Amazon' : 'Yes, publish to Amazon')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

