'use client';

import {CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

import { Batch, BatchItem } from '@/components/listing/types';

// Batch lifecycle as the Paper status rail: draft → sent to Amazon (sending … shipping) → shipped/closed.
const RAIL_STEP: Record<string, number> = {
  draft: 0,
  sending: 1, ready: 1, boxing: 1, placement: 1, shipping: 1,
  shipped: 2, closed: 2,
};

export function StatusBadge({ status }: { status: string }) {
  const failed = status === 'failed';
  const step = RAIL_STEP[status] ?? 0;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`rail ${failed ? 'failed' : ''}`} data-step={failed ? undefined : step}>
      <span className="track"><b /><b /><b /></span>
      <span className="lbl">{label}</span>
    </span>
  );
}

/**
 * Draft-time pre-flight badge for a batch item. Answers "will this item make
 * it onto the truck?" BEFORE send: gated ASINs get an approval deep link,
 * catalog-defective ASINs get flagged as needing a Seller Support case, and
 * items Amazon hasn't FBA-registered yet show as registering/stuck.
 */

/**
 * Draft-time pre-flight badge for a batch item. Answers "will this item make
 * it onto the truck?" BEFORE send: gated ASINs get an approval deep link,
 * catalog-defective ASINs get flagged as needing a Seller Support case, and
 * items Amazon hasn't FBA-registered yet show as registering/stuck.
 */
/** Restrictions API "GATED" covers three different problems — name the real one. */
export function gatedLabel(item: BatchItem): string {
  const restriction = item.preflightDetail?.restriction;
  if (restriction?.status === 'APPROVAL_REQUIRED') return 'NEEDS APPROVAL';
  if (restriction?.reasons?.some((r) => /does not exist/i.test(r))) return 'ASIN NOT ON AMAZON';
  return 'NOT ELIGIBLE';
}

export function PreflightChip({ item, channel }: { item: BatchItem; channel: string }) {
  const s = item.preflightStatus;
  if (!s) return null;
  switch (s) {
    case 'READY': {
      if (channel === 'FBA') {
        return <span className="tag text-[9px] text-positive" title={item.fnsku ? `FNSKU ${item.fnsku}` : undefined}>FBA READY</span>;
      }
      // MFN: the offer exists on Amazon. Say whether anyone can buy it.
      const qtyOff = item.sendQtyToAmazon === 0;
      const zeroOnAmazon = item.preflightDetail?.mfnAvailable === 0 || (qtyOff && item.preflightDetail?.mfnAvailable == null);
      return zeroOnAmazon ? (
        <span
          className="tag text-[9px] text-text-secondary"
          title={qtyOff
            ? 'On Amazon at 0 available. Qty → Amazon is off: add the stock in Seller Central, or turn it on.'
            : 'On Amazon at 0 available: sold out, or set to 0 in Seller Central.'}
        >
          ON AMAZON · 0 AVAILABLE
        </span>
      ) : (
        <span className="tag text-[9px] text-positive" title="On sale on Amazon">LIVE</span>
      );
    }
    case 'GATED': {
      const restriction = item.preflightDetail?.restriction;
      const url = restriction?.approvalUrl;
      const chip = (
        <span className="tag tag-attn text-[9px]" title={restriction?.reasons?.join(' ') || undefined}>
          ⛔ {gatedLabel(item)}{url ? ' ↗' : ''}
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
          className="tag tag-attn text-[9px]"
          title="Amazon's catalog data for this ASIN is rejecting the listing — usually needs a Seller Support catalog case. May block FNSKU assignment."
        >
          ⚠ CATALOG ISSUE
        </span>
      );
    case 'STUCK':
      return channel === 'FBA' ? (
        <span
          className="tag text-[9px] text-warning"
          title="No FNSKU yet after 10+ minutes — Amazon hasn't registered this listing for FBA. It may still clear on its own."
        >
          ⏳ NOT FBA-REGISTERED
        </span>
      ) : (
        <span
          className="tag text-[9px] text-warning"
          title="10+ minutes and the offer still isn't buyable on Amazon. It may still clear on its own; check the listing in Seller Central."
        >
          ⏳ NOT LIVE YET
        </span>
      );
    case 'PENDING':
      return <span className="tag tag-blue text-[9px]">REGISTERING…</span>;
    case 'FAILED':
      return <span className="tag text-[9px] text-negative">FAILED</span>;
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

// ─── SendStatusCard ─────────────────────────────────────────────────────────
// Renders the progress of an in-flight or completed send operation.
export function SendStatusCard({ batch, items }: { batch: Batch; items: BatchItem[] }) {
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
    <div className={`flash p-4 mb-5 ${
      isFailed ? 'flash-bad' :
      isReady ? 'border-l-positive' :
      'border-l-link'
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
          <div className="text-text-tertiary label-caps text-[10px] mb-1">Listings</div>
          <div className="text-text-primary tabular-nums">
            {listingsReady} active / {listingsProcessing} processing
            {listingsFailed > 0 && <span className="text-negative"> / {listingsFailed} failed</span>}
            <span className="text-text-tertiary"> of {totalListings}</span>
          </div>
        </div>
        {isFBA && (
          <div className="bg-bg-elevated rounded p-3">
            <div className="text-text-tertiary label-caps text-[10px] mb-1">Inbound plan</div>
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
