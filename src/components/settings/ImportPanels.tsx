'use client';

import { useState } from 'react';
import { CheckCircle } from 'lucide-react';

export function WalmartServiceFeeImport() {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-2">Walmart WFS Service Fees</h2>
      <div className="flex items-start gap-2 py-2 px-3 bg-positive/10 border border-positive/25 rounded-md mb-3">
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
        <div className="mt-3 p-3 bg-positive-muted rounded-md text-xs text-positive space-y-1">
          <div>Rows processed: {result.rowsProcessed}</div>
          <div>Shipping costs updated: {result.shippingCostsUpdated}</div>
          <div>Estimated fees replaced: {result.feesUpdated}</div>
          <div>New fees imported: {result.feesInserted}</div>
        </div>
      )}
      {result?.error && (
        <div className="mt-3 p-3 bg-negative-muted rounded-md text-xs text-negative">{result.error}</div>
      )}
    </div>
  );
}
