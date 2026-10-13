/**
 * GET   /api/data/recovery — Recovery Hub: grand totals, per-source summaries,
 *        and the UNIFIED ACTION QUEUE — every claimable item across all five
 *        recovery surfaces (warehouse-loss claims, reimbursement re-evaluations,
 *        Amazon SAFE-T disputes, Walmart disputes, discrepancy detectors),
 *        normalized to one shape with server-rendered claim text, filing URL,
 *        deadline, and plain-English reason. The hub is the one place that
 *        answers "what should I file a case for right now."
 * PATCH /api/data/recovery — status lifecycle (file / dismiss / received /
 *        reopen), dispatched by `source` to the right underlying table.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import {
  getTemplateForCandidate as wmtTemplate,
  renderTemplate as renderWmt,
} from '@/lib/walmart-disputes/templates';
import {
  getTemplateForReason as amzTemplate,
  renderTemplate as renderAmz,
} from '@/lib/amazon-claims/disputeTemplates';
import { openDb } from '@/lib/db-conn';

const getDb = () => openDb();

const GET_SUPPORT_URL = 'https://sellercentral.amazon.com/cu/contact-us';
const SAFET_URL = 'https://sellercentral.amazon.com/safetclaim/dashboard';
const WMT_DISPUTE_URL = 'https://seller.walmart.com/returns-reimbursements/dashboard';

type Source = 'discrepancy' | 'claims' | 'reevals' | 'amz' | 'wmt';

export interface QueueItem {
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

export interface RecoverySource {
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

const fmtUsd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildQueue(db: Database.Database): QueueItem[] {
  const queue: QueueItem[] = [];

  // ---- 1. Discrepancy detectors (refund-no-return, fee overcharge, replacement-no-return) ----
  const disc = db.prepare(`
    SELECT id, discrepancy_type as t, order_id as orderId, asin, sku, product_name as productName,
           event_date as eventDate, quantity, estimated_value_cents as amount, eligibility,
           eligibility_reasons as reasons, window_until as windowUntil, detail, status, filed_at as filedAt
    FROM recovery_discrepancies WHERE eligibility != 'not_eligible'
  `).all() as any[];
  for (const r of disc) {
    let reasons: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let detail: Record<string, any> = {};
    try { reasons = JSON.parse(r.reasons || '[]'); } catch { /* keep empty */ }
    try { detail = JSON.parse(r.detail || '{}'); } catch { /* keep empty */ }
    const isRnr = r.t === 'refund_no_return';
    const isRepl = r.t === 'replacement_no_return';
    queue.push({
      source: 'discrepancy',
      sourceLabel: isRnr ? 'Refund, no return' : isRepl ? 'Replacement, not made whole' : 'FBA fee overcharge',
      id: r.id,
      marketplace: 'amazon',
      productName: r.productName,
      refId: r.orderId || r.asin,
      refLabel: r.orderId ? 'Order' : 'ASIN',
      sku: r.sku, asin: r.asin,
      quantity: r.quantity,
      amountCents: r.amount || 0,
      eventDate: r.eventDate,
      windowUntil: r.windowUntil,
      eligibility: r.eligibility === 'waiting' ? 'waiting' : 'eligible',
      reason: reasons[0] || (isRnr ? 'Customer was refunded but never returned the item' : isRepl ? 'Free replacement shipped and never reimbursed' : 'Per-unit FBA fee jumped vs its own baseline'),
      status: r.status,
      filedAt: r.filedAt,
      claimText: isRnr
        ? [
            `Subject: Reimbursement claim — customer return never received (Order ${r.orderId})`, '',
            `Hello,`, '',
            `On ${fmtDate(r.eventDate)}, a refund of ${fmtUsd(r.amount || 0)} was issued to the customer on order ${r.orderId} (${r.productName || r.asin || r.sku}, SKU ${r.sku || '—'}).`, '',
            `More than 60 days have passed and the returned item has never been received at a fulfillment center — there is no entry for this order in the FBA Customer Returns report, and no reimbursement (including a proactive one) has been issued to my account.`, '',
            `Per the FBA Inventory Reimbursement Policy (Customer Return Claims), when a customer is refunded but does not return the item, the seller may claim reimbursement between 60 and 120 days after the refund. This claim is inside that window. I'm requesting reimbursement of ${fmtUsd(r.amount || 0)} for this order (sourcing cost documentation available on request).`, '',
            `Thank you.`,
          ].join('\n')
        : isRepl ? [
            `Subject: Reimbursement claim — replacement order ${r.orderId}, original item not returned`, '',
            `Hello,`, '',
            `On ${fmtDate(r.eventDate)}, Amazon shipped a free replacement (order ${r.orderId}) for original order ${detail.originalOrderId || '—'} (${r.productName || r.asin || r.sku}, SKU ${r.sku || '—'}, quantity ${r.quantity || 1}).${detail.reasonLabel ? ` Amazon's Replacements report records the reason as "${detail.reasonLabel}".` : ''}`, '',
            `More than 60 days have passed. The original unit has not been returned to my sellable inventory and no reimbursement has been issued to my account for either order, so I have shipped two units and been paid for one.`, '',
            `Per the FBA Inventory Reimbursement Policy (Customer Return Claims), a claim may be filed between 60 and 120 days after the customer received a replacement. This claim is inside that window. I'm requesting reimbursement of ${fmtUsd(r.amount || 0)} for the unreturned unit (sourcing cost documentation available on request).`, '',
            `Thank you.`,
          ].join('\n')
        : [
            `Subject: FBA fulfillment fee remeasurement request — ASIN ${r.asin}`, '',
            `Hello,`, '',
            `The per-unit FBA fulfillment fee for ASIN ${r.asin} (${r.productName || ''}) increased from ${fmtUsd(detail.baselineCents || 0)} to ${fmtUsd(detail.recentCents || 0)} per unit without any change to the product or its packaging.`, '',
            `I believe the item was remeasured incorrectly. Please remeasure (cubiscan) this ASIN and, if the original dimensions are confirmed, reimburse the fee difference of ${fmtUsd(detail.deltaCents || 0)}/unit for the ${detail.recentOrders || 0} units charged at the higher rate (approximately ${fmtUsd(r.amount || 0)}).`, '',
            `Thank you.`,
          ].join('\n'),
      evidence: reasons,
      fileUrl: GET_SUPPORT_URL,
      fileUrlLabel: 'Open Get Support',
      steps: [
        'Click "Open & mark filed" — Seller Central Get Support opens.',
        'Choose Selling on Amazon → Fulfillment by Amazon.',
        isRnr ? 'Describe it as a customer return not received reimbursement claim.'
          : isRepl ? 'First check Manage FBA Returns for the ORIGINAL order — if the unit came back, dismiss this instead. Otherwise describe it as a replacement where the original was never returned.'
          : 'Request a remeasurement (cubiscan) and fee reimbursement.',
        'Paste the claim message as the case description and submit.',
      ],
    });
  }

  // ---- 2. Warehouse-loss claims (reimbursement_candidates) ----
  const claims = db.prepare(`
    SELECT id, adjustment_date as eventDate, asin, sku, product_name as productName,
           fulfillment_center_id as fc, reason, disposition, quantity,
           estimated_value_cents as amount, eligible_until as windowUntil, status, filed_at as filedAt
    FROM reimbursement_candidates WHERE status NOT IN ('matched')
  `).all() as any[];
  for (const r of claims) {
    queue.push({
      source: 'claims',
      sourceLabel: 'Warehouse loss',
      id: r.id,
      marketplace: 'amazon',
      productName: r.productName,
      refId: r.asin || r.sku,
      refLabel: 'ASIN',
      sku: r.sku, asin: r.asin,
      quantity: Math.abs(r.quantity),
      amountCents: r.amount || 0,
      eventDate: r.eventDate,
      windowUntil: r.windowUntil,
      eligibility: 'eligible',
      reason: `Amazon recorded ${Math.abs(r.quantity)} unit(s) ${r.disposition || ''} lost/adjusted at ${r.fc || 'an FC'} but never reimbursed`,
      status: r.status,
      filedAt: r.filedAt,
      claimText: [
        `Subject: Reimbursement claim — inventory lost/damaged in FBA warehouse (ASIN ${r.asin || r.sku})`, '',
        `Hello,`, '',
        `Your inventory ledger shows an adjustment of ${Math.abs(r.quantity)} unit(s) of ${r.productName || r.asin || r.sku} (ASIN ${r.asin || '—'}, SKU ${r.sku || '—'}) on ${fmtDate(r.eventDate)} at ${r.fc || 'a fulfillment center'} (disposition: ${r.disposition || 'n/a'}).`, '',
        `No reimbursement has been issued for this loss. Per the FBA Inventory Reimbursement Policy (Warehouse Lost & Damaged), I'm requesting reimbursement of approximately ${fmtUsd(r.amount || 0)}.`, '',
        `Thank you.`,
      ].join('\n'),
      evidence: ['Inventory Ledger report showing the adjustment', 'No matching reimbursement in the Reimbursements report'],
      fileUrl: GET_SUPPORT_URL,
      fileUrlLabel: 'Open Get Support',
      steps: [
        'Click "Open & mark filed" — Seller Central Get Support opens.',
        'Choose Selling on Amazon → Fulfillment by Amazon → Inventory lost in FBA warehouse.',
        'Paste the claim message and submit.',
      ],
    });
  }

  // ---- 3. Reimbursement re-evaluations (Amazon underpaid) ----
  const reevals = db.prepare(`
    SELECT id, CASE WHEN instr(reimbursement_id, ':') > 0 THEN substr(reimbursement_id, 1, instr(reimbursement_id, ':') - 1) ELSE reimbursement_id END as reimbId, reimbursement_date as eventDate, asin, sku,
           product_name as productName, quantity, paid_cents as paid, expected_cents as expected,
           gap_cents as amount, reason, date(reimbursement_date, '+60 days') as windowUntil,
           status, filed_at as filedAt
    FROM amazon_reimbursement_reevaluations
  `).all() as any[];
  for (const r of reevals) {
    queue.push({
      source: 'reevals',
      sourceLabel: 'Underpaid reimbursement',
      id: r.id,
      marketplace: 'amazon',
      productName: r.productName,
      refId: r.reimbId,
      refLabel: 'Reimb ID',
      sku: r.sku, asin: r.asin,
      quantity: r.quantity,
      amountCents: r.amount || 0,
      eventDate: r.eventDate,
      windowUntil: r.windowUntil,
      eligibility: 'eligible',
      reason: `Amazon paid ${fmtUsd(r.paid)} vs ${fmtUsd(r.expected)} documented value — ${fmtUsd(r.amount)} short (${r.reason || 'reimbursement'})`,
      status: r.status,
      filedAt: r.filedAt,
      claimText: [
        `Subject: Reimbursement re-evaluation request — reimbursement ID ${r.reimbId}`, '',
        `Hello,`, '',
        `Reimbursement ${r.reimbId} (${fmtDate(r.eventDate)}) paid ${fmtUsd(r.paid)} for ${r.quantity} unit(s) of ${r.productName || r.asin || r.sku} (ASIN ${r.asin || '—'}).`, '',
        `My documented value for this item is ${fmtUsd(r.expected)} (${r.quantity} × sourcing cost — invoice available on request). Per the FBA reimbursement policy, please re-evaluate this reimbursement and pay the difference of ${fmtUsd(r.amount)}.`, '',
        `Thank you.`,
      ].join('\n'),
      evidence: ['Purchase invoice showing sourcing cost', `Reimbursement ID ${r.reimbId} (copy it — the dispute form requires it)`],
      fileUrl: GET_SUPPORT_URL,
      fileUrlLabel: 'Open Get Support',
      steps: [
        'Copy the Reimbursement ID above — the form requires it.',
        'Click "Open & mark filed" — Get Support opens.',
        'Search "Submit a reimbursement claim dispute", enter the ID, attach your invoice.',
        'File FAST — the window is 60 days from the reimbursement.',
      ],
    });
  }

  // ---- 4 + 5. Amazon SAFE-T + Walmart disputes ----
  for (const [source, table, marketplace] of [
    ['amz', 'amazon_dispute_candidates', 'amazon'],
    ['wmt', 'walmart_dispute_candidates', 'walmart'],
  ] as [Source, string, 'amazon' | 'walmart'][]) {
    const rows = db.prepare(`
      SELECT id, order_id as orderId, refund_date as eventDate, return_reason as reason,
             asin, sku, product_name as productName, refund_amount_cents as amount,
             fulfillment_channel as channel, eligibility, eligibility_reasons as reasons,
             dispute_window_until as windowUntil, status, filed_at as filedAt
      FROM ${table} WHERE eligibility IN ('eligible', 'maybe')
    `).all() as any[];
    for (const r of rows) {
      let reasons: string[] = [];
      try { reasons = JSON.parse(r.reasons || '[]'); } catch { /* keep empty */ }
      const vars = {
        orderId: r.orderId,
        refundDate: fmtDate(r.eventDate),
        refundAmount: fmtUsd(r.amount),
        productName: r.productName || '',
        asin: r.asin || '',
        sku: r.sku || '',
        reason: r.reason,
      };
      const isAmz = source === 'amz';
      const isFba = isAmz && r.channel === 'FBA';
      const tpl = isAmz ? amzTemplate(r.reason) : wmtTemplate(r.reason, reasons);
      const lostInPipeline = !isAmz && reasons.some((t: string) => t.includes('never returned') || t.includes('lost in Walmart'));
      queue.push({
        source,
        sourceLabel: isAmz ? 'SAFE-T dispute' : (lostInPipeline ? 'WFS lost return' : 'WFS dispute'),
        id: r.id,
        marketplace,
        productName: r.productName,
        refId: r.orderId,
        refLabel: 'Order',
        sku: r.sku, asin: r.asin,
        quantity: 1,
        amountCents: r.amount || 0,
        eventDate: r.eventDate,
        windowUntil: r.windowUntil,
        eligibility: r.eligibility === 'maybe' ? 'maybe' : 'eligible',
        reason: reasons[0] || `${r.reason} refund — disputable`,
        status: r.status,
        filedAt: r.filedAt,
        claimText: isAmz
          ? renderAmz(tpl, vars, isFba ? 'fba_reimbursement_case' : 'safet')
          : renderWmt(tpl, vars),
        evidence: tpl.evidenceChecklist,
        fileUrl: isAmz ? (isFba ? GET_SUPPORT_URL : SAFET_URL) : WMT_DISPUTE_URL,
        fileUrlLabel: isAmz ? (isFba ? 'Open Get Support' : 'Open SAFE-T dashboard') : 'Open Seller Center',
        steps: isAmz
          ? [
              isFba ? 'Click "Open & mark filed" — Get Support opens; file a reimbursement claim case.' : 'Click "Open & mark filed" — the SAFE-T dashboard opens.',
              'Find the order, start the claim, paste the message.',
              'Attach the evidence listed above and submit.',
            ]
          : [
              'Click "Open & mark filed" — Seller Center Returns & Reimbursements opens.',
              ...(lostInPipeline ? ['First check Payments → Services Fees → Refund for a LostReturnAdjustment on this PO: Walmart may already have paid it.'] : []),
              lostInPipeline ? 'Use "Initiate claim" (the Dispute button is blocked for WFS returns).' : 'Find the return and open a dispute.',
              'Paste the message, attach evidence, submit.',
            ],
      });
    }
  }

  return queue;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get('tab') || 'tofile';

  const db = getDb();
  try {
    // ---- per-source aggregates (cards) ----
    const agg = (sql: string) => db.prepare(sql).get() as Record<string, number | null>;
    const claims = agg(`
      SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'pending' THEN COALESCE(estimated_value_cents, 0) ELSE 0 END) as pendingValue,
        SUM(CASE WHEN status = 'pending' AND date(eligible_until) < date('now', '+14 days') THEN 1 ELSE 0 END) as urgent,
        SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed,
        SUM(CASE WHEN status = 'filed' THEN COALESCE(estimated_value_cents, 0) ELSE 0 END) as filedValue,
        SUM(CASE WHEN status = 'received' THEN COALESCE(estimated_value_cents, 0) ELSE 0 END) as recovered
      FROM reimbursement_candidates`);
    const reevals = agg(`
      SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'pending' THEN gap_cents ELSE 0 END) as pendingValue,
        SUM(CASE WHEN status = 'pending' AND date(reimbursement_date, '+60 days') < date('now', '+14 days') THEN 1 ELSE 0 END) as urgent,
        SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed,
        SUM(CASE WHEN status = 'filed' THEN gap_cents ELSE 0 END) as filedValue,
        SUM(CASE WHEN status = 'received' THEN gap_cents ELSE 0 END) as recovered
      FROM amazon_reimbursement_reevaluations`);
    const disputeAgg = (table: string) => agg(`
      SELECT SUM(CASE WHEN status = 'pending' AND eligibility IN ('eligible', 'maybe') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'pending' AND eligibility IN ('eligible', 'maybe') THEN refund_amount_cents ELSE 0 END) as pendingValue,
        SUM(CASE WHEN status = 'pending' AND eligibility IN ('eligible', 'maybe') AND date(dispute_window_until) < date('now', '+14 days') THEN 1 ELSE 0 END) as urgent,
        SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed,
        SUM(CASE WHEN status = 'filed' THEN refund_amount_cents ELSE 0 END) as filedValue,
        SUM(CASE WHEN status = 'received' THEN refund_amount_cents ELSE 0 END) as recovered
      FROM ${table}`);
    const amzDisputes = disputeAgg('amazon_dispute_candidates');
    const wmtDisputes = disputeAgg('walmart_dispute_candidates');
    const discrepancies = agg(`
      SELECT SUM(CASE WHEN status = 'pending' AND eligibility = 'eligible' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'pending' AND eligibility = 'eligible' THEN estimated_value_cents ELSE 0 END) as pendingValue,
        SUM(CASE WHEN status = 'pending' AND eligibility = 'eligible' AND window_until IS NOT NULL AND date(window_until) < date('now', '+14 days') THEN 1 ELSE 0 END) as urgent,
        SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed,
        SUM(CASE WHEN status = 'filed' THEN estimated_value_cents ELSE 0 END) as filedValue,
        SUM(CASE WHEN status = 'received' THEN estimated_value_cents ELSE 0 END) as recovered
      FROM recovery_discrepancies`);

    const n = (v: number | null | undefined) => v || 0;
    const toSource = (key: string, label: string, href: string, description: string, a: Record<string, number | null>): RecoverySource => ({
      key, label, href, description,
      pendingCount: n(a.pending), pendingValueCents: n(a.pendingValue), urgentCount: n(a.urgent),
      filedCount: n(a.filed), filedValueCents: n(a.filedValue), recoveredValueCents: n(a.recovered),
    });

    const sources: RecoverySource[] = [
      toSource('discrepancies', 'Discrepancy Detectors', '/bookkeep/recovery', 'Refunds never returned + FBA fee overcharges', discrepancies),
      toSource('claims', 'Claims to File', '/bookkeep/claims-to-file', 'FBA warehouse lost/damaged inventory Amazon never reimbursed', claims),
      toSource('reevals', 'Re-Evaluations', '/bookkeep/reimbursement-reevaluations', 'Reimbursements Amazon paid below documented value', reevals),
      toSource('amz', 'Amazon SAFE-T', '/bookkeep/amazon-disputes', 'MFN/SFP refunds where customer fault is disputable', amzDisputes),
      toSource('wmt', 'Walmart Disputes', '/bookkeep/walmart-disputes', 'WFS auto-refunds and lost-in-pipeline returns', wmtDisputes),
    ];

    const grand = sources.reduce(
      (acc, s) => ({
        pendingCount: acc.pendingCount + s.pendingCount,
        pendingValueCents: acc.pendingValueCents + s.pendingValueCents,
        urgentCount: acc.urgentCount + s.urgentCount,
        filedCount: acc.filedCount + s.filedCount,
        filedValueCents: acc.filedValueCents + s.filedValueCents,
        recoveredValueCents: acc.recoveredValueCents + s.recoveredValueCents,
      }),
      { pendingCount: 0, pendingValueCents: 0, urgentCount: 0, filedCount: 0, filedValueCents: 0, recoveredValueCents: 0 }
    );

    // ---- unified queue, filtered by tab ----
    const all = buildQueue(db);
    let queue: QueueItem[];
    if (tab === 'tofile') queue = all.filter(q => q.status === 'pending' && q.eligibility === 'eligible');
    else if (tab === 'waiting') queue = all.filter(q => q.status === 'pending' && (q.eligibility === 'waiting' || q.eligibility === 'maybe'));
    else if (tab === 'filed') queue = all.filter(q => q.status === 'filed' || q.status === 'received');
    else if (tab === 'closed') queue = all.filter(q => ['expired', 'dismissed'].includes(q.status));
    else queue = all;

    queue.sort((a, b) =>
      (a.windowUntil || '9999').localeCompare(b.windowUntil || '9999') || b.amountCents - a.amountCents
    );

    const lastSync = (db.prepare(`SELECT value FROM settings WHERE key = 'recovery_scan_last_sync'`).get() as { value: string } | undefined)?.value || null;

    return NextResponse.json({ sources, grand, queue, lastSync });
  } finally {
    db.close();
  }
}

const PATCH_TABLES: Record<Source, string> = {
  discrepancy: 'recovery_discrepancies',
  claims: 'reimbursement_candidates',
  reevals: 'amazon_reimbursement_reevaluations',
  amz: 'amazon_dispute_candidates',
  wmt: 'walmart_dispute_candidates',
};

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, action, claimNotes } = body as { id: number; action: 'file' | 'dismiss' | 'received' | 'reopen'; claimNotes?: string };
  const source = (body.source || 'discrepancy') as Source;
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });
  const table = PATCH_TABLES[source];
  if (!table) return NextResponse.json({ error: `Unknown source: ${source}` }, { status: 400 });

  const db = getDb();
  try {
    if (action === 'file') {
      db.prepare(`UPDATE ${table} SET status = 'filed', filed_at = datetime('now'), claim_notes = ?, updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'dismiss') {
      db.prepare(`UPDATE ${table} SET status = 'dismissed', claim_notes = COALESCE(?, claim_notes), updated_at = datetime('now') WHERE id = ?`).run(claimNotes || null, id);
    } else if (action === 'received') {
      db.prepare(`UPDATE ${table} SET status = 'received', updated_at = datetime('now') WHERE id = ?`).run(id);
    } else if (action === 'reopen') {
      db.prepare(`UPDATE ${table} SET status = 'pending', filed_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } finally {
    db.close();
  }
}
