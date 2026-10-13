/**
 * Import eBay "Transaction report" CSV exports
 * (Seller Hub → Payments → Reports → Transaction report).
 *
 * MANUAL FALLBACK ONLY since Sept 23 2026. The same costs now sync daily from
 * the eBay Finances API (src/lib/ebay-api/payoutCosts.ts). That API had
 * "404'd" since April 2025 only because it was called on api.ebay.com; it is
 * served from apiz.ebay.com. Both paths write through applyEbayPayoutCosts, so
 * running this importer over the API's window is harmless (each replaces the
 * window it covers). The regular eBay sync reads the Fulfillment API, which
 * carries item revenue, buyer-paid shipping, and `totalMarketplaceFee` (Final
 * Value + international fees ONLY).
 *
 * Three real costs live exclusively on eBay's payout side and were missing from
 * the books entirely:
 *   - Shipping labels        → order_items.shipping_cost  (matched by order number)
 *   - Promoted Listings fees → fee_details, order-less, marketplace=ebay
 *   - Insertion fees         → fee_details, order-less, marketplace=ebay
 *
 * DELIBERATELY NOT IMPORTED (each would double-count):
 *   Order    — already synced from the Fulfillment API
 *   Refund   — already synced from paymentSummary.refunds[]
 *   Payout   — bank transfer, not a P&L event
 *   Charge   — eBay debiting the funding source to cover a negative balance;
 *              settlement mechanics, the underlying cost is already its own row
 *   Hold / Transfer — cash-timing only
 *
 * Fees are aggregated per (feeType, posted day) because `idx_fee_details_unique`
 * is day-level — 228 insertion fees at the same price on the same day would
 * otherwise silently collapse to one. Same reasoning as the WFS recon importer.
 *
 * Idempotent: deletions are BOUNDED to the date window actually covered by the
 * CSVs (never unbounded — see the import-transactions staleness bug of July 6,
 * 2026, where an unbounded delete wiped months of real fees a stale CSV did not
 * re-supply). Re-running with the same file converges; re-running with a
 * shorter file only rewrites that shorter window.
 */
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { openDb } from '@/lib/db-conn';
import { applyEbayPayoutCosts, addPayoutFee, addPayoutLabel, PAYOUT_FEE_EVENT, type PayoutCosts } from '@/lib/ebay-api/payoutCosts';

const DIR = path.join(process.cwd(), 'data', 'ebay-transactions');
const EVENT_TYPE = PAYOUT_FEE_EVENT;

/** eBay's free-text Description → our fee_type / fee_category. Prefix-matched. */
const FEE_MAP: { match: RegExp; feeType: string; feeCategory: string }[] = [
  { match: /^Promoted Listings/i, feeType: 'EbayPromotedListing', feeCategory: 'eBay Advertising Fees' },
  { match: /^Insertion Fee/i,     feeType: 'EbayInsertionFee',    feeCategory: 'eBay Listing Fees' },
  { match: /^Subscription/i,      feeType: 'EbaySubscriptionFee', feeCategory: 'eBay Service Fees' },
  { match: /^Store/i,             feeType: 'EbayStoreFee',        feeCategory: 'eBay Service Fees' },
];
function classifyFee(desc: string) {
  for (const m of FEE_MAP) if (m.match.test(desc)) return { feeType: m.feeType, feeCategory: m.feeCategory };
  return { feeType: 'EbayOtherFee', feeCategory: 'eBay Service Fees' };
}

/** Minimal RFC-4180 parser. Returns raw rows; the header is located separately
 *  because eBay prefixes the file with ~12 lines of notes and metadata. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Locate the real header row and return dict-rows below it. */
function toRecords(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const hi = rows.findIndex((r) => r[0]?.trim() === 'Transaction creation date');
  if (hi < 0) return [];
  const headers = rows[hi].map((h) => h.trim());
  return rows.slice(hi + 1)
    .filter((r) => r.length === headers.length)
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      return o;
    });
}

/** "1,234.56" | "--" | "" → cents. eBay writes "--" for every empty cell. */
function toCents(v: string | undefined): number {
  const s = (v ?? '').trim().replace(/,/g, '');
  if (!s || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
/** "Aug 25, 2026" → "2026-08-25". Returns '' if unparseable. */
function toIsoDate(v: string | undefined): string {
  const m = (v ?? '').trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return '';
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return '';
  return `${m[3]}-${mo}-${m[2].padStart(2, '0')}`;
}

export async function POST() {
  if (!fs.existsSync(DIR)) {
    return NextResponse.json(
      { error: `Directory not found: data/ebay-transactions/. Create it and drop the eBay Transaction report CSV(s) in.` },
      { status: 400 },
    );
  }
  const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'No CSVs in data/ebay-transactions/. Export from Seller Hub → Payments → Reports → Transaction report.' },
      { status: 400 },
    );
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  const rows: { date: string; kind: 'label' | 'fee'; order?: string; cents: number; fee?: { feeType: string; feeCategory: string } }[] = [];
  const skipped: Record<string, number> = {};
  const parsedFiles: { file: string; rows: number }[] = [];
  let minDate = '', maxDate = '', badDates = 0;

  for (const file of files) {
    const recs = toRecords(fs.readFileSync(path.join(DIR, file), 'utf-8'));
    parsedFiles.push({ file, rows: recs.length });

    for (const r of recs) {
      const type = (r['Type'] ?? '').trim();
      const date = toIsoDate(r['Transaction creation date']);
      if (!date) { badDates++; continue; }
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      if (type === 'Shipping label') {
        const order = (r['Order number'] ?? '').trim();
        // Net amount is signed: negative = label purchased, POSITIVE = label voided.
        // Negate so a purchase is a positive cost and a void nets back out of the
        // same order. Do NOT use Math.abs(): it books voided labels as extra cost.
        const cents = -toCents(r['Net amount']);
        if (!order || order === '--' || cents === 0) { skipped['Shipping label (no order/zero)'] = (skipped['Shipping label (no order/zero)'] ?? 0) + 1; continue; }
        rows.push({ date, kind: 'label', order, cents });
      } else if (type === 'Other fee') {
        const cents = toCents(r['Net amount']); // already signed: negative = charge
        if (cents === 0) { skipped['Other fee (zero)'] = (skipped['Other fee (zero)'] ?? 0) + 1; continue; }
        rows.push({ date, kind: 'fee', cents, fee: classifyFee((r['Description'] ?? '').trim()) });
      } else {
        skipped[type || '(blank)'] = (skipped[type || '(blank)'] ?? 0) + 1;
      }
    }
  }

  if (!minDate) {
    return NextResponse.json({ error: 'No dated rows parsed — is this an eBay Transaction report?' }, { status: 400 });
  }
  const maxDateNext = new Date(new Date(maxDate + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const pc: PayoutCosts = { source: 'ebay-transaction-report', fromDate: minDate, throughDate: maxDate, labelByOrder: new Map(), fees: new Map() };
  for (const row of rows) {
    if (row.kind === 'label') addPayoutLabel(pc, row.order!, row.cents);
    else addPayoutFee(pc, row.date, row.fee!, row.cents);
  }

  // ── Write ────────────────────────────────────────────────────────────────
  const db = openDb();
  const now = new Date().toISOString();
  let applied;
  try {
    applied = applyEbayPayoutCosts(db, pc, now);
    db.prepare(`
      INSERT INTO sync_log (sync_type, started_at, completed_at, records_fetched, status)
      VALUES ('ebay-transaction-report', ?, ?, ?, 'success')
    `).run(now, new Date().toISOString(), applied.labelsApplied + applied.feeRows);
  } catch (err: any) {
    db.close();
    return NextResponse.json({ error: `Import failed: ${err.message}` }, { status: 500 });
  }
  const { labelsApplied, labelCents, ordersNotFound, feeRows, feeCents, priorEventsRemoved, priorFeesRemoved } = applied;

  // ── Report ───────────────────────────────────────────────────────────────
  const byType = db.prepare(`
    SELECT fd.fee_type, COUNT(*) AS rows, ROUND(SUM(-fd.amount) / 100.0, 2) AS dollars
    FROM fee_details fd JOIN financial_events fe ON fe.id = fd.financial_event_id
    WHERE fe.event_type = ? AND date(fd.posted_date) >= ? AND date(fd.posted_date) < ?
    GROUP BY fd.fee_type ORDER BY dollars DESC
  `).all(EVENT_TYPE, minDate, maxDateNext);
  db.close();

  return NextResponse.json({
    success: true,
    coverage: { from: minDate, through: maxDate },
    files: parsedFiles,
    shippingLabels: {
      ordersUpdated: labelsApplied,
      totalCost: +(labelCents / 100).toFixed(2),
      ordersNotInFlipLedger: ordersNotFound.length,
      unmatchedSample: ordersNotFound.slice(0, 10),
    },
    fees: { rowsWritten: feeRows, totalCost: +(-feeCents / 100).toFixed(2), byType },
    replacedPriorImport: { events: priorEventsRemoved, feeDetails: priorFeesRemoved },
    skippedByType: skipped,
    unparseableDates: badDates,
  });
}

export async function GET() {
  const exists = fs.existsSync(DIR);
  const files = exists ? fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv')) : [];
  const db = openDb({ readonly: true });
  const imported = db.prepare(`
    SELECT COUNT(*) AS events, MIN(date(posted_date)) AS from_date, MAX(date(posted_date)) AS through_date
    FROM financial_events WHERE event_type = ?
  `).get(EVENT_TYPE);
  const labels = db.prepare(`
    SELECT COUNT(*) AS orders, ROUND(SUM(oi.shipping_cost) / 100.0, 2) AS dollars
    FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
    WHERE o.marketplace = 'ebay' AND oi.shipping_cost > 0
  `).get();
  db.close();
  return NextResponse.json({ directory: 'data/ebay-transactions', exists, files, imported, shippingLabels: labels });
}
