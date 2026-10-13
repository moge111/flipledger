'use client';

import { Copy } from 'lucide-react';
import { LiveState, ReceiveStatus } from '@/components/merchant-inventory/types';

// Labeled identifier with copy button — Prep Ship Hub-style product info block.
// When `href` is set, the value becomes a link (opens in a new tab).
export function IdentifierChip({ label, value, href }: { label: string; value: string | null | undefined; href?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-text-tertiary/60 label-caps shrink-0">{label}</span>
      {href
        ? <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-link truncate hover:underline"
            title={`Open ${label} in Seller Central: ${value}`}
          >
            {value}
          </a>
        : <span className="text-text-secondary truncate" title={value}>{value}</span>}
      <button
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value); }}
        title={`Copy ${label}: ${value}`}
        className="shrink-0 text-text-tertiary/40 hover:text-text-tertiary transition-colors"
      >
        <Copy size={10} />
      </button>
    </div>
  );
}

const RECEIVE_STATUS_STYLES: Record<ReceiveStatus, string> = {
  pending:   'tag text-text-tertiary',
  received:  'tag text-link',
  inspected: 'tag text-warning',
  ready:     'tag text-positive',
};

const RECEIVE_STATUS_LABELS: Record<ReceiveStatus, string> = {
  pending: 'Pending', received: 'Received', inspected: 'Inspected', ready: 'Ready',
};

const LIVE_STATE_STYLES: Record<LiveState, string> = {
  active:     'tag text-positive',
  oos:        'tag text-warning',
  inactive:   'tag text-negative',
  not_listed: 'tag text-text-tertiary',
};

const LIVE_STATE_LABELS: Record<LiveState, string> = {
  active:     'Live',
  oos:        'OOS',
  inactive:   'Inactive',
  not_listed: 'Not Listed',
};

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

export function ReceiveStatusBadge({ status }: { status: ReceiveStatus }) {
  return (
    <span className={RECEIVE_STATUS_STYLES[status]}>
      {RECEIVE_STATUS_LABELS[status]}
    </span>
  );
}

export function LiveStateBadge({ state }: { state: LiveState }) {
  return (
    <span className={LIVE_STATE_STYLES[state]}>
      {LIVE_STATE_LABELS[state]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Label types
// ---------------------------------------------------------------------------
