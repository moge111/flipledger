'use client';

import { useState, } from 'react';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';
import {
  ExternalLink, RefreshCw, AlertCircle, Loader2, CheckCircle2, XCircle,
  Inbox, Copy, Check, X as XClose, ChevronRight,
} from 'lucide-react';
import CopyableText from '@/components/ui/CopyableText';
import { useQuery } from '@/lib/useQuery';

type Source = 'discrepancy' | 'claims' | 'reevals' | 'amz' | 'wmt';

interface QueueItem {
  source: Source;
  sourceLabel: string;
  id: number;
  marketplace: 'amazon' | 'walmart';
  productName: string | null;
  refId: string | null;
  refLabel: string;
  sku: string | null;
  asin: string | null;
  quantity: number;
  amountCents: number;
  eventDate: string;
  windowUntil: string | null;
  eligibility: 'eligible' | 'maybe' | 'waiting';
  reason: string;
  status: string;
  filedAt: string | null;
  claimText: string;
  evidence: string[];
  fileUrl: string;
  fileUrlLabel: string;
  steps: string[];
}

interface SourceSummary {
  key: string;
  label: string;
  href: string;
  description: string;
  pendingCount: number;
  pendingValueCents: number;
  urgentCount: number;
  filedCount: number;
  filedValueCents: number;
  recoveredValueCents: number;
}

interface GrandTotals {
  pendingCount: number;
  pendingValueCents: number;
  urgentCount: number;
  filedCount: number;
  filedValueCents: number;
  recoveredValueCents: number;
}

const TABS: Array<{ key: 'tofile' | 'waiting' | 'filed' | 'closed' | 'all'; label: string }> = [
  { key: 'tofile', label: 'File These Now' },
  { key: 'waiting', label: 'Waiting / Maybe' },
  { key: 'filed', label: 'Filed' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

const SOURCE_CHIP: Record<Source, string> = {
  discrepancy: 'tag text-text-primary',
  claims: 'tag text-text-secondary',
  reevals: 'tag text-text-secondary',
  amz: 'mkt mkt-amazon',
  wmt: 'mkt mkt-walmart',
};

export default function RecoveryHubPage() {
  // Snapshot of "now" for deadline math — render must stay pure (react-hooks/purity).
  const [nowMs] = useState(() => Date.now());
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'tofile' | 'waiting' | 'filed' | 'closed' | 'all'>('tofile');
  const [openItem, setOpenItem] = useState<QueueItem | null>(null);
  const [editedBody, setEditedBody] = useState('');
  const [copied, setCopied] = useState(false);

  const { data, loading, reload: fetchData } = useQuery<{ grand?: GrandTotals | null; lastSync?: string | null; queue?: QueueItem[]; sources?: SourceSummary[] }>(`/api/data/recovery?tab=${tab}`);
  const queue: QueueItem[] = data?.queue || [];
  const sources: SourceSummary[] = data?.sources || [];
  const grand: GrandTotals | null = data?.grand || null;
  const lastSync: string | null = data?.lastSync || null;

  async function runScan() {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/recovery-scan', { method: 'POST' });
      const data = await res.json();
      if (data.error) alert(`Scan failed: ${data.error}`);
      else await fetchData();
    } catch (err) {
      alert(String(err));
    }
    setSyncing(false);
  }

  async function patchItem(item: QueueItem, action: 'file' | 'dismiss' | 'received' | 'reopen') {
    const res = await fetch('/api/data/recovery', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: item.source, id: item.id, action }),
    });
    const data = await res.json();
    if (data.error) alert(`Update failed: ${data.error}`);
    else await fetchData();
  }

  function openTemplate(item: QueueItem) {
    setOpenItem(item);
    setEditedBody(item.claimText);
    setCopied(false);
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      alert(`Copy failed: ${err}`);
    }
  }

  const marketplaceBadge = (m: 'amazon' | 'walmart') => (
    <span className={m === 'amazon' ? 'mkt mkt-amazon' : 'mkt mkt-walmart'}>
      {m === 'amazon' ? 'AMZ' : 'WMT'}
    </span>
  );

  const eligibilityChip = (e: QueueItem['eligibility']) => {
    if (e === 'eligible') return <span className="tag text-positive">FILE NOW</span>;
    if (e === 'maybe') return <span className="tag text-warning">WORTH A TRY</span>;
    return <span className="tag">WAITING</span>;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title">Recovery Hub</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Every dollar Amazon and Walmart owe you, in one queue. If it&apos;s under <span className="text-text-secondary font-medium">File These Now</span>, it&apos;s worth a case — sorted by deadline.
            {lastSync && <span className="ml-2">· Last scanned {formatDate(lastSync)}</span>}
          </p>
        </div>
        <button
          onClick={runScan}
          disabled={syncing}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>

      {/* Grand totals */}
      {grand && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Recoverable Now</div>
            <div className="stat-num text-xl sm:text-2xl text-text-primary">{formatCurrency(grand.pendingValueCents)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatNumber(grand.pendingCount)} open claims across all sources</div>
          </div>
          <div className={`panel p-5 ${grand.urgentCount > 0 ? 'border-t-negative' : 'border-t-border-default'}`}>
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Closing Soon (≤14d)</div>
            <div className={`stat-num text-xl sm:text-2xl ${grand.urgentCount > 0 ? 'text-negative' : 'text-text-primary'}`}>{formatNumber(grand.urgentCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">File before the window closes</div>
          </div>
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Filed, Awaiting Decision</div>
            <div className="stat-num text-xl sm:text-2xl text-text-primary">{formatCurrency(grand.filedValueCents)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatNumber(grand.filedCount)} claims pending with the marketplace</div>
          </div>
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Recovered</div>
            <div className="stat-num text-xl sm:text-2xl text-positive">{formatCurrency(grand.recoveredValueCents)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">Won across all recovery surfaces</div>
          </div>
        </div>
      )}

      {/* Unified action queue */}
      <div className="flex items-center gap-2 mb-4 border-b border-border-subtle overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 h-9 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === t.key
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-text-tertiary py-12 text-center">Loading…</div>
      ) : queue.length === 0 ? (
        <div className="text-text-tertiary py-12 text-center flex flex-col items-center gap-2">
          <Inbox size={32} className="text-text-tertiary/50" />
          <span>{tab === 'tofile' ? 'Nothing to file right now — you’re caught up. Run a scan to refresh.' : 'Nothing here.'}</span>
        </div>
      ) : (
        <div className="panel overflow-hidden mb-8">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-[11px] label-caps text-text-tertiary">
              <tr>
                <th className="text-left px-4 py-2">Claim</th>
                <th className="text-left px-4 py-2">Product</th>
                <th className="text-left px-4 py-2">Why you can claim it</th>
                <th className="text-right px-4 py-2">Value</th>
                <th className="text-left px-4 py-2">Deadline</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((c) => {
                const days = c.windowUntil
                  ? Math.ceil((new Date(c.windowUntil).getTime() - nowMs) / 86400000)
                  : null;
                const urgent = days !== null && days <= 14 && c.status === 'pending' && c.eligibility !== 'waiting';
                const clickable = c.status === 'pending' && c.eligibility !== 'waiting';
                return (
                  <tr
                    key={`${c.source}-${c.id}`}
                    className={`border-t border-border-subtle hover:bg-bg-elevated/50 ${clickable ? 'cursor-pointer' : ''}`}
                    onClick={() => { if (clickable) openTemplate(c); }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {marketplaceBadge(c.marketplace)}
                        <span className={SOURCE_CHIP[c.source]}>
                          {c.sourceLabel.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-[11px] text-text-tertiary mt-1 tabular-nums">{formatDate(c.eventDate)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-text-primary truncate max-w-[280px]" title={c.productName || ''}>
                        {c.productName || c.asin || c.sku}
                      </div>
                      <div className="text-[11px] text-text-tertiary flex items-center gap-1.5">
                        {c.refId && (
                          <>
                            <span>{c.refLabel}</span>
                            <CopyableText text={c.refId} title={`Click to copy: ${c.refId}`} />
                          </>
                        )}
                        {c.quantity > 1 && <span>· ×{c.quantity}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary max-w-[320px]">
                      <div className="mb-1">{eligibilityChip(c.eligibility)}</div>
                      {c.reason}
                    </td>
                    <td className="px-4 py-3 text-right text-text-primary tabular-nums">
                      {formatCurrency(c.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {c.windowUntil ? (
                        <span className={urgent ? 'text-negative font-semibold' : 'text-text-secondary'}>
                          {formatDate(c.windowUntil)}
                          {days !== null && c.status === 'pending' && (
                            <div className={`text-[10px] ${urgent ? 'text-negative' : 'text-text-tertiary'}`}>
                              {days >= 0 ? `${days}d left` : 'Expired'}
                            </div>
                          )}
                        </span>
                      ) : (
                        <span className="text-text-tertiary">No deadline</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {c.status === 'pending' && c.eligibility !== 'waiting' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); openTemplate(c); }}
                              className="inline-flex items-center gap-1 px-2.5 h-7 text-[11px] rounded-sm text-accent hover:bg-bg-hover transition-colors font-medium border-[1.2px] border-current"
                              title="Open the ready-to-paste claim + filing link"
                            >
                              File this <ChevronRight size={11} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchItem(c, 'dismiss'); }}
                              className="px-2 h-7 text-[11px] rounded text-text-primary hover:text-negative transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong"
                              title="Dismiss — don't show again"
                            >
                              <XCircle size={11} />
                            </button>
                          </>
                        )}
                        {c.status === 'pending' && c.eligibility === 'waiting' && (
                          <span className="text-[10px] text-warning">Not claimable yet</span>
                        )}
                        {c.status === 'filed' && (
                          <>
                            <span className="text-[10px] text-accent">Filed {c.filedAt ? formatDate(c.filedAt) : ''}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchItem(c, 'received'); }}
                              className="px-2 h-7 text-[11px] rounded-sm text-positive hover:bg-positive/20 transition-colors border-[1.2px] border-current"
                              title="Mark as won"
                            >
                              Won
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchItem(c, 'reopen'); }}
                              className="px-2 h-7 text-[11px] rounded text-text-primary hover:text-text-primary transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong"
                              title="Reopen"
                            >
                              Reopen
                            </button>
                          </>
                        )}
                        {c.status === 'received' && (
                          <span className="text-[10px] text-positive flex items-center gap-1">
                            <CheckCircle2 size={11} /> Won
                          </span>
                        )}
                        {c.status === 'expired' && (
                          <span className="text-[10px] text-text-tertiary flex items-center gap-1">
                            <AlertCircle size={11} /> Expired
                          </span>
                        )}
                        {c.status === 'dismissed' && (
                          <span className="text-[10px] text-text-tertiary">Dismissed</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-source breakdown (detail pages live here now — removed from the sidebar) */}
      <h2 className="text-sm text-text-tertiary label-caps mb-3">Browse by source</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
        {sources.map((s) => (
          <a
            key={s.key}
            href={s.href}
            className="panel p-4 hover:bg-bg-hover transition-colors group"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-medium text-text-primary">{s.label}</div>
              <ChevronRight size={14} className="text-text-tertiary group-hover:text-text-primary transition-colors" />
            </div>
            <div className="text-xs text-text-tertiary mb-3 min-h-[32px]">{s.description}</div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-text-primary tabular-nums">{formatCurrency(s.pendingValueCents)}</span>
              <span className="text-[11px] text-text-tertiary">{s.pendingCount} open</span>
              {s.urgentCount > 0 && (
                <span className="tag text-negative">{s.urgentCount} urgent</span>
              )}
            </div>
            {s.recoveredValueCents > 0 && (
              <div className="text-[11px] text-positive mt-1">{formatCurrency(s.recoveredValueCents)} recovered</div>
            )}
          </a>
        ))}
      </div>

      {/* Claim modal — works for every source (server-rendered template) */}
      {openItem && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setOpenItem(null)}
        >
          <div
            className="panel max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b-[1.5px] border-border-strong flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
                  {marketplaceBadge(openItem.marketplace)} {openItem.sourceLabel}
                </h2>
                <p className="text-xs text-text-tertiary mt-0.5 flex items-center gap-1.5 max-w-[520px]">
                  {openItem.refId && (
                    <>
                      <span>{openItem.refLabel}</span>
                      <CopyableText text={openItem.refId} variant="chip" title={`Click to copy ${openItem.refLabel}`} />
                    </>
                  )}
                  <span className="truncate">· {openItem.productName || ''} · {formatCurrency(openItem.amountCents)}</span>
                </p>
              </div>
              <button
                onClick={() => setOpenItem(null)}
                className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
                title="Close"
              >
                <XClose size={16} />
              </button>
            </div>

            <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
              <div className="bg-accent/5 border border-accent/20 rounded p-3 text-xs text-text-secondary">
                <div className="font-medium text-text-primary mb-1">Why this is claimable</div>
                <div>{openItem.reason}</div>
                {openItem.evidence.length > 0 && (
                  <>
                    <div className="font-medium text-text-primary mt-2 mb-1">Evidence to attach</div>
                    <ul className="space-y-1">
                      {openItem.evidence.map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-text-tertiary mt-0.5">·</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div>
                <label className="text-[11px] label-caps text-text-tertiary block mb-2">
                  Claim message (edit, then paste into the form)
                </label>
                <textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="w-full h-64 px-3 py-2 bg-bg-elevated border border-border-default rounded text-sm text-text-primary focus:outline-none focus:border-link resize-y tabular-nums"
                />
              </div>

              <div className="bg-accent/5 border border-accent/20 rounded p-3 text-xs text-text-secondary">
                <div className="font-medium text-text-primary mb-1.5">How to file (3–5 minutes)</div>
                <ol className="space-y-1">
                  {openItem.steps.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-text-primary tabular-nums">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between bg-bg-elevated/30">
              <button
                onClick={() => {
                  patchItem(openItem, 'dismiss');
                  setOpenItem(null);
                }}
                className="px-3 h-8 text-xs text-text-tertiary hover:text-negative transition-colors"
              >
                Dismiss
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyToClipboard}
                  className={`flex items-center gap-1.5 px-3 h-8 text-xs rounded border transition-colors ${
                    copied
                      ? 'bg-bg-surface border-positive text-positive'
                      : 'bg-bg-elevated border-border-default text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy text'}
                </button>
                <a
                  href={openItem.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => { patchItem(openItem, 'file'); setOpenItem(null); }}
                  className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-accent text-text-inverse rounded font-bold hover:bg-accent/90 transition-colors"
                  title={`${openItem.fileUrlLabel}. File the case there, then this item is marked filed.`}
                >
                  <ExternalLink size={12} /> {openItem.fileUrlLabel} &amp; mark filed
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
