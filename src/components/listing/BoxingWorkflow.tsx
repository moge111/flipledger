'use client';

import { useEffect, useState, useRef } from 'react';
import { formatCurrency } from '@/lib/formatters';
import {Plus, Copy, Trash2, ExternalLink, CheckCircle, Loader2, Box as BoxIcon, MapPin, Sparkles } from 'lucide-react';
import { CarrierBookingPanel } from '@/components/listing/CarrierBookingPanel';

import { BatchItem, Box, BoxingWorkflowProps, PackGroup } from '@/components/listing/types';

export function BoxingWorkflow({
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
  onDuplicateBox,
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

  // Option IDs already requested. Kept in a ref, not tied to effect cleanup:
  // the parent loads placement options twice on mount, and cancelling the
  // first fetch while marking its options "loading" left the spinners stuck.
  const requestedEstimates = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (batch.status !== 'placement' || placementOptions.length === 0) return;
    const pending = placementOptions.filter((o) => !requestedEstimates.current.has(o.placementOptionId));
    if (pending.length === 0) return;
    for (const o of pending) requestedEstimates.current.add(o.placementOptionId);
    setShipEstimates((prev) => {
      const next = { ...prev };
      for (const o of pending) next[o.placementOptionId] = { loading: true, totalCents: null };
      return next;
    });
    (async () => {
      for (const opt of pending) {
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
        setShipEstimates((prev) => ({ ...prev, [opt.placementOptionId]: { loading: false, totalCents } }));
      }
    })();
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

  const labelNames = { box: 'Box ID', shipping: 'Shipping' } as const;

  async function sendLabelsToPrinter(shipmentId: string, type: 'box' | 'shipping') {
    try {
      const res = await fetch(
        `/api/list/batches/${batch.id}/labels?type=${type}&shipmentId=${encodeURIComponent(shipmentId)}&action=print&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      return await res.json();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async function handlePrintLabels(shipmentId: string, type: 'box' | 'shipping') {
    setPrintingLabel(`${type}-${shipmentId}`);
    const data = await sendLabelsToPrinter(shipmentId, type);
    if (data.success) {
      alert(`✓ Printed ${labelNames[type]} labels for ${shipmentId}\nPrinter: ${data.printer}${data.jobId ? ' (job ' + data.jobId + ')' : ''}`);
    } else {
      const hint = data.hint ? `\n\n${data.hint}` : '';
      alert(`Print failed: ${data.error}${hint}\n\nTry "Download PDF" instead and print manually.`);
    }
    setPrintingLabel(null);
  }

  // One shipment at a time so the printer jobs come out in shipment order.
  // Keeps going past a failure and reports every shipment at the end.
  async function handlePrintAllLabels(type: 'box' | 'shipping') {
    setPrintingLabel(`${type}-all`);
    const failures: string[] = [];
    for (const s of shipments) {
      setPrintingLabel(`${type}-${s.shipmentId}`);
      const data = await sendLabelsToPrinter(s.shipmentId, type);
      if (!data.success) failures.push(`${s.shipmentId}: ${data.error}`);
    }
    setPrintingLabel(null);
    const printed = shipments.length - failures.length;
    if (failures.length === 0) {
      alert(`✓ Printed ${labelNames[type]} labels for all ${printed} shipments`);
    } else {
      alert(`Printed ${printed} of ${shipments.length} shipments. Failed:\n\n${failures.join('\n')}\n\nUse that shipment's own Print or PDF button to retry.`);
    }
  }

  function handleDownloadLabels(shipmentId: string, type: 'box' | 'shipping') {
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
    <div className="panel mb-5 overflow-hidden">
      {/* Workflow header + step indicator */}
      <div className="px-4 py-3 border-b-[1.5px] border-border-strong">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <h3 className="label-caps text-[12px] text-text-primary">Ship to Amazon</h3>
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
                className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
                title="Copy a paste-ready summary of your boxes for Seller Central re-entry"
              >
                {copyBoxesFlash ? '✓ Copied' : '📋 Copy layout'}
              </button>
            )}
            <div className="text-xs text-text-tertiary tabular-nums">
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
                className={isMultiGroup ? 'border-[1.5px] border-border-strong rounded-lg overflow-hidden' : ''}
              >
                {/* Group header (only shown for multi-group) */}
                {isMultiGroup && section.group && (
                  <div className="panel-bar">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-text-inverse text-[10px] font-semibold">
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
                          {!packingLocked && (
                            <button
                              onClick={() => onDuplicateBox(idx)}
                              className="inline-flex items-center gap-1 px-1.5 py-1 text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                              title="Add another box with the same size, weight and contents (capped at what's still unassigned)"
                            >
                              <Copy size={12} /> Duplicate
                            </button>
                          )}
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
                          <div className="text-[10px] label-caps text-text-tertiary mb-1.5">Contents</div>
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
                                      <span className="text-text-secondary w-10 text-right tabular-nums">× {quantity}</span>
                                    ) : (
                                      <input
                                        autoComplete="off"
                                        type="number"
                                        min="0"
                                        max={batchItem.quantity}
                                        value={quantity}
                                        onChange={(e) => onSetBoxItemQty(idx, batchItem.id, parseInt(e.target.value) || 0)}
                                        className="w-12 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] focus:outline-none focus:border-link tabular-nums"
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
                    <div className="attn-banner p-3">
                      <div className="text-[11px] text-warning mb-1.5 label-caps">
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
                      className="h-8 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-1.5"
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
                className="h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Save boxes to FlipLedger without pushing to Amazon (partial progress OK)"
              >
                {savingBoxes ? 'Saving…' : 'Save draft'}
              </button>
              <button
                onClick={onConfirmPacking}
                disabled={packing || !fullyAllocated || boxes.length === 0}
                className="h-9 px-4 bg-accent text-text-inverse rounded text-sm font-bold hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {packing ? <Loader2 size={12} className="animate-spin" /> : <BoxIcon size={12} />}
                {packing ? 'Confirming with Amazon…' : 'Confirm packing'}
              </button>
            </div>
          )}

          {!fullyAllocated && !packingLocked && totalUnallocated > 0 && (
            <p className="text-[11px] text-warning">
              All items must be fully assigned to boxes before you can confirm packing.
            </p>
          )}

          {batch.packingError && (
            <div className="text-[11px] text-negative rounded-sm p-2 font-mono border-[1.2px] border-current">
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
              className="h-9 px-4 bg-accent text-text-inverse rounded text-sm font-bold hover:bg-accent/90 transition-colors flex items-center gap-1.5"
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
                        <span className="tag text-positive">CONFIRMED</span>
                      )}
                    </div>
                    <div className="stat-num text-xl sm:text-2xl text-text-primary mb-1">
                      {totalKnown ? formatCurrency(feeCents + (est.totalCents as number)) : formatCurrency(feeCents)}
                      {totalKnown && <span className="text-[11px] font-normal text-text-tertiary ml-1.5">total</span>}
                    </div>
                    <div className="space-y-0.5 mb-2 text-[11px]">
                      <div className="flex justify-between text-text-secondary">
                        <span>Placement fee</span>
                        <span className="tabular-nums">{formatCurrency(feeCents)}</span>
                      </div>
                      <div className="flex justify-between text-text-secondary">
                        <span>Shipping (Partnered UPS)</span>
                        <span className="tabular-nums">
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
                        className="w-full h-8 px-3 bg-accent text-text-inverse rounded text-xs font-bold hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
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
            <div className="text-[11px] text-negative rounded-sm p-2 font-mono border-[1.2px] border-current">
              Placement error: {batch.placementError}
            </div>
          )}

          {isShippingPhase && (
            <>
              <div className="flash border-l-positive p-3">
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
                      ? <>Carrier booked: <span className="font-medium text-text-secondary">{batch.transportationCarrier}</span> ({batch.transportationShippingMode}). Print the shipping labels — Amazon returns the FBA box ID and the UPS label together, one per box. FNSKU stickers are printed from the batch header while scanning.</>
                      : <>Carrier booked: <span className="font-medium text-text-secondary">{batch.transportationCarrier}</span> ({batch.transportationShippingMode}). Print the FBA box ID labels below, then generate the carrier label with your own carrier&apos;s tools. FNSKU stickers are printed from the batch header while scanning.</>
                    : <>Print box ID labels (one per box, taped to outside) for each shipment below. Choose a carrier in the next section to commit the shipment for transit.</>
                  }
                </p>
                {(batch.placementFeeCents != null || batch.transportationCostCents != null) && (
                  <div className="flex gap-4 mt-2 text-[11px]">
                    {batch.placementFeeCents != null && (
                      <span className="text-text-secondary">
                        Placement fee: <span className="font-medium tabular-nums">{formatCurrency(batch.placementFeeCents)}</span>
                      </span>
                    )}
                    {batch.transportationCostCents != null && (
                      <span className="text-text-secondary">
                        Shipping: <span className="font-medium tabular-nums">{formatCurrency(batch.transportationCostCents)}</span>
                      </span>
                    )}
                    {batch.placementFeeCents != null && batch.transportationCostCents != null && (
                      <span className="text-text-primary font-medium">
                        Total inbound cost: <span className="tabular-nums">{formatCurrency(batch.placementFeeCents + batch.transportationCostCents)}</span>
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
                  {shipments.length > 1 && (() => {
                    const partnered =
                      batch.transportationStatus === 'CONFIRMED' &&
                      (batch.transportationCarrier || '').toLowerCase().includes('ups');
                    const cartonType: 'box' | 'shipping' = partnered ? 'shipping' : 'box';
                    const busy = printingLabel !== null;
                    const allBusy = (type: string) => busy && printingLabel !== null && printingLabel.startsWith(`${type}-`);
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 border border-border-subtle rounded-lg bg-bg-elevated p-3">
                        <span className="text-[11px] label-caps text-text-tertiary mr-1">All {shipments.length} shipments</span>
                        <button
                          onClick={() => handlePrintAllLabels(cartonType)}
                          disabled={busy}
                          className="h-7 px-2.5 bg-accent text-text-inverse rounded text-[11px] font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1"
                          title="Send every shipment's carton labels to the Rollo, one shipment after another"
                        >
                          {allBusy(cartonType) ? <Loader2 size={10} className="animate-spin" /> : null}
                          {partnered ? 'Print all shipping labels' : 'Print all box labels'}
                        </button>
                      </div>
                    );
                  })()}
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
                          <span className="text-[10px] text-text-tertiary label-caps px-1.5 py-0.5 bg-bg-surface rounded">
                            {s.status}
                          </span>
                        </div>

                        {/* Print actions */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border-subtle">
                          {/* Carton labels — combined FBA box ID + UPS when Partnered, box ID alone otherwise */}
                          <button
                            onClick={() => handlePrintLabels(s.shipmentId, cartonType)}
                            disabled={printingLabel === cartonKey}
                            className={
                              partnered
                                ? 'h-7 px-2.5 bg-accent text-text-inverse border-[1.5px] border-accent rounded text-[11px] font-bold hover:bg-accent-hover disabled:opacity-50 transition-colors flex items-center gap-1'
                                : 'h-7 px-2.5 bg-bg-surface border-[1.5px] border-border-strong rounded text-[11px] font-semibold text-text-primary hover:bg-bg-hover disabled:opacity-50 transition-colors flex items-center gap-1'
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
                            className="h-7 px-2 bg-bg-surface border-[1.5px] border-border-strong rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
                  className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-link hover:underline"
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
      <span className="text-warning w-14 text-right tabular-nums">{remaining} left</span>
      <input
        autoComplete="off"
        type="number"
        min="1"
        max={remaining}
        value={qty}
        onChange={(e) => setQty(Math.max(0, Math.min(remaining, parseInt(e.target.value) || 0)))}
        className="w-14 h-6 px-1 text-right bg-bg-surface border border-border-default rounded text-[11px] focus:outline-none focus:border-link tabular-nums"
      />
      {boxIndices.length > 1 ? (
        <select
          value={targetBoxIdx}
          onChange={(e) => setTargetBoxIdx(parseInt(e.target.value))}
          className="h-6 px-1 bg-bg-surface border border-border-default rounded text-[11px] focus:outline-none focus:border-link"
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
        className="h-6 px-2 rounded-sm text-[10px] text-accent hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-[1.2px] border-current"
      >
        Add
      </button>
    </div>
  );
}

function StepChip({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] label-caps ${
        done
          ? 'tag text-positive'
          : active
            ? 'border-accent text-text-inverse bg-accent'
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
      <label className="text-[10px] label-caps text-text-tertiary">{label}</label>
      <input
        autoComplete="off"
        type="number"
        step="0.1"
        min="0"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full mt-0.5 h-8 px-2 bg-bg-surface border border-border-default rounded text-xs focus:outline-none focus:border-link disabled:opacity-50 disabled:cursor-not-allowed tabular-nums"
      />
    </div>
  );
}
