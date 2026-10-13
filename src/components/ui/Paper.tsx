import type { ReactNode } from 'react';
import { formatCurrency } from '@/lib/formatters';

/*
 * Paper primitives. The look is a printed shipping label: a white panel with a
 * 1.5px ink outline and a hard 2px offset shadow, headed by a black "label bar"
 * in condensed caps. Styles live in globals.css (.panel, .panel-bar, .seg,
 * .hero-num, .stat-num); these wrappers just keep the markup consistent.
 */

interface PanelProps {
  title?: ReactNode;
  /** secondary caption on the right of the label bar (rendered at 70% opacity) */
  caption?: ReactNode;
  /** controls on the right of the label bar */
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export function Panel({ title, caption, actions, className = '', bodyClassName = '', children }: PanelProps) {
  return (
    <section className={`panel ${className}`}>
      {title !== undefined && (
        <div className="panel-bar">
          <span className="min-w-0 truncate">{title}</span>
          {(caption !== undefined || actions) && (
            <span className="flex items-center gap-3 shrink-0">
              {caption !== undefined && <span className="panel-bar-caption">{caption}</span>}
              {actions}
            </span>
          )}
        </div>
      )}
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </section>
  );
}

/** Money with the cents printed at half size, raised: $16,789.63 → $16,789 + small .63 */
export function Money({ cents, className = '', signed = false }: { cents: number; className?: string; signed?: boolean }) {
  const text = (signed && cents > 0 ? '+' : '') + formatCurrency(cents);
  const dot = text.lastIndexOf('.');
  if (dot < 0) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {text.slice(0, dot)}<span className="cents">{text.slice(dot)}</span>
    </span>
  );
}

interface SegOption<T extends string> { value: T; label: ReactNode; title?: string }

/** Segmented toggle: outlined label, the active option printed in solid ink. */
export function Seg<T extends string>({ options, value, onChange, ariaLabel, className = '' }: {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={`seg ${className}`} role="group" aria-label={ariaLabel}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-current={o.value === value ? 'true' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Status rail: three sequential stages. step 0/1/2; `failed` strikes it through. */
export function Rail({ step, label, failed = false, className = '' }: { step: 0 | 1 | 2; label: ReactNode; failed?: boolean; className?: string }) {
  return (
    <span className={`rail ${failed ? 'failed' : ''} ${className}`} data-step={failed ? undefined : step}>
      <span className="track"><b /><b /><b /></span>
      <span className="lbl">{label}</span>
    </span>
  );
}
