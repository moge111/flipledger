'use client';

import { useState } from 'react';
import { CheckCircle } from 'lucide-react';

export function WalmartServiceFeeImport() {
  return (
    <div className="panel mb-6">
      <h2 className="panel-bar"><span className="flex items-center gap-2">Walmart WFS Service Fees</span></h2>
<div className="p-6">
      <div className="flex items-start gap-2 py-2 px-3 flash border-l-positive mb-3">
        <CheckCircle size={14} className="text-positive mt-0.5 shrink-0" />
        <span className="text-xs text-text-secondary">
          Automatic since Aug 23, 2026 — no manual export needed.
        </span>
      </div>
      <p className="text-xs text-text-tertiary">
        Storage, inbound transportation, return-to-vendor, removal-order fees and the WFS
        refund / lost-inventory credits are all captured from the reconciliation report on
        every Walmart sync. The recon feed has carried them since Nov 2024; the parser used to
        discard them because they arrive without a Purchase Order&nbsp;#.
      </p>
      <p className="text-[11px] text-text-tertiary mt-3">
        The old Seller Center CSV import has been retired. Do not re-enable it — it writes a
        separate event type that nothing reconciles against the recon-sourced rows, so running
        both would double-count. Recon is also the more complete source. The one thing lost is
        per-item attribution on storage fees, which recon reports as a period total.
      </p>
      <WfsReturnDispositionImport />
    </div>
</div>
  );
}

interface RtvImportResult {
  error?: string;
  rowsInserted?: number;
  table?: { rows: number; through: string | null };
  lostReturns?: { rowsInserted: number; table: { rows: number; credit_cents: number; through_date: string | null } };
}

// Which returned units came back (RTV) and which Walmart lost and paid for
// (LostReturnAdjustment) is only in the Services Fees CSV exports; the recon
// roll-ups carry no PO or GTIN. Attribution only: no money rows are written.
function WfsReturnDispositionImport() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RtvImportResult | null>(null);

  async function run() {
    setRunning(true);
    try {
      const res = await fetch('/api/sync/import-wfs-rtv', { method: 'POST' });
      setResult(await res.json());
    } catch {
      setResult({ error: 'Network error' });
    }
    setRunning(false);
  }

  return (
    <div className="mt-4 pt-4 border-t border-border-subtle">
      <h3 className="text-sm font-medium text-text-primary mb-1">Return dispositions (RTV &amp; lost returns)</h3>
      <p className="text-xs text-text-tertiary mb-3">
        Export <span className="text-text-secondary">RC_InventoryRTVFee</span> and <span className="text-text-secondary">Refund</span> CSVs
        from Seller Center → Payments → Services Fees, unzip into <code>data/walmart-service-fees/</code>, then import.
        FIFO and the Walmart claim detector use this to tell returns that came back from returns Walmart lost and already paid for.
        Nothing is added to the books.
      </p>
      <button
        onClick={run}
        disabled={running}
        className="px-3 py-1.5 text-xs font-semibold rounded-md text-text-primary hover:bg-bg-hover disabled:opacity-50 bg-bg-surface border-[1.5px] border-border-strong"
      >
        {running ? 'Importing…' : 'Import RTV & lost returns'}
      </button>
      {result && (
        <p className={`text-xs mt-2 ${result.error ? 'text-negative' : 'text-text-secondary'}`}>
          {result.error
            ? result.error
            : `RTV: ${result.rowsInserted ?? 0} new (${result.table?.rows ?? 0} total, through ${result.table?.through ?? '—'}). ` +
              `Lost returns: ${result.lostReturns?.rowsInserted ?? 0} new (${result.lostReturns?.table.rows ?? 0} total, ` +
              `$${((result.lostReturns?.table.credit_cents ?? 0) / 100).toFixed(2)}, through ${result.lostReturns?.table.through_date ?? '—'}).`}
        </p>
      )}
    </div>
  );
}

// Ship-from address + carrier contact used for Amazon FBA inbound shipments.
// Amazon requires a real name/phone/email on transportation options — the
// carrier uses them for pickup contact — so there is no safe default here.

export function ImportTransactionReport() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/sync/import-transactions', { method: 'POST', body: formData });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: String(err) });
    }
    setImporting(false);
  }

  return (
    <div>
      <label className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors cursor-pointer w-fit">
        <input type="file" accept=".csv,.tsv,.txt" onChange={handleImport} className="hidden" disabled={importing} />
        {importing ? 'Importing...' : 'Choose CSV File'}
      </label>
      {result && !result.error && (
        <div className="mt-3 p-3 rounded-sm text-xs text-positive space-y-1 border-[1.2px] border-current">
          <div>Rows processed: {result.rowsProcessed}</div>
          <div>Shipping costs updated: {result.shippingCostsUpdated}</div>
          <div>Estimated fees replaced: {result.feesUpdated}</div>
          <div>New fees imported: {result.feesInserted}</div>
        </div>
      )}
      {result?.error && (
        <div className="mt-3 p-3 rounded-sm text-xs text-negative border-[1.2px] border-current">{result.error}</div>
      )}
    </div>
  );
}
