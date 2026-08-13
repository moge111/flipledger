/**
 * Import Walmart WFS "Services Fees" exports (Seller Center → Payments → Services Fees).
 *
 * These WFS service fees are NOT in the recon/settlement API feed (verified
 * exhaustively May 2026) and are not in any public Marketplace API. The only
 * source is the per-fee-type CSV export from Seller Center. Drop the unzipped
 * CSVs in data/walmart-service-fees/ and POST this route.
 *
 * Costs (Net Payable POSITIVE) → fee_details + financial_events (marketplace=walmart):
 *   StorageFee, InboundTransportationFee, RC_InventoryRTVFee, InventoryRemovalOrder
 * Reimbursements (Net Payable NEGATIVE = credit to seller) → reimbursements table:
 *   Refund, LostInventory
 *
 * Skips *_reconciliationreport exports (already synced via recon API) and
 * ItemSalesReport (unrelated). Idempotent: deletes prior import then re-inserts.
 */
import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DIR = path.join(process.cwd(), 'data', 'walmart-service-fees');

const COST_MAP: Record<string, { feeType: string; feeCategory: string }> = {
  StorageFee: { feeType: 'WFSStorageFee', feeCategory: 'WFS Storage & Inventory Fees' },
  InboundTransportationFee: { feeType: 'WFSInboundTransportationFee', feeCategory: 'WFS Inbound Fees' },
  RC_InventoryRTVFee: { feeType: 'WFSInventoryRTVFee', feeCategory: 'WFS Storage & Inventory Fees' },
  InventoryRemovalOrder: { feeType: 'WFSRemovalFee', feeCategory: 'WFS Storage & Inventory Fees' },
};
const REIMB_TYPES = new Set(['Refund', 'LostInventory']);

// Minimal RFC-4180-ish parser: handles quoted fields w/ embedded commas + Excel ="..." cells.
function parseCsv(text: string): Record<string, string>[] {
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
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length === headers.length).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => { o[h] = unexcel(r[idx]); });
    return o;
  });
}
// strip Excel ="..." wrapper and surrounding whitespace
function unexcel(v: string): string {
  if (v == null) return '';
  let s = v.trim();
  const m = s.match(/^="(.*)"$/);
  if (m) s = m[1];
  return s.trim();
}

// Two Walmart WFS export shapes carry the same data under different headers:
//   - per-fee-type "Services Fees" CSVs: Transaction Date/Time, Partner GTIN, …
//   - the full YTD "Settlement Report": Transaction Date and Time, GTIN, …
// pick() reads whichever alias is present.
function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v.trim() !== '') return v.trim();
  }
  return '';
}

export async function POST() {
  if (!fs.existsSync(DIR)) {
    return NextResponse.json({ error: `Directory not found: ${DIR}` }, { status: 400 });
  }
  const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  const db = new Database(path.join(process.cwd(), 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');

  // Aggregate costs by (transactionType, day, key) so per-line storage accruals
  // don't collide on the day-level fee_details unique index. key = gtin|po|ref.
  const costAgg = new Map<string, { type: string; day: string; gtin: string; name: string; cents: number }>();
  const reimbRows: { id: string; date: string; gtin: string; name: string; reason: string; cents: number; qty: number }[] = [];
  const stats: Record<string, { rows: number; cents: number }> = {};
  let filesParsed = 0, skipped: string[] = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    // skip recon dumps / item sales / anything without the service-fee shape
    if (!/"?Transaction Type"?/.test(text.split('\n')[0]) || !/Net Payable/.test(text.split('\n')[0])) {
      skipped.push(file); continue;
    }
    // The full Settlement Report carries reimbursements AND costs, but its
    // cost rows duplicate what we already track more precisely: FulfillmentFee
    // is the recon WalmartFee (pick/pack), and its StorageFee is a single
    // undated lump vs the granular per-fee-type StorageFee CSVs. So from a
    // settlement report we take ONLY reimbursements; costs come from the
    // per-fee-type exports (and FulfillmentFee from recon).
    const isSettlementReport = /^SettlementReport/i.test(file) || /WFS Reference ID/.test(text.split('\n')[0]);
    // filename date: per-fee-type "_YYYY-MM-DD_" or settlement "_YYYY-MM-DDThh…"
    const fileDate = (file.match(/_(\d{4}-\d{2}-\d{2})[_T]/) || [])[1] || '';
    const rows = parseCsv(text);
    filesParsed++;
    for (const row of rows) {
      const type = (row['Transaction Type'] || '').trim();
      if (!type) continue;
      const npRaw = (row['Net Payable'] || '').trim();
      if (npRaw === '') continue;
      const np = parseFloat(npRaw);
      if (!isFinite(np)) continue;
      const day = (pick(row, 'Transaction Date/Time', 'Transaction Date and Time').slice(0, 10)) || fileDate;
      if (!day) continue;
      const gtin = pick(row, 'Partner GTIN', 'GTIN');
      const name = pick(row, 'Partner Item Name', 'Item Name');
      const po = pick(row, 'Walmart.com PO #', 'PO Number');
      const ref = pick(row, 'WFSReferenceID', 'WFS Reference ID');

      stats[type] = stats[type] || { rows: 0, cents: 0 };
      stats[type].rows++;
      stats[type].cents += Math.round(np * 100);

      if (isSettlementReport && !REIMB_TYPES.has(type)) {
        // settlement-report cost row — already tracked elsewhere, skip
        continue;
      }

      if (COST_MAP[type]) {
        // cost: store as NEGATIVE fee amount (P&L does -SUM(amount))
        const key = `${type}|${day}|${gtin || po || ref || 'NA'}`;
        const cents = -Math.round(np * 100); // positive Net Payable → negative cost
        const ex = costAgg.get(key);
        if (ex) ex.cents += cents;
        else costAgg.set(key, { type, day, gtin: gtin || po || '', name, cents });
      } else if (REIMB_TYPES.has(type)) {
        // reimbursement / credit to seller: Net Payable negative → positive credit
        reimbRows.push({
          id: `WFS-SVC-${ref || `${type}-${day}-${gtin}-${Math.round(np * 100)}`}`,
          date: day, gtin, name,
          reason: `${type}${row['Reason Code'] ? ': ' + row['Reason Code'] : ''}`,
          cents: -Math.round(np * 100), // negative Net Payable → positive reimbursement
          qty: parseInt(row['Qty'] || '1') || 1,
        });
      }
      // other transaction types ignored
    }
  }

  const result = { feesInserted: 0, feeDollars: 0, reimbInserted: 0, reimbDollars: 0 };
  const tx = db.transaction(() => {
    // ── idempotent cleanup of prior import ──
    const oldEvents = db.prepare("SELECT id FROM financial_events WHERE event_type = 'WalmartServiceFee'").all() as { id: number }[];
    if (oldEvents.length) {
      const ids = oldEvents.map((e) => e.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM fee_details WHERE financial_event_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM financial_events WHERE id IN (${ph})`).run(...ids);
    }
    db.prepare("DELETE FROM reimbursements WHERE reimbursement_id LIKE 'WFS-SVC-%'").run();

    const insEvent = db.prepare(`INSERT INTO financial_events (event_type, posted_date, order_id, asin, sku, marketplace, total_amount, raw_data, created_at)
      VALUES ('WalmartServiceFee', ?, NULL, ?, ?, 'walmart', ?, ?, ?)`);
    const insFee = db.prepare(`INSERT INTO fee_details (financial_event_id, order_id, asin, fee_type, fee_category, amount, posted_date)
      VALUES (?, NULL, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();

    for (const g of costAgg.values()) {
      if (g.cents === 0) continue;
      const map = COST_MAP[g.type];
      const postedDate = `${g.day}T12:00:00.000Z`;
      const info = insEvent.run(postedDate, g.gtin || null, g.type, g.cents, JSON.stringify({ source: 'wfs-service-fees', type: g.type, item: g.name }), now);
      insFee.run(info.lastInsertRowid as number, g.gtin || null, map.feeType, map.feeCategory, g.cents, postedDate);
      result.feesInserted++;
      result.feeDollars += g.cents / 100;
    }

    const insReimb = db.prepare(`INSERT OR IGNORE INTO reimbursements (reimbursement_id, reimbursement_date, asin, sku, reason, amount, quantity, status, marketplace, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 'walmart', ?)`);
    for (const r of reimbRows) {
      if (r.cents === 0) continue;
      insReimb.run(r.id, `${r.date}T12:00:00.000Z`, r.gtin || null, null, r.reason, r.cents, r.qty, now);
      result.reimbInserted++;
      result.reimbDollars += r.cents / 100;
    }
  });
  tx();
  db.close();

  return NextResponse.json({
    filesParsed, filesSkipped: skipped,
    perType: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { rows: v.rows, netPayable: (v.cents / 100).toFixed(2) }])),
    ...result,
    feeDollars: result.feeDollars.toFixed(2),
    reimbDollars: result.reimbDollars.toFixed(2),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
