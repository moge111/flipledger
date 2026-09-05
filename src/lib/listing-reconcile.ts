/**
 * Reconcile a listing batch in 'sending' status against Amazon.
 *
 * Shared by:
 *   - GET /api/list/batches/[id]/status  (browser polling while the page is open)
 *   - the auto-sync sweep                 (server-side, so batches whose tab was
 *                                          closed mid-send still finish instead of
 *                                          sitting in 'sending' forever)
 *
 * For each item still PROCESSING it polls the listing and applies the
 * channel-aware ready check (FBA: FNSKU assigned; MFN: BUYABLE). For FBA it
 * also polls the inbound plan operation. When everything is done it
 * transitions the batch to 'ready'; on hard failures to 'failed'.
 */
import Database from 'better-sqlite3';
import { getListing, getSellerId } from '@/lib/sp-api/listingsItems';
import { getInboundOperation } from '@/lib/sp-api/inboundPlansV2';
import type { SPAPICredentials } from '@/lib/sp-api/types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('listing-reconcile');

const getDb = () => openDb();

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function saveListingState(batchId: number, itemId: number, state: { status: string; error: string | null }) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE listing_batch_items SET
        listing_status = ?,
        listing_error = ?,
        listing_updated_at = ?
      WHERE id = ? AND batch_id = ?
    `).run(state.status, state.error, new Date().toISOString(), itemId, batchId);
  } finally {
    db.close();
  }
}

export interface ReconcileResult {
  reconciled: boolean;
  /** Batch status after reconciliation ('sending' if still in flight). */
  status: string;
  operationStatus: string | null;
  reason?: string;
}

export async function reconcileSendingBatch(batchId: number): Promise<ReconcileResult> {
  const db = getDb();
  let batch: any;
  let items: any[];
  let creds: SPAPICredentials | null;
  try {
    batch = db.prepare(`
      SELECT id, status, channel,
             inbound_operation_id as inboundOperationId,
             plan_status as planStatus
      FROM listing_batches WHERE id = ?
    `).get(batchId);
    if (!batch) {
      return { reconciled: false, status: 'missing', operationStatus: null, reason: 'Batch not found' };
    }
    if (batch.status !== 'sending') {
      return { reconciled: false, status: batch.status, operationStatus: null, reason: `Batch is '${batch.status}', not 'sending'` };
    }
    items = db.prepare(`
      SELECT id, sku, listing_status as listingStatus, listing_error as listingError
      FROM listing_batch_items WHERE batch_id = ?
      ORDER BY id ASC
    `).all(batchId) as any[];
    creds = getAmazonCredentials(db);
  } finally {
    db.close();
  }

  if (!creds) {
    return { reconciled: false, status: batch.status, operationStatus: null, reason: 'Amazon SP-API credentials not configured' };
  }

  // Refresh each processing listing. Channel-aware "ready" check:
  //   FBA: FNSKU populated = listing is FBA-registered, ready for inbound.
  //        BUYABLE only happens after physical inventory arrives at Amazon —
  //        waiting for BUYABLE here would hang the batch indefinitely.
  //   MFN: summary.status contains 'BUYABLE' = customer can buy now.
  // ERROR-severity issues are surfaced as non-fatal warnings (most clear on
  // their own — fresh MFN listings can take 30+ min before BUYABLE).
  const sellerId = await getSellerId(creds).catch(() => null);
  if (sellerId) {
    for (const item of items) {
      if (item.listingStatus !== 'PROCESSING') continue;
      try {
        const listing = await getListing(creds, sellerId, item.sku);
        if (!listing) continue; // still being registered, leave as PROCESSING

        const summary = listing.summaries?.[0];
        const summaryStatus: string[] = summary?.status || [];
        const fnSku: string | undefined = summary?.fnSku;

        const isReady = batch.channel === 'FBA' ? !!fnSku : summaryStatus.includes('BUYABLE');

        const issues: any[] = listing.issues || [];
        const errorIssues = issues.filter((i: any) => (i?.severity || '').toUpperCase() === 'ERROR');
        const errorNote = errorIssues.length > 0
          ? errorIssues.map((i: any) => i.message).join('; ')
          : null;

        if (isReady) {
          saveListingState(batchId, item.id, { status: 'ACTIVE', error: errorNote });
          item.listingStatus = 'ACTIVE';
          item.listingError = errorNote;
        } else if (errorNote !== item.listingError) {
          saveListingState(batchId, item.id, { status: 'PROCESSING', error: errorNote });
          item.listingError = errorNote;
        }
      } catch (err) {
        log.warn(`listing poll failed for ${item.sku}:`, err);
      }
    }
  }

  // For FBA batches, also poll the inbound plan operation state.
  let operationStatus: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | null = null;
  let operationProblems: any[] = [];
  if (batch.channel === 'FBA' && batch.inboundOperationId && batch.planStatus !== 'SUCCESS') {
    try {
      const op = await getInboundOperation(creds, batch.inboundOperationId);
      operationStatus = op.operationStatus;
      operationProblems = op.operationProblems;
      const db2 = getDb();
      try {
        db2.prepare(`UPDATE listing_batches SET plan_status = ?, updated_at = ? WHERE id = ?`)
          .run(op.operationStatus, new Date().toISOString(), batchId);
      } finally {
        db2.close();
      }
      batch.planStatus = op.operationStatus;
    } catch (err) {
      log.warn(`operation poll failed:`, err);
    }
  }

  // Decide whether to transition to 'ready' or 'failed'.
  //   FBA: all shippable listings ACTIVE + operation SUCCESS
  //   MFN: all shippable listings ACTIVE (no operation)
  // Items flagged NOT_INBOUND_READY (no FNSKU) or FAILED (listing creation
  // rejected — gated ASIN, bad attributes) were deliberately EXCLUDED from
  // the shipment by the send flow (one stuck/gated listing must not block
  // the shipment) — they must not block readiness here either, and they are
  // not batch-level failures. The send flow already failBatches when EVERY
  // listing failed, so shippable is only empty on legacy/hand-edited batches.
  const shippable = items.filter((i) => i.listingStatus !== 'NOT_INBOUND_READY' && i.listingStatus !== 'FAILED');
  const allListingsReady = shippable.length > 0 && shippable.every((i) => i.listingStatus === 'ACTIVE');
  const noShippableItems = shippable.length === 0;
  const opDone = batch.channel === 'FBA'
    ? ((operationStatus || batch.planStatus) === 'SUCCESS')
    : true;
  const opFailed = batch.channel === 'FBA' && (operationStatus || batch.planStatus) === 'FAILED';

  let finalStatus = batch.status as string;
  if (noShippableItems || opFailed) {
    const errorMsg = noShippableItems
      ? 'Every listing in this batch failed or was excluded. See per-item errors.'
      : `Inbound plan operation failed: ${JSON.stringify(operationProblems)}`;
    const db3 = getDb();
    try {
      db3.prepare(`UPDATE listing_batches SET status = 'failed', send_error = ?, updated_at = ? WHERE id = ?`)
        .run(errorMsg, new Date().toISOString(), batchId);
    } finally {
      db3.close();
    }
    finalStatus = 'failed';
  } else if (allListingsReady && opDone) {
    const db4 = getDb();
    try {
      db4.prepare(`UPDATE listing_batches SET status = 'ready', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), batchId);
    } finally {
      db4.close();
    }
    finalStatus = 'ready';
  }

  return { reconciled: true, status: finalStatus, operationStatus: operationStatus || batch.planStatus || null };
}

/**
 * Sweep every batch stuck in 'sending' whose send started long enough ago
 * that the send POST cannot still be running server-side (the FBA send flow's
 * worst-case internal retries run ~80 minutes; 3 hours is a safe margin).
 * Called from the auto-sync tick.
 */
export async function reconcileStaleSendingBatches(): Promise<{ checked: number; transitioned: number }> {
  const db = getDb();
  let stale: { id: number; name: string }[];
  try {
    stale = db.prepare(`
      SELECT id, name FROM listing_batches
      WHERE status = 'sending'
        AND COALESCE(sent_at, updated_at, created_at) < datetime('now', '-3 hours')
    `).all() as { id: number; name: string }[];
  } finally {
    db.close();
  }

  let transitioned = 0;
  for (const b of stale) {
    try {
      const result = await reconcileSendingBatch(b.id);
      if (result.reconciled && result.status !== 'sending') {
        transitioned++;
        log.info(`Batch ${b.id} ("${b.name}") reconciled: sending → ${result.status}`);
      }
    } catch (err) {
      log.warn(`Batch ${b.id} reconcile failed:`, err);
    }
  }
  return { checked: stale.length, transitioned };
}
