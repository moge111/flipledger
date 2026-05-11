/**
 * SP-API Finances v2024 client.
 *
 * Why this exists: the v0 Financial Events API (we already use it) returns
 * "ShipmentEvent" records but does NOT expose Amazon's per-transaction
 * Delivery Date Policy (DD7) state. To accurately track when an FBM/FBA sale's
 * funds release to the seller — and to correctly distinguish a refund of
 * held funds (no cash impact) vs a refund of disbursed funds (real cash out)
 * — we need v2024 which exposes:
 *
 *   transactionStatus: "DEFERRED" | "RELEASED" | "DEFERRED_RELEASED"
 *   contexts[].deferralReason: e.g. "DD7"
 *   contexts[].maturityDate: when funds actually release
 *
 * One v2024 transaction corresponds to one v0 ShipmentEvent (or Refund, etc.).
 * They share the order_id; transactionId itself is opaque (Amazon-internal).
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export interface FinanceV2Transaction {
  transactionId: string;
  transactionType: string;
  transactionStatus: 'DEFERRED' | 'RELEASED' | 'DEFERRED_RELEASED';
  deferralReason: string | null;
  maturityDate: string | null;
  postedDate: string;
  totalAmountCents: number;
  marketplaceId: string | null;
  orderId: string | null;
  shipmentId: string | null;
  settlementId: string | null;
  financialEventGroupId: string | null;
  description: string | null;
}

function toCents(amount: number | undefined): number {
  if (amount === undefined || amount === null) return 0;
  return Math.round(amount * 100);
}

function extractRelatedId(tx: any, name: string): string | null {
  const items: any[] = tx?.relatedIdentifiers || [];
  const hit = items.find((r) => r?.relatedIdentifierName === name);
  return hit?.relatedIdentifierValue || null;
}

function extractDeferralContext(tx: any): { reason: string | null; maturity: string | null } {
  const contexts: any[] = tx?.contexts || [];
  const def = contexts.find((c) => c?.contextType === 'DeferredContext');
  return {
    reason: def?.deferralReason || null,
    maturity: def?.maturityDate || null,
  };
}

/**
 * Sync all transactions posted in the given window.
 *
 * Defaults: last 30 days. Max window per Amazon: 31 days. Use multiple calls
 * to backfill longer.
 */
export async function syncFinancesV2024Transactions(
  credentials: SPAPICredentials,
  postedAfterIso?: string,
  postedBeforeIso?: string
): Promise<{ inserted: number; updated: number; pagesFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let inserted = 0;
  let updated = 0;
  let pagesFetched = 0;
  const now = new Date().toISOString();

  const postedAfter = postedAfterIso || new Date(Date.now() - 30 * 86400000).toISOString();

  // Use INSERT OR REPLACE keyed on transaction_id — Amazon may update
  // transactionStatus from DEFERRED → RELEASED over time, and we want the
  // latest state for any given transactionId.
  const upsert = db.prepare(`
    INSERT INTO finances_transactions_v2 (
      transaction_id, transaction_type, transaction_status, deferral_reason,
      posted_date, maturity_date, total_amount_cents, marketplace_id,
      order_id, shipment_id, settlement_id, financial_event_group_id,
      description, raw_data, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      transaction_status = excluded.transaction_status,
      deferral_reason = excluded.deferral_reason,
      maturity_date = excluded.maturity_date,
      raw_data = excluded.raw_data,
      fetched_at = excluded.fetched_at
  `);

  try {
    let nextToken: string | undefined;
    do {
      const params: Record<string, string> = nextToken
        ? { nextToken }
        : {
            postedAfter,
            marketplaceId: credentials.marketplaceId,
            ...(postedBeforeIso ? { postedBefore: postedBeforeIso } : {}),
          };

      const response = await spApiRequest(
        credentials,
        '/finances/2024-06-19/transactions',
        params
      );
      pagesFetched++;

      const txs: any[] = response?.payload?.transactions || [];
      for (const tx of txs) {
        try {
          const { reason, maturity } = extractDeferralContext(tx);
          const result = upsert.run(
            tx.transactionId,
            tx.transactionType,
            tx.transactionStatus,
            reason,
            tx.postedDate,
            maturity,
            toCents(tx?.totalAmount?.currencyAmount),
            tx?.marketplaceDetails?.marketplaceId || tx?.sellingPartnerMetadata?.marketplaceId || null,
            extractRelatedId(tx, 'ORDER_ID'),
            extractRelatedId(tx, 'SHIPMENT_ID'),
            extractRelatedId(tx, 'SETTLEMENT_ID'),
            extractRelatedId(tx, 'FINANCIAL_EVENT_GROUP_ID'),
            tx.description || null,
            JSON.stringify(tx),
            now
          );
          // result.changes is 1 for both INSERT and UPDATE in SQLite — distinguish
          // by checking lastInsertRowid (non-zero on insert, 0 on update).
          if (Number(result.lastInsertRowid) > 0) {
            inserted++;
          } else {
            updated++;
          }
        } catch (err) {
          errors.push(`Transaction ${tx.transactionId}: ${err}`);
        }
      }

      nextToken = response?.payload?.nextToken;
    } while (nextToken);
  } catch (err) {
    errors.push(`syncFinancesV2024Transactions: ${err}`);
  } finally {
    db.close();
  }

  return { inserted, updated, pagesFetched, errors };
}
