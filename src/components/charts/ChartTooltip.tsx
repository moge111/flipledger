'use client';

// Recharts tooltip as a small Paper panel: outlined, popover shadow, condensed-caps header.
interface Entry { name?: string | number; value?: number | string; color?: string; dataKey?: string | number }

export default function ChartTooltip({ active, payload, label, format }: {
  active?: boolean;
  payload?: Entry[];
  label?: string | number;
  format?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label !== undefined && <div className="label-caps text-text-tertiary mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 tabular-nums">
          <span className="w-2 h-2 rounded-[1px] shrink-0" style={{ background: p.color }} />
          <span className="text-text-secondary">{p.name}</span>
          <span className="ml-auto pl-3 font-semibold">
            {format ? format(Number(p.value), String(p.name)) : String(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
