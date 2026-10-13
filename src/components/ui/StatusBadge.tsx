import { ReactNode } from 'react';

export type StatusBadgeTone =
  | 'positive'
  | 'warning'
  | 'negative'
  | 'info'
  | 'neutral'
  | 'amazon'
  | 'walmart'
  | 'ebay'
  | 'paypal';

export type StatusBadgeSize = 'xs' | 'sm';

interface StatusBadgeProps {
  tone: StatusBadgeTone;
  size?: StatusBadgeSize;
  className?: string;
  children: ReactNode;
}

const TONE_CLASSES: Record<StatusBadgeTone, string> = {
  positive: 'tag text-positive',
  warning:  'tag text-warning',
  negative: 'tag text-negative',
  info:     'tag text-info',
  neutral:  'tag text-text-tertiary',
  amazon:   'mkt mkt-amazon',
  walmart:  'mkt mkt-walmart',
  ebay:     'mkt mkt-ebay',
  paypal:   'mkt mkt-paypal',
};

const SIZE_CLASSES: Record<StatusBadgeSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-[10.5px]',
};

export default function StatusBadge({
  tone,
  size = 'sm',
  className = '',
  children,
}: StatusBadgeProps) {
  return (
    <span
      className={`${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {children}
    </span>
  );
}
