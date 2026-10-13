'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { marketToday, addDays } from '@/lib/market-day';

export interface DateRange {
  preset: string;
  startDate: string;
  endDate: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

function getPresetDates(preset: string): { startDate: string; endDate: string } {
  // All presets resolve on the MARKETPLACE calendar (Pacific), because that is
  // the day Amazon and Walmart close their books on — midnight Pacific = 1 AM
  // Mountain. Resolving these against the browser's local date (or worse, the
  // UTC date, which is what this used to do) puts "Today" on the wrong day for
  // the entire evening. See src/lib/market-day.ts.
  const today = marketToday();               // YYYY-MM-DD, Pacific
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');

  switch (preset) {
    case 'today':
      return { startDate: today, endDate: today };
    case '7d':
      return { startDate: addDays(today, -7), endDate: today };
    case '30d':
      return { startDate: addDays(today, -30), endDate: today };
    case 'this-month':
      return { startDate: `${y}-${pad(m)}-01`, endDate: today };
    case 'last-month': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { startDate: `${ly}-${pad(lm)}-01`, endDate: addDays(`${y}-${pad(m)}-01`, -1) };
    }
    case 'this-quarter': {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return { startDate: `${y}-${pad(q)}-01`, endDate: today };
    }
    case 'last-quarter': {
      const cq = Math.floor((m - 1) / 3);
      const ly = cq === 0 ? y - 1 : y;
      const lq = cq === 0 ? 10 : (cq - 1) * 3 + 1;
      return { startDate: `${ly}-${pad(lq)}-01`, endDate: addDays(`${y}-${pad(cq * 3 + 1)}-01`, -1) };
    }
    case 'ytd':
      return { startDate: `${y}-01-01`, endDate: today };
    case 'last-year':
      return { startDate: `${y - 1}-01-01`, endDate: `${y - 1}-12-31` };
    default:
      return { startDate: addDays(today, -30), endDate: today };
  }
}

const presets = [
  { label: 'Today', value: 'today' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'This Month', value: 'this-month' },
  { label: 'Last Month', value: 'last-month' },
  { label: 'This Quarter', value: 'this-quarter' },
  { label: 'Last Quarter', value: 'last-quarter' },
  { label: 'Year to Date', value: 'ytd' },
  { label: 'Last Year', value: 'last-year' },
];

export function createDateRange(preset: string): DateRange {
  const { startDate, endDate } = getPresetDates(preset);
  return { preset, startDate, endDate };
}

export default function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const activeLabel = value.preset === 'custom'
    ? `${value.startDate} – ${value.endDate}`
    : presets.find(p => p.value === value.preset)?.label || 'Last 30 days';

  function handlePreset(preset: string) {
    const dates = getPresetDates(preset);
    onChange({ preset, ...dates });
    setOpen(false);
    setShowCustom(false);
  }

  function handleCustomApply() {
    onChange({ preset: 'custom', startDate: customStart, endDate: customEnd });
    setOpen(false);
    setShowCustom(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-9 px-3 bg-bg-surface border-[1.5px] border-border-strong rounded-md text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
      >
        <Calendar size={14} className="text-text-tertiary" />
        <span className="max-w-[200px] truncate">{activeLabel}</span>
        <ChevronDown size={14} className="text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border-[1.5px] border-border-strong rounded-lg shadow-lg z-50 py-1 min-w-[200px]">
          {presets.map((preset) => (
            <button
              key={preset.value}
              onClick={() => handlePreset(preset.value)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                value.preset === preset.value
                  ? 'bg-accent text-text-inverse font-semibold'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {preset.label}
            </button>
          ))}
          <div className="border-t border-border-subtle mt-1 pt-1">
            <button
              onClick={() => setShowCustom(!showCustom)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                value.preset === 'custom'
                  ? 'bg-accent text-text-inverse font-semibold'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              Custom Range...
            </button>
          </div>
          {showCustom && (
            <div className="px-3 py-2 border-t border-border-subtle space-y-2">
              <div>
                <label className="block text-[11px] label-caps text-text-tertiary mb-1">Start</label>
                <input
                  type="date"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  className="w-full h-8 px-2 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] label-caps text-text-tertiary mb-1">End</label>
                <input
                  type="date"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  className="w-full h-8 px-2 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-link focus:outline-none"
                />
              </div>
              <button
                onClick={handleCustomApply}
                className="w-full h-8 bg-accent text-text-inverse rounded-md text-sm font-bold hover:bg-accent-hover transition-colors"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
