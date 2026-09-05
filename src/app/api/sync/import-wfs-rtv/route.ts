/**
 * POST /api/sync/import-wfs-rtv
 *
 * Imports per-unit WFS return-to-vendor records from the Seller Center
 * "Services Fees" RC_InventoryRTVFee CSV exports in data/walmart-service-fees/.
 *
 * WHY THIS EXISTS: an RTV means Walmart shipped a customer return back to the
 * seller — the unit is NOT lost, so no reimbursement claim is owed. Since the
 * Aug 2026 recon migration the RTV *fees* arrive as period-level roll-ups with
 * an empty Partner GTIN, so the money is captured but WHICH unit came back is
 * not. Without that attribution the Refunds page's "returns never returned to
 * you" detector treats every settled return as lost, which is how 17 of 19
 * flagged claims turned out to be units already sitting in the garage.
 *
 * SAFETY: this writes ONLY to wfs_rtv_units. It never touches fee_details,
 * financial_events, or reimbursements, so it cannot double-count against the
 * recon roll-ups the way re-enabling the retired CSV fee importer would.
 * Idempotent — re-running converges (unique index on gtin+date+reference).
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { openDb } from '@/lib/db-conn';

const DIR = path.join(process.cwd(), 'data', 'walmart-service-fees');

/** Strips Excel's ="..." wrapper that Walmart's exports use on ID columns. */
function clean(v: string | undefined): string {
  return (v || '').replace(/^="?/, '').replace(/"$/, '').trim();
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map(h => clean(h));
  return lines.slice(1).map(l => {
    const cells = split(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

export async function POST() {
  if (!fs.existsSync(DIR)) {
    return NextResponse.json({ error: `Directory not found: ${DIR}` }, { status: 400 });
  }
  const files = fs.readdirSync(DIR).filter(f => /^RC_InventoryRTVFee_.*\.csv$/i.test(f)).sort();
  if (files.length === 0) {
    return NextResponse.json({
      error: 'No RC_InventoryRTVFee CSVs found. Export them from Seller Center → Payments → Services Fees and unzip into data/walmart-service-fees/.',
    }, { status: 400 });
  }

  const db = openDb();
  db.pragma('journal_mode = WAL');
  try {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO wfs_rtv_units (gtin, rtv_date, quantity, net_payable_cents, wfs_reference_id, source_file)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let scanned = 0, inserted = 0, skippedNoGtin = 0;
    const dates: string[] = [];

    db.transaction(() => {
      for (const file of files) {
        for (const row of parseCsv(fs.readFileSync(path.join(DIR, file), 'utf8'))) {
          scanned++;
          const gtin = clean(row['Partner GTIN']);
          // Date column name varies across Walmart's export vintages.
          const date = clean(row['Transaction Date/Time'] || row['Transaction Date and Time']).slice(0, 10);
          if (!gtin || !date) { skippedNoGtin++; continue; }
          const qty = parseInt(clean(row['Qty']) || '1', 10) || 1;
          const net = Math.round(parseFloat(clean(row['Net Payable']) || '0') * 100);
          dates.push(date);
          inserted += ins.run(gtin, date, qty, net, clean(row['WFSReferenceID']) || null, file).changes;
        }
      }
    })();

    const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(quantity),0) units, MIN(rtv_date) mn, MAX(rtv_date) mx FROM wfs_rtv_units`).get() as any;
    return NextResponse.json({
      success: true,
      filesRead: files.length,
      rowsScanned: scanned,
      rowsInserted: inserted,
      rowsSkippedNoGtin: skippedNoGtin,
      csvCoverage: dates.length ? { from: dates.sort()[0], through: dates[dates.length - 1] } : null,
      table: { rows: total.n, units: total.units, from: total.mn, through: total.mx },
      note: 'Disposition data only — no financial rows written. Re-export the CSVs periodically; RTV lags a return by ~2-7 weeks.',
    });
  } finally {
    db.close();
  }
}

export async function GET() {
  const db = openDb();
  try {
    const t = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(quantity),0) units, MIN(rtv_date) from_date, MAX(rtv_date) through_date FROM wfs_rtv_units`).get();
    return NextResponse.json({ ...(t as object), dir: DIR });
  } finally {
    db.close();
  }
}
