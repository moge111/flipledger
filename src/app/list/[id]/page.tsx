'use client';

import { useEffect, useState, useRef, useCallback, use } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { generateMSKU } from '@/lib/listing-msku';
import { ArrowLeft, Search, Plus, Trash2, Package, TrendingUp, DollarSign, Percent, Send, ExternalLink, CheckCircle, AlertCircle, AlertTriangle, Loader2, Archive, Box as BoxIcon, MapPin, Sparkles, Pencil, X as XIcon, Check, ChevronDown, RefreshCw } from 'lucide-react';

interface Batch {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  inboundPlanId: string | null;
  inboundOperationId?: string | null;
  planStatus?: string | null;
  sendError?: string | null;
  sentAt?: string | null;
  shipFromCity: string | null;
  shipFromState: string | null;
  // Phase 3: packing
  packingStatus?: string | null;
  packingError?: string | null;
  packingConfirmedAt?: string | null;
  // Phase 3: placement
  placementStatus?: string | null;
  placementOptionId?: string | null;
  placementFeeCents?: number | null;
  placementError?: string | null;
  placementConfirmedAt?: string | null;
  // Phase 4: transportation (carrier booking)
  transportationStatus?: string | null;
  transportationOptionId?: string | null;
  transportationCarrier?: string | null;
  transportationCostCents?: number | null;
  transportationShippingMode?: string | null;
  transportationConfirmedAt?: string | null;
  transportationError?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BoxItemAssignment {
  id?: number;
  boxId?: number;
  itemId: number;
  quantity: number;
}

interface Box {
  id?: number;
  boxIndex?: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  packingGroupId?: string | null; // which Amazon pack group this box belongs to (for multi-group batches)
  items: BoxItemAssignment[];
}

// Amazon-assigned pack group: a subset of batch items that ship as their own
// shipment (and possibly to a different FC). Multi-group batches must be
// boxed group-by-group.
interface PackGroup {
  id: number;                      // local DB id
  packingGroupId: string;          // Amazon's pgXXX id
  groupIndex: number;
  items: Array<{
    itemId: number;
    sku: string;
    productName: string | null;
    quantity: number;
  }>;
}

interface PlacementFee {
  target: string;
  type: string;
  value: { amount: number; code: string };
  description?: string;
}

interface PlacementOption {
  placementOptionId: string;
  shipmentIds: string[];
  fees: PlacementFee[];
  status: 'OFFERED' | 'ACCEPTED' | 'EXPIRED';
  discounts?: any[];
}

interface BatchItem {
  id: number;
  asin: string;
  sku: string;
  msku: string | null;
  productName: string | null;
  imageUrl: string | null;
  condition: string;
  quantity: number;
  listPriceCents: number;
  buyPriceCents: number;
  estimatedFeeCents: number;
  estimatedShipCents: number;
  supplier: string | null;
  purchaseDate: string | null;
  listingStatus?: string | null;
  listingError?: string | null;
  labelsPrintedAt?: string | null;  // user marks "I'm done labeling this SKU"
  // Pre-flight validation (checked at add time — see /preflight route)
  fnsku?: string | null;
  inboundReady?: number | null;
  prepCategory?: string | null;
  preflightStatus?: string | null;  // READY | PENDING | GATED | CATALOG_ISSUE | STUCK | FAILED | UNPRICED
  preflightDetail?: {
    restriction?: { status: string; reasons: string[]; approvalUrl: string | null };
    errorIssues?: string[];
    catalogDefect?: boolean;
  } | null;
}

interface FeeEstimate {
  totalFeeCents: number;
  referralFeeCents: number;
  fbaFeeCents: number;
  source: 'sp-api' | 'cache' | 'fallback';
}

interface ShippingEstimate {
  costCents: number;
  source: 'per-asin' | 'marketplace-avg' | 'none';
  sampleSize: number;
}

interface ExistingMsku {
  msku: string;
  lastBuyPriceCents: number;
  source: 'live_inventory' | 'inventory_ledger' | 'listing_batch';
  unitsInStock?: number | null;
  /** Fulfillment channel this MSKU is currently registered on, when known. */
  channel?: 'FBA' | 'MFN';
  /** False when reusing it would flip the live listing's channel. */
  compatible?: boolean;
}

interface CatalogResult {
  asin: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  dimensions: { lengthIn?: number; widthIn?: number; heightIn?: number; weightLb?: number } | null;
  source: 'amazon' | 'local';
  avgFeeRate?: number;
  avgSalePrice?: number;
  unitsSoldLast30d?: number;
  unitsSoldLast90d?: number;
  currentFbaStock?: number;
  lastBuyPrice?: number;
  feeEstimate?: FeeEstimate | null;
  feeEstimatePriceCents?: number;
  shippingEstimate?: ShippingEstimate | null;
  existingMskus?: ExistingMsku[];
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft:     'bg-bg-elevated text-text-secondary border-border-default',
    sending:   'bg-accent/10 text-accent border-accent/30',
    ready:     'bg-positive/10 text-positive border-positive/20',
    failed:    'bg-negative/10 text-negative border-negative/30',
    boxing:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
    placement: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    shipping:  'bg-blue-500/10 text-blue-400 border-blue-500/20',
    shipped:   'bg-positive/10 text-positive border-positive/20',
    closed:    'bg-text-tertiary/10 text-text-tertiary border-text-tertiary/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${map[status] || map.draft}`}>
      {status}
    </span>
  );
}

/**
 * Draft-time pre-flight badge for a batch item. Answers "will this item make
 * it onto the truck?" BEFORE send: gated ASINs get an approval deep link,
 * catalog-defective ASINs get flagged as needing a Seller Support case, and
 * items Amazon hasn't FBA-registered yet show as registering/stuck.
 */
function PreflightChip({ item, channel }: { item: BatchItem; channel: string }) {
  const s = item.preflightStatus;
  if (!s) return null;
  switch (s) {
    case 'READY':
      return (
        <span className="text-[9px] text-positive bg-positive/10 px-1 rounded" title={item.fnsku ? `FNSKU ${item.fnsku}` : undefined}>
          {channel === 'FBA' ? 'FBA READY' : 'LIVE'}
        </span>
      );
    case 'GATED': {
      const url = item.preflightDetail?.restriction?.approvalUrl;
      const chip = (
        <span className="text-[9px] text-negative bg-negative/10 px-1 rounded border border-negative/30">
          ⛔ NEEDS APPROVAL{url ? ' ↗' : ''}
        </span>
      );
      return url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open the Seller Central approval request (often instant)">
          {chip}
        </a>
      ) : chip;
    }
    case 'CATALOG_ISSUE':
      return (
        <span
          className="text-[9px] text-amber-400 bg-amber-500/10 px-1 rounded border border-amber-500/30"
          title="Amazon's catalog data for this ASIN is rejecting the listing — usually needs a Seller Support catalog case. May block FNSKU assignment."
        >
          ⚠ CATALOG ISSUE
        </span>
      );
    case 'STUCK':
      return (
        <span
          className="text-[9px] text-amber-400 bg-amber-500/10 px-1 rounded"
          title="No FNSKU yet after 10+ minutes — Amazon hasn't registered this listing for FBA. It may still clear on its own."
        >
          ⏳ NOT FBA-REGISTERED
        </span>
      );
    case 'PENDING':
      return <span className="text-[9px] text-accent bg-accent/10 px-1 rounded">REGISTERING…</span>;
    case 'FAILED':
      return <span className="text-[9px] text-negative bg-negative/10 px-1 rounded">FAILED</span>;
    case 'UNPRICED':
      return (
        <span className="text-[9px] text-text-tertiary bg-bg-elevated px-1 rounded border border-border-default" title="Set a list price — the Amazon listing is created once a price exists.">
          NO PRICE
        </span>
      );
    default:
      return null;
  }
}

export default function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
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
        if (first.avgSalePrice) setListPrice((first.avgSalePrice / 100).toFixed(2));
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
          quantity: parseInt(quantity) || 1,
          listPrice: parseFloat(listPrice) || 0,
          buyPrice: parseFloat(buyPrice) || 0,
          supplier: supplier.trim() || null,
          purchaseDate: new Date().toISOString(),
          estimatedFeeCents: perUnitFeeCents,
          estimatedShipCents: perUnitShipCents,
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

  async function handleRemoveItem(itemId: number) {
    if (!confirm('Remove this item from the batch?')) return;
    try {
      await fetch(`/api/list/batches/${id}/items/${itemId}`, { method: 'DELETE' });
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
        quantity: parseInt(editForm.quantity) || 1,
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

  // ─── Single-item preview (what the user is about to add) ─────────
  const previewQty = parseInt(quantity) || 1;
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
  const previewRoi = previewBuy > 0 ? (previewProfit / (previewBuy * previewQty)) * 100 : 0;

  if (loading || !batch) {
    return (
      <div className="text-text-tertiary">Loading batch…</div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link href="/list" className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{batch.name}</h1>
              <StatusBadge status={batch.status} />
              <span className="text-xs text-text-tertiary uppercase tracking-wider">{batch.channel}</span>
            </div>
            <p className="text-xs text-text-tertiary mt-0.5">Created {new Date(batch.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
          </div>
        </div>

        {/* Right-side actions */}
        <div className="flex items-center gap-2">
          {batch.status === 'draft' && (
            <Link
              href={`/list/${batch.id}/import`}
              className="flex items-center gap-2 h-9 px-4 bg-bg-elevated text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
            >
              <Plus size={14} />
              Import items
            </Link>
          )}
          {batch.status === 'draft' && items.length > 0 && (
            <button
              onClick={() => setShowSendModal(true)}
              className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
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
                className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
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
                className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
                className="flex items-center gap-2 h-9 px-3 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                title="Pull the current batch state from Amazon. Use after finishing packing/placement in Seller Central."
              >
                {syncingFromAmazon ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {syncingFromAmazon ? 'Syncing…' : 'Sync from Amazon'}
              </button>
              <a
                href={`https://sellercentral.amazon.com/fba/sendtoamazon/pack_mixed_unit_step?wf=${batch.inboundPlanId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
              className="flex items-center gap-2 h-9 px-4 bg-positive text-white rounded-md text-sm font-medium hover:bg-positive/90 transition-colors"
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
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-amber-500/30 rounded-md text-sm text-amber-400 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
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
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <Package size={12} /> Units
          </div>
          <div className="text-xl font-semibold text-text-primary mt-1">{totalUnits}</div>
          <div className="text-[11px] text-text-tertiary">{items.length} SKU{items.length === 1 ? '' : 's'}</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <DollarSign size={12} /> Expected Revenue
          </div>
          <div className="text-xl font-semibold text-text-primary mt-1">{formatCurrency(totalRevenue)}</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="text-[10px] font-medium tracking-widest uppercase text-text-tertiary">Cost + Fees{totalShip > 0 ? ' + Ship' : ''}</div>
          <div className="text-xl font-semibold text-text-secondary mt-1">{formatCurrency(totalCost + totalFees + totalShip)}</div>
          <div className="text-[11px] text-text-tertiary">
            {formatCurrency(totalCost)} cost · {formatCurrency(totalFees)} fees
            {totalShip > 0 && <> · {formatCurrency(totalShip)} ship</>}
          </div>
        </div>
        <div className="bg-bg-surface border border-accent/30 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-accent">
            <TrendingUp size={12} /> Expected Profit
          </div>
          <div className={`text-xl font-semibold mt-1 ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
            {formatCurrency(expectedProfit)}
          </div>
          <div className="text-[11px] text-text-tertiary">{margin.toFixed(1)}% margin</div>
        </div>
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest uppercase text-text-tertiary">
            <Percent size={12} /> ROI
          </div>
          <div className={`text-xl font-semibold mt-1 ${roi >= 30 ? 'text-positive' : roi >= 0 ? 'text-text-primary' : 'text-negative'}`}>
            {roi.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Scan / add item form */}
      {batch.status === 'draft' && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden mb-5">
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
                  className="w-full h-10 pl-9 pr-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-accent font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={!query.trim() || searching}
                className="h-10 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
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
                        className="inline-flex items-center gap-1 hover:text-accent transition-colors"
                        title="Open Amazon listing in a new tab"
                      >
                        {scanned.asin}
                        <ExternalLink size={11} className="opacity-60" />
                      </a>
                      {scanned.brand && <span>· {scanned.brand}</span>}
                      <span className={`ml-auto px-1.5 py-0.5 rounded ${scanned.source === 'local' ? 'bg-positive/10 text-positive' : 'bg-accent/10 text-accent'}`}>
                        {scanned.source === 'local' ? 'IN YOUR CATALOG' : 'FROM AMAZON'}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 text-[11px]">
                      <div>
                        <span className="text-text-tertiary">Avg sale: </span>
                        <span className="text-text-primary font-mono">{scanned.avgSalePrice ? formatCurrency(scanned.avgSalePrice) : '—'}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">Est. fees: </span>
                        {scanned.feeEstimate ? (
                          <span className="text-text-primary font-mono" title={`Referral: ${formatCurrency(scanned.feeEstimate.referralFeeCents)}${scanned.feeEstimate.fbaFeeCents ? ' · FBA: ' + formatCurrency(scanned.feeEstimate.fbaFeeCents) : ''} · ${scanned.feeEstimate.source}`}>
                            {formatCurrency(scanned.feeEstimate.totalFeeCents)}
                          </span>
                        ) : (
                          <span className="text-text-tertiary font-mono">—</span>
                        )}
                      </div>
                      <div>
                        <span className="text-text-tertiary">Sold 30d: </span>
                        <span className="text-text-primary font-mono">{scanned.unitsSoldLast30d ?? 0}</span>
                      </div>
                      <div>
                        <span className="text-text-tertiary">FBA stock: </span>
                        <span className="text-text-primary font-mono">{scanned.currentFbaStock ?? 0}</span>
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
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors font-mono"
                                  title={`Use this MSKU (no new Amazon listing will be created). Buy price ${m.lastBuyPriceCents > 0 ? '$' + (m.lastBuyPriceCents / 100).toFixed(2) : 'unknown'} from ${m.source}${m.unitsInStock ? ` · ${m.unitsInStock} in FBA` : ''}`}
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
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary flex items-center gap-1">
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
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Condition</label>
                    <select
                      value={condition}
                      onChange={(e) => setCondition(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-accent"
                    >
                      <option value="NewItem">New</option>
                      <option value="UsedLikeNew">Used - Like New</option>
                      <option value="UsedVeryGood">Used - Very Good</option>
                      <option value="UsedGood">Used - Good</option>
                      <option value="UsedAcceptable">Used - Acceptable</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Qty</label>
                    <input
                      autoComplete="off"
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Buy Price ($)</label>
                    <input
                      autoComplete="off"
                      type="number"
                      step="0.01"
                      value={buyPrice}
                      onChange={(e) => setBuyPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">List Price ($)</label>
                    <input
                      autoComplete="off"
                      type="number"
                      step="0.01"
                      value={listPrice}
                      onChange={(e) => setListPrice(e.target.value)}
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  {batch.channel === 'MFN' && (
                    <div>
                      <label className="text-[10px] uppercase tracking-widest text-text-tertiary flex items-center gap-1">
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
                        className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm font-mono focus:outline-none focus:border-accent"
                      />
                    </div>
                  )}
                  <div className={batch.channel === 'MFN' ? 'col-span-1' : 'col-span-2'}>
                    <label className="text-[10px] uppercase tracking-widest text-text-tertiary">Supplier</label>
                    <input
                      autoComplete="off"
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      placeholder="Walmart, Target, …"
                      className="w-full mt-1 h-9 px-2 bg-bg-elevated border border-border-default rounded text-sm focus:outline-none focus:border-accent"
                    />
                  </div>

                  {/* Per-item preview */}
                  <div className="col-span-6 border-t border-border-subtle pt-3 mt-1 flex items-center justify-between">
                    <div className="text-xs text-text-tertiary">
                      Projected: <span className={`font-mono ${previewProfit >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(Math.round(previewProfit * 100))}</span>{' '}
                      profit · <span className="text-text-primary font-mono">{previewRoi.toFixed(1)}%</span> ROI{' '}
                      · fees <span className="text-text-primary font-mono">{formatCurrency(previewPerUnitFeeCents * previewQty)}</span>
                      {previewShipTotal > 0 && (
                        <> · ship <span className="text-text-primary font-mono">{formatCurrency(Math.round(previewShipTotal * 100))}</span></>
                      )}
                      <span className="ml-1 text-text-tertiary">({feeSourceLabel})</span>
                    </div>
                    <button
                      onClick={handleAddItem}
                      disabled={!sku || !buyPrice || saving}
                      className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
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
      <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">Batch Items</span>
            <span className="text-xs text-text-tertiary">({items.length})</span>
            {/* Pre-flight shape of the batch — know BEFORE hitting Send */}
            {batch.status === 'draft' && items.length > 0 && (() => {
              const count = (s: string) => items.filter((i) => i.preflightStatus === s).length;
              const ready = count('READY');
              const pending = count('PENDING') + items.filter((i) => !i.preflightStatus && i.listPriceCents > 0).length;
              const gated = count('GATED');
              const catalog = count('CATALOG_ISSUE');
              const stuck = count('STUCK');
              const failed = count('FAILED');
              const unpriced = count('UNPRICED') + items.filter((i) => !i.preflightStatus && (!i.listPriceCents || i.listPriceCents <= 0)).length;
              const parts: { label: string; cls: string }[] = [];
              if (ready > 0) parts.push({ label: `${ready} ready`, cls: 'text-positive' });
              if (pending > 0) parts.push({ label: `${pending} registering`, cls: 'text-accent' });
              if (gated > 0) parts.push({ label: `${gated} needs approval`, cls: 'text-negative' });
              if (catalog > 0) parts.push({ label: `${catalog} catalog issue`, cls: 'text-amber-400' });
              if (stuck > 0) parts.push({ label: `${stuck} not registered`, cls: 'text-amber-400' });
              if (failed > 0) parts.push({ label: `${failed} failed`, cls: 'text-negative' });
              if (unpriced > 0) parts.push({ label: `${unpriced} no price`, cls: 'text-text-tertiary' });
              if (parts.length === 0) return null;
              return (
                <span className="text-[11px] font-mono flex items-center gap-1.5 ml-2">
                  {parts.map((p, i) => (
                    <span key={p.label} className={p.cls}>
                      {i > 0 && <span className="text-text-tertiary/50 mr-1.5">·</span>}
                      {p.label}
                    </span>
                  ))}
                </span>
              );
            })()}
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
                <tr className="bg-bg-elevated">
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Condition</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Buy</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">List</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Est. Fees</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Est. Profit</th>
                  <th className="px-2 py-2.5 border-b border-border-subtle w-10"></th>
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
                              className="text-sm text-text-primary hover:text-accent hover:underline truncate max-w-[400px] block"
                              title={item.productName || ''}
                            >
                              {item.productName || item.asin}
                            </a>
                            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-mono">
                              <span>{item.sku}</span>
                              {item.fnsku && (
                                <span className="text-[10px] text-text-tertiary/70">· {item.fnsku}</span>
                              )}
                              {batch.status === 'draft' && item.preflightStatus ? (
                                // Draft: pre-flight badge (gating / catalog / FNSKU state)
                                <PreflightChip item={item} channel={batch.channel} />
                              ) : (
                                // Post-send: listing lifecycle chips
                                <>
                                  {item.listingStatus === 'ACTIVE' && (
                                    <span className="text-[9px] text-positive bg-positive/10 px-1 rounded">LIVE</span>
                                  )}
                                  {item.listingStatus === 'PROCESSING' && (
                                    <span className="text-[9px] text-accent bg-accent/10 px-1 rounded">PROCESSING</span>
                                  )}
                                  {item.listingStatus === 'FAILED' && (
                                    <span className="text-[9px] text-negative bg-negative/10 px-1 rounded">FAILED</span>
                                  )}
                                  {item.listingStatus === 'NOT_INBOUND_READY' && (
                                    <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1 rounded">EXCLUDED</span>
                                  )}
                                </>
                              )}
                            </div>
                            {/* Inline warning / error message — always visible, not a tooltip */}
                            {item.listingError && (
                              <div
                                className={`text-[11px] mt-0.5 leading-snug ${
                                  item.listingStatus === 'FAILED' ? 'text-negative' : 'text-amber-400'
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
                            className="w-full h-7 px-1 bg-bg-elevated border border-border-default rounded text-xs focus:outline-none focus:border-accent"
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
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">
                        {isEditing ? (
                          <input
                            autoComplete="off"
                            type="number"
                            min="1"
                            value={editForm.quantity}
                            onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
                            className="w-14 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : item.quantity}
                      </td>
                      {/* Buy — editable, FlipLedger-local (affects FIFO/COGS, not Amazon) */}
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">
                        {isEditing ? (
                          <input
                            autoComplete="off"
                            type="number"
                            step="0.01"
                            value={editForm.buyPrice}
                            onChange={(e) => setEditForm({ ...editForm, buyPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : formatCurrency(cost)}
                      </td>
                      {/* List — only editable in draft (post-draft would silently diverge from live Amazon listing) */}
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">
                        {isEditing && batch.status === 'draft' ? (
                          <input
                            autoComplete="off"
                            type="number"
                            step="0.01"
                            value={editForm.listPrice}
                            onChange={(e) => setEditForm({ ...editForm, listPrice: e.target.value })}
                            className="w-20 h-7 px-1 text-right bg-bg-elevated border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent"
                          />
                        ) : formatCurrency(rev)}
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">
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
                      <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${profit >= 0 ? 'text-positive' : 'text-negative'}`}>
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
                              <button
                                onClick={() => handleStartEdit(item)}
                                className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors"
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
                                  className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors"
                                  title="Edit quantity"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                              {/* Per-row FNSKU print */}
                              {item.listingStatus === 'ACTIVE' && batch.channel === 'FBA' && (
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
          <div className="bg-bg-surface border border-border-default rounded-lg p-5 w-[480px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <AlertCircle size={20} className="text-amber-400 shrink-0 mt-0.5" />
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
                      This will create <b className="text-text-primary">{items.length}</b> merchant-fulfilled listing{items.length === 1 ? '' : 's'} on Amazon for <b className="text-text-primary">{totalUnits}</b> unit{totalUnits === 1 ? '' : 's'}. As soon as Amazon finishes verification, customers can buy them — and you&apos;ll be responsible for shipping each order yourself. Unpublishing must be done from Seller Central.
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
                <span className="font-mono text-text-primary">{formatCurrency(totalRevenue)}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-tertiary">Est. profit:</span>
                <span className={`font-mono ${expectedProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
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
                className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-2"
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

// ─── SendStatusCard ─────────────────────────────────────────────────────────
// Renders the progress of an in-flight or completed send operation.
function SendStatusCard({ batch, items }: { batch: Batch; items: BatchItem[] }) {
  const listingsReady = items.filter((i) => i.listingStatus === 'ACTIVE').length;
  const listingsFailed = items.filter((i) => i.listingStatus === 'FAILED').length;
  const listingsProcessing = items.filter((i) => i.listingStatus === 'PROCESSING').length;
  const totalListings = items.length;

  const isFBA = batch.channel === 'FBA';
  const planState = batch.planStatus || 'IN_PROGRESS';

  const isSending = batch.status === 'sending';
  const isReady = batch.status === 'ready';
  const isFailed = batch.status === 'failed';

  return (
    <div className={`rounded-lg p-4 mb-5 border ${
      isFailed ? 'border-negative/30 bg-negative/5' :
      isReady ? 'border-positive/30 bg-positive/5' :
      'border-accent/30 bg-accent/5'
    }`}>
      <div className="flex items-center gap-2 mb-3">
        {isFailed ? (
          <AlertCircle size={18} className="text-negative" />
        ) : isReady ? (
          <CheckCircle size={18} className="text-positive" />
        ) : (
          <Loader2 size={18} className="text-accent animate-spin" />
        )}
        <h3 className={`text-sm font-medium ${
          isFailed ? 'text-negative' : isReady ? 'text-positive' : 'text-accent'
        }`}>
          {isFailed
            ? (isFBA ? 'Send failed' : 'Publish failed')
            : isReady
              ? (isFBA ? 'Inbound plan ready' : 'Listings live on Amazon')
              : (isFBA ? 'Sending to Amazon…' : 'Publishing to Amazon…')}
        </h3>
      </div>

      {isFailed && batch.sendError && (
        <div className="text-xs text-text-primary bg-bg-elevated rounded p-2 mb-3 font-mono whitespace-pre-wrap">
          {batch.sendError}
        </div>
      )}

      <div className={`grid grid-cols-1 ${isFBA ? 'sm:grid-cols-2' : ''} gap-3 text-xs`}>
        <div className="bg-bg-elevated rounded p-3">
          <div className="text-text-tertiary uppercase tracking-wider text-[10px] font-medium mb-1">Listings</div>
          <div className="text-text-primary font-mono">
            {listingsReady} active / {listingsProcessing} processing
            {listingsFailed > 0 && <span className="text-negative"> / {listingsFailed} failed</span>}
            <span className="text-text-tertiary"> of {totalListings}</span>
          </div>
        </div>
        {isFBA && (
          <div className="bg-bg-elevated rounded p-3">
            <div className="text-text-tertiary uppercase tracking-wider text-[10px] font-medium mb-1">Inbound plan</div>
            <div className="text-text-primary font-mono">
              {planState === 'SUCCESS' ? 'Active' : planState === 'FAILED' ? 'Failed' : 'Creating…'}
              {batch.inboundPlanId && (
                <span className="text-text-tertiary ml-1 text-[10px]">({batch.inboundPlanId.slice(0, 12)}…)</span>
              )}
            </div>
          </div>
        )}
      </div>

      {isSending && (
        <p className="text-[11px] text-text-tertiary mt-3">
          Amazon is verifying your MSKUs. This usually takes 10–15 minutes for new items and is near-instant for restocks.
          You can close this page and come back — FlipLedger will track it.
        </p>
      )}
    </div>
  );
}

// ─── BoxingWorkflow ─────────────────────────────────────────────────────────
//
// Phase 3 UI. Drives the batch through three sub-phases:
//   1. Boxing:    enter box dimensions + assign items to boxes
//   2. Placement: Amazon returns 3 options (Optimized/Partial/Minimal), pick one
//   3. Shipping:  confirmed placement — show shipment IDs + destinations (map TBD)

interface BoxingWorkflowProps {
  batch: Batch;
  items: BatchItem[];
  boxes: Box[];
  packGroups: PackGroup[];
  placementOptions: PlacementOption[];
  savingBoxes: boolean;
  packing: boolean;
  loadingPlacement: boolean;
  confirmingPlacementId: string | null;
  onAddBox: (packingGroupId?: string) => void;
  onRemoveBox: (idx: number) => void;
  onUpdateBoxField: (idx: number, field: keyof Box, value: number) => void;
  onSetBoxItemQty: (boxIdx: number, itemId: number, qty: number) => void;
  onSaveBoxes: () => void;
  onConfirmPacking: () => void;
  onGeneratePlacement: () => void;
  onLoadPlacement: () => void;
  onConfirmPlacement: (optionId: string) => void;
}

function BoxingWorkflow({
  batch,
  items,
  boxes,
  packGroups,
  placementOptions,
  savingBoxes,
  packing,
  loadingPlacement,
  confirmingPlacementId,
  onAddBox,
  onRemoveBox,
  onUpdateBoxField,
  onSetBoxItemQty,
  onSaveBoxes,
  onConfirmPacking,
  onGeneratePlacement,
  onLoadPlacement,
  onConfirmPlacement,
}: BoxingWorkflowProps) {
  // Auto-load placement options when we first transition into placement state
  useEffect(() => {
    if (batch.status === 'placement' && placementOptions.length === 0) {
      onLoadPlacement();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.status]);

  // Per-placement-option shipping estimates (Partnered UPS) so the cards can
  // show "placement fee + shipping = total" BEFORE choosing. Fetched
  // sequentially — each estimate may trigger a transportation-options
  // generation op on the same plan, and concurrent ops can conflict.
  const [shipEstimates, setShipEstimates] = useState<Record<string, { loading: boolean; totalCents: number | null }>>({});

  useEffect(() => {
    if (batch.status !== 'placement' || placementOptions.length === 0) return;
    const pending = placementOptions.filter((o) => shipEstimates[o.placementOptionId] === undefined);
    if (pending.length === 0) return;
    let cancelled = false;
    setShipEstimates((prev) => {
      const next = { ...prev };
      for (const o of pending) next[o.placementOptionId] = { loading: true, totalCents: null };
      return next;
    });
    (async () => {
      for (const opt of pending) {
        if (cancelled) return;
        let totalCents: number | null = null;
        try {
          const res = await fetch(
            `/api/list/batches/${batch.id}/placement/shipping-estimate?placementOptionId=${encodeURIComponent(opt.placementOptionId)}`
          );
          if (res.ok) {
            const data = await res.json();
            totalCents = data.partneredTotalCents ?? null;
          }
        } catch { /* leave null — card shows an em dash */ }
        if (cancelled) return;
        setShipEstimates((prev) => ({ ...prev, [opt.placementOptionId]: { loading: false, totalCents } }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.status, placementOptions]);

  // Phase 4: Shipments + label printing — fetched once we hit shipping status
  const [shipments, setShipments] = useState<Array<{
    shipmentId: string;
    name: string;
    status: string;
    destination: { city?: string; stateOrProvinceCode?: string; postalCode?: string } | null;
    destinationFC: string | null;
    boxCount: number | null;
  }>>([]);
  const [printingLabel, setPrintingLabel] = useState<string | null>(null); // key: `${type}-${shipmentId}`
  const [copyBoxesFlash, setCopyBoxesFlash] = useState(false);

  useEffect(() => {
    if (batch.status !== 'shipping' && batch.status !== 'shipped') return;
    if (shipments.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/list/batches/${batch.id}/shipments`);
        const data = await res.json();
        if (!cancelled && data.shipments) setShipments(data.shipments);
      } catch (err) {
        console.warn('shipments fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [batch.status, batch.id, shipments.length]);

  async function handlePrintLabels(shipmentId: string, type: 'fnsku' | 'box' | 'shipping') {
    const key = `${type}-${shipmentId}`;
    setPrintingLabel(key);
    const labelName = type === 'fnsku' ? 'FNSKU' : type === 'box' ? 'Box ID' : 'Shipping';
    try {
      const res = await fetch(
        `/api/list/batches/${batch.id}/labels?type=${type}&shipmentId=${encodeURIComponent(shipmentId)}&action=print&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      const data = await res.json();
      if (data.success) {
        alert(`✓ Printed ${labelName} labels for ${shipmentId}\nPrinter: ${data.printer}${data.jobId ? ' (job ' + data.jobId + ')' : ''}`);
      } else {
        const hint = data.hint ? `\n\n${data.hint}` : '';
        alert(`Print failed: ${data.error}${hint}\n\nTry "Download PDF" instead and print manually.`);
      }
    } catch (err) {
      alert(`Print error: ${err}`);
    }
    setPrintingLabel(null);
  }

  function handleDownloadLabels(shipmentId: string, type: 'fnsku' | 'box' | 'shipping') {
    // Use a simple link click — the browser handles the PDF download via Content-Disposition
    const url = `/api/list/batches/${batch.id}/labels?type=${type}&shipmentId=${encodeURIComponent(shipmentId)}&action=download`;
    window.open(url, '_blank');
  }

  // Build an itemId → batch item map for quick lookups
  const itemMap = new Map<number, BatchItem>();
  for (const it of items) itemMap.set(it.id, it);

  // For each batch item, how many units are already allocated across boxes?
  const allocated = new Map<number, number>();
  for (const box of boxes) {
    for (const bi of box.items) {
      allocated.set(bi.itemId, (allocated.get(bi.itemId) || 0) + bi.quantity);
    }
  }
  // Only items actually in the shipment need to be boxed. Items excluded at
  // Send (NOT_INBOUND_READY — no FNSKU — or FAILED) were dropped from the
  // inbound plan and aren't in any Amazon pack group, so they can never be
  // allocated to a box. Counting them would leave `fullyAllocated` false
  // forever and permanently disable "Confirm packing" even when every
  // shippable item is boxed. (July 8, 2026: the excluded Giganotosaurus did
  // exactly this on batch 28.)
  const shippableItems = items.filter((it) => it.listingStatus === 'ACTIVE');
  const fullyAllocated = shippableItems.every((it) => (allocated.get(it.id) || 0) === it.quantity);

  // Multi-group: pre-compute which boxes belong to each pack group, plus
  // per-group unallocated items. For single-group batches we render the same
  // layout but without the group headers.
  const isMultiGroup = packGroups.length > 1;
  const groupSections: Array<{
    group: PackGroup | null;          // null for single-group batches with no group metadata
    boxIndices: number[];             // indexes into the global boxes[] array
    unallocatedInGroup: Array<{ item: BatchItem; remaining: number }>;
  }> = [];

  if (packGroups.length === 0) {
    // No group metadata yet — treat all boxes as one section, all batch items as that section's expected items
    const unallocatedInGroup = shippableItems
      .map((it) => ({ item: it, remaining: it.quantity - (allocated.get(it.id) || 0) }))
      .filter((x) => x.remaining > 0);
    groupSections.push({
      group: null,
      boxIndices: boxes.map((_, i) => i),
      unallocatedInGroup,
    });
  } else {
    for (const g of packGroups) {
      const boxIndices = boxes
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.packingGroupId === g.packingGroupId)
        .map(({ i }) => i);
      const groupItemIds = new Set(g.items.map((it) => it.itemId));
      const allocatedInThisGroup = new Map<number, number>();
      for (const idx of boxIndices) {
        for (const bi of boxes[idx].items) {
          if (groupItemIds.has(bi.itemId)) {
            allocatedInThisGroup.set(bi.itemId, (allocatedInThisGroup.get(bi.itemId) || 0) + bi.quantity);
          }
        }
      }
      const unallocatedInGroup = g.items
        .map((it) => {
          const batchItem = itemMap.get(it.itemId);
          if (!batchItem) return null;
          const remaining = it.quantity - (allocatedInThisGroup.get(it.itemId) || 0);
          return remaining > 0 ? { item: batchItem, remaining } : null;
        })
        .filter((x): x is { item: BatchItem; remaining: number } => x !== null);
      groupSections.push({ group: g, boxIndices, unallocatedInGroup });
    }
  }

  const totalUnallocated = groupSections.reduce((s, sec) => s + sec.unallocatedInGroup.length, 0);

  // Total boxes weight for the summary bar
  const totalBoxWeight = boxes.reduce((sum, b) => sum + (b.weightLb || 0), 0);

  const isBoxingPhase = batch.status === 'ready' || batch.status === 'boxing';
  const isPlacementPhase = batch.status === 'placement';
  const isShippingPhase = batch.status === 'shipping';
  const packingLocked = batch.packingStatus === 'SUCCESS';

  return (
    <div className="bg-bg-surface border border-accent/20 rounded-lg mb-5 overflow-hidden">
      {/* Workflow header + step indicator */}
      <div className="px-4 py-3 border-b border-border-subtle bg-accent/5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <h3 className="text-sm font-medium text-text-primary">Ship to Amazon</h3>
          </div>
          <div className="flex items-center gap-2">
            {boxes.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const lines: string[] = [];
                  lines.push(`Boxing layout for ${batch?.name || 'batch'} — paste-friendly`);
                  lines.push('');
                  boxes.forEach((box, i) => {
                    lines.push(`Box ${i + 1}: ${box.lengthIn}×${box.widthIn}×${box.heightIn} in · ${box.weightLb} lb`);
                    box.items.forEach((bi) => {
                      const it = items.find((x) => x.id === bi.itemId);
                      const name = it?.productName || it?.sku || 'unknown';
                      const sku = it?.sku || '';
                      lines.push(`  - ${bi.quantity}× ${name}${sku ? `  [${sku}]` : ''}`);
                    });
                    lines.push('');
                  });
                  const text = lines.join('\n');
                  navigator.clipboard.writeText(text).then(() => {
                    setCopyBoxesFlash(true);
                    setTimeout(() => setCopyBoxesFlash(false), 2000);
                  });
                }}
                className="text-[11px] text-text-tertiary hover:text-accent transition-colors"
                title="Copy a paste-ready summary of your boxes for Seller Central re-entry"
              >
                {copyBoxesFlash ? '✓ Copied' : '📋 Copy layout'}
              </button>
            )}
            <div className="text-xs text-text-tertiary font-mono">
              {boxes.length} box{boxes.length === 1 ? '' : 'es'} · {totalBoxWeight.toFixed(1)} lb total
            </div>
          </div>
        </div>
        {/* Three-step breadcrumb */}
        <div className="flex items-center gap-2 text-[11px]">
          <StepChip
            label="1. Box"
            active={isBoxingPhase}
            done={packingLocked || isPlacementPhase || isShippingPhase}
          />
          <span className="text-text-tertiary">→</span>
          <StepChip
            label="2. Placement"
            active={isPlacementPhase}
            done={isShippingPhase || !!batch.placementOptionId}
          />
          <span className="text-text-tertiary">→</span>
          <StepChip label="3. Ship" active={isShippingPhase} done={false} />
        </div>
      </div>

      {/* ─── Step 1: Boxing ─── */}
      {isBoxingPhase && (
        <div className="p-4 space-y-4">
          {/* Multi-group banner: tell the user what Amazon decided */}
          {isMultiGroup && (
            <div className="text-[11px] text-text-secondary bg-accent/5 border border-accent/20 rounded p-2.5">
              <strong className="text-accent">Amazon split this batch into {packGroups.length} pack groups.</strong>{' '}
              Each group ships separately and may go to a different fulfillment center. Box each group&apos;s items in their own boxes below.
            </div>
          )}

          {/* Per-group sections */}
          {groupSections.map((section, sectionIdx) => {
            const isLastSection = sectionIdx === groupSections.length - 1;
            return (
              <div
                key={section.group?.packingGroupId || 'single'}
                className={isMultiGroup ? 'border border-accent/20 rounded-lg overflow-hidden' : ''}
              >
                {/* Group header (only shown for multi-group) */}
                {isMultiGroup && section.group && (
                  <div className="px-3 py-2 bg-accent/10 border-b border-accent/20 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white text-[10px] font-semibold">
                        {sectionIdx + 1}
                      </span>
                      <span className="text-xs font-medium text-text-primary">Pack Group {sectionIdx + 1}</span>
                      <span className="text-[10px] text-text-tertiary font-mono">{section.group.packingGroupId.slice(0, 12)}…</span>
                    </div>
                    <span className="text-[11px] text-text-tertiary">
                      {section.group.items.reduce((s, it) => s + it.quantity, 0)} unit{section.group.items.reduce((s, it) => s + it.quantity, 0) === 1 ? '' : 's'} · {section.boxIndices.length} box{section.boxIndices.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                )}

                <div className={isMultiGroup ? 'p-3 space-y-3' : 'space-y-3'}>
                  {/* Box list for this group */}
                  {section.boxIndices.map((idx, boxIdxInSection) => {
                    const box = boxes[idx];
                    const boxItemsInThisBox = box.items.map((bi) => ({
                      batchItem: itemMap.get(bi.itemId),
                      quantity: bi.quantity,
                    }));
                    const boxUnits = box.items.reduce((s, bi) => s + bi.quantity, 0);
                    return (
                      <div key={idx} className="border border-border-subtle rounded-lg bg-bg-elevated overflow-hidden">
                        <div className="px-3 py-2 flex items-center gap-3 border-b border-border-subtle">
                          <BoxIcon size={14} className="text-text-tertiary" />
                          <span className="text-xs font-medium text-text-primary">Box {boxIdxInSection + 1}</span>
                          <span className="text-[11px] text-text-tertiary ml-auto">{boxUnits} unit{boxUnits === 1 ? '' : 's'}</span>
                          {!packingLocked && section.boxIndices.length > 1 && (
                            <button
                              onClick={() => onRemoveBox(idx)}
                              className="p-1 text-text-tertiary hover:text-negative transition-colors"
                              title="Remove box"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                        <div className="p-3 grid grid-cols-4 gap-2">
                          <DimensionInput label="L (in)" value={box.lengthIn} onChange={(v) => onUpdateBoxField(idx, 'lengthIn', v)} disabled={packingLocked} />
                          <DimensionInput label="W (in)" value={box.widthIn} onChange={(v) => onUpdateBoxField(idx, 'widthIn', v)} disabled={packingLocked} />
                          <DimensionInput label="H (in)" value={box.heightIn} onChange={(v) => onUpdateBoxField(idx, 'heightIn', v)} disabled={packingLocked} />
                          <DimensionInput label="Weight (lb)" value={box.weightLb} onChange={(v) => onUpdateBoxField(idx, 'weightLb', v)} disabled={packingLocked} />
                        </div>
                        <div className="px-3 pb-3">
                          <div className="text-[10px] uppercase tracking-widest text-text-tertiary mb-1.5">Contents</div>
                          {boxItemsInThisBox.length === 0 ? (
                            <div className="text-[11px] text-text-tertiary italic py-1">No items assigned yet</div>
                          ) : (
                            <div className="space-y-1">
                              {boxItemsInThisBox.map(({ batchItem, quantity }) => {
                                if (!batchItem) return null;
                                return (
                                  <div key={batchItem.id} className="flex items-center gap-2 text-[11px]">
                                    <span className="text-text-primary truncate flex-1" title={batchItem.productName || ''}>
                                      {batchItem.productName || batchItem.asin}
                                    </span>
                                    <span className="text-text-tertiary font-mono">{batchItem.sku}</span>
                                    {packingLocked ? (
                                      <span className="text-text-secondary font-mono w-10 text-right">× {quantity}</span>
                                    ) : (
                                      <input
                                        autoComplete="off"
                                        type="number"
                                        min="0"
                                        max={batchItem.quantity}
                                        value={quantity}
                                        onChange={(e) => onSetBoxItemQty(idx, batchItem.id, parseInt(e.target.value) || 0)}
                                        className="w-12 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] font-mono focus:outline-none focus:border-accent"
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Unallocated items in this group */}
                  {!packingLocked && section.unallocatedInGroup.length > 0 && (
                    <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3">
                      <div className="text-[11px] text-amber-400 mb-1.5 font-medium uppercase tracking-widest">
                        Unassigned items {isMultiGroup ? `(in this group)` : ''}
                      </div>
                      <div className="space-y-1">
                        {section.unallocatedInGroup.map(({ item: it, remaining }) => (
                          <UnassignedItemRow
                            key={it.id}
                            item={it}
                            remaining={remaining}
                            boxIndices={section.boxIndices}
                            boxes={boxes}
                            onAdd={(boxIdx, qty) => {
                              const existing = boxes[boxIdx].items.find((bi) => bi.itemId === it.id);
                              const newQty = (existing?.quantity || 0) + qty;
                              onSetBoxItemQty(boxIdx, it.id, newQty);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Per-group "Add box" button */}
                  {!packingLocked && (
                    <button
                      onClick={() => onAddBox(section.group?.packingGroupId)}
                      className="h-8 px-3 bg-bg-elevated border border-border-default rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
                    >
                      <Plus size={12} /> Add box {isMultiGroup ? `to group ${sectionIdx + 1}` : ''}
                    </button>
                  )}
                </div>

                {/* Spacer between groups */}
                {!isLastSection && isMultiGroup && <div className="h-1" />}
              </div>
            );
          })}

          {/* Global action bar */}
          {!packingLocked && (
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
              <button
                onClick={onSaveBoxes}
                disabled={savingBoxes || packing || boxes.length === 0}
                className="h-9 px-3 bg-bg-elevated border border-border-default rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Save boxes to FlipLedger without pushing to Amazon (partial progress OK)"
              >
                {savingBoxes ? 'Saving…' : 'Save draft'}
              </button>
              <button
                onClick={onConfirmPacking}
                disabled={packing || !fullyAllocated || boxes.length === 0}
                className="h-9 px-4 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {packing ? <Loader2 size={12} className="animate-spin" /> : <BoxIcon size={12} />}
                {packing ? 'Confirming with Amazon…' : 'Confirm packing'}
              </button>
            </div>
          )}

          {!fullyAllocated && !packingLocked && totalUnallocated > 0 && (
            <p className="text-[11px] text-amber-400">
              All items must be fully assigned to boxes before you can confirm packing.
            </p>
          )}

          {batch.packingError && (
            <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded p-2 font-mono">
              Packing error: {batch.packingError}
            </div>
          )}
        </div>
      )}

      {/* ─── Step 2: Placement ─── */}
      {(isPlacementPhase || isShippingPhase) && (
        <div className="p-4 space-y-3">
          {loadingPlacement && placementOptions.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-text-tertiary">
              <Loader2 size={12} className="animate-spin" />
              Loading placement options from Amazon…
            </div>
          )}

          {/* Show the generate button when options haven't been generated yet
              OR when a previous generate FAILED (transient Amazon errors) —
              otherwise a failed generate is a dead-end with no retry path. */}
          {!loadingPlacement && placementOptions.length === 0 && isPlacementPhase &&
            (!batch.placementStatus || batch.placementStatus === 'FAILED') && (
            <button
              onClick={onGeneratePlacement}
              className="h-9 px-4 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 transition-colors flex items-center gap-1.5"
            >
              <MapPin size={12} />
              {batch.placementStatus === 'FAILED' ? 'Retry placement options' : 'Generate placement options'}
            </button>
          )}

          {placementOptions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {placementOptions.map((opt, idx) => {
                const feeCents = opt.fees.reduce(
                  (sum, f) => sum + Math.round((f.value?.amount || 0) * 100),
                  0
                );
                const isConfirmed = batch.placementOptionId === opt.placementOptionId;
                const isConfirming = confirmingPlacementId === opt.placementOptionId;
                const shipmentCount = opt.shipmentIds.length;
                // Amazon returns options in order of decreasing destination count
                // (Optimized has the most, Minimal has 1). Label based on that.
                const label = idx === 0 ? 'Optimized' : idx === placementOptions.length - 1 ? 'Minimal' : 'Partial';
                const est = shipEstimates[opt.placementOptionId];
                const totalKnown = est && !est.loading && est.totalCents !== null;
                return (
                  <div
                    key={opt.placementOptionId}
                    className={`border rounded-lg p-3 ${
                      isConfirmed
                        ? 'border-positive/50 bg-positive/5'
                        : 'border-border-subtle bg-bg-elevated hover:border-accent/30 transition-colors'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-text-primary">{label}</span>
                      {isConfirmed && (
                        <span className="text-[10px] text-positive bg-positive/10 px-1.5 py-0.5 rounded">CONFIRMED</span>
                      )}
                    </div>
                    <div className="text-2xl font-semibold text-text-primary mb-1">
                      {totalKnown ? formatCurrency(feeCents + (est.totalCents as number)) : formatCurrency(feeCents)}
                      {totalKnown && <span className="text-[11px] font-normal text-text-tertiary ml-1.5">total</span>}
                    </div>
                    <div className="space-y-0.5 mb-2 text-[11px]">
                      <div className="flex justify-between text-text-secondary">
                        <span>Placement fee</span>
                        <span className="font-mono">{formatCurrency(feeCents)}</span>
                      </div>
                      <div className="flex justify-between text-text-secondary">
                        <span>Shipping (Partnered UPS)</span>
                        <span className="font-mono">
                          {est?.loading ? (
                            <Loader2 size={10} className="animate-spin inline" />
                          ) : est?.totalCents !== null && est?.totalCents !== undefined ? (
                            formatCurrency(est.totalCents)
                          ) : (
                            '—'
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="text-[11px] text-text-tertiary mb-3">
                      {shipmentCount} destination{shipmentCount === 1 ? '' : 's'}
                      {est && !est.loading && est.totalCents === null && ' · UPS rate not quoted yet — refresh in a minute'}
                    </div>
                    {!isConfirmed && isPlacementPhase && (
                      <button
                        onClick={() => onConfirmPlacement(opt.placementOptionId)}
                        disabled={!!confirmingPlacementId}
                        className="w-full h-8 px-3 bg-accent text-white rounded text-xs font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                      >
                        {isConfirming ? <Loader2 size={10} className="animate-spin" /> : null}
                        {isConfirming ? 'Confirming…' : 'Choose this'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {batch.placementError && (
            <div className="text-[11px] text-negative bg-negative/5 border border-negative/30 rounded p-2 font-mono">
              Placement error: {batch.placementError}
            </div>
          )}

          {isShippingPhase && (
            <>
              <div className="border border-positive/30 bg-positive/5 rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle size={14} className="text-positive" />
                  <span className="text-xs font-medium text-positive">
                    Shipments committed
                    {shipments.length > 0 && ` — ${shipments.length} shipment${shipments.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                <p className="text-[11px] text-text-tertiary">
                  {batch.transportationStatus === 'CONFIRMED'
                    ? (batch.transportationCarrier || '').toLowerCase().includes('ups')
                      ? <>Carrier booked: <span className="font-medium text-text-secondary">{batch.transportationCarrier}</span> ({batch.transportationShippingMode}). Print FNSKU labels (one per unit, over the original UPC), then shipping labels — Amazon returns the FBA box ID and the UPS label together, one per page.</>
                      : <>Carrier booked: <span className="font-medium text-text-secondary">{batch.transportationCarrier}</span> ({batch.transportationShippingMode}). Print FNSKU labels (one per unit) and FBA box ID labels below, then generate the carrier label with your own carrier&apos;s tools.</>
                    : <>Print FNSKU labels (one per unit, applied over original UPC) and box ID labels (one per box, taped to outside) for each shipment below. Choose a carrier in the next section to commit the shipment for transit.</>
                  }
                </p>
                {(batch.placementFeeCents != null || batch.transportationCostCents != null) && (
                  <div className="flex gap-4 mt-2 text-[11px]">
                    {batch.placementFeeCents != null && (
                      <span className="text-text-secondary">
                        Placement fee: <span className="font-mono font-medium">{formatCurrency(batch.placementFeeCents)}</span>
                      </span>
                    )}
                    {batch.transportationCostCents != null && (
                      <span className="text-text-secondary">
                        Shipping: <span className="font-mono font-medium">{formatCurrency(batch.transportationCostCents)}</span>
                      </span>
                    )}
                    {batch.placementFeeCents != null && batch.transportationCostCents != null && (
                      <span className="text-text-primary font-medium">
                        Total inbound cost: <span className="font-mono">{formatCurrency(batch.placementFeeCents + batch.transportationCostCents)}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Carrier (transportation) booking — only show if not yet confirmed */}
              {batch.transportationStatus !== 'CONFIRMED' && (
                <CarrierBookingPanel batchId={batch.id} />
              )}

              {/* Per-shipment print cards */}
              {shipments.length === 0 ? (
                <div className="text-[11px] text-text-tertiary italic">Loading shipments…</div>
              ) : (
                <div className="space-y-2">
                  {shipments.map((s) => {
                    const dest = s.destination;
                    const destLabel = dest?.city
                      ? `${dest.city}, ${dest.stateOrProvinceCode || ''} ${dest.postalCode || ''}`.trim()
                      : (s.destinationFC || 'Destination TBD');
                    // ONE carton-label button. With Amazon Partnered UPS booked, the
                    // 'shipping' PageType already returns the FBA box ID label AND the
                    // UPS label together, so a separate box-label button is redundant.
                    // Own-carrier shipments have no UPS label, so fall back to box-only.
                    const partnered =
                      batch.transportationStatus === 'CONFIRMED' &&
                      (batch.transportationCarrier || '').toLowerCase().includes('ups');
                    const cartonType: 'box' | 'shipping' = partnered ? 'shipping' : 'box';
                    const cartonLabel = partnered ? 'Print shipping labels' : 'Print box labels';
                    const cartonKey = `${cartonType}-${s.shipmentId}`;
                    return (
                      <div key={s.shipmentId} className="border border-border-subtle rounded-lg bg-bg-elevated p-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-xs font-medium text-text-primary font-mono">{s.shipmentId}</div>
                            <div className="text-[11px] text-text-tertiary mt-0.5">
                              <MapPin size={10} className="inline mr-0.5" />
                              {destLabel}
                              {s.boxCount != null && <> · {s.boxCount} box{s.boxCount === 1 ? '' : 'es'}</>}
                            </div>
                          </div>
                          <span className="text-[10px] text-text-tertiary uppercase tracking-wider px-1.5 py-0.5 bg-bg-surface rounded">
                            {s.status}
                          </span>
                        </div>

                        {/* Print actions */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border-subtle">
                          {/* FNSKU labels */}
                          <button
                            onClick={() => handlePrintLabels(s.shipmentId, 'fnsku')}
                            disabled={printingLabel === `fnsku-${s.shipmentId}`}
                            className="h-7 px-2.5 bg-accent text-white rounded text-[11px] font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1"
                            title="Print FNSKU per-unit labels to Rollo"
                          >
                            {printingLabel === `fnsku-${s.shipmentId}` ? <Loader2 size={10} className="animate-spin" /> : null}
                            Print FNSKU labels
                          </button>
                          <button
                            onClick={() => handleDownloadLabels(s.shipmentId, 'fnsku')}
                            className="h-7 px-2 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                            title="Download FNSKU labels as PDF instead of printing"
                          >
                            PDF
                          </button>
                          <span className="text-text-tertiary text-[11px]">·</span>
                          {/* Carton labels — combined FBA box ID + UPS when Partnered, box ID alone otherwise */}
                          <button
                            onClick={() => handlePrintLabels(s.shipmentId, cartonType)}
                            disabled={printingLabel === cartonKey}
                            className={
                              partnered
                                ? 'h-7 px-2.5 bg-positive/15 border border-positive/30 rounded text-[11px] font-medium text-positive hover:bg-positive/25 disabled:opacity-50 transition-colors flex items-center gap-1'
                                : 'h-7 px-2.5 bg-bg-surface border border-border-default rounded text-[11px] font-medium text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors flex items-center gap-1'
                            }
                            title={
                              partnered
                                ? 'Print carton labels to Rollo — Amazon returns the FBA box ID and the UPS shipping label together, one per page'
                                : 'Print FBA box ID labels to Rollo (own carrier — generate the carrier label with your own tools)'
                            }
                          >
                            {printingLabel === cartonKey ? <Loader2 size={10} className="animate-spin" /> : null}
                            {cartonLabel}
                          </button>
                          <button
                            onClick={() => handleDownloadLabels(s.shipmentId, cartonType)}
                            className="h-7 px-2 bg-bg-surface border border-border-default rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                            title={partnered ? 'Download carton labels as PDF (FBA box ID + UPS)' : 'Download FBA box ID labels as PDF'}
                          >
                            PDF
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Fallback: still expose Seller Central in case anything fails */}
              {batch.inboundPlanId && (
                <a
                  href={`https://sellercentral.amazon.com/fba/sendtoamazon/pack_mixed_unit_step?wf=${batch.inboundPlanId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-accent hover:underline"
                >
                  <ExternalLink size={10} /> Or open in Seller Central
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PrintRowButton ─────────────────────────────────────────────────────────
// Per-row FNSKU print picker. Click the package icon → small popover opens
// with a quantity input + "Print all (N)" / "Print 1" shortcuts. Defaults to
// the row's full quantity; user can type any number for partial reprints.
function PrintRowButton({
  defaultQty,
  isPrinting,
  onPrint,
  onDownload,
}: {
  defaultQty: number;
  isPrinting: boolean;
  onPrint: (copies: number) => void;
  onDownload: (copies: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(defaultQty));
  // Smart positioning: flip the popover above the trigger when the row is
  // near the bottom of the viewport and the default below-positioning would
  // get cut off. Decided on open via getBoundingClientRect().
  const [openAbove, setOpenAbove] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQty(String(defaultQty));
    // Decide direction: the popover is ~150-200px tall depending on shortcuts.
    // If there's < 220px below the trigger but more above, flip up.
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenAbove(spaceBelow < 220 && spaceAbove > spaceBelow);
    }
  }, [open, defaultQty]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function go(action: 'print' | 'download') {
    const n = parseInt(qty);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      alert('Quantity must be 1–200');
      return;
    }
    setOpen(false);
    if (action === 'print') onPrint(n);
    else onDownload(n);
  }

  // Show the "All (N)" / "1 (replacement)" shortcuts only when they're
  // actually useful (i.e., qty > 1). For qty=1 rows the input already
  // contains 1 and both shortcuts are no-ops.
  const showShortcuts = defaultQty > 1;

  return (
    <div ref={ref} className="relative inline-flex justify-end">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        disabled={isPrinting}
        className="p-1 text-text-tertiary hover:text-accent hover:bg-accent/10 rounded transition-colors disabled:opacity-50"
        title={`Print FNSKU label (${defaultQty} unit${defaultQty === 1 ? '' : 's'})`}
      >
        {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
      </button>
      {open && (
        <div className={`absolute right-0 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl p-3 text-sm ${openAbove ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <div className="text-[11px] uppercase tracking-widest text-text-tertiary mb-2">Print FNSKU labels</div>
          <div className="flex items-center gap-2 mb-2">
            <input
              autoComplete="off"
              type="number"
              min="1"
              max="200"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') go('print'); }}
              autoFocus
              className="w-20 h-8 px-2 bg-bg-surface border border-border-default rounded text-sm font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[11px] text-text-tertiary">label{parseInt(qty) === 1 ? '' : 's'}</span>
          </div>
          {showShortcuts && (
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setQty(String(defaultQty))}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title={`Reset to all ${defaultQty} units`}
              >
                All ({defaultQty})
              </button>
              <button
                onClick={() => setQty('1')}
                className="text-[11px] px-2 py-1 bg-bg-surface border border-border-default rounded hover:bg-bg-hover transition-colors"
                title="Print just 1 — useful for replacing a damaged label"
              >
                1 (replacement)
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle">
            <button
              onClick={() => go('download')}
              className="text-[11px] px-2 py-1.5 text-text-secondary hover:text-text-primary transition-colors"
            >
              Download PDF
            </button>
            <button
              onClick={() => go('print')}
              disabled={isPrinting}
              className="h-7 px-3 bg-accent text-white rounded text-xs font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              Print to Rollo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FnskuPrintButton ───────────────────────────────────────────────────────
// Split-button: primary action prints 1 label per SKU (Rollo dialog handles
// quantity). Caret opens a small menu for the other mode (1 per unit) plus
// PDF download options.
function FnskuPrintButton({
  printing,
  onPrint,
  onDownload,
}: {
  printing: boolean;
  onPrint: (mode: 'per-sku' | 'per-unit') => void;
  onDownload: (mode: 'per-sku' | 'per-unit') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => onPrint('per-sku')}
        disabled={printing}
        className="flex items-center gap-2 h-9 pl-3 pr-2 bg-bg-elevated border border-border-default rounded-l-md border-r-0 text-sm text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="Print 1 FNSKU label per unique SKU. Set the copy count at the Rollo print dialog."
      >
        {printing ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
        {printing ? 'Printing…' : 'Print FNSKU (1/SKU)'}
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={printing}
        className="flex items-center justify-center h-9 px-1.5 bg-bg-elevated border border-border-default rounded-r-md text-sm text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
        title="More label options"
        aria-label="More options"
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-bg-elevated border border-border-default rounded-md shadow-xl py-1 text-sm">
          <button
            onClick={() => { setOpen(false); onPrint('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-primary">Print all units (pre-counted)</div>
            <div className="text-[11px] text-text-tertiary">One label per unit. No Rollo qty dialog.</div>
          </button>
          <div className="my-1 border-t border-border-subtle"></div>
          <button
            onClick={() => { setOpen(false); onDownload('per-sku'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (1/SKU)</div>
          </button>
          <button
            onClick={() => { setOpen(false); onDownload('per-unit'); }}
            className="w-full text-left px-3 py-2 hover:bg-bg-hover transition-colors"
          >
            <div className="text-text-secondary">Download PDF (all units)</div>
          </button>
        </div>
      )}
    </div>
  );
}

function UnassignedItemRow({
  item,
  remaining,
  boxIndices,
  boxes,
  onAdd,
}: {
  item: BatchItem;
  remaining: number;
  boxIndices: number[];
  boxes: Box[];
  onAdd: (boxIdx: number, qty: number) => void;
}) {
  const [qty, setQty] = useState(remaining);
  const [targetBoxIdx, setTargetBoxIdx] = useState<number>(boxIndices[boxIndices.length - 1] ?? 0);

  // Reset qty when remaining changes (e.g. after a partial add)
  useEffect(() => { setQty(remaining); }, [remaining]);
  // Track box count so a NEWLY-ADDED box becomes the default target: when the
  // user clicks "Add box", they're about to pack into it — every unassigned
  // row should point there so adding is one click, not dropdown-then-click.
  // (July 8, 2026 boxing-UX request.) Also reset the target if its box was
  // removed.
  const prevBoxCount = useRef(boxIndices.length);
  useEffect(() => {
    const grew = boxIndices.length > prevBoxCount.current;
    prevBoxCount.current = boxIndices.length;
    if (grew || !boxIndices.includes(targetBoxIdx)) {
      setTargetBoxIdx(boxIndices[boxIndices.length - 1] ?? 0);
    }
  }, [boxIndices, targetBoxIdx]);

  const canAdd = qty > 0 && qty <= remaining && boxIndices.length > 0;
  // Map global box index → display label (1-based within this group's section)
  const boxLabel = (idx: number) => `Box ${boxIndices.indexOf(idx) + 1}`;

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-text-primary truncate flex-1" title={item.productName || ''}>
        {item.productName || item.asin}
      </span>
      <span className="text-text-tertiary font-mono">{item.sku}</span>
      <span className="text-amber-400 font-mono w-14 text-right">{remaining} left</span>
      <input
        autoComplete="off"
        type="number"
        min="1"
        max={remaining}
        value={qty}
        onChange={(e) => setQty(Math.max(0, Math.min(remaining, parseInt(e.target.value) || 0)))}
        className="w-14 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] font-mono focus:outline-none focus:border-accent"
      />
      {boxIndices.length > 1 ? (
        <select
          value={targetBoxIdx}
          onChange={(e) => setTargetBoxIdx(parseInt(e.target.value))}
          className="h-6 px-1 bg-bg-surface border border-border-default rounded text-[11px] focus:outline-none focus:border-accent"
        >
          {boxIndices.map((idx) => (
            <option key={idx} value={idx}>{boxLabel(idx)}</option>
          ))}
        </select>
      ) : (
        <span className="text-text-tertiary text-[10px]">→ Box 1</span>
      )}
      <button
        onClick={() => canAdd && onAdd(targetBoxIdx, qty)}
        disabled={!canAdd}
        className="h-6 px-2 bg-accent/10 border border-accent/30 rounded text-[10px] text-accent hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add
      </button>
    </div>
  );
}

interface TransportationOption {
  transportationOptionId: string;
  shipmentId: string;
  shippingSolution: 'USE_YOUR_OWN_CARRIER' | 'AMAZON_PARTNERED_CARRIER' | string;
  shippingMode: string;
  carrier?: { name?: string; alphaCode?: string };
  quote?: { cost?: { amount: number; code: string } } | null;
  preconditions?: string[];
}

function CarrierBookingPanel({ batchId }: { batchId: number }) {
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [options, setOptions] = useState<TransportationOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRegenTried = useRef(false);

  const load = useCallback(async (regenerate: boolean) => {
    if (regenerate) setRegenerating(true); else setLoading(true);
    setError(null);
    try {
      const url = `/api/list/batches/${batchId}/transportation${regenerate ? '?regenerate=1' : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setOptions(d.options || []);
      setSelected((prev) => prev ?? d.transportationOptionId ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setRegenerating(false);
    }
  }, [batchId]);

  useEffect(() => { load(false); }, [load]);

  // Amazon computes the Amazon-Partnered (UPS) rate lazily after placement
  // confirmation. If the first load came back with options but no Partnered
  // one, it's likely still warming up — auto-regenerate once to chase it.
  useEffect(() => {
    if (loading || regenerating || autoRegenTried.current) return;
    if (options.length > 0 && !options.some((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER')) {
      autoRegenTried.current = true;
      load(true);
    }
  }, [loading, regenerating, options, load]);

  async function handleConfirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/list/batches/${batchId}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transportationOptionId: selected }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
        setConfirming(false);
        return;
      }
      // Reload the page so batch state refreshes — simplest correct UX
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setConfirming(false);
    }
  }

  // A placement can span multiple shipments (Amazon splits across FCs). Amazon
  // returns a transportation option PER shipment, so a single carrier choice
  // (e.g. Amazon Partnered UPS Ground) shows up once per shipment. Collapse
  // those into ONE choice per (solution, mode, carrier), summing the quote
  // across shipments — so the card shows the TRUE total you'll pay, and only
  // choices available for EVERY shipment are offered (Amazon requires a carrier
  // for all shipments to confirm). July 8, 2026.
  const shipmentIds = [...new Set(options.map((o) => o.shipmentId))];
  const groupMap = new Map<string, TransportationOption[]>();
  for (const o of options) {
    const key = `${o.shippingSolution}|${o.shippingMode}|${(o.carrier?.name || '').toLowerCase()}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(o);
  }
  const choices = [...groupMap.values()]
    // Keep only carrier choices offered for every shipment in the placement.
    .filter((opts) => shipmentIds.every((sid) => opts.some((o) => o.shipmentId === sid)))
    .map((opts) => {
      // One representative option per shipment (dedupe if Amazon repeats).
      const perShipment = shipmentIds.map((sid) => opts.find((o) => o.shipmentId === sid)!);
      const anyQuoted = perShipment.some((o) => o.quote?.cost?.amount != null);
      const totalCost = perShipment.reduce((s, o) => s + (o.quote?.cost?.amount || 0), 0);
      const first = perShipment[0];
      return {
        key: first.transportationOptionId,
        repOptionId: first.transportationOptionId,
        carrierName: first.carrier?.name || first.shippingSolution,
        shippingMode: first.shippingMode,
        shippingSolution: first.shippingSolution,
        isPartnered: first.shippingSolution === 'AMAZON_PARTNERED_CARRIER',
        totalCost: anyQuoted ? totalCost : null,
        shipmentCount: perShipment.length,
      };
    });
  const sorted = choices.sort((a, b) => {
    const aP = a.isPartnered ? 0 : 1;
    const bP = b.isPartnered ? 0 : 1;
    if (aP !== bP) return aP - bP;
    const aSmall = a.shippingMode === 'GROUND_SMALL_PARCEL' ? 0 : 1;
    const bSmall = b.shippingMode === 'GROUND_SMALL_PARCEL' ? 0 : 1;
    if (aSmall !== bSmall) return aSmall - bSmall;
    return a.carrierName.localeCompare(b.carrierName);
  });

  return (
    <div className="border border-border-subtle rounded-lg bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-text-primary mb-0.5">Choose a carrier</div>
          <div className="text-[11px] text-text-tertiary">
            <span className="text-positive">Amazon Partnered</span> options come with discounted rates AND Amazon-generated UPS labels —
            you&apos;ll be able to print everything from inside FlipLedger.
            &quot;Own carrier&quot; options leave label generation to you (UPS WorldShip, USPS Click-N-Ship, etc.).
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading || regenerating}
          title="Re-fetch carrier options from Amazon (chases the Partnered UPS rate, which can take a moment to appear)"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border-subtle bg-bg-surface text-[11px] text-text-secondary hover:border-border-default disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
          {regenerating ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {loading && <div className="text-[11px] text-text-tertiary italic">Loading carrier options…</div>}
      {regenerating && !loading && (
        <div className="text-[11px] text-text-tertiary italic flex items-center gap-1.5">
          <Loader2 size={11} className="animate-spin" /> Checking Amazon for Partnered UPS rates… (this can take up to a minute)
        </div>
      )}
      {error && <div className="text-[11px] text-negative">{error}</div>}
      {!loading && !regenerating && !error && sorted.length === 0 && (
        <div className="text-[11px] text-text-tertiary italic">No carrier options returned by Amazon. Try Refresh.</div>
      )}
      {!loading && !regenerating && sorted.length > 0 && !sorted.some((c) => c.isPartnered) && (
        <div className="text-[11px] text-amber-400/90 italic">
          No Amazon Partnered rate yet — it&apos;s computed a moment after placement and may need another Refresh to appear.
        </div>
      )}
      {shipmentIds.length > 1 && (
        <div className="text-[10px] text-text-tertiary">
          This placement has {shipmentIds.length} shipments — prices shown are the <span className="font-medium">total across all shipments</span>, and your carrier applies to every shipment.
        </div>
      )}
      {!loading && sorted.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
          {sorted.map((c) => {
            const isSelected = selected === c.repOptionId;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setSelected(c.repOptionId)}
                className={`text-left border rounded p-2.5 transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/15 ring-1 ring-accent'
                    : c.isPartnered
                      ? 'border-positive/40 bg-positive/5 hover:border-positive/60'
                      : 'border-border-subtle bg-bg-surface hover:border-border-default'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <div className="text-xs font-medium text-text-primary truncate flex-1">
                    {c.carrierName}
                  </div>
                  {c.isPartnered && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-positive/20 text-positive uppercase tracking-wider shrink-0">
                      Partnered
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-tertiary uppercase tracking-wider">
                  {c.shippingMode.replace(/_/g, ' ')}
                </div>
                {c.totalCost != null ? (
                  <div className="text-sm font-mono text-positive mt-1 font-medium">
                    ${c.totalCost.toFixed(2)}
                    {c.shipmentCount > 1 && <span className="text-[10px] text-text-tertiary font-sans"> total · {c.shipmentCount} shipments</span>}
                  </div>
                ) : c.shippingSolution === 'USE_YOUR_OWN_CARRIER' ? (
                  <div className="text-[10px] text-text-tertiary mt-1 italic">
                    Pricing via your own carrier account
                  </div>
                ) : null}
                {c.isPartnered && (
                  <div className="text-[10px] text-positive/80 mt-1">
                    ✓ Amazon generates the UPS labels
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {!loading && sorted.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selected || confirming}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {confirming ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {confirming ? 'Confirming…' : 'Confirm carrier'}
          </button>
        </div>
      )}
    </div>
  );
}

function StepChip({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${
        done
          ? 'border-positive/30 text-positive bg-positive/5'
          : active
            ? 'border-accent/30 text-accent bg-accent/10'
            : 'border-border-subtle text-text-tertiary bg-bg-elevated'
      }`}
    >
      {done && <CheckCircle size={10} className="mr-1" />}
      {label}
    </span>
  );
}

function DimensionInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-widest text-text-tertiary">{label}</label>
      <input
        autoComplete="off"
        type="number"
        step="0.1"
        min="0"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full mt-0.5 h-8 px-2 bg-bg-surface border border-border-default rounded text-xs font-mono focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}
