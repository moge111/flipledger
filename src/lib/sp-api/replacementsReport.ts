/**
 * SP-API FBA Replacements report sync.
 *
 * A replacement order ships a second unit to the customer for free. The Orders
 * API flags it (IsReplacementOrder + ReplacedOrderId — captured in orders.ts)
 * but never says WHY. The reason only exists in the FBA Replacements report
 * (`GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA`), as a numeric
 * `replacement-reason-code`.
 *
 * Rows are keyed on the replacement's SHIP date, so a replacement only appears
 * here a day or two after it ships. The report also backfills the flag and the
 * original order id for replacements older than the orders-sync window.
 *
 * FBA only, and the sync only annotates orders we already have — it never
 * creates an order from a report row.
 */
import { getAccessToken, getEndpoint, fetchWithRetry } from './auth';
import { waitForReport } from './customerReturns';
import { downloadReport } from './reports';
import type { SPAPICredentials } from './types';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('sp-api/replacementsReport');

// Amazon's documented replacement-reason-code values (Replacements report help page).
export const REPLACEMENT_REASONS: Record<number, string> = {
  0: 'Other',
  1: 'Was lost',
  2: 'Defective',
  3: 'Damaged in shipping',
  4: 'Shipped wrong item',
  5: 'Item missing from shipment',
  6: 'Lost by shipper',
  7: 'Catalog error / wrong item ordered',
  8: 'Shipped to wrong address',
  9: 'Delivery problem (correct address)',
  10: 'Damaged due to FC handling',
  11: 'Shipment in cleanup: item not received',
  12: 'Policy exception / customer error',
};

export function replacementReasonLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return REPLACEMENT_REASONS[code] ?? `Code ${code}`;
}

export interface ReplacementRow {
  shipmentDate: string;
  sku: string;
  asin: string;
  quantity: number;
  reasonCode: number | null;
  replacementOrderId: string;
  originalOrderId: string;
}

/** Parse the TSV body. Columns are looked up by header name, not position. */
export function parseReplacementsReport(tsv: string): ReplacementRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
  const headerCols = lines[0].split('\t').map(unquote);
  const colIdx = (name: string) => headerCols.indexOf(name);

  const iShipDate = colIdx('shipment-date');
  const iSku = colIdx('sku');
  const iAsin = colIdx('asin');
  const iQuantity = colIdx('quantity');
  const iReason = colIdx('replacement-reason-code');
  const iReplacement = colIdx('replacement-amazon-order-id');
  const iOriginal = colIdx('original-amazon-order-id');

  if (iReplacement < 0 || iOriginal < 0) {
    throw new Error(`Replacements report header missing required columns: ${headerCols.join(', ')}`);
  }

  const rows: ReplacementRow[] = [];
  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
    const cols = lines[lineIdx].split('\t').map(unquote);
    const replacementOrderId = cols[iReplacement] || '';
    if (!replacementOrderId) continue;
    const rawReason = iReason >= 0 ? cols[iReason] : '';
    const reasonCode = rawReason !== undefined && rawReason !== '' && !Number.isNaN(Number(rawReason))
      ? Number(rawReason)
      : null;
    rows.push({
      shipmentDate: iShipDate >= 0 ? cols[iShipDate] || '' : '',
      sku: iSku >= 0 ? cols[iSku] || '' : '',
      asin: iAsin >= 0 ? cols[iAsin] || '' : '',
      quantity: iQuantity >= 0 ? parseInt(cols[iQuantity] || '0', 10) : 0,
      reasonCode,
      replacementOrderId,
      originalOrderId: cols[iOriginal] || '',
    });
  }
  return rows;
}

/** Stamp report rows onto existing orders. Idempotent. Exported for tests. */
export function applyReplacementRows(rows: ReplacementRow[]): {
  matched: number;
  updated: number;
  unmatched: number;
} {
  const db = openDb();
  let matched = 0;
  let updated = 0;
  let unmatched = 0;
  try {
    const find = db.prepare(
      `SELECT is_replacement as isReplacement, replaced_order_id as replacedOrderId, replacement_reason_code as reasonCode
       FROM orders WHERE order_id = ? AND marketplace = 'amazon'`
    );
    const update = db.prepare(
      `UPDATE orders SET is_replacement = 1,
         replaced_order_id = COALESCE(?, replaced_order_id),
         replacement_reason_code = COALESCE(?, replacement_reason_code)
       WHERE order_id = ?`
    );
    type Existing = { isReplacement: number | null; replacedOrderId: string | null; reasonCode: number | null };

    const tx = db.transaction(() => {
      for (const row of rows) {
        const existing = find.get(row.replacementOrderId) as Existing | undefined;
        if (!existing) { unmatched++; continue; }
        matched++;
        const original = row.originalOrderId || null;
        const changed = existing.isReplacement !== 1
          || (original !== null && existing.replacedOrderId !== original)
          || (row.reasonCode !== null && existing.reasonCode !== row.reasonCode);
        if (changed) {
          update.run(original, row.reasonCode, row.replacementOrderId);
          updated++;
        }
      }
    });
    tx();
  } finally {
    db.close();
  }
  return { matched, updated, unmatched };
}

export async function syncReplacementsReport(
  credentials: SPAPICredentials,
  startDate: string,
  endDate: string
): Promise<{
  reportRows: number;
  matched: number;
  updated: number;
  unmatched: number;
  reasonBreakdown: Record<string, number>;
}> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);

  const response = await fetchWithRetry(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA',
      marketplaceIds: [credentials.marketplaceId],
      dataStartTime: startDate,
      dataEndTime: endDate,
    }),
  });
  if (!response.ok) {
    throw new Error(`SP-API createReport ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (!data?.reportId) {
    throw new Error(`createReport: missing reportId in response: ${JSON.stringify(data)}`);
  }
  log.info(`Created report ${data.reportId}`);

  const { reportDocumentId } = await waitForReport(credentials, data.reportId);
  const tsv = await downloadReport(credentials, reportDocumentId);
  const rows = parseReplacementsReport(tsv);

  const reasonBreakdown: Record<string, number> = {};
  for (const row of rows) {
    const label = replacementReasonLabel(row.reasonCode) ?? 'Unknown';
    reasonBreakdown[label] = (reasonBreakdown[label] || 0) + 1;
  }

  const result = applyReplacementRows(rows);
  log.info(`${rows.length} replacement rows — ${result.matched} matched, ${result.updated} updated, ${result.unmatched} not in orders`);
  return { reportRows: rows.length, ...result, reasonBreakdown };
}
