/**
 * Import eBay "Transaction report" CSV exports
 * (Seller Hub → Payments → Reports → Transaction report).
 *
 * WHY THIS EXISTS: eBay's Finances API (sell/finances/v1/*) returns 404 for this
 * account — the Application Growth Check has never been approved (re-verified
 * live Aug 25, 2026: the Fulfillment API returns 200 with the same token while
 * every Finances endpoint 404s). The regular eBay sync therefore only captures
 * what the Fulfillment API exposes: item revenue, buyer-paid shipping, and
 * `totalMarketplaceFee` (which is Final Value + international fees ONLY).
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

const DIR = path.join(process.cwd(), 'data', 'ebay-transactions');
const EVENT_TYPE = 'EbayTransactionReportFee';

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
  const labelByOrder = new Map<string, { cents: number; count: number; date: string }>();
  const feeAgg = new Map<string, { date: string; feeType: string; feeCategory: string; cents: number; count: number }>();
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
        // Net amount is signed: negative = label purchased, POSITIVE = label voided
        // (a refund of a label you bought and cancelled). Negate so a purchase
        // becomes a positive cost and a void nets back out of the same order.
        // Do NOT use Math.abs() here — it books voided labels as extra cost.
        const cents = -toCents(r['Net amount']);
        if (!order || order === '--' || cents === 0) { skipped['Shipping label (no order/zero)'] = (skipped['Shipping label (no order/zero)'] ?? 0) + 1; continue; }
        const cur = labelByOrder.get(order);
        // An order can legitimately have >1 label (reship, multi-package) — sum them.
        if (cur) { cur.cents += cents; cur.count += 1; }
        else labelByOrder.set(order, { cents, count: 1, date });
      } else if (type === 'Other fee') {
        const cents = toCents(r['Net amount']); // already signed: negative = charge
        if (cents === 0) { skipped['Other fee (zero)'] = (skipped['Other fee (zero)'] ?? 0) + 1; continue; }
        const { feeType, feeCategory } = classifyFee((r['Description'] ?? '').trim());
        const key = `${feeType}|${date}`;
        const cur = feeAgg.get(key);
        if (cur) { cur.cents += cents; cur.count += 1; }
        else feeAgg.set(key, { date, feeType, feeCategory, cents, count: 1 });
      } else {
        skipped[type || '(blank)'] = (skipped[type || '(blank)'] ?? 0) + 1;
      }
    }
  }

  if (!minDate) {
    return NextResponse.json({ error: 'No dated rows parsed — is this an eBay Transaction report?' }, { status: 400 });
  }
  // Exclusive upper bound for date() comparisons.
  const maxDateNext = new Date(new Date(maxDate + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);

  // ── Write ────────────────────────────────────────────────────────────────
  const db = openDb();
  db.pragma('journal_mode = WAL');
  const now = new Date().toISOString();

  let labelsApplied = 0, labelCents = 0;
  const ordersNotFound: string[] = [];
  let feeRows = 0, feeCents = 0, priorFeesRemoved = 0, priorEventsRemoved = 0;

  try {
    const apply = db.transaction(() => {
      // 1. Clear this window's prior import (children first), bounded to [minDate, maxDate].
      const priorEvents = db.prepare(`
        SELECT id FROM financial_events
        WHERE event_type = ? AND date(posted_date) >= ? AND date(posted_date) < ?
      `).all(EVENT_TYPE, minDate, maxDateNext) as { id: number }[];
      if (priorEvents.length) {
        const ids = priorEvents.map((e) => e.id);
        const ph = ids.map(() => '?').join(',');
        priorFeesRemoved = db.prepare(`DELETE FROM fee_details WHERE financial_event_id IN (${ph})`).run(...ids).changes;
        priorEventsRemoved = db.prepare(`DELETE FROM financial_events WHERE id IN (${ph})`).run(...ids).changes;
      }

      // 2. Shipping labels → order_items.shipping_cost.
      //    Reset ONLY the orders this file covers, so a re-run converges and we
      //    can never zero out an order the CSV says nothing about.
      const findItem = db.prepare(`
        SELECT MIN(oi.id) AS id FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id
        WHERE oi.order_id = ? AND o.marketplace = 'ebay'
      `);
      const zeroOrder = db.prepare(`UPDATE order_items SET shipping_cost = 0 WHERE order_id = ?`);
      const setCost = db.prepare(`UPDATE order_items SET shipping_cost = ? WHERE id = ?`);

      for (const [order, info] of labelByOrder) {
        const row = findItem.get(order) as { id: number | null } | undefined;
        if (!row?.id) { ordersNotFound.push(order); continue; }
        // Multi-item orders: put the whole label cost on the lowest-id line only.
        // Spreading it across every line multiplies it in every SUM (the June 9,
        // 2026 audit found exactly this bug on the Amazon side).
        // Voids can in principle exceed purchases for an order; never store a
        // negative shipping cost (it would read as income in every SUM).
        const cost = Math.max(0, info.cents);
        zeroOrder.run(order);
        setCost.run(cost, row.id);
        labelsApplied++; labelCents += cost;
      }

      // 3. Promoted-listing / insertion / other fees → order-less service fees.
      //    order_id NULL so the P&L picks them up via its serviceFees query,
      //    which scopes by financial_events.marketplace.
      const insEvent = db.prepare(`
        INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
        VALUES (?, ?, NULL, NULL, NULL, 'ebay', ?, ?, ?)
      `);
      const insFee = db.prepare(`
        INSERT OR IGNORE INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
        VALUES (?, NULL, NULL, ?, ?, ?, ?)
      `);
      for (const f of feeAgg.values()) {
        const res = insEvent.run(EVENT_TYPE, f.date, f.cents, JSON.stringify({ source: 'ebay-transaction-report', feeType: f.feeType, rowsAggregated: f.count }), now);
        const evId = Number(res.lastInsertRowid);
        const fr = insFee.run(evId, f.feeType, f.feeCategory, f.cents, f.date);
        if (fr.changes > 0) { feeRows++; feeCents += f.cents; }
        else db.prepare(`DELETE FROM financial_events WHERE id = ?`).run(evId); // never leave a childless event
      }

      db.prepare(`
        INSERT INTO sync_log (sync_type, started_at, completed_at, records_fetched, status)
        VALUES ('ebay-transaction-report', ?, ?, ?, 'success')
      `).run(now, new Date().toISOString(), labelsApplied + feeRows);
    });
    apply();
  } catch (err: any) {
    db.close();
    return NextResponse.json({ error: `Import failed: ${err.message}` }, { status: 500 });
  }

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
