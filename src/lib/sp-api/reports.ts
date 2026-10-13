/**
 * SP-API Reports API client.
 * Downloads settlement reports — Amazon's final word on all financial data.
 * This is where MFN shipping label costs live.
 */

import { spApiRequest } from './auth';
import type { SPAPICredentials } from './types';
import { isV2024CoveredServiceFee } from './serviceFeesV2024';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('sp-api/reports');

const getDb = () => openDb();

/**
 * List available settlement reports.
 */
export async function getSettlementReports(
  credentials: SPAPICredentials,
  startDate: string,
): Promise<any[]> {
  const params: Record<string, string> = {
    reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    processingStatuses: 'DONE',
    createdSince: startDate,
    pageSize: '100',
  };

  const response = await spApiRequest(credentials, '/reports/2021-06-30/reports', params);
  return response.reports || [];
}

/**
 * Download a report's content by document ID.
 */
export async function downloadReport(
  credentials: SPAPICredentials,
  reportDocumentId: string
): Promise<string> {
  const docResponse = await spApiRequest(
    credentials,
    `/reports/2021-06-30/documents/${reportDocumentId}`
  );

  const downloadUrl = docResponse.url;
  if (!downloadUrl) throw new Error('No download URL in report document response');

  const reportResponse = await fetch(downloadUrl);
  if (!reportResponse.ok) {
    throw new Error(`Failed to download report: ${reportResponse.status}`);
  }

  // Some SP-API reports are returned gzip-compressed (indicated by
  // `compressionAlgorithm: GZIP` in the document response). Customer returns
  // happens to be uncompressed; ledger detail and most others are compressed.
  if (docResponse.compressionAlgorithm === 'GZIP') {
    const buf = Buffer.from(await reportResponse.arrayBuffer());
    const zlib = await import('zlib');
    return zlib.gunzipSync(buf).toString('utf-8');
  }

  return reportResponse.text();
}

/**
 * Sync settlement reports — downloads all available reports and extracts
 * shipping label costs + any other data we're missing from Financial Events.
 */
export async function syncSettlementReports(
  credentials: SPAPICredentials,
  startDate: string
): Promise<{ reportsProcessed: number; shippingCostsUpdated: number; errors: string[] }> {
  const errors: string[] = [];
  let reportsProcessed = 0;
  let shippingCostsUpdated = 0;

  try {
    const reports = await getSettlementReports(credentials, startDate);
    log.info(`Found ${reports.length} settlement reports`);

    for (const report of reports) {
      try {
        if (!report.reportDocumentId) continue;

        const content = await downloadReport(credentials, report.reportDocumentId);
        const updated = parseSettlementReport(content);
        shippingCostsUpdated += updated;
        reportsProcessed++;

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        errors.push(`Report ${report.reportId}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Settlement reports listing: ${err}`);
  }

  return { reportsProcessed, shippingCostsUpdated, errors };
}

/**
 * Parse a settlement report TSV and extract shipping label costs.
 * Settlement reports are tab-separated with headers in the first row.
 */
function parseSettlementReport(content: string): number {
  const db = getDb();
  let updated = 0;

  try {
    const lines = content.split('\n');
    if (lines.length < 2) return 0;

    // Parse header to find column indices
    const headers = lines[0].split('\t').map(h => h.trim().replace(/"/g, ''));
    const colIndex = (name: string) => headers.indexOf(name);

    const orderIdIdx = colIndex('order-id');
    const transactionTypeIdx = colIndex('transaction-type');
    const amountTypeIdx = colIndex('amount-type');
    const amountDescriptionIdx = colIndex('amount-description');
    const amountIdx = colIndex('amount');
    const postedDateColIdx = colIndex('posted-date') >= 0 ? colIndex('posted-date') : colIndex('posted-date-time');

    // Settlement header columns (constant across all rows of a report; the
    // payout total lives only on the summary row, which has a blank order-id).
    const settlementIdIdx = colIndex('settlement-id');
    const startDateIdx = colIndex('settlement-start-date');
    const endDateIdx = colIndex('settlement-end-date');
    const depositDateIdx = colIndex('deposit-date');
    const totalAmountIdx = colIndex('total-amount');
    const currencyIdx = colIndex('currency');

    if (orderIdIdx === -1 || amountIdx === -1) {
      // Try V1 format columns
      const altOrderIdx = colIndex('order id');
      const altAmountIdx = colIndex('total');
      if (altOrderIdx === -1) return 0;
    }

    // ── Capture the settlement header (one disbursement per report) ──
    // settlement-id / start / end / deposit are identical on every row; the
    // total-amount (net payout) appears only on the summary row.
    // Settlement dates come in several shapes: "2026-05-08 20:23:56 UTC",
    // ISO "2026-05-08T20:23:56Z", or monthly "18.03.2026 16:05:21 UTC".
    // Normalize all to a clean YYYY-MM-DD (date-level is enough for window
    // attribution; payout total is exact regardless).
    const normDate = (d: string): string => {
      if (!d) return d;
      d = d.trim();
      const dm = d.match(/^(\d{2})\.(\d{2})\.(\d{4})/); // DD.MM.YYYY[ time]
      if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
      const iso = d.match(/^(\d{4}-\d{2}-\d{2})/); // YYYY-MM-DD[ T/space time]
      if (iso) return iso[1];
      return d;
    };
    if (settlementIdIdx >= 0 && totalAmountIdx >= 0) {
      let sid = '', sStart = '', sEnd = '', sDeposit = '', sCurrency = '';
      let sTotalCents: number | null = null;
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t').map((x) => x.trim().replace(/"/g, ''));
        if (!sid && c[settlementIdIdx]) {
          sid = c[settlementIdIdx];
          sStart = normDate(c[startDateIdx] || '');
          sEnd = normDate(c[endDateIdx] || '');
          sDeposit = normDate(c[depositDateIdx] || '');
          sCurrency = currencyIdx >= 0 ? c[currencyIdx] : 'USD';
        }
        const ta = totalAmountIdx >= 0 ? c[totalAmountIdx] : '';
        if (ta && !isNaN(parseFloat(ta))) sTotalCents = Math.round(parseFloat(ta) * 100);
      }
      if (sid && sTotalCents !== null) {
        db.prepare(`
          INSERT INTO settlements (settlement_id, marketplace, start_date, end_date, deposit_date, total_amount_cents, currency, created_at)
          VALUES (?, 'amazon', ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(settlement_id) DO UPDATE SET
            start_date = excluded.start_date, end_date = excluded.end_date,
            deposit_date = excluded.deposit_date, total_amount_cents = excluded.total_amount_cents,
            currency = excluded.currency
        `).run(sid, sStart, sEnd, sDeposit, sTotalCents, sCurrency || 'USD');
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t').map(c => c.trim().replace(/"/g, ''));
      if (cols.length < Math.max(orderIdIdx, amountIdx) + 1) continue;

      const orderId = cols[orderIdIdx];
      const transactionType = transactionTypeIdx >= 0 ? cols[transactionTypeIdx] : '';
      const amountType = amountTypeIdx >= 0 ? cols[amountTypeIdx] : '';
      const amountDescription = amountDescriptionIdx >= 0 ? cols[amountDescriptionIdx] : '';
      const amount = parseFloat(cols[amountIdx] || '0');

      if (isNaN(amount)) continue;
      // Service fees have no order ID — don't skip them
      if (!orderId && transactionType !== 'other-transaction' && transactionType !== 'Liquidations') continue;

      // Get posted date from settlement report
      const postedDate = postedDateColIdx >= 0 && cols[postedDateColIdx] ? cols[postedDateColIdx] : new Date().toISOString();

      // Shipping label costs — one label = one cost. Apply to a single line
      // item, not every 0-cost item of the order (multi-item orders would
      // multiply the label cost).
      if (transactionType === 'other-transaction' && amountDescription === 'Shipping label purchase' && amount < 0) {
        const costCents = Math.abs(Math.round(amount * 100));
        const result = db.prepare(`
          UPDATE order_items SET shipping_cost = ?
          WHERE id = (SELECT id FROM order_items WHERE order_id = ? AND shipping_cost = 0 ORDER BY id LIMIT 1)
        `).run(costCents, orderId);
        if (result.changes > 0) updated++;
      }

      // Reserve balance — Amazon's Deferred Disbursement +7 hold. Captured
      // separately so we can show "Available vs Held" cash flow on the
      // dashboard. Each settlement report includes a "Current Reserve Amount"
      // (held now) and "Previous Reserve Amount Balance" (was held last cycle).
      if (transactionType === 'other-transaction'
          && (amountDescription === 'Current Reserve Amount' || amountDescription === 'Previous Reserve Amount Balance')) {
        const reserveCents = Math.round(amount * 100);
        let reserveDate = postedDate || new Date().toISOString();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(reserveDate)) {
          const [dd, mm, yyyy] = reserveDate.split('.');
          reserveDate = `${yyyy}-${mm}-${dd}`;
        }
        // Upsert: each settlement should have one Current + one Previous row.
        // Match on (marketplace, posted_date) and update whichever field this row is.
        const existing = db.prepare(`
          SELECT id FROM reserve_balance_history
          WHERE marketplace = 'amazon' AND posted_date = ?
        `).get(reserveDate) as { id?: number } | undefined;

        if (existing?.id) {
          if (amountDescription === 'Current Reserve Amount') {
            db.prepare('UPDATE reserve_balance_history SET current_reserve_cents = ?, raw_data = ? WHERE id = ?').run(reserveCents, JSON.stringify({ amountDescription, amount }), existing.id);
          } else {
            db.prepare('UPDATE reserve_balance_history SET previous_reserve_cents = ?, raw_data = ? WHERE id = ?').run(reserveCents, JSON.stringify({ amountDescription, amount }), existing.id);
          }
        } else {
          db.prepare(`
            INSERT INTO reserve_balance_history (marketplace, posted_date, current_reserve_cents, previous_reserve_cents, raw_data, created_at)
            VALUES ('amazon', ?, ?, ?, ?, datetime('now'))
          `).run(
            reserveDate,
            amountDescription === 'Current Reserve Amount' ? reserveCents : 0,
            amountDescription === 'Previous Reserve Amount Balance' ? reserveCents : 0,
            JSON.stringify({ amountDescription, amount })
          );
        }
        continue;
      }

      // Service fees from settlement (storage, subscriptions, inbound, etc.)
      // These have proper posted dates that match when they were actually charged
      // transaction-type = 'other-transaction', amount-type varies ('other-transaction', 'FBA Inventory Reimbursement', etc.)
      if (transactionType === 'other-transaction' && amount !== 0
          && amountDescription !== 'Shipping label purchase'
          && amountDescription !== 'Payable to Amazon'
          && amountDescription !== 'Successful charge'
          && amountDescription !== 'Current Reserve Amount'
          && amountDescription !== 'Previous Reserve Amount Balance') {
        const feeCents = Math.round(amount * 100);
        const feeType = amountDescription.replace(/\s+/g, '');
        const feeCategory =
          amountDescription.includes('Storage') || amountDescription.includes('storage') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Subscription') || amountDescription.includes('subscription') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Inbound') || amountDescription.includes('inbound') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Removal') || amountDescription.includes('Disposal') ? 'FBA Inventory and Inbound Service Fees' :
          amountDescription.includes('Advertising') || amountDescription.includes('Cost of Advertising') ? 'Advertising' :
          'Other Fees';

        // Use settlement posted date, not API fetch time
        // Handle multiple date formats: YYYY-MM-DD, DD.MM.YYYY, ISO
        let feeDate = postedDate || new Date().toISOString();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(feeDate)) {
          // DD.MM.YYYY → YYYY-MM-DD
          const [dd, mm, yyyy] = feeDate.split('.');
          feeDate = `${yyyy}-${mm}-${dd}`;
        }

        // Reimbursements go to the reimbursements table, not fee_details.
        // That includes NEGATIVE rows: Amazon labels a reimbursement reversal
        // COMPENSATED_CLAWBACK. Those used to fall through to the fee path and
        // were booked as a fee on top of the canonical Reimbursement_Reversal,
        // counting each clawback twice ($87.75 in Jun-Jul 2026, review A5).
        if (amountType === 'FBA Inventory Reimbursement' || amountDescription === 'COMPENSATED_CLAWBACK') {
          // Skip if the canonical FBA Reimbursements Report already has this
          // entry (same date + amount). Settlement rows have no sku/asin so
          // we match on date+amount only — canonical numeric IDs win. A
          // clawback may post a day away from its canonical row, hence ±1 day.
          const dayWindow = feeCents < 0 ? 1 : 0;
          const canonical = db.prepare(`
            SELECT 1 FROM reimbursements
            WHERE marketplace = 'amazon'
              AND reimbursement_id GLOB '[0-9]*'
              AND abs(julianday(date(reimbursement_date)) - julianday(date(?))) <= ?
              AND amount = ?
            LIMIT 1
          `).get(feeDate, dayWindow, feeCents);

          if (!canonical) {
            const reimbId = `SETTLEMENT-${amountDescription.replace(/\s+/g, '-')}-${feeDate}-${feeCents}`;
            const reimbResult = db.prepare(`
              INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
              VALUES (?, ?, NULL, NULL, ?, ?, 1, 'Approved', 'amazon', datetime('now'))
            `).run(reimbId, feeDate, amountDescription, feeCents);
            if (reimbResult.changes > 0) updated++;
          }
          continue;
        }

        // From the cutover on, service fees are booked from the v2024 ledger.
        // Settlement placement lines are per item while v2024 is per shipment,
        // so no amount check can match them; they must not be written at all.
        if (isV2024CoveredServiceFee(amountDescription, feeDate)) continue;

        // Skip if this fee already exists from ANY Amazon source (settlement,
        // transaction report import, or live Financial Events API). Sources use
        // different fee_type names ('SubscriptionFee' vs 'Subscription',
        // 'InboundTransportationFee' vs 'FBAInboundTransportationFee') and post
        // dates that skew by 0-4 days, so match on amount + order-less +
        // amazon-marketplace within a 5-day window. Without this, the settlement
        // re-sync re-inserts every fee the transaction-report import just
        // replaced (July 6-7 2026: $496 of double-counted fees).
        const existing = db.prepare(`
          SELECT 1 FROM fee_details fd
          JOIN financial_events fe ON fd.financial_event_id = fe.id
          WHERE fe.marketplace = 'amazon'
            AND (fd.order_id IS NULL OR fd.order_id = '')
            AND fd.amount = ?
            AND abs(julianday(date(fd.posted_date)) - julianday(date(?))) <= 5
          LIMIT 1
        `).get(feeCents, feeDate);

        if (!existing) {
          // OR IGNORE: a leftover orphan SettlementServiceFee event with the
          // same (type, day, amount) must not abort the whole report.
          const eventResult = db.prepare(`
            INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
            VALUES ('SettlementServiceFee', ?, NULL, NULL, NULL, 'amazon', ?, ?, datetime('now'))
          `).run(feeDate, feeCents, JSON.stringify({ description: amountDescription, settlement: true }));

          if (eventResult.changes > 0) {
            db.prepare(`
              INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
              VALUES (?, NULL, NULL, ?, ?, ?, ?)
            `).run(Number(eventResult.lastInsertRowid), feeType, feeCategory, feeCents, feeDate);
            updated++;
          }
        }
      }

      // Capture fees for orders missing fee_details (Commission, FBA fees, etc.)
      // Settlement fees are REAL data — stored with sentinel -1 (not 0, the
      // estimator's sentinel, which overrideEstimatedFees() deletes the moment
      // any other real fee exists for the order). Only rows from the
      // Financial Events API count as "already have it": a pre-existing
      // ESTIMATE must not block the real settlement value.
      if (transactionType === 'Order' && amountType === 'ItemFees' && amount < 0 && orderId) {
        const existing = db.prepare(
          'SELECT 1 FROM fee_details WHERE order_id = ? AND fee_type = ? AND financial_event_id != 0 LIMIT 1'
        ).get(orderId, amountDescription);
        if (!existing) {
          const feeCents = Math.round(amount * 100);
          const feeCategory = amountDescription === 'Commission' ? 'Selling Fees' :
            amountDescription.includes('FBA') ? 'FBA Transaction Fees' :
            amountDescription.includes('Variable') ? 'Selling Fees' : 'Other Fees';
          // The settlement value replaces any estimator row of the same type.
          db.prepare(
            'DELETE FROM fee_details WHERE order_id = ? AND fee_type = ? AND financial_event_id = 0'
          ).run(orderId, amountDescription);
          let feeDate = postedDate || new Date().toISOString();
          if (/^\d{2}\.\d{2}\.\d{4}/.test(feeDate)) {
            const [dd, mm, yyyy] = feeDate.substring(0, 10).split('.');
            feeDate = `${yyyy}-${mm}-${dd}`;
          }
          db.prepare(`
            INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
            VALUES (-1, ?, NULL, ?, ?, ?, ?)
          `).run(orderId, amountDescription, feeCategory, feeCents, feeDate);
          updated++;
        }
      }
    }
  } finally {
    db.close();
  }

  return updated;
}
