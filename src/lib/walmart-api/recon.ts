/**
 * Walmart Marketplace Reconciliation Report API client.
 * Reports are ZIP files containing CSV with exact fees per order.
 */

import { getAccessToken } from './auth';
import type { WalmartCredentials } from './types';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import { execSync, } from 'child_process';
import fs from 'fs';
import { openDb } from '@/lib/db-conn';
import { createLogger } from '@/lib/log';

const log = createLogger('walmart-api/recon');

const getDb = () => openDb();

function toCents(amount: number | string | undefined): number {
  if (amount === undefined || amount === null || amount === '') return 0;
  return Math.round(Number(amount) * 100);
}

/**
 * Get list of available reconciliation report dates.
 */
export async function getAvailableReconDates(
  credentials: WalmartCredentials,
): Promise<string[]> {
  const token = await getAccessToken(credentials);
  const response = await fetch(
    'https://marketplace.walmartapis.com/v3/report/reconreport/availableReconFiles',
    {
      headers: {
        'WM_SEC.ACCESS_TOKEN': token,
        'WM_SVC.NAME': 'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': uuidv4(),
        'Accept': 'application/json',
      },
    },
  );
  if (!response.ok) return [];
  const data = await response.json();
  return data?.availableApReportDates || [];
}

/**
 * Download and parse a reconciliation report for a specific date.
 * The API returns a ZIP file containing a CSV.
 */
export async function syncReconReport(
  credentials: WalmartCredentials,
  reportDate: string,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const db = getDb();
  const errors: string[] = [];
  let recordsFetched = 0;

  try {
    const token = await getAccessToken(credentials);

    // Download ZIP
    const response = await fetch(
      `https://marketplace.walmartapis.com/v3/report/reconreport/reconFile?reportDate=${reportDate}&reportVersion=v1`,
      {
        headers: {
          'WM_SEC.ACCESS_TOKEN': token,
          'WM_SVC.NAME': 'Walmart Marketplace',
          'WM_QOS.CORRELATION_ID': uuidv4(),
          'Accept': 'application/octet-stream',
        },
      },
    );

    if (!response.ok) {
      errors.push(`Recon report ${reportDate}: HTTP ${response.status}`);
      return { recordsFetched, errors };
    }

    // Save ZIP and extract
    const buffer = Buffer.from(await response.arrayBuffer());
    const tmpZip = `/tmp/walmart_recon_${reportDate}.zip`;
    const tmpDir = `/tmp/walmart_recon_${reportDate}`;
    fs.writeFileSync(tmpZip, buffer);
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`cd ${tmpDir} && unzip -o ${tmpZip}`, { stdio: 'pipe' });

    // Find the CSV
    const csvFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.csv'));
    if (csvFiles.length === 0) {
      errors.push(`Recon report ${reportDate}: No CSV in ZIP`);
      return { recordsFetched, errors };
    }

    const csvContent = fs.readFileSync(path.join(tmpDir, csvFiles[0]), 'utf-8');
    const lines = csvContent.split('\n').filter(l => l.trim());
    if (lines.length < 3) return { recordsFetched, errors };

    // Parse CSV: row 0 = headers, row 1 = "Number of Lines...", row 2+ = data or PaymentSummary
    const headers = lines[0].split(',').map(h => h.trim());
    const now = new Date().toISOString();
    const wfsServiceRows: WfsServiceRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length < headers.length) continue;

      const entry: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        entry[headers[j]] = (values[j] || '').trim();
      }

      // WFS service-fee / inventory-adjustment roll-ups have NO Purchase Order #
      // and would be dropped by the guard below. Collect them for a scoped,
      // replace-in-place apply after the loop (see applyWfsServiceRows).
      const wfsDesc = reconCell(entry['Transaction Description']);
      if (WFS_SERVICE_FEE_MAP[wfsDesc] || WFS_REIMB_MAP[wfsDesc]) {
        const cents = toCents(reconCell(entry['Amount']));
        if (cents !== 0) {
          wfsServiceRows.push({
            description: wfsDesc,
            isoDate: reconIsoDate(entry['Transaction Posted Timestamp'], now),
            cents,
            raw: entry,
          });
        }
        continue;
      }

      // Skip metadata rows
      if (!entry['Purchase Order #'] || !entry['Amount Type']) continue;
      if (entry['Transaction Type'] === 'PaymentSummary') continue;

      try {
        processReconEntry(db, entry, now);
        recordsFetched++;
      } catch (err: any) {
        errors.push(`Recon entry: ${err.message}`);
      }
    }

    // Apply WFS service-fee roll-ups (scoped replace — see applyWfsServiceRows)
    const wfsApplied = applyWfsServiceRows(db, reportDate, wfsServiceRows, now);
    recordsFetched += wfsServiceRows.length;
    if (wfsServiceRows.length) {
      log.info(`${reportDate}: ${wfsServiceRows.length} WFS service row(s) -> ${wfsApplied.fees} fee, ${wfsApplied.reimbursements} reimb`);
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(tmpZip);

  } catch (err: any) {
    errors.push(`Recon report ${reportDate}: ${err.message}`);
  } finally {
    db.close();
  }

  return { recordsFetched, errors };
}

/**
 * Sync all available recon reports from the last N days.
 */
export async function syncAllReconReports(
  credentials: WalmartCredentials,
  sinceDays: number = 90,
): Promise<{ recordsFetched: number; errors: string[] }> {
  const dates = await getAvailableReconDates(credentials);
  // Dates are in MMDDYYYY format
  const cutoff = new Date(Date.now() - sinceDays * 86400000);

  let totalFetched = 0;
  const allErrors: string[] = [];

  for (const dateStr of dates) {
    // Parse MMDDYYYY
    const month = parseInt(dateStr.substring(0, 2));
    const day = parseInt(dateStr.substring(2, 4));
    const year = parseInt(dateStr.substring(4, 8));
    const reportDate = new Date(year, month - 1, day);

    if (reportDate < cutoff) continue;

    log.info(`Processing report ${dateStr}...`);
    const result = await syncReconReport(credentials, dateStr);
    totalFetched += result.recordsFetched;
    allErrors.push(...result.errors);
  }

  return { recordsFetched: totalFetched, errors: allErrors };
}

/**
 * WFS service-fee / inventory-adjustment lines carried by the recon report.
 *
 * These are PERIOD-LEVEL ROLL-UPS: no Purchase Order #, no Transaction Key, no
 * GTIN, no quantity — just description + posted timestamp + amount. They were
 * silently discarded for the life of this integration because the main parse
 * loop skips any row without a Purchase Order # (they have none), which is why
 * a May 2026 audit wrongly concluded "recon has zero storage/inbound/RTV".
 * Verified present in every recon report back to Nov 2024.
 *
 * fee_type / fee_category deliberately MATCH the retired Seller-Center CSV
 * importer so the P&L presentation is unchanged by the source switch.
 */
const WFS_SERVICE_FEE_MAP: Record<string, { feeType: string; feeCategory: string }> = {
  'WFS StorageFee': { feeType: 'WFSStorageFee', feeCategory: 'WFS Storage & Inventory Fees' },
  'WFS InboundTransportationFee': { feeType: 'WFSInboundTransportationFee', feeCategory: 'WFS Inbound Fees' },
  'WFS RC_InventoryRTVFee': { feeType: 'WFSInventoryRTVFee', feeCategory: 'WFS Storage & Inventory Fees' },
  'WFS InventoryRemovalOrder': { feeType: 'WFSRemovalFee', feeCategory: 'WFS Storage & Inventory Fees' },
};
/** Positive-amount WFS inventory adjustments = money back to the seller. */
const WFS_REIMB_MAP: Record<string, string> = {
  'WFS Refund': 'WFS Refund',
  'WFS LostInventory': 'WFS Lost Inventory',
};

export const WFS_SERVICE_EVENT_TYPE = 'WalmartReconServiceFee';
export const WFS_SERVICE_REIMB_PREFIX = 'WMT-WFSSVC-';

/** Recon rows are plain CSV but tolerate Excel ="..." wrappers defensively. */
function reconCell(v: string | undefined): string {
  let x = (v || '').trim();
  const m = x.match(/^="?(.*?)"?$/);
  if (m) x = m[1];
  return x.replace(/^"|"$/g, '').trim();
}

/** MM/DD/YYYY -> ISO date-at-midnight. Falls back to `fallback`. */
function reconIsoDate(posted: string, fallback: string): string {
  const p = reconCell(posted);
  if (p.includes('/')) {
    const parts = p.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T00:00:00Z`;
    }
  }
  return fallback;
}

export interface WfsServiceRow {
  description: string;
  isoDate: string;
  cents: number;
  raw: Record<string, string>;
}

/**
 * Replace this report's WFS service-fee contribution, atomically.
 *
 * IDEMPOTENCY: these rows carry no stable per-transaction id, so identity-based
 * dedup is impossible. Instead every row is tagged with its source reportDate
 * and a re-sync DELETEs that report's prior rows before inserting — the report
 * is the unit of replacement. Re-syncing the same report any number of times
 * converges on the same totals; overlapping reports cannot double-count because
 * each owns only its own tagged rows.
 *
 * Amounts are aggregated per (feeType, posted day) because idx_fee_details_unique
 * is day-level and would otherwise silently collapse distinct same-day rows.
 */
export function applyWfsServiceRows(
  db: Database.Database,
  reportDate: string,
  rows: WfsServiceRow[],
  now: string,
): { fees: number; reimbursements: number } {
  const run = db.transaction(() => {
    // --- wipe this report's prior contribution (children first) ---
    db.prepare(`
      DELETE FROM fee_details WHERE financial_event_id IN (
        SELECT id FROM financial_events
        WHERE event_type = ? AND json_extract(raw_data, '$.reportDate') = ?
      )
    `).run(WFS_SERVICE_EVENT_TYPE, reportDate);
    db.prepare(`
      DELETE FROM financial_events
      WHERE event_type = ? AND json_extract(raw_data, '$.reportDate') = ?
    `).run(WFS_SERVICE_EVENT_TYPE, reportDate);
    db.prepare(`DELETE FROM reimbursements WHERE reimbursement_id LIKE ?`)
      .run(`${WFS_SERVICE_REIMB_PREFIX}${reportDate}-%`);

    // --- aggregate then insert ---
    const feeAgg = new Map<string, { feeType: string; feeCategory: string; isoDate: string; cents: number; n: number }>();
    const reimbAgg = new Map<string, { reason: string; isoDate: string; cents: number; n: number }>();

    for (const r of rows) {
      const feeMap = WFS_SERVICE_FEE_MAP[r.description];
      if (feeMap && r.cents < 0) {
        const k = `${feeMap.feeType}|${r.isoDate}`;
        const ex = feeAgg.get(k);
        if (ex) { ex.cents += r.cents; ex.n++; }
        else feeAgg.set(k, { ...feeMap, isoDate: r.isoDate, cents: r.cents, n: 1 });
        continue;
      }
      const reason = WFS_REIMB_MAP[r.description];
      if (reason && r.cents > 0) {
        const k = `${reason}|${r.isoDate}`;
        const ex = reimbAgg.get(k);
        if (ex) { ex.cents += r.cents; ex.n++; }
        else reimbAgg.set(k, { reason, isoDate: r.isoDate, cents: r.cents, n: 1 });
        continue;
      }
      // A positive fee row (credit) or negative reimbursement (clawback) is
      // rare but real; route on sign so it still lands somewhere correct.
      if (feeMap) {
        const k = `${feeMap.feeType}|${r.isoDate}`;
        const ex = feeAgg.get(k);
        if (ex) { ex.cents += r.cents; ex.n++; }
        else feeAgg.set(k, { ...feeMap, isoDate: r.isoDate, cents: r.cents, n: 1 });
      }
    }

    let fees = 0, reimbursements = 0;
    for (const [, f] of feeAgg) {
      if (f.cents === 0) continue;
      const raw = JSON.stringify({ reportDate, feeType: f.feeType, lines: f.n, source: 'recon-wfs-service' });
      const res = db.prepare(`
        INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES (?, ?, NULL, NULL, NULL, 'walmart', ?, ?, ?)
      `).run(WFS_SERVICE_EVENT_TYPE, f.isoDate, f.cents, raw, now);
      db.prepare(`
        INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, NULL, NULL, ?, ?, ?, ?)
      `).run(Number(res.lastInsertRowid), f.feeType, f.feeCategory, f.cents, f.isoDate);
      fees++;
    }
    for (const [, r] of reimbAgg) {
      if (r.cents === 0) continue;
      db.prepare(`
        INSERT INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
        VALUES (?, ?, NULL, NULL, ?, ?, 1, 'Approved', 'walmart', ?)
      `).run(`${WFS_SERVICE_REIMB_PREFIX}${reportDate}-${r.reason.replace(/\s+/g, '')}-${r.isoDate.slice(0, 10)}`,
        r.isoDate, r.reason, r.cents, now);
      reimbursements++;
    }
    return { fees, reimbursements };
  });
  return run();
}

// Books the refund-side reversal of a Walmart-funded incentive as a negative
// reimbursement (income reversal). Idempotent via the Transaction Key.
// No financial_events row is written: the Refund branch already stored this
// line as a WalmartRefundEvent, and a second (WalmartIncentive) copy made the
// per-order Net on /lookup subtract the reversal twice (review A12).
export function applyFundedIncentiveReversal(
  db: Database.Database,
  entry: Record<string, string>,
  orderId: string,
  sku: string,
  amount: number,
  isoDate: string,
  now: string,
) {
  const txKey = entry['Transaction Key'] || `${orderId}-${sku}-${isoDate.substring(0, 10)}`;

  db.prepare(`
    INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
    VALUES (?, ?, ?, ?, 'Walmart Funded Incentive Reversal', ?, 1, 'Approved', 'walmart', ?)
  `).run(`WMT-FUNDED-REV-${txKey}`, isoDate, sku, sku, amount, now);
}

function processReconEntry(db: Database.Database, entry: Record<string, string>, now: string) {
  const orderId = entry['Purchase Order #'];
  const sku = entry['Partner Item Id'] || '';
  const amountType = entry['Amount Type'] || '';
  const amount = toCents(entry['Amount']);
  const postedDate = entry['Transaction Posted Timestamp'] || now;
  const commissionRate = entry['Commission Rate'] || '';
  const category = entry['Contract Category'] || '';

  if (!orderId || amount === 0) return;

  const transactionType = entry['Transaction Type'] || '';

  // Convert posted date once for refund-event handling below
  let refundIsoDate = now;
  if (postedDate.includes('/')) {
    const parts = postedDate.split('/');
    if (parts.length === 3) {
      refundIsoDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T00:00:00Z`;
    }
  }

  // ----- Dispute Settlement: customer return reversed, Walmart credited us back -----
  // Structurally a reimbursement (income), not a fee. Amount is positive in the
  // raw recon data and must STAY positive. Goes to the reimbursements table,
  // mirroring Amazon's FBA reimbursements.
  if (transactionType === 'Dispute Settlement') {
    const txKey = entry['Transaction Key'] || `${orderId}-${refundIsoDate}-${amount}`;
    const reason = entry['Transaction Description'] || 'Dispute Settlement';

    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartDisputeSettlement', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(refundIsoDate, orderId, sku, sku, amount, JSON.stringify(entry), now);

    if (amount > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', 'walmart', ?)
      `).run(`WMT-DISPUTE-${txKey}`, refundIsoDate, sku, sku, `Dispute: ${reason}`, amount, now);
    }
    return;
  }

  // Handle Refund-type rows. Walmart sends one Refund row per amountType
  // (Product Price, Commission on Product, WFS Inventory Fee/Reimbursement,
  // etc.) for the same return. We:
  //   1. Update the refund_amount on the refunds row (Product Price only —
  //      that's the customer-facing dollar value)
  //   2. ALWAYS create a WalmartRefundEvent financial_event so we have an
  //      audit trail of every refund-related debit/credit. This is what
  //      dispute candidates use to verify a refund actually settled.
  //   3. For Commission on Product credits (positive amount = clawback returning
  //      the original referral fee to seller), mirror to fee_details so the
  //      original fee charge is offset in P&L.
  if (transactionType === 'Refund') {
    if (amountType === 'Product Price' && amount < 0) {
      db.prepare(`
        UPDATE refunds SET refund_amount = ? WHERE order_id = ? AND marketplace = 'walmart' AND refund_amount = 0
      `).run(Math.abs(amount), orderId);
    }

    // Audit trail row — preserves raw sign (negative = customer refund debit,
    // positive = clawback credit returning to seller).
    const refundFeResult = db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartRefundEvent', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(refundIsoDate, orderId, sku, sku, amount, JSON.stringify(entry), now);

    // For commission clawbacks (positive amount on a Refund/Commission row),
    // mirror to fee_details so the original fee is offset in P&L.
    const refundEventId = refundFeResult.changes > 0 ? Number(refundFeResult.lastInsertRowid) : null;
    if (refundEventId && amount > 0 && amountType === 'Commission on Product') {
      db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, ?, ?, 'WalmartReferralFeeClawback', 'Walmart Referral Fee', ?, ?)
      `).run(refundEventId, orderId, sku, amount, refundIsoDate);
    }

    // A return also reverses the Walmart-funded incentive booked on the sale
    // (negative "Total Walmart Funded Savings"). The sale side is income in
    // reimbursements, so the reversal must land there too or the incentive
    // stays on the books for a unit the customer sent back.
    if (amount < 0 && amountType === 'Total Walmart Funded Savings') {
      applyFundedIncentiveReversal(db, entry, orderId, sku, amount, refundIsoDate, now);
    }
    return;
  }

  // ----- Walmart-funded price incentive (e.g. item $140 → customer $123,
  // "Walmart funded -$17") -----
  // Walmart settles the seller against the FULL pre-incentive item price and
  // funds the discount itself — the recon "Commission on Product" row confirms
  // this (commission is charged on the full price, not the discounted one).
  // The Orders API only hands us the post-incentive CUSTOMER price as revenue,
  // so this funded amount is real seller income we'd otherwise drop entirely.
  // Capture it as a reimbursement (income), mirroring the commission-incentive
  // handling below. Idempotent via the synthetic reimbursement_id.
  if (amountType === 'Total Walmart Funded Savings') {
    const savings = Math.abs(amount);
    if (savings > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES ('WalmartIncentive', ?, ?, ?, ?, 'walmart', ?, ?, ?)
      `).run(refundIsoDate, orderId, sku, sku, savings, JSON.stringify(entry), now);

      db.prepare(`
        INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
        VALUES (?, ?, ?, ?, 'Walmart Funded Incentive', ?, 1, 'Approved', 'walmart', ?)
      `).run(`WMT-FUNDED-${orderId}-${sku}`, refundIsoDate, sku, sku, savings, now);
    }
    return;
  }

  // ----- Walmart shipping claim payouts (lost/damaged shipment reimbursements) -----
  // These arrive as a POSITIVE "Fee/Reimbursement" adjustment with a description
  // like "Shipping Protection Claim Payout" / "Shipping Insurance claim payout".
  // They're income (Walmart paying out a claim for a lost/damaged shipment), NOT
  // a fee credit — route to the reimbursements table so they're visible as
  // reimbursements instead of buried in "Walmart Fees". The matching
  // WalmartIncentive financial_event keeps per-order WFS Sales profit consistent
  // (and prevents a double-count: this replaces the fee-credit, doesn't add to it).
  // NOTE: the descriptive text for these lives in "Transaction Description"
  // ("Shipping Protection Claim Payout" / "Shipping Insurance claim payout"),
  // NOT "Amount Description" (which is empty on these rows).
  const txnDescription = (entry['Transaction Description'] || '').toString();
  if (amountType === 'Fee/Reimbursement' && amount > 0 && /claim payout/i.test(txnDescription)) {
    db.prepare(`
      INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartIncentive', ?, ?, ?, ?, 'walmart', ?, ?, ?)
    `).run(refundIsoDate, orderId, sku, sku, amount, JSON.stringify(entry), now);

    db.prepare(`
      INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', 'walmart', ?)
    `).run(`WMT-SHIPCLAIM-${orderId}-${refundIsoDate.substring(0,10)}`, refundIsoDate, sku, sku, txnDescription || 'Walmart Shipping Claim Payout', amount, now);
    return;
  }

  // Map Walmart amount types to our fee categories
  let feeType: string;
  let feeCategory: string;

  switch (amountType) {
    case 'Commission on Product':
      feeType = 'WalmartReferralFee';
      feeCategory = 'Walmart Referral Fee';
      break;
    case 'Fee/Reimbursement':
      feeType = 'WalmartFee';
      feeCategory = 'Walmart Fees';
      break;
    case 'WFS Inventory Fee/Reimbursement':
      feeType = 'WFSFee';
      feeCategory = 'WFS Fees';
      break;
    case 'Product Price':
    case 'Product tax':
    case 'Product tax withheld':
    case 'Net Payable':
      // Not fees — skip these. ('Total Walmart Funded Savings' is handled
      // above as income, not skipped.)
      return;
    default:
      feeType = amountType.replace(/[^a-zA-Z0-9]/g, '');
      feeCategory = 'Walmart Other';
  }

  // Convert posted date from MM/DD/YYYY to ISO
  let isoDate = now;
  if (postedDate.includes('/')) {
    const parts = postedDate.split('/');
    if (parts.length === 3) {
      isoDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T00:00:00Z`;
    }
  }

  // Preserve sign: Walmart sends negative for charges to seller, positive for
  // credits/reimbursements. Don't force-negate — credit rows must stay positive
  // (e.g. Adjustment / Fee/Reimbursement with positive amount = a credit).
  const feeAmount = amount;

  // Create financial event
  const feResult = db.prepare(`
    INSERT OR IGNORE INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
    VALUES ('WalmartReconEvent', ?, ?, ?, ?, 'walmart', ?, ?, ?)
  `).run(isoDate, orderId, sku, sku, feeAmount, JSON.stringify(entry), now);

  const eventId = feResult.changes > 0 ? Number(feResult.lastInsertRowid) : null;
  if (eventId) {
    db.prepare(`
      INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, orderId, sku, feeType, feeCategory, feeAmount, isoDate);
  }

  // "Commission Saving" is NOT booked. It is a descriptive column on the
  // commission row, not cash: the Amount above is already charged at the
  // reduced rate (amount == Commission Rate x price), and every recon deposit
  // equals the sum of the Amount column exactly. Booking the saving as income
  // counted the same money twice (Sept 21 2026: $912.75 removed).

  // Mark order as reconciled
  db.prepare("UPDATE orders SET is_estimated = 0 WHERE order_id = ? AND marketplace = 'walmart'").run(orderId);
}

/** Parse a CSV line handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
