'use client';

/**
 * WFS (Walmart) batch page: add products by walmart.com link / item ID / UPC,
 * send them to Walmart as an inbound shipment, then per shipment enter the
 * boxes, get FedEx rates through Walmart (or use your own carrier), and print
 * the WFS box labels. Amazon batches use the main batch page instead.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, Printer, Download, Send, Trash2, Truck, X as XIcon, ExternalLink, Package, DollarSign, TrendingUp, Percent } from 'lucide-react';
import { formatCurrency } from '@/lib/formatters';
import { useQuery } from '@/lib/useQuery';
import { Panel, Seg } from '@/components/ui/Paper';
import { StatusBadge } from '@/components/listing/BatchBadges';

interface WfsItem {
  id: number;
  sku: string;
  productName: string | null;
  imageUrl: string | null;
  quantity: number;
  buyPriceCents: number;
  listPriceCents: number;
  supplier: string | null;
  walmartItemId: string | null;
  gtin: string | null;
  walmartSetupStatus: 'PENDING' | 'READY' | 'FAILED' | null;
  sendQtyToAmazon: number | null;
  skuStock: number;
  walmartSetup: { status: string; error: string | null; pending: string | null; updatedAt: string } | null;
  feeEstimate?: FeeEstimate;
}

interface FeeEstimate {
  referralCents: number;
  fulfillmentCents: number;
  referralRate: number;
  referralSource: 'sku' | 'default';
  fulfillmentSource: 'sku' | 'weight' | 'account' | 'none';
}

/** Per-unit fees (referral + WFS) for an item, cents. */
const unitFees = (i: WfsItem) => (i.feeEstimate ? i.feeEstimate.referralCents + i.feeEstimate.fulfillmentCents : 0);
/** Expected profit for the whole line, cents; null when the item has no Walmart price. */
const lineProfit = (i: WfsItem) => (i.listPriceCents > 0 ? i.quantity * (i.listPriceCents - unitFees(i) - i.buyPriceCents) : null);

function feeTooltip(i: WfsItem): string {
  const f = i.feeEstimate;
  if (!f) return '';
  const ref = `Referral ${formatCurrency(f.referralCents)} (${(f.referralRate * 100).toFixed(1)}%${f.referralSource === 'sku' ? ', this SKU\'s last settled rate' : ', standard rate'})`;
  if (f.fulfillmentSource === 'none') return `${ref} per unit. Your shipping cost isn't included.`;
  const src = { sku: "this SKU's last WFS fee", weight: 'WFS rate card by weight', account: 'your 90-day average WFS fee', none: '' }[f.fulfillmentSource];
  return `${ref} + WFS fulfillment ${formatCurrency(f.fulfillmentCents)} (${src}) per unit`;
}

type FieldKind = 'text' | 'longtext' | 'list' | 'enum' | 'multi' | 'integer' | 'number' | 'measure';
interface FormField {
  key: string;
  title: string;
  description?: string;
  kind: FieldKind;
  options?: string[];
  units?: string[];
  required: boolean;
  value: unknown;
  source: 'walmart' | 'amazon' | 'default' | 'remembered' | 'ai' | null;
}

interface SetupFormData {
  kind: 'WFS_NEW' | 'WFS_CONVERT' | 'SF_NEW';
  productType: string;
  sku: string;
  skuLocked: boolean;
  priceDollars: number | null;
  shippingWeightLb: number | null;
  unit: { lengthIn: number; widthIn: number; heightIn: number; weightLb: number } | null;
  countryOfOrigin: string;
  countries: string[];
  batteryType: string;
  batteryTypes: string[];
  batterySizes: string[];
  batterySize?: string;
  batteryHint: string | null;
  electronics: boolean;
  fields: FormField[];
  silent: Record<string, unknown>;
  unsupported: string[];
  aiNote: string | null;
}

interface SetupPrompt {
  message: string;
  product: { itemId: string; title: string; imageUrl: string | null; priceCents: number | null; upc: string | null; productType: string | null };
  form: SetupFormData;
}

interface WfsBatch {
  id: number;
  name: string;
  status: string;
  channel: string;
  inboundOrderId: string | null;
  isHolding: number | null;
  sendError: string | null;
  createdAt: string;
}

type LoadType = 'SINGLE SKU' | 'MIXED SKUS';
interface Box { lengthIn: number | string; widthIn: number | string; heightIn: number | string; weightLb: number | string; loadType: LoadType }
interface Quote { quoteId: string; carrierName: string; netChargeCents: number; estimatedDelivery: string | null }
interface Shipment {
  shipmentId: string;
  fcName: string | null;
  shipTo: { fcName?: string; addressLine1: string; city: string; stateCode: string; postalCode: string } | null;
  items: { sku: string; quantity: number }[];
  expectedDeliveryDate: string | null;
  boxes: Box[];
  quotes: Quote[];
  quotedAt: string | null;
  bookedChargeCents: number | null;
  bookedAt: string | null;
  carrierName: string | null;
  tracking: string[];
  status: string;
  error: string | null;
  walmartStatus: string | null;
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (url: string, body: unknown) =>
  call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const inputCls = 'h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-link';
const btnCls = 'flex items-center gap-2 h-9 px-3 rounded-md text-sm font-semibold transition-colors disabled:opacity-50';
const primaryBtn = `${btnCls} bg-accent text-text-inverse font-bold hover:bg-accent/90`;
const secondaryBtn = `${btnCls} bg-bg-surface border-[1.5px] border-border-strong text-text-primary hover:bg-bg-hover`;

export function WfsBatchView({ batchId }: { batchId: string }) {
  const { data, loading, reload } = useQuery<{ batch: WfsBatch; items: WfsItem[] }>(`/api/list/batches/${batchId}`);
  const batch = data?.batch;
  const items = data?.items ?? [];
  const shipping = batch?.status === 'shipping';
  const { data: shipData, reload: reloadShipments } = useQuery<{ shipments: Shipment[] }>(
    shipping ? `/api/list/batches/${batchId}/wfs` : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingUp = items.some(i => i.walmartSetupStatus === 'PENDING');
  const sf = batch?.channel === 'WMT_SF';
  const holding = !!batch?.isHolding;

  // While Walmart is creating or switching a SKU, check on it every 30 s.
  useEffect(() => {
    if (!settingUp) return;
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try { await post(`/api/list/batches/${batchId}/wfs/setup`, {}); } catch { /* next tick */ }
      if (!stop) reload(true);
    };
    const timer = setInterval(tick, 30000);
    tick();
    return () => { stop = true; clearInterval(timer); };
  }, [settingUp, batchId, reload]);

  if (loading || !batch) return <div className="text-text-tertiary">Loading batch…</div>;

  const units = items.reduce((s, i) => s + i.quantity, 0);
  const costCents = items.reduce((s, i) => s + i.quantity * i.buyPriceCents, 0);
  const skuCount = new Set(items.map(i => i.sku)).size;
  const priced = items.filter(i => i.listPriceCents > 0);
  const unpricedCount = items.length - priced.length;
  const revenueCents = priced.reduce((s, i) => s + i.quantity * i.listPriceCents, 0);
  const pricedCostCents = priced.reduce((s, i) => s + i.quantity * i.buyPriceCents, 0);
  const feesCents = priced.reduce((s, i) => s + i.quantity * unitFees(i), 0);
  const profitCents = revenueCents - pricedCostCents - feesCents;
  const roi = pricedCostCents > 0 ? (profitCents / pricedCostCents) * 100 : 0;
  const margin = revenueCents > 0 ? (profitCents / revenueCents) * 100 : 0;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy(null);
  }

  const sendToWalmart = () => {
    if (!confirm(`Create a Walmart inbound shipment for ${units} units of ${skuCount} SKU${skuCount === 1 ? '' : 's'}?\n\nWalmart may split it across fulfillment centers. You can cancel it until the boxes arrive.`)) return;
    run('send', async () => { await post(`/api/list/batches/${batchId}/wfs`, { action: 'send' }); reload(true); });
  };
  const cancelShipment = () => {
    if (!confirm('Cancel this Walmart shipment? Any booked FedEx label is cancelled too. The batch goes back to draft; your cost lots stay.')) return;
    run('cancel', async () => { await post(`/api/list/batches/${batchId}/wfs`, { action: 'cancel' }); reload(true); });
  };
  const notReady = items.some(i => i.walmartSetupStatus && i.walmartSetupStatus !== 'READY');
  const publish = () => {
    const pushed = [...new Set(items.filter(i => i.sendQtyToAmazon !== 0).map(i => i.sku))];
    if (!confirm(`Set the Walmart quantity for ${pushed.length} SKU${pushed.length === 1 ? '' : 's'} to your stock in FlipLedger?\n\n${pushed.map(sku => `${sku}: ${items.find(i => i.sku === sku)?.skuStock ?? 0} available`).join('\n')}`)) return;
    run('publish', async () => { await post(`/api/list/batches/${batchId}/wfs`, { action: 'publish' }); reload(true); });
  };
  const closeBatch = () => {
    if (!confirm('Close this batch? Do this once Walmart has received everything.')) return;
    run('close', async () => {
      await call(`/api/list/batches/${batchId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
      reload(true);
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <Link href="/list" className="p-1.5 rounded-md hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title">{batch.name}</h1>
              {!holding && <StatusBadge status={batch.status} />}
              <span className="text-xs text-text-tertiary label-caps">{holding ? 'Waiting to ship · WFS' : sf ? 'Seller fulfilled · Walmart' : 'WFS · Walmart'}</span>
            </div>
            <p className="text-xs text-text-tertiary mt-0.5">
              {units} units · {skuCount} SKU{skuCount === 1 ? '' : 's'} · {formatCurrency(costCents)} at cost
              {batch.inboundOrderId && <> · Walmart inbound order <span className="font-mono">{batch.inboundOrderId}</span></>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!sf && !holding && batch.status === 'draft' && items.length > 0 && (
            <button onClick={sendToWalmart} disabled={busy !== null || notReady} className={primaryBtn}
              title={notReady ? 'Waiting for Walmart to finish setting up new SKUs' : undefined}>
              {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send to Walmart
            </button>
          )}
          {sf && ['draft', 'ready'].includes(batch.status) && items.length > 0 && (
            <button onClick={publish} disabled={busy !== null || notReady} className={primaryBtn}
              title={notReady ? 'Waiting for Walmart to finish setting up new SKUs' : undefined}>
              {busy === 'publish' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {batch.status === 'ready' ? 'Publish again' : 'Publish to Walmart'}
            </button>
          )}
          {sf && batch.status === 'ready' && <button onClick={closeBatch} disabled={busy !== null} className={secondaryBtn}>Close batch</button>}
          {shipping && (
            <>
              <button onClick={cancelShipment} disabled={busy !== null} className={secondaryBtn}>
                {busy === 'cancel' ? <Loader2 size={14} className="animate-spin" /> : <XIcon size={14} />} Cancel shipment
              </button>
              <button onClick={closeBatch} disabled={busy !== null} className={secondaryBtn}>Close batch</button>
            </>
          )}
        </div>
      </div>

      {(error || batch.sendError) && (
        <div className="attn-banner mb-4 text-sm">{error || `Last ${sf ? 'publish' : 'send'} failed: ${batch.sendError}`}</div>
      )}

      {items.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
          <div className="panel p-3">
            <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary"><Package size={12} /> Units</div>
            <div className="stat-num text-lg sm:text-xl text-text-primary mt-1">{units}</div>
            <div className="text-[11px] text-text-tertiary">{skuCount} SKU{skuCount === 1 ? '' : 's'}</div>
          </div>
          <div className="panel p-3">
            <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary"><DollarSign size={12} /> Expected Revenue</div>
            <div className="stat-num text-lg sm:text-xl text-text-primary mt-1">{formatCurrency(revenueCents)}</div>
            {unpricedCount > 0 && <div className="text-[11px] text-text-tertiary">{unpricedCount} item{unpricedCount === 1 ? '' : 's'} without a price left out</div>}
          </div>
          <div className="panel p-3">
            <div className="text-[10px] label-caps text-text-tertiary">Cost + Fees</div>
            <div className="stat-num text-lg sm:text-xl text-text-secondary mt-1">{formatCurrency(pricedCostCents + feesCents)}</div>
            <div className="text-[11px] text-text-tertiary">
              {formatCurrency(pricedCostCents)} cost · {formatCurrency(feesCents)} {sf ? 'referral fees' : 'fees'}
            </div>
          </div>
          <div className="panel p-3">
            <div className="flex items-center gap-1.5 text-[10px] label-caps text-accent"><TrendingUp size={12} /> Expected Profit</div>
            <div className={`stat-num text-lg sm:text-xl mt-1 ${profitCents >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(profitCents)}</div>
            <div className="text-[11px] text-text-tertiary">{margin.toFixed(1)}% margin{sf ? ' · before shipping' : ''}</div>
          </div>
          <div className="panel p-3">
            <div className="flex items-center gap-1.5 text-[10px] label-caps text-text-tertiary"><Percent size={12} /> ROI</div>
            <div className={`stat-num text-lg sm:text-xl mt-1 ${roi >= 30 ? 'text-positive' : roi >= 0 ? 'text-text-primary' : 'text-negative'}`}>{roi.toFixed(1)}%</div>
          </div>
        </div>
      )}

      {holding && (
        <p className="text-sm text-text-secondary mb-4">
          Units you've bought for WFS but aren't shipping yet. Adding a product here creates its Walmart SKU and records the cost now,
          so it's ready when you ship. To ship, open a WFS batch and pull units in from its <b>Stock to send</b> panel.
        </p>
      )}

      {!sf && !holding && batch.status === 'draft' && <StockToSendPanel batchId={batchId} onMoved={() => reload(true)} />}

      {batch.status === 'draft' && <AddItemForm batchId={batchId} sf={sf} onAdded={() => reload(true)} />}

      <ItemsTable batchId={batchId} items={items} editable={batch.status === 'draft'} onChange={() => reload(true)} onError={setError} />

      {shipping && (
        <div className="space-y-4 mt-4">
          {(shipData?.shipments ?? []).map(s => (
            <ShipmentCard key={s.shipmentId} batchId={batchId} shipment={s} onChange={() => reloadShipments(true)} />
          ))}
        </div>
      )}
    </div>
  );
}

interface HoldingItem {
  id: number; sku: string; productName: string | null; imageUrl: string | null; walmartItemId: string | null;
  quantity: number; buyPriceCents: number; walmartSetupStatus: string | null;
}

/** Units waiting in "Walmart stock to send", movable into this shipment batch with their cost lot. */
function StockToSendPanel({ batchId, onMoved }: { batchId: string; onMoved: () => void }) {
  const { data, reload } = useQuery<{ id: number | null; items: HoldingItem[] }>('/api/list/walmart/holding');
  const [qty, setQty] = useState<Record<number, string>>({});
  const [moving, setMoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = data?.items ?? [];
  if (!data?.id || items.length === 0) return null;

  async function move(it: HoldingItem) {
    const n = parseInt(qty[it.id] ?? String(it.quantity), 10);
    setMoving(it.id);
    setError(null);
    try {
      await post(`/api/list/batches/${batchId}/wfs/move`, { itemId: it.id, quantity: n });
      setQty(q => { const next = { ...q }; delete next[it.id]; return next; });
      reload(true);
      onMoved();
    } catch (e) { setError((e as Error).message); }
    setMoving(null);
  }

  const units = items.reduce((s, i) => s + i.quantity, 0);
  return (
    <Panel title="Stock to send" caption={`${units} unit${units === 1 ? '' : 's'} waiting`} className="mb-4">
      <table className="w-full text-sm">
        <tbody>
          {items.map(it => (
            <tr key={it.id} className="border-t border-border-subtle first:border-t-0">
              <td className="px-4 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  {it.imageUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={it.imageUrl} alt="" className="w-8 h-8 object-contain rounded bg-white shrink-0" />
                    : <div className="w-8 h-8 rounded bg-bg-elevated shrink-0" />}
                  <div className="min-w-0">
                    <div className="truncate max-w-[260px] text-text-primary" title={it.productName || it.sku}>{it.productName || it.sku}</div>
                    <div className="text-xs text-text-tertiary">
                      <span className="font-mono">{it.sku}</span> · {formatCurrency(it.buyPriceCents)} each
                      {it.walmartSetupStatus === 'PENDING' && <span className="tag tag-attn ml-2">SKU SETTING UP</span>}
                      {it.walmartSetupStatus === 'FAILED' && <span className="tag ml-2 text-negative">SETUP FAILED</span>}
                    </div>
                  </div>
                </div>
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                <input type="number" min={1} max={it.quantity} value={qty[it.id] ?? String(it.quantity)}
                  onChange={e => setQty(q => ({ ...q, [it.id]: e.target.value }))}
                  className={`${inputCls} w-20 tabular-nums`} />
                <span className="text-xs text-text-tertiary ml-2">of {it.quantity}</span>
              </td>
              <td className="px-4 py-2 text-right w-40">
                <button onClick={() => move(it)} disabled={moving !== null} className={secondaryBtn}>
                  {moving === it.id ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add to batch
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="text-sm text-negative px-4 pb-3">{error}</p>}
    </Panel>
  );
}

function AddItemForm({ batchId, sf, onAdded }: { batchId: string; sf: boolean; onAdded: () => void }) {
  const [query, setQuery] = useState('');
  const [qty, setQty] = useState('1');
  const [buy, setBuy] = useState('');
  const [supplier, setSupplier] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sendQty, setSendQty] = useState(true);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [prompt, setPrompt] = useState<SetupPrompt | null>(null);

  async function add(setup?: Record<string, unknown>, newPurchase = false) {
    setAdding(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/list/batches/${batchId}/wfs/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, quantity: qty, buyPrice: buy, supplier: supplier || undefined, purchaseDate, sendQty, setup, newPurchase }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.status === 409 && r.inHolding) {
        setAdding(false);
        if (confirm(`${r.error}\n\nOK = these ${qty} are a NEW purchase (records another cost lot).\nCancel = I'll move the waiting units in instead.`)) return add(setup, true);
        setMessage({ ok: false, text: `Use the Stock to send panel above to move the ${r.inHolding.units} waiting unit${r.inHolding.units === 1 ? '' : 's'} of ${r.inHolding.sku} into this batch.` });
        return;
      } else if (r.batteryConflict && setup) {
        setAdding(false);
        if (confirm(`${r.error}\n\nOK = submit "Does Not Contain a Battery" anyway (your call — a wrong battery declaration can get units refused or charged at the FC).\nCancel = go back and choose the battery type.`)) {
          return add({ ...setup, overrideBatteryEvidence: true }, newPurchase);
        }
        setMessage({ ok: false, text: r.error });
        return;
      } else if (res.status === 409 && r.needsSetup) {
        setPrompt({ message: r.error, product: r.product, form: r.form });
      } else if (!res.ok) {
        throw new Error(r.problems?.length ? `Walmart would reject this: ${r.problems.join('; ')}` : r.error || `Request failed (${res.status})`);
      } else {
        const what = r.kind === 'WFS_NEW' ? `creating ${r.sku} on WFS`
          : r.kind === 'WFS_CONVERT' ? `your SKU ${r.sku} is being moved to WFS`
            : r.kind === 'SF_NEW' ? `creating the offer ${r.sku}` : `as ${r.sku}`;
        const cost = r.costFrom
          ? ` at ${formatCurrency(r.costFrom.buyPriceCents)} each (your last cost${r.costFrom.supplier ? `, ${r.costFrom.supplier}` : ''}, ${r.costFrom.datePurchased.slice(0, 10)}; edit it in the row if it changed)`
          : '';
        setMessage({ ok: true, text: `Added ${qty} × ${r.product.title}${cost} — ${what}${r.note ? ` — ${r.note}` : ''}` });
        setPrompt(null);
        setQuery('');
        setQty('1');
        setBuy('');
        onAdded();
      }
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    setAdding(false);
  }

  return (
    <Panel title="Add product" className="mb-4" bodyClassName="p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[260px]">
          <span className="text-xs text-text-tertiary label-caps">Walmart link, item ID or UPC</span>
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setPrompt(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !adding && !prompt) add(); }}
            autoFocus
            placeholder="https://www.walmart.com/ip/… or 1339239849 or 045496597818"
            className={`${inputCls} w-full mt-1`}
          />
        </label>
        <label className="w-20">
          <span className="text-xs text-text-tertiary label-caps">Qty</span>
          <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !adding && !prompt) add(); }} className={`${inputCls} w-full mt-1 tabular-nums`} />
        </label>
        <label className="w-28">
          <span className="text-xs text-text-tertiary label-caps">Buy price $</span>
          <input type="number" min={0} step="0.01" value={buy} onChange={e => setBuy(e.target.value)} placeholder="last cost"
            title="Leave blank on a restock to use this SKU's last cost. New products need a buy price."
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && !adding && !prompt) add(); }}
            className={`${inputCls} w-full mt-1 tabular-nums`} />
        </label>
        <label className="w-40">
          <span className="text-xs text-text-tertiary label-caps">Supplier</span>
          <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="last supplier" className={`${inputCls} w-full mt-1`} />
        </label>
        <label className="w-40">
          <span className="text-xs text-text-tertiary label-caps">Bought on</span>
          <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} className={`${inputCls} w-full mt-1`} />
        </label>
        {sf && (
          <label className="flex items-center gap-2 h-9 text-sm" title="On: Publish sets the Walmart quantity to this SKU's stock in FlipLedger. Off: FlipLedger never changes it.">
            <input type="checkbox" checked={sendQty} onChange={e => setSendQty(e.target.checked)} /> Qty → Walmart
          </label>
        )}
        {!prompt && (
          <button onClick={() => add()} disabled={adding || !query.trim()} className={primaryBtn}>
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
          </button>
        )}
      </div>
      {adding && !prompt && <p className="text-xs text-text-tertiary mt-2">Looking it up on Walmart (can take a few seconds)…</p>}
      {prompt && <SetupForm prompt={prompt} busy={adding} onCancel={() => setPrompt(null)} onSubmit={setup => add(setup)} />}
      {message && <p className={`text-sm mt-2 whitespace-pre-line ${message.ok ? 'text-positive' : 'text-negative'}`}>{message.text}</p>}
    </Panel>
  );
}

const YES_NO = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] as const;
const SOURCE_LABEL: Record<string, string> = { walmart: "from Walmart's page", amazon: 'from Amazon', default: 'default', remembered: 'your last answer', ai: 'suggested by Claude — check it' };

/** One spec field, edited in the shape its schema wants. */
function FieldInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.kind) {
    case 'longtext':
      return <textarea value={String(value ?? '')} onChange={e => onChange(e.target.value)} rows={3} className={`${inputCls} w-full h-auto py-2`} />;
    case 'list':
      return (
        <textarea value={Array.isArray(value) ? value.join('\n') : String(value ?? '')} onChange={e => onChange(e.target.value.split('\n'))}
          rows={Math.min(8, Math.max(2, Array.isArray(value) ? value.length : 2))} placeholder="One per line" className={`${inputCls} w-full h-auto py-2`} />
      );
    case 'enum':
      return (
        <select value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={`${inputCls} w-full`}>
          <option value="">Choose…</option>
          {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'multi': {
      const sel = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {field.options?.map(o => (
            <label key={o} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={sel.has(o)} onChange={e => {
                const next = new Set(sel);
                if (e.target.checked) next.add(o); else next.delete(o);
                onChange([...next]);
              }} /> {o}
            </label>
          ))}
        </div>
      );
    }
    case 'integer': case 'number':
      return <input type="number" step={field.kind === 'integer' ? 1 : 'any'} value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={`${inputCls} w-40 tabular-nums`} />;
    case 'measure': {
      const m = (value ?? {}) as { measure?: unknown; unit?: string };
      return (
        <div className="flex gap-2">
          <input type="number" step="any" value={String(m.measure ?? '')} onChange={e => onChange({ ...m, measure: e.target.value })} className={`${inputCls} w-28 tabular-nums`} />
          <select value={m.unit ?? ''} onChange={e => onChange({ ...m, unit: e.target.value })} className={`${inputCls} w-32`}>
            <option value="">unit…</option>
            {field.units?.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      );
    }
    default:
      return <input value={String(value ?? '')} onChange={e => onChange(e.target.value)} className={`${inputCls} w-full`} />;
  }
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.filter(x => String(x).trim()).length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && (!(v as { measure?: unknown }).measure || !(v as { unit?: unknown }).unit));

/** Everything Walmart needs to create (or switch) the SKU, prefilled where FlipLedger knows it. */
function SetupForm({ prompt, busy, onCancel, onSubmit }: {
  prompt: SetupPrompt; busy: boolean; onCancel: () => void; onSubmit: (setup: Record<string, unknown>) => void;
}) {
  const d = prompt.form;
  const wfs = d.kind !== 'SF_NEW';
  const [sku, setSku] = useState(d.sku);
  const [price, setPrice] = useState(d.priceDollars?.toFixed(2) ?? '');
  const [shipWeight, setShipWeight] = useState(d.shippingWeightLb?.toString() ?? '');
  const [unit, setUnit] = useState({
    lengthIn: d.unit?.lengthIn?.toString() ?? '', widthIn: d.unit?.widthIn?.toString() ?? '',
    heightIn: d.unit?.heightIn?.toString() ?? '', weightLb: d.unit?.weightLb?.toString() ?? '',
  });
  const [country, setCountry] = useState(d.countryOfOrigin);
  const [battery, setBattery] = useState(d.batteryType);
  const [batterySize, setBatterySize] = useState(d.batterySize ?? '');
  const [electronics, setElectronics] = useState<'yes' | 'no'>(d.electronics ? 'yes' : 'no');
  const [chemical, setChemical] = useState<'yes' | 'no'>('no');
  const [aerosol, setAerosol] = useState<'yes' | 'no'>('no');
  const [pesticide, setPesticide] = useState<'yes' | 'no'>('no');
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(d.fields.map(f => [f.key, f.value])));
  // Fields FlipLedger couldn't fill: shown first, highlighted, and remembered for next time.
  const asked = d.fields.filter(f => f.source == null || f.source === 'remembered' || f.source === 'ai').map(f => f.key);

  const hasBattery = !!battery && battery !== 'Does Not Contain a Battery';
  const lithium = /Lithium/.test(battery);
  const docs = lithium || chemical === 'yes' || aerosol === 'yes' || pesticide === 'yes';
  const missing = d.fields.filter(f => f.required && isEmpty(values[f.key])).map(f => f.title);
  const coreDone = !!sku && Number(price) > 0 && (wfs
    ? Object.values(unit).every(v => Number(v) > 0) && !!country && !!battery && (!hasBattery || !!batterySize)
    : Number(shipWeight) > 0);
  const blocked = d.unsupported.length > 0 || (wfs && docs);
  const review = d.fields.filter(f => f.source == null || f.source === 'ai');
  const filled = d.fields.filter(f => !(f.source == null || f.source === 'ai'));

  return (
    <div className="mt-4 border-t border-border-subtle pt-4 space-y-4">
      <div className="flex items-start gap-3">
        {prompt.product.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={prompt.product.imageUrl} alt="" className="w-12 h-12 object-contain rounded bg-white shrink-0" />
        )}
        <div className="text-sm">
          <div className="text-text-primary font-semibold">{prompt.product.title}</div>
          <div className="text-text-tertiary">Item {prompt.product.itemId} · UPC {prompt.product.upc} · {d.productType}</div>
          <div className="attn-banner mt-2 text-sm">{prompt.message}</div>
        </div>
      </div>

      {d.unsupported.length > 0 && (
        <p className="text-sm text-negative">Walmart also requires {d.unsupported.join(', ')} for {d.productType}, which FlipLedger can't fill in yet. Set this item up in Seller Center.</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="w-64">
          <span className="text-xs text-text-tertiary label-caps">Walmart SKU</span>
          <input value={sku} onChange={e => setSku(e.target.value)} disabled={d.skuLocked} className={`${inputCls} w-full mt-1 font-mono`} />
        </label>
        <label className="w-32">
          <span className="text-xs text-text-tertiary label-caps">Selling price $</span>
          <input type="number" min={0} step="0.01" value={price} onChange={e => setPrice(e.target.value)} className={`${inputCls} w-full mt-1 tabular-nums`} />
        </label>
        {!wfs && (
          <label className="w-32">
            <span className="text-xs text-text-tertiary label-caps">Ship weight lb</span>
            <input type="number" min={0} step="0.01" value={shipWeight} onChange={e => setShipWeight(e.target.value)} className={`${inputCls} w-full mt-1 tabular-nums`} />
          </label>
        )}
      </div>
      {prompt.product.priceCents ? <p className="text-xs text-text-tertiary -mt-2">Walmart shows {formatCurrency(prompt.product.priceCents)} on this item right now.</p> : null}

      {wfs && (
        <>
          <div>
            <span className="text-xs text-text-tertiary label-caps">One unit in its box (L × W × H in, lb)</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {(['lengthIn', 'widthIn', 'heightIn', 'weightLb'] as const).map(k => (
                <input key={k} type="number" min={0} step="0.01" value={unit[k]} placeholder={k === 'lengthIn' ? 'L' : k === 'widthIn' ? 'W' : k === 'heightIn' ? 'H' : 'lb'}
                  onChange={e => setUnit(u => ({ ...u, [k]: e.target.value }))} className={`${inputCls} w-24 tabular-nums`} />
              ))}
            </div>
            {d.unit && <p className="text-xs text-text-tertiary mt-1">From Amazon's catalog.</p>}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="w-64">
              <span className="text-xs text-text-tertiary label-caps">Country of origin</span>
              <select value={country} onChange={e => setCountry(e.target.value)} className={`${inputCls} w-full mt-1`}>
                <option value="">Choose…</option>
                {d.countries.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="w-64">
              <span className="text-xs text-text-tertiary label-caps">Battery</span>
              <select value={battery} onChange={e => setBattery(e.target.value)} className={`${inputCls} w-full mt-1`}>
                <option value="">Choose…</option>
                {d.batteryTypes.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            {hasBattery && !lithium && (
              <label className="w-40">
                <span className="text-xs text-text-tertiary label-caps">Battery size</span>
                <select value={batterySize} onChange={e => setBatterySize(e.target.value)} className={`${inputCls} w-full mt-1`}>
                  <option value="">Choose…</option>
                  {d.batterySizes.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            )}
          </div>
          {d.batteryHint && <p className="text-xs text-text-tertiary -mt-2">{d.batteryHint}</p>}

          <div className="flex flex-wrap gap-6 text-sm">
            {([['Has electronic parts', electronics, setElectronics], ['Chemical', chemical, setChemical], ['Aerosol', aerosol, setAerosol], ['Pesticide', pesticide, setPesticide]] as const).map(([label, v, set]) => (
              <div key={label}><span className="text-xs text-text-tertiary label-caps block mb-1">{label}</span>
                <Seg ariaLabel={label} value={v} onChange={set as (x: 'yes' | 'no') => void} options={[...YES_NO]} /></div>
            ))}
          </div>
          {docs && <p className="text-sm text-negative">Walmart needs extra documents for {lithium ? 'lithium batteries' : 'chemicals, aerosols and pesticides'} — set this one up in Seller Center.</p>}

          <div>
            <div className="label-caps text-xs text-text-tertiary mb-2">Walmart product details ({d.productType})</div>
            {d.aiNote && <p className="text-xs text-text-tertiary mb-2">{d.aiNote}</p>}
            {/* Only what needs a look: empty fields and Claude's suggestions. The rest is folded away. */}
            <div className="space-y-3">
              {review.map(f => (
                <div key={f.key} className="tag-attn rounded-md p-2 -mx-2">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-sm text-text-primary">{f.title}{f.required ? '' : ' (optional)'}</span>
                    <span className="text-xs text-text-tertiary">{f.source ? SOURCE_LABEL[f.source] : 'FlipLedger couldn’t find this — please fill it in'}</span>
                  </div>
                  <FieldInput field={f} value={values[f.key]} onChange={v => setValues(x => ({ ...x, [f.key]: v }))} />
                </div>
              ))}
            </div>
            {filled.length > 0 && (
              <details className="mt-3 group">
                <summary className="text-sm text-text-secondary cursor-pointer select-none">
                  {`${filled.length} detail${filled.length === 1 ? '' : 's'} filled automatically (Walmart's page, your past answers, defaults) — show to edit`}
                </summary>
                <div className="space-y-3 mt-3">
                  {filled.map(f => (
                    <div key={f.key}>
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-sm text-text-primary">{f.title}</span>
                        <span className="text-xs text-text-tertiary">{f.source ? SOURCE_LABEL[f.source] : ''}</span>
                      </div>
                      <FieldInput field={f} value={values[f.key]} onChange={v => setValues(x => ({ ...x, [f.key]: v }))} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </>
      )}

      {d.kind === 'WFS_CONVERT' && (
        <p className="text-sm text-text-secondary">
          You already sell this on Walmart as <span className="font-mono">{d.sku}</span>, shipped by you. Walmart allows one SKU per product, so adding it here
          moves that SKU to WFS: once Walmart has the stock, Walmart ships its orders instead of you.
        </p>
      )}
      {(() => {
        // Every reason the button is disabled, right next to it.
        const why: string[] = [];
        if (d.unsupported.length) why.push(`Walmart also requires ${d.unsupported.join(', ')}, which FlipLedger can't fill yet — use Seller Center`);
        if (wfs && lithium) why.push("this item has a lithium battery — Walmart needs battery specs FlipLedger doesn't collect yet, so use \"Convert to WFS\" in Seller Center, then add it here");
        else if (wfs && docs) why.push('chemicals, aerosols and pesticides need a safety data sheet — use Seller Center');
        if (!sku) why.push('enter a SKU');
        if (!(Number(price) > 0)) why.push('enter the selling price');
        if (wfs) {
          if (!Object.values(unit).every(v => Number(v) > 0)) why.push("enter the unit's box size and weight");
          if (!country) why.push('choose the country of origin');
          if (!battery) why.push('choose the battery type');
          else if (hasBattery && !lithium && !batterySize) why.push('choose the battery size');
        } else if (!(Number(shipWeight) > 0)) why.push('enter the ship weight');
        if (missing.length) why.push(`fill in ${missing.join(', ')}`);
        return why.length ? <p className="text-sm text-negative">Can&apos;t add yet: {why.join('; ')}.</p> : null;
      })()}
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({
            sku, priceDollars: price, shippingWeightLb: wfs ? unit.weightLb : shipWeight,
            ...(wfs ? {
              unit, countryOfOrigin: country, batteryType: battery, batterySize: hasBattery ? batterySize : undefined,
              electronics: electronics === 'yes', isChemical: chemical === 'yes', isAerosol: aerosol === 'yes', isPesticide: pesticide === 'yes',
              visible: values, silent: d.silent, askedKeys: asked,
            } : {}),
          })}
          disabled={busy || blocked || !coreDone || missing.length > 0}
          className={primaryBtn}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          {d.kind === 'WFS_CONVERT' ? 'Add (moves SKU to WFS)' : d.kind === 'WFS_NEW' ? 'Create SKU & add' : 'Create offer & add'}
        </button>
        <button onClick={onCancel} disabled={busy} className={secondaryBtn}>Cancel</button>
      </div>
      <p className="text-xs text-text-tertiary">
        FlipLedger checks this against Walmart&apos;s own rules before sending. Walmart usually takes minutes, sometimes up to a day for a review. The cost lot is recorded now.
      </p>
    </div>
  );
}

function ItemsTable({ batchId, items, editable, onChange, onError }: {
  batchId: string; items: WfsItem[]; editable: boolean; onChange: () => void; onError: (msg: string) => void;
}) {
  async function patch(item: WfsItem, body: Record<string, unknown>) {
    try {
      const r = await call(`/api/list/batches/${batchId}/items/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ledgerWarning) onError(r.ledgerWarning);
      onChange();
    } catch (e) { onError((e as Error).message); }
  }
  async function remove(item: WfsItem) {
    if (!confirm(`Remove ${item.sku} from this batch? Its cost lot is removed too.`)) return;
    try { await call(`/api/list/batches/${batchId}/items/${item.id}`, { method: 'DELETE' }); onChange(); }
    catch (e) { onError((e as Error).message); }
  }

  if (items.length === 0) {
    return <Panel title="Items" bodyClassName="p-6 text-sm text-text-tertiary">No products yet. Add one above.</Panel>;
  }
  return (
    <Panel title="Items" caption={`${items.length} line${items.length === 1 ? '' : 's'}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">Product</th>
              <th className="px-4 py-2 text-left">SKU</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Buy</th>
              <th className="px-4 py-2 text-right">Cost</th>
              <th className="px-4 py-2 text-right">Walmart price</th>
              <th className="px-4 py-2 text-right">Fees / unit</th>
              <th className="px-4 py-2 text-right">Est. profit</th>
              {editable && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} className="border-t border-border-subtle">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-3 min-w-0">
                    {it.imageUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={it.imageUrl} alt="" className="w-9 h-9 object-contain rounded bg-white shrink-0" />
                      : <div className="w-9 h-9 rounded bg-bg-elevated shrink-0" />}
                    <div className="min-w-0">
                      <div className="truncate max-w-[260px] text-text-primary" title={it.productName || it.sku}>{it.productName || it.sku}</div>
                      {it.walmartItemId && (
                        <a href={`https://www.walmart.com/ip/${it.walmartItemId}`} target="_blank" rel="noreferrer" className="text-xs text-link inline-flex items-center gap-1">
                          Item {it.walmartItemId} <ExternalLink size={10} />
                        </a>
                      )}
                      <SetupStatus batchId={batchId} item={it} onChange={onChange} onError={onError} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{it.sku}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {editable ? (
                    <input
                      type="number" min={1} defaultValue={it.quantity}
                      onBlur={e => { const n = parseInt(e.target.value, 10); if (n >= 1 && n !== it.quantity) patch(it, { quantity: n }); }}
                      className={`${inputCls} w-20 text-right h-8`}
                    />
                  ) : it.quantity}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {editable ? (
                    <input
                      type="number" min={0} step="0.01" defaultValue={(it.buyPriceCents / 100).toFixed(2)}
                      onBlur={e => { const v = Number(e.target.value); if (v >= 0 && Math.round(v * 100) !== it.buyPriceCents) patch(it, { buyPrice: v }); }}
                      className={`${inputCls} w-24 text-right h-8`}
                    />
                  ) : formatCurrency(it.buyPriceCents)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(it.quantity * it.buyPriceCents)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <WalmartPrice batchId={batchId} item={it} onChange={onChange} onError={onError} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-text-secondary" title={feeTooltip(it)}>
                  {it.listPriceCents > 0 && it.feeEstimate ? formatCurrency(unitFees(it)) : '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {(() => {
                    const p = lineProfit(it);
                    if (p === null) return <span className="text-text-tertiary">—</span>;
                    const cost = it.quantity * it.buyPriceCents;
                    return (
                      <div>
                        <div className={p >= 0 ? 'text-positive' : 'text-negative'}>{formatCurrency(p)}</div>
                        {cost > 0 && <div className="text-[11px] text-text-tertiary">{((p / cost) * 100).toFixed(0)}% ROI</div>}
                      </div>
                    );
                  })()}
                </td>
                {editable && (
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => remove(it)} className="p-1.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-negative" title="Remove">
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const emptyBox = (): Box => ({ lengthIn: '', widthIn: '', heightIn: '', weightLb: '', loadType: 'SINGLE SKU' });

function ShipmentCard({ batchId, shipment, onChange }: { batchId: string; shipment: Shipment; onChange: () => void }) {
  const base = `/api/list/batches/${batchId}/wfs/shipments/${shipment.shipmentId}`;
  const [boxes, setBoxes] = useState<Box[]>(shipment.boxes.length ? shipment.boxes : [emptyBox()]);
  const [mode, setMode] = useState<'walmart' | 'own'>(shipment.status === 'TRACKING_SENT' ? 'own' : 'walmart');
  const [carrier, setCarrier] = useState('UPS');
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const booked = shipment.status === 'BOOKED';
  const trackingSent = shipment.status === 'TRACKING_SENT';
  const boxesSaved = shipment.boxes.length > 0 && JSON.stringify(shipment.boxes) === JSON.stringify(boxes.map(normalizeBox));
  const units = shipment.items.reduce((s, i) => s + i.quantity, 0);
  const to = shipment.shipTo;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy(null);
  }

  const saveBoxes = () => run('boxes', async () => { await post(base, { action: 'boxes', boxes: boxes.map(normalizeBox) }); onChange(); });
  const getQuote = () => run('quote', async () => { await post(base, { action: 'quote' }); onChange(); });
  const book = (q: Quote) => {
    if (!confirm(`Book ${q.carrierName} through Walmart for ${formatCurrency(q.netChargeCents)}?\n\nWalmart charges this to your account. You can cancel the booking within 24 hours.`)) return;
    run('book', async () => {
      const r = await post(base, { action: 'book', quoteId: q.quoteId, chargeCents: q.netChargeCents });
      if (r.note) setNote(r.note);
      onChange();
    });
  };
  const cancelBooking = () => {
    if (!confirm('Cancel the FedEx booking? Walmart only allows this within 24 hours of booking.')) return;
    run('cancel-booking', async () => { await post(base, { action: 'cancel-booking' }); onChange(); });
  };
  const sendTracking = () => run('tracking', async () => {
    await post(base, { action: 'tracking', carrierName: carrier, trackingNumbers: tracking });
    onChange();
  });
  const label = (kind: 'receiving' | 'carrier', action: 'print' | 'download') => {
    const url = `${base}?label=${kind}&action=${action}`;
    if (action === 'download') { window.open(url, '_blank'); return; }
    run(`${kind}-print`, async () => {
      const r = await call(url);
      setNote(`Sent to ${r.printer}.`);
    });
  };

  return (
    <Panel
      title={<span>Shipment <span className="font-mono">{shipment.shipmentId}</span> → {to?.fcName || shipment.fcName || to?.city}</span>}
      caption={shipment.walmartStatus ? shipment.walmartStatus.replace(/_/g, ' ') : 'Created'}
      bodyClassName="p-4 space-y-5"
    >
      <div className="text-sm text-text-secondary">
        {to && <div>{to.addressLine1}, {to.city}, {to.stateCode} {to.postalCode}</div>}
        <div className="mt-1">
          {units} units: {shipment.items.map(i => `${i.sku} × ${i.quantity}`).join(' · ')}
          {shipment.expectedDeliveryDate && <> · Walmart expects it by {new Date(shipment.expectedDeliveryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}
        </div>
      </div>

      {/* Boxes */}
      <div>
        <div className="label-caps text-xs text-text-tertiary mb-2">Boxes</div>
        <div className="space-y-2">
          {boxes.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-12 text-text-tertiary">Box {i + 1}</span>
              {(['lengthIn', 'widthIn', 'heightIn'] as const).map(k => (
                <input
                  key={k} type="number" min={0} step="0.1" value={b[k]} disabled={booked}
                  placeholder={k === 'lengthIn' ? 'L in' : k === 'widthIn' ? 'W in' : 'H in'}
                  onChange={e => setBoxes(bs => bs.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))}
                  className={`${inputCls} w-20 tabular-nums`}
                />
              ))}
              <input
                type="number" min={0} step="0.1" value={b.weightLb} disabled={booked} placeholder="lb"
                onChange={e => setBoxes(bs => bs.map((x, j) => j === i ? { ...x, weightLb: e.target.value } : x))}
                className={`${inputCls} w-20 tabular-nums`}
              />
              <Seg<LoadType>
                ariaLabel="Box contents"
                value={b.loadType}
                onChange={v => !booked && setBoxes(bs => bs.map((x, j) => j === i ? { ...x, loadType: v } : x))}
                options={[{ value: 'SINGLE SKU', label: 'One SKU' }, { value: 'MIXED SKUS', label: 'Mixed' }]}
              />
              {!booked && boxes.length > 1 && (
                <button onClick={() => setBoxes(bs => bs.filter((_, j) => j !== i))} className="p-1.5 text-text-tertiary hover:text-negative" title="Remove box">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {!booked && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => setBoxes(bs => [...bs, { ...(bs[bs.length - 1] ?? emptyBox()) }])} className={secondaryBtn}>
              <Plus size={14} /> Add box
            </button>
            <button onClick={saveBoxes} disabled={busy !== null || boxesSaved} className={secondaryBtn}>
              {busy === 'boxes' && <Loader2 size={14} className="animate-spin" />} {boxesSaved ? 'Boxes saved' : 'Save boxes'}
            </button>
          </div>
        )}
      </div>

      {/* WFS box labels */}
      <div>
        <div className="label-caps text-xs text-text-tertiary mb-2">WFS box labels (one per box)</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => label('receiving', 'print')} disabled={busy !== null || !boxesSaved} className={secondaryBtn}>
            {busy === 'receiving-print' ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Print box labels
          </button>
          <button onClick={() => label('receiving', 'download')} disabled={!boxesSaved} className={secondaryBtn}><Download size={14} /> PDF</button>
          {!boxesSaved && <span className="text-xs text-text-tertiary self-center">Save the boxes first.</span>}
        </div>
      </div>

      {/* Carrier */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <span className="label-caps text-xs text-text-tertiary">Carrier</span>
          {!booked && !trackingSent && (
            <Seg<'walmart' | 'own'>
              ariaLabel="Carrier"
              value={mode}
              onChange={setMode}
              options={[{ value: 'walmart', label: 'Walmart FedEx' }, { value: 'own', label: 'Own carrier' }]}
            />
          )}
        </div>

        {booked ? (
          <div className="space-y-2 text-sm">
            <div>
              <span className="tag text-positive">Booked</span> {shipment.carrierName} · {formatCurrency(shipment.bookedChargeCents ?? 0)}
              {shipment.bookedAt && <span className="text-text-tertiary"> · {new Date(shipment.bookedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => label('carrier', 'print')} disabled={busy !== null} className={primaryBtn}>
                {busy === 'carrier-print' ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Print FedEx labels
              </button>
              <button onClick={() => label('carrier', 'download')} className={secondaryBtn}><Download size={14} /> PDF</button>
              <button onClick={cancelBooking} disabled={busy !== null} className={secondaryBtn}>
                {busy === 'cancel-booking' && <Loader2 size={14} className="animate-spin" />} Cancel booking
              </button>
            </div>
          </div>
        ) : trackingSent ? (
          <div className="text-sm">
            <span className="tag text-positive">Tracking sent</span> {shipment.carrierName}: <span className="font-mono">{shipment.tracking.join(', ')}</span>
          </div>
        ) : mode === 'walmart' ? (
          <div className="space-y-2">
            <button onClick={getQuote} disabled={busy !== null || !boxesSaved} className={secondaryBtn}>
              {busy === 'quote' ? <Loader2 size={14} className="animate-spin" /> : <Truck size={14} />} {shipment.quotes.length ? 'Get a new rate' : 'Get FedEx rate'}
            </button>
            {!boxesSaved && <p className="text-xs text-text-tertiary">Save the boxes first — the rate is based on them.</p>}
            {shipment.quotes.map(q => (
              <div key={q.quoteId} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold">{q.carrierName}</span>
                <span className="tabular-nums">{formatCurrency(q.netChargeCents)}</span>
                {q.estimatedDelivery && <span className="text-text-tertiary">arrives ~{new Date(q.estimatedDelivery).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                <button onClick={() => book(q)} disabled={busy !== null} className={primaryBtn}>
                  {busy === 'book' && <Loader2 size={14} className="animate-spin" />} Book {formatCurrency(q.netChargeCents)}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-32">
              <span className="text-xs text-text-tertiary label-caps">Carrier</span>
              <input value={carrier} onChange={e => setCarrier(e.target.value)} className={`${inputCls} w-full mt-1`} />
            </label>
            <label className="flex-1 min-w-[240px]">
              <span className="text-xs text-text-tertiary label-caps">Tracking numbers (one per box)</span>
              <input value={tracking} onChange={e => setTracking(e.target.value)} placeholder="1Z…, 1Z…" className={`${inputCls} w-full mt-1 font-mono`} />
            </label>
            <button onClick={sendTracking} disabled={busy !== null || !tracking.trim()} className={primaryBtn}>
              {busy === 'tracking' && <Loader2 size={14} className="animate-spin" />} Send tracking to Walmart
            </button>
          </div>
        )}
      </div>

      {(error || shipment.error) && <p className="text-sm text-negative">{error || shipment.error}</p>}
      {note && <p className="text-sm text-text-secondary">{note}</p>}
    </Panel>
  );
}

function normalizeBox(b: Box) {
  return {
    lengthIn: Number(b.lengthIn), widthIn: Number(b.widthIn), heightIn: Number(b.heightIn),
    weightLb: Number(b.weightLb), loadType: b.loadType,
  };
}

const REVIEW_AFTER_MIN = 15;
const formatAge = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);

function SetupStatus({ batchId, item, onChange, onError }: {
  batchId: string; item: WfsItem; onChange: () => void; onError: (msg: string) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const st = item.walmartSetupStatus;
  if (!st) return null;
  if (st === 'READY') return <div><span className="tag text-[9px] text-positive">SET UP ON WALMART</span></div>;
  if (st === 'FAILED') {
    const retry = async () => {
      setRetrying(true);
      try { await post(`/api/list/batches/${batchId}/wfs/setup`, { retryItemId: item.id }); onChange(); }
      catch (e) { onError((e as Error).message); }
      setRetrying(false);
    };
    return (
      <div className="mt-1 space-y-1">
        <span className="tag text-[9px] text-negative">WALMART SETUP FAILED</span>
        <p className="text-xs text-negative max-w-[420px] whitespace-normal">{item.walmartSetup?.error}</p>
        <button onClick={retry} disabled={retrying} className="text-xs text-link">{retrying ? 'Retrying…' : 'Retry'}</button>
      </div>
    );
  }
  // Walmart's feed API reports a held item only as INPROGRESS (no note); Seller
  // Center calls it "item under review". Most setups finish in a few minutes, so
  // one still pending after REVIEW_AFTER_MIN is treated as under review.
  const submittedAt = item.walmartSetup?.updatedAt ? Date.parse(item.walmartSetup.updatedAt) : NaN;
  const minutes = Number.isFinite(submittedAt) ? (Date.now() - submittedAt) / 60000 : 0;
  const underReview = minutes >= REVIEW_AFTER_MIN;
  return (
    <div className="mt-1">
      <span className="tag-attn tag text-[9px]">{underReview ? 'UNDER REVIEW AT WALMART' : 'SETTING UP ON WALMART'}</span>
      {item.walmartSetup?.pending
        ? <p className="text-xs text-text-tertiary max-w-[420px] whitespace-normal">{item.walmartSetup.pending}</p>
        : underReview && (
          <p className="text-xs text-text-tertiary max-w-[420px] whitespace-normal">
            Submitted {formatAge(minutes)} ago. Walmart is reviewing this item before it goes live, which can take up to 24 hours. Nothing to do; this updates on its own.
          </p>
        )}
    </div>
  );
}

/** The SKU's Walmart selling price, editable in any batch status (saved to Walmart on Enter / leaving the box). */
function WalmartPrice({ batchId, item, onChange, onError }: {
  batchId: string; item: WfsItem; onChange: () => void; onError: (msg: string) => void;
}) {
  const [value, setValue] = useState((item.listPriceCents / 100).toFixed(2));
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const settingUp = item.walmartSetupStatus === 'PENDING' || item.walmartSetupStatus === 'FAILED';
  const save = async () => {
    const cents = Math.round(Number(value) * 100);
    if (!(cents > 0) || cents === item.listPriceCents) return;
    setState('saving');
    try {
      await post(`/api/list/batches/${batchId}/wfs/price`, { itemId: item.id, priceDollars: Number(value) });
      setState('saved');
      onChange();
    } catch (e) {
      setState('idle');
      setValue((item.listPriceCents / 100).toFixed(2));
      onError((e as Error).message);
    }
  };
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <input
        type="number" min={0} step="0.01" value={value} disabled={settingUp || state === 'saving'}
        title={settingUp ? 'Change the price once Walmart has set the SKU up' : 'Walmart selling price — saved to Walmart when you leave the box'}
        onChange={e => { setValue(e.target.value); setState('idle'); }}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`${inputCls} w-24 text-right h-8`}
      />
      {state === 'saving' && <span className="text-[10px] text-text-tertiary">Updating Walmart…</span>}
      {state === 'saved' && <span className="text-[10px] text-positive">Updated on Walmart</span>}
    </div>
  );
}
