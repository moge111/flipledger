'use client';

import {CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

import { Batch, BatchItem } from '@/components/listing/types';

export function StatusBadge({ status }: { status: string }) {
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

/**
 * Draft-time pre-flight badge for a batch item. Answers "will this item make
 * it onto the truck?" BEFORE send: gated ASINs get an approval deep link,
 * catalog-defective ASINs get flagged as needing a Seller Support case, and
 * items Amazon hasn't FBA-registered yet show as registering/stuck.
 */
export function PreflightChip({ item, channel }: { item: BatchItem; channel: string }) {
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
