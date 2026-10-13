'use client';

import DateRangePicker, { type DateRange } from './DateRangePicker';
import MarketplaceFilter from './MarketplaceFilter';
import { Seg } from './Paper';
import { Download } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  onExport?: () => void;
  marketplace?: string;
  onMarketplaceChange?: (marketplace: string) => void;
  dateBasis?: string;
  onDateBasisChange?: (basis: string) => void;
}

export default function PageHeader({ title, subtitle, dateRange, onDateRangeChange, onExport, marketplace, onMarketplaceChange, dateBasis, onDateBasisChange }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-6">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="text-sm text-text-tertiary mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onDateBasisChange && (
          <Seg
            ariaLabel="Date basis"
            value={dateBasis === 'purchase' ? 'purchase' : 'posted'}
            onChange={onDateBasisChange}
            options={[
              { value: 'posted', label: 'Cash' },
              { value: 'purchase', label: 'Accrual' },
            ]}
          />
        )}
        {onMarketplaceChange && (
          <MarketplaceFilter value={marketplace || 'all'} onChange={onMarketplaceChange} />
        )}
        <DateRangePicker value={dateRange} onChange={onDateRangeChange} />
        {onExport && (
          <button
            onClick={onExport}
            className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
          >
            <Download size={14} />
            Export
          </button>
        )}
      </div>
    </div>
  );
}
