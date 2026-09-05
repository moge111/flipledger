'use client';

import { formatCurrency } from '@/lib/formatters';
import { Package, Plus, CheckCircle2, Info } from 'lucide-react';

import { liveStateBadge } from '@/components/mfn/receive/helpers';
import { SearchResultCardProps } from '@/components/mfn/receive/types';
import { AsinLink, MskuLink } from '@/components/mfn/receive/widgets';

export function UpcChip({ upc }: { upc: string }) {
  return (
    <span
      className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-mono font-medium border bg-slate-900/60 text-text-tertiary border-border-subtle"
      title="UPC"
    >
      UPC {upc}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SearchResultCard
// ---------------------------------------------------------------------------

export function SearchResultCard({ result, inBatch, onAdd, onImageClick, onShowDetail }: SearchResultCardProps) {
  const displayCost = result.buy_price ?? result.parsed_cost_cents;
  const displayPrice = result.amazon_list_price_cents ?? result.parsed_list_price_cents ?? result.il_list_price_cents;

  return (
    <div className={`flex items-start gap-4 p-4 rounded-xl border transition-colors ${
      inBatch ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-slate-800 hover:bg-bg-hover'
    }`}>
      {result.image_url
        ? (
            <button
              type="button"
              onClick={onImageClick}
              className="shrink-0 rounded-lg overflow-hidden bg-white border border-border-subtle hover:ring-2 hover:ring-blue-500/40 transition-shadow"
              title="View larger"
            >
              <img src={result.image_url} alt="" className="w-24 h-24 object-contain block p-1.5" />
            </button>
          )
        : <div className="w-24 h-24 bg-slate-700/40 rounded-lg shrink-0 flex items-center justify-center"><Package size={26} className="text-text-tertiary/40" /></div>}

      <div className="min-w-0 flex-1">
        <div className="text-base text-text-primary font-medium leading-snug line-clamp-2" title={result.product_name ?? result.asin}>
          {result.product_name || result.asin}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <AsinLink asin={result.asin} className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline" />
          {liveStateBadge(result.amazon_status, result.amazon_qty)}
          {result.upc && <UpcChip upc={result.upc} />}
        </div>
        <div className="mt-1">
          <MskuLink sku={result.sku} className="font-mono text-[10px] text-text-tertiary/50 truncate block hover:text-blue-300 hover:underline" />
        </div>
        {(displayCost != null || displayPrice != null) && (
          <div className="flex items-center gap-4 mt-2">
            {displayCost != null && (
              <span className="text-sm text-text-secondary tabular-nums">
                <span className="text-[10px] text-text-tertiary uppercase tracking-wide mr-1">Cost</span>
                {formatCurrency(displayCost)}
              </span>
            )}
            {displayPrice != null && (
              <span className="text-sm text-text-secondary tabular-nums">
                <span className="text-[10px] text-text-tertiary uppercase tracking-wide mr-1">List</span>
                {formatCurrency(displayPrice)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onShowDetail}
          className="p-2 rounded-md text-text-tertiary/60 hover:text-blue-400 hover:bg-slate-800 transition-colors"
          title="View details"
        >
          <Info size={15} />
        </button>
        <button
          onClick={onAdd}
          disabled={inBatch}
          className={`h-9 px-3.5 rounded-md text-sm font-medium border transition-colors flex items-center gap-1.5 ${
            inBatch
              ? 'border-blue-500/30 text-blue-400/60 cursor-default'
              : 'border-blue-500/50 text-blue-400 hover:bg-blue-500/10'
          }`}
        >
          {inBatch ? <CheckCircle2 size={14} /> : <Plus size={14} />}
          {inBatch ? 'Added' : 'Add'}
        </button>
      </div>
    </div>
  );
}

// Derives display values for a saved/collapsed BatchItemCard row.
// Fallback priority: persisted DB field → draft field → null.
// Pure helper — no side effects, safe to call from any render context.
