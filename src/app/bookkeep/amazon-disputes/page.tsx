'use client';

import { useState, } from 'react';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';
import { ExternalLink, RefreshCw, AlertCircle, Loader2, CheckCircle2, XCircle, Inbox, Copy, Check, X as XClose } from 'lucide-react';
import { getTemplateForReason, renderTemplate } from '@/lib/amazon-claims/disputeTemplates';
import CopyableText from '@/components/ui/CopyableText';
import { useQuery } from '@/lib/useQuery';

interface Candidate {
  id: number;
  refundId: number;
  orderId: string;
  refundDate: string;
  returnReason: string;
  asin: string | null;
  sku: string | null;
  productName: string | null;
  refundAmountCents: number;
  fulfillmentChannel: string | null;
  eligibility: 'eligible' | 'maybe' | 'not_eligible';
  eligibilityReasons: string[];
  disputeWindowUntil: string | null;
  status: 'pending' | 'filed' | 'received' | 'expired' | 'dismissed';
  filedAt: string | null;
  claimNotes: string | null;
}

interface Totals {
  eligiblePending: number;
  eligibleValueCents: number;
  maybePending: number;
  maybeValueCents: number;
  filedCount: number;
  filedValueCents: number;
  recoveredValueCents: number;
  urgentCount: number;
}

const TABS: Array<{ key: 'eligible' | 'maybe' | 'filed' | 'not_eligible' | 'all'; label: string }> = [
  { key: 'eligible', label: 'Eligible' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'filed', label: 'Filed' },
  { key: 'not_eligible', label: 'Not Eligible' },
  { key: 'all', label: 'All' },
];

export default function AmazonDisputesPage() {
  // Snapshot of "now" for deadline math — render must stay pure (react-hooks/purity).
  const [nowMs] = useState(() => Date.now());
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'eligible' | 'maybe' | 'filed' | 'not_eligible' | 'all'>('eligible');
  const [openCandidate, setOpenCandidate] = useState<Candidate | null>(null);
  const [editedBody, setEditedBody] = useState('');
  const [copied, setCopied] = useState(false);

  const { data, loading, reload: fetchData } = useQuery<{ candidates?: Candidate[]; lastSync?: string | null; totals?: Totals | null }>(`/api/data/amazon-dispute-candidates?tab=${tab}`);
  const candidates: Candidate[] = data?.candidates || [];
  const totals: Totals | null = data?.totals || null;
  const lastSync: string | null = data?.lastSync || null;

  async function runSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/amazon-disputes', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        alert(`Sync failed: ${data.error}`);
      } else {
        await fetchData();
      }
    } catch (err) {
      alert(String(err));
    }
    setSyncing(false);
  }

  async function patchCandidate(id: number, action: 'file' | 'dismiss' | 'received' | 'reopen') {
    const res = await fetch('/api/data/amazon-dispute-candidates', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    if (data.error) {
      alert(`Update failed: ${data.error}`);
    } else {
      await fetchData();
    }
  }

  // Two recovery paths:
  //   - SAFE-T claims (for non-FBA: SFP, MFN with prepaid label, Easy Ship, VAS)
  //   - FBA reimbursement claim case (for FBA orders Amazon didn't auto-reimburse)
  const safetUrl = 'https://sellercentral.amazon.com/safet-claims';
  const fbaReimbursementCaseUrl = 'https://sellercentral.amazon.com/cu/contact-us'; // Help → Get Support → "Submit a reimbursement claim dispute"
  const safetHelpUrl = 'https://sellercentral.amazon.com/help/hub/reference/external/G202145040';

  function recoveryPathFor(channel: string | null): 'safet' | 'fba_reimbursement_case' {
    const c = (channel || '').toUpperCase();
    return (c === 'AFN' || c === 'FBA') ? 'fba_reimbursement_case' : 'safet';
  }

  function openTemplate(c: Candidate) {
    const template = getTemplateForReason(c.returnReason);
    const body = renderTemplate(template, {
      orderId: c.orderId,
      refundDate: formatDate(c.refundDate),
      refundAmount: formatCurrency(c.refundAmountCents),
      productName: c.productName || c.asin || c.sku || 'item',
      asin: c.asin || '—',
      sku: c.sku || '—',
      reason: c.returnReason,
    }, recoveryPathFor(c.fulfillmentChannel));
    setOpenCandidate(c);
    setEditedBody(body);
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

  const eligibilityChip = (e: 'eligible' | 'maybe' | 'not_eligible') => {
    if (e === 'eligible') return <span className="tag text-positive">ELIGIBLE</span>;
    if (e === 'maybe') return <span className="tag text-warning">MAYBE</span>;
    return <span className="tag text-text-tertiary">NOT ELIGIBLE</span>;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title">Amazon SAFE-T Disputes</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            MFN/SFP customer refunds where seller fault is questionable. Filed via SAFE-T claim within 90 days. <strong>FBA refunds aren&apos;t here</strong> — for those, see <a href="/bookkeep/reimbursement-reevaluations" className="text-link hover:underline">Reimbursement Re-Evaluations</a> (underpaid claims) or <a href="/bookkeep/claims-to-file" className="text-link hover:underline">Claims to File</a> (warehouse losses).
            {lastSync && (
              <span className="ml-2 text-text-tertiary">· Last synced {formatDate(lastSync)}</span>
            )}
          </p>
        </div>
        <button
          onClick={runSync}
          disabled={syncing}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Syncing…' : 'Refresh'}
        </button>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Eligible to File</div>
            <div className="stat-num text-xl sm:text-2xl text-text-primary">{formatNumber(totals.eligiblePending)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatCurrency(totals.eligibleValueCents)} potential recovery</div>
          </div>
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Maybe Eligible</div>
            <div className="stat-num text-xl sm:text-2xl text-text-primary">{formatNumber(totals.maybePending)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{formatCurrency(totals.maybeValueCents)} if successful</div>
          </div>
          <div className={`panel p-5 ${totals.urgentCount > 0 ? 'border-t-negative' : 'border-t-border-default'}`}>
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Closing Soon (≤14d)</div>
            <div className={`stat-num text-xl sm:text-2xl ${totals.urgentCount > 0 ? 'text-negative' : 'text-text-primary'}`}>{formatNumber(totals.urgentCount)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">File before window closes</div>
          </div>
          <div className="panel p-5">
            <div className="text-[11px] label-caps text-text-tertiary mb-2">Filed / Recovered</div>
            <div className="stat-num text-xl sm:text-2xl text-text-primary">{formatCurrency(totals.recoveredValueCents)}</div>
            <div className="text-xs text-text-tertiary mt-1.5">{totals.filedCount} filed, {formatCurrency(totals.filedValueCents)} pending</div>
          </div>
        </div>
      )}

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
      ) : candidates.length === 0 ? (
        <div className="text-text-tertiary py-12 text-center flex flex-col items-center gap-2">
          <Inbox size={32} className="text-text-tertiary/50" />
          <span>{tab === 'eligible' ? 'No eligible disputes right now.' : 'Nothing here.'}</span>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-[11px] label-caps text-text-tertiary">
              <tr>
                <th className="text-left px-4 py-2">Refund Date</th>
                <th className="text-left px-4 py-2">Product</th>
                <th className="text-left px-4 py-2">Reason</th>
                <th className="text-left px-4 py-2">Eligibility</th>
                <th className="text-right px-4 py-2">Refund</th>
                <th className="text-left px-4 py-2">Window</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const days = c.disputeWindowUntil
                  ? Math.ceil((new Date(c.disputeWindowUntil).getTime() - nowMs) / 86400000)
                  : null;
                const urgent = days !== null && days <= 14 && c.status === 'pending' && c.eligibility !== 'not_eligible';
                const clickable = c.eligibility !== 'not_eligible' && c.status !== 'expired' && c.status !== 'dismissed';
                return (
                  <tr
                    key={c.id}
                    className={`border-t border-border-subtle hover:bg-bg-elevated/50 ${clickable ? 'cursor-pointer' : ''}`}
                    onClick={() => { if (clickable) openTemplate(c); }}
                  >
                    <td className="px-4 py-3 text-text-secondary text-xs tabular-nums">
                      {formatDate(c.refundDate)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-text-primary truncate max-w-[320px]" title={c.productName || ''}>
                        {c.productName || c.asin || c.sku}
                      </div>
                      <div className="text-[11px] text-text-tertiary flex items-center gap-1.5">
                        <CopyableText text={c.orderId} title={`Click to copy order ID: ${c.orderId}`} />
                        {c.fulfillmentChannel && <span>· {c.fulfillmentChannel}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs font-mono">
                      {c.returnReason}
                    </td>
                    <td className="px-4 py-3">
                      {eligibilityChip(c.eligibility)}
                      {c.eligibilityReasons.length > 0 && (
                        <div className="text-[10px] text-text-tertiary mt-1 max-w-[220px]">
                          {c.eligibilityReasons[0]}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-text-primary tabular-nums">
                      {formatCurrency(c.refundAmountCents)}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {c.disputeWindowUntil ? (
                        <span className={urgent ? 'text-negative font-semibold' : 'text-text-secondary'}>
                          {formatDate(c.disputeWindowUntil)}
                          {days !== null && c.status === 'pending' && c.eligibility !== 'not_eligible' && (
                            <div className={`text-[10px] ${urgent ? 'text-negative' : 'text-text-tertiary'}`}>
                              {days >= 0 ? `${days}d left` : 'Expired'}
                            </div>
                          )}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {c.status === 'pending' && c.eligibility !== 'not_eligible' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); openTemplate(c); }}
                              className="inline-flex items-center gap-1 px-2 h-7 text-[11px] rounded-sm text-accent hover:bg-bg-hover transition-colors border-[1.2px] border-current"
                              title="View dispute template"
                            >
                              View
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'file'); }}
                              className="px-2 h-7 text-[11px] rounded text-text-primary hover:text-text-primary transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong"
                              title="Mark as filed (skip template)"
                            >
                              <CheckCircle2 size={11} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'dismiss'); }}
                              className="px-2 h-7 text-[11px] rounded text-text-primary hover:text-negative transition-colors font-semibold hover:bg-bg-hover bg-bg-surface border-[1.5px] border-border-strong"
                              title="Dismiss"
                            >
                              <XCircle size={11} />
                            </button>
                          </>
                        )}
                        {c.status === 'filed' && (
                          <>
                            <span className="text-[10px] text-accent">Filed {c.filedAt ? formatDate(c.filedAt) : ''}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'received'); }}
                              className="px-2 h-7 text-[11px] rounded-sm text-positive hover:bg-positive/20 transition-colors border-[1.2px] border-current"
                              title="Mark as won"
                            >
                              Won
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); patchCandidate(c.id, 'reopen'); }}
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
                        {c.status === 'pending' && c.eligibility === 'not_eligible' && (
                          <span className="text-[10px] text-text-tertiary">Not eligible</span>
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

      {/* Dispute template modal */}
      {openCandidate && (() => {
        const template = getTemplateForReason(openCandidate.returnReason);
        const path = recoveryPathFor(openCandidate.fulfillmentChannel);
        const isFba = path === 'fba_reimbursement_case';
        return (
          <div
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
            onClick={() => setOpenCandidate(null)}
          >
            <div
              className="panel max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b-[1.5px] border-border-strong flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">{template.title}</h2>
                  <p className="text-xs text-text-tertiary mt-0.5 flex items-center gap-1.5 max-w-[500px]">
                    <span>Order</span>
                    <CopyableText text={openCandidate.orderId} variant="chip" title="Click to copy order ID" />
                    <span className="truncate">· {openCandidate.productName || openCandidate.asin} · {formatCurrency(openCandidate.refundAmountCents)}</span>
                  </p>
                </div>
                <button
                  onClick={() => setOpenCandidate(null)}
                  className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
                  title="Close"
                >
                  <XClose size={16} />
                </button>
              </div>

              <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
                {/* Path callout — explains which Amazon recovery flow this candidate uses */}
                <div className={`p-3 text-xs ${isFba ? 'attn-banner' : 'flash border-l-positive'}`}>
                  <div className="font-medium text-text-primary mb-1">
                    {isFba ? 'FBA — Reimbursement Claim Case' : 'MFN/SFP — SAFE-T Claim'}
                  </div>
                  <div className="text-text-secondary">
                    {isFba
                      ? 'FBA orders are NOT eligible for SAFE-T. Instead, file a Reimbursement Claim Case via Help → Get Support → Selling on Amazon → Fulfillment by Amazon → "Submit a reimbursement claim dispute". Use this when Amazon refunded the customer but didn\'t auto-reimburse you.'
                      : 'Non-FBA orders (SFP, MFN with prepaid return label, Easy Ship, VAS) are eligible for SAFE-T claims via the dedicated SAFE-T dashboard.'}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] label-caps text-text-tertiary block mb-2">
                    {isFba ? 'Claim message (paste into the case description)' : 'SAFE-T claim message (edit before submitting)'}
                  </label>
                  <textarea
                    value={editedBody}
                    onChange={(e) => setEditedBody(e.target.value)}
                    className="w-full h-64 px-3 py-2 bg-bg-elevated border border-border-default rounded text-sm text-text-primary focus:outline-none focus:border-link resize-y tabular-nums"
                  />
                </div>

                {template.evidenceChecklist.length > 0 && (
                  <div>
                    <label className="text-[11px] label-caps text-text-tertiary block mb-2">
                      Evidence to attach (recommended)
                    </label>
                    <ul className="space-y-1">
                      {template.evidenceChecklist.map((item, i) => (
                        <li key={i} className="text-xs text-text-secondary flex items-start gap-2">
                          <span className="text-text-tertiary mt-0.5">·</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="bg-accent/5 border border-accent/20 rounded p-3 text-xs text-text-secondary">
                  <div className="font-medium text-text-primary mb-1.5">How to file (3-5 minutes)</div>
                  {isFba ? (
                    <ol className="space-y-1">
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">1.</span><span>Click <strong>&quot;Open Get Support & mark filed&quot;</strong> below.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">2.</span><span>Choose <strong>Selling on Amazon</strong> → <strong>Fulfillment by Amazon</strong>.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">3.</span><span>Click <strong>&quot;Submit a reimbursement claim dispute&quot;</strong>.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">4.</span><span>Enter the order ID: <code className="font-mono bg-bg-elevated px-1 rounded">{openCandidate.orderId}</code></span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">5.</span><span>Paste the claim message above as the case description.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">6.</span><span>Submit. Amazon decides within 1-3 business days.</span></li>
                    </ol>
                  ) : (
                    <ol className="space-y-1">
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">1.</span><span>Click <strong>&quot;Open SAFE-T & mark filed&quot;</strong> below.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">2.</span><span>Click <strong>&quot;File a new SAFE-T claim&quot;</strong>.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">3.</span><span>Paste the order ID: <code className="font-mono bg-bg-elevated px-1 rounded">{openCandidate.orderId}</code></span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">4.</span><span>Pick the matching return reason and paste the claim message above as the explanation.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">5.</span><span>Attach evidence (screenshots, tracking, etc.) if you have any.</span></li>
                      <li className="flex gap-2"><span className="text-text-primary tabular-nums">6.</span><span>Submit. Amazon decides within 1-2 weeks.</span></li>
                    </ol>
                  )}
                  <div className="mt-2 pt-2 border-t border-border-subtle">
                    Confidence: <span className={
                      template.confidence === 'high' ? 'text-positive' :
                      template.confidence === 'medium' ? 'text-warning' : 'text-text-tertiary'
                    }>{template.confidence.toUpperCase()}</span>
                    {!isFba && <span className="ml-3"><a href={safetHelpUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">SAFE-T help docs ↗</a></span>}
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between bg-bg-elevated/30">
                <button
                  onClick={() => {
                    if (openCandidate) {
                      patchCandidate(openCandidate.id, 'dismiss');
                      setOpenCandidate(null);
                    }
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
                    href={isFba ? fbaReimbursementCaseUrl : safetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => patchCandidate(openCandidate.id, 'file')}
                    className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-accent text-text-inverse rounded font-bold hover:bg-accent/90 transition-colors"
                    title={isFba ? "Opens Get Support. Choose Selling on Amazon → FBA → Submit a reimbursement claim dispute." : "Opens the SAFE-T Claims dashboard."}
                  >
                    <ExternalLink size={12} /> {isFba ? 'Open Get Support' : 'Open SAFE-T'} & mark filed
                  </a>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
