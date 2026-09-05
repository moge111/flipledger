'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import { TransportationOption } from '@/components/listing/types';

export function CarrierBookingPanel({ batchId }: { batchId: number }) {
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [options, setOptions] = useState<TransportationOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRegenTried = useRef(false);

  const load = useCallback(async (regenerate: boolean) => {
    if (regenerate) setRegenerating(true); else setLoading(true);
    setError(null);
    try {
      const url = `/api/list/batches/${batchId}/transportation${regenerate ? '?regenerate=1' : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setOptions(d.options || []);
      setSelected((prev) => prev ?? d.transportationOptionId ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setRegenerating(false);
    }
  }, [batchId]);

  useEffect(() => { load(false); }, [load]);

  // Amazon computes the Amazon-Partnered (UPS) rate lazily after placement
  // confirmation. If the first load came back with options but no Partnered
  // one, it's likely still warming up — auto-regenerate once to chase it.
  useEffect(() => {
    if (loading || regenerating || autoRegenTried.current) return;
    if (options.length > 0 && !options.some((o) => o.shippingSolution === 'AMAZON_PARTNERED_CARRIER')) {
      autoRegenTried.current = true;
      load(true);
    }
  }, [loading, regenerating, options, load]);

  async function handleConfirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/list/batches/${batchId}/transportation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transportationOptionId: selected }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
        setConfirming(false);
        return;
      }
      // Reload the page so batch state refreshes — simplest correct UX
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setConfirming(false);
    }
  }

  // A placement can span multiple shipments (Amazon splits across FCs). Amazon
  // returns a transportation option PER shipment, so a single carrier choice
  // (e.g. Amazon Partnered UPS Ground) shows up once per shipment. Collapse
  // those into ONE choice per (solution, mode, carrier), summing the quote
  // across shipments — so the card shows the TRUE total you'll pay, and only
  // choices available for EVERY shipment are offered (Amazon requires a carrier
  // for all shipments to confirm). July 8, 2026.
  const shipmentIds = [...new Set(options.map((o) => o.shipmentId))];
  const groupMap = new Map<string, TransportationOption[]>();
  for (const o of options) {
    const key = `${o.shippingSolution}|${o.shippingMode}|${(o.carrier?.name || '').toLowerCase()}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(o);
  }
  const choices = [...groupMap.values()]
    // Keep only carrier choices offered for every shipment in the placement.
    .filter((opts) => shipmentIds.every((sid) => opts.some((o) => o.shipmentId === sid)))
    .map((opts) => {
      // One representative option per shipment (dedupe if Amazon repeats).
      const perShipment = shipmentIds.map((sid) => opts.find((o) => o.shipmentId === sid)!);
      const anyQuoted = perShipment.some((o) => o.quote?.cost?.amount != null);
      const totalCost = perShipment.reduce((s, o) => s + (o.quote?.cost?.amount || 0), 0);
      const first = perShipment[0];
      return {
        key: first.transportationOptionId,
        repOptionId: first.transportationOptionId,
        carrierName: first.carrier?.name || first.shippingSolution,
        shippingMode: first.shippingMode,
        shippingSolution: first.shippingSolution,
        isPartnered: first.shippingSolution === 'AMAZON_PARTNERED_CARRIER',
        totalCost: anyQuoted ? totalCost : null,
        shipmentCount: perShipment.length,
      };
    });
  const sorted = choices.sort((a, b) => {
    const aP = a.isPartnered ? 0 : 1;
    const bP = b.isPartnered ? 0 : 1;
    if (aP !== bP) return aP - bP;
    const aSmall = a.shippingMode === 'GROUND_SMALL_PARCEL' ? 0 : 1;
    const bSmall = b.shippingMode === 'GROUND_SMALL_PARCEL' ? 0 : 1;
    if (aSmall !== bSmall) return aSmall - bSmall;
    return a.carrierName.localeCompare(b.carrierName);
  });

  return (
    <div className="border border-border-subtle rounded-lg bg-bg-elevated p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-text-primary mb-0.5">Choose a carrier</div>
          <div className="text-[11px] text-text-tertiary">
            <span className="text-positive">Amazon Partnered</span> options come with discounted rates AND Amazon-generated UPS labels —
            you&apos;ll be able to print everything from inside FlipLedger.
            &quot;Own carrier&quot; options leave label generation to you (UPS WorldShip, USPS Click-N-Ship, etc.).
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading || regenerating}
          title="Re-fetch carrier options from Amazon (chases the Partnered UPS rate, which can take a moment to appear)"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-border-subtle bg-bg-surface text-[11px] text-text-secondary hover:border-border-default disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
          {regenerating ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {loading && <div className="text-[11px] text-text-tertiary italic">Loading carrier options…</div>}
      {regenerating && !loading && (
        <div className="text-[11px] text-text-tertiary italic flex items-center gap-1.5">
          <Loader2 size={11} className="animate-spin" /> Checking Amazon for Partnered UPS rates… (this can take up to a minute)
        </div>
      )}
      {error && <div className="text-[11px] text-negative">{error}</div>}
      {!loading && !regenerating && !error && sorted.length === 0 && (
        <div className="text-[11px] text-text-tertiary italic">No carrier options returned by Amazon. Try Refresh.</div>
      )}
      {!loading && !regenerating && sorted.length > 0 && !sorted.some((c) => c.isPartnered) && (
        <div className="text-[11px] text-amber-400/90 italic">
          No Amazon Partnered rate yet — it&apos;s computed a moment after placement and may need another Refresh to appear.
        </div>
      )}
      {shipmentIds.length > 1 && (
        <div className="text-[10px] text-text-tertiary">
          This placement has {shipmentIds.length} shipments — prices shown are the <span className="font-medium">total across all shipments</span>, and your carrier applies to every shipment.
        </div>
      )}
      {!loading && sorted.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
          {sorted.map((c) => {
            const isSelected = selected === c.repOptionId;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setSelected(c.repOptionId)}
                className={`text-left border rounded p-2.5 transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/15 ring-1 ring-accent'
                    : c.isPartnered
                      ? 'border-positive/40 bg-positive/5 hover:border-positive/60'
                      : 'border-border-subtle bg-bg-surface hover:border-border-default'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <div className="text-xs font-medium text-text-primary truncate flex-1">
                    {c.carrierName}
                  </div>
                  {c.isPartnered && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-positive/20 text-positive uppercase tracking-wider shrink-0">
                      Partnered
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-text-tertiary uppercase tracking-wider">
                  {c.shippingMode.replace(/_/g, ' ')}
                </div>
                {c.totalCost != null ? (
                  <div className="text-sm font-mono text-positive mt-1 font-medium">
                    ${c.totalCost.toFixed(2)}
                    {c.shipmentCount > 1 && <span className="text-[10px] text-text-tertiary font-sans"> total · {c.shipmentCount} shipments</span>}
                  </div>
                ) : c.shippingSolution === 'USE_YOUR_OWN_CARRIER' ? (
                  <div className="text-[10px] text-text-tertiary mt-1 italic">
                    Pricing via your own carrier account
                  </div>
                ) : null}
                {c.isPartnered && (
                  <div className="text-[10px] text-positive/80 mt-1">
                    ✓ Amazon generates the UPS labels
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {!loading && sorted.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selected || confirming}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {confirming ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {confirming ? 'Confirming…' : 'Confirm carrier'}
          </button>
        </div>
      )}
    </div>
  );
}
