'use client';

import { formatPercent, formatNumber } from '@/lib/formatters';
import { calculatePercentChange } from '@/lib/calculations';
import { Money } from '@/components/ui/Paper';

interface StatCardProps {
  label: string;
  value: number;
  previousValue?: number;
  format: 'currency' | 'percent' | 'number';
  accentColor?: 'default' | 'positive' | 'negative' | 'amazon';
}

// Paper stat tile: a small label panel — condensed-caps label over an expanded heavy number.
// Profit/loss tiles print their number green/red; everything else stays ink.
export default function StatCard({ label, value, previousValue, format, accentColor = 'default' }: StatCardProps) {
  const change = previousValue !== undefined ? calculatePercentChange(value, previousValue) : null;

  const numberColor = {
    default: 'text-text-primary',
    positive: 'text-positive',
    negative: 'text-negative',
    amazon: 'text-text-primary',
  }[accentColor];

  return (
    <div className="panel px-4 py-3.5">
      <div className="label-caps text-text-tertiary mb-1.5">
        {label}
      </div>
      <div className={`stat-num text-[18px] sm:text-[24px] ${numberColor}`}>
        {format === 'currency'
          ? <Money cents={value} />
          : format === 'percent' ? formatPercent(value) : formatNumber(value)}
      </div>
      {change !== null && (
        <div className={`text-xs mt-1.5 tabular-nums font-semibold ${change >= 0 ? 'text-positive' : 'text-negative'}`}>
          {change >= 0 ? '+' : ''}{change.toFixed(1)}% <span className="font-normal text-text-tertiary">vs prev period</span>
        </div>
      )}
    </div>
  );
}
