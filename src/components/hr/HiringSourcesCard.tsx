'use client';

import { useEffect, useMemo, useState } from 'react';
import { PieChart, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * HR Overview card: a donut + table of how many hires came from each `sources`
 * value in the New Hire Checklist (aggregated across all weeks). Hand-rolled SVG
 * donut to match the house chart style (no chart dependency).
 */

type SourceCount = { source: string; count: number };

// Distinct slice colours; cycled if there are more sources than colours.
const PALETTE = [
  '#10b981', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f43f5e', '#6366f1', '#84cc16', '#06b6d4',
  '#eab308', '#a855f7', '#ef4444', '#22c55e', '#3b82f6',
];
const UNSPECIFIED_COLOR = '#d4d4d8';

type Slice = { label: string; count: number; color: string; start: number; end: number; muted: boolean };

const SIZE = 188;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER_R = 80;
const INNER_R = 50;

function polar(deg: number, r: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function slicePath(s: number, e: number) {
  if (e - s >= 359.99) {
    const t = polar(0, OUTER_R); const b = polar(180, OUTER_R);
    const it = polar(0, INNER_R); const ib = polar(180, INNER_R);
    return `M ${t.x} ${t.y} A ${OUTER_R} ${OUTER_R} 0 1 1 ${b.x} ${b.y} A ${OUTER_R} ${OUTER_R} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${INNER_R} ${INNER_R} 0 1 0 ${ib.x} ${ib.y} A ${INNER_R} ${INNER_R} 0 1 0 ${it.x} ${it.y} Z`;
  }
  const large = e - s > 180 ? 1 : 0;
  const s1 = polar(s, OUTER_R); const e1 = polar(e, OUTER_R);
  const s2 = polar(e, INNER_R); const e2 = polar(s, INNER_R);
  return `M ${s1.x} ${s1.y} A ${OUTER_R} ${OUTER_R} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${INNER_R} ${INNER_R} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
}

export default function HiringSourcesCard() {
  const [sources, setSources] = useState<SourceCount[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch('/api/hr/new-hire-checklist/sources', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { sources?: SourceCount[]; total?: number; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setSources(j.sources ?? []);
        setTotal(j.total ?? 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load hiring sources'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Build slices: each named source + an "Unspecified" remainder so counts
  // reconcile with the total tracked hires.
  const { slices, sumNamed } = useMemo(() => {
    const sumNamed = sources.reduce((s, x) => s + x.count, 0);
    const unspecified = Math.max(0, total - sumNamed);
    const rows: { label: string; count: number; color: string; muted: boolean }[] = sources.map((s, i) => ({
      label: s.source,
      count: s.count,
      color: PALETTE[i % PALETTE.length]!,
      muted: false,
    }));
    if (unspecified > 0) rows.push({ label: 'Unspecified', count: unspecified, color: UNSPECIFIED_COLOR, muted: true });

    const grand = rows.reduce((s, x) => s + x.count, 0);
    let cum = 0;
    const slices: Slice[] = rows.map((row) => {
      const start = cum;
      cum += grand > 0 ? (row.count / grand) * 360 : 0;
      return { ...row, start, end: cum };
    });
    return { slices, sumNamed };
  }, [sources, total]);

  const activeSlice = slices.find((s) => s.label === hovered) ?? null;
  const centerValue = activeSlice ? activeSlice.count : total;
  const centerLabel = activeSlice ? activeSlice.label : 'total hires';
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-100/70 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-900 sm:px-6">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-emerald-700/80 dark:text-emerald-400/70">
            New Hire Checklist
          </p>
          <h2 className="mt-0.5 flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            <PieChart className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            Hiring sources
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Where our hires came from — across all weeks.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-label="Refresh hiring sources"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading hiring sources…
        </div>
      ) : error ? (
        <div className="px-6 py-12 text-center text-sm text-rose-600">{error}</div>
      ) : total === 0 || slices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <PieChart className="h-8 w-8 text-emerald-200 dark:text-emerald-900" />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No hires recorded yet. Add hires (with a <strong>Sources</strong> value) in the New Hire
            Checklist and they&apos;ll appear here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6 px-5 py-6 sm:px-6 lg:flex-row lg:items-center lg:gap-8">
          {/* Donut */}
          <div className="shrink-0">
            <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Hiring sources donut chart">
              {slices.map((s) => (
                <path
                  key={s.label}
                  d={slicePath(s.start, s.end)}
                  fill={s.color}
                  opacity={hovered && hovered !== s.label ? 0.3 : 1}
                  onMouseEnter={() => setHovered(s.label)}
                  onMouseLeave={() => setHovered(null)}
                  className="cursor-default transition-opacity duration-150"
                />
              ))}
              <text x={CX} y={CY - 4} textAnchor="middle" className="fill-zinc-900 dark:fill-zinc-50" fontSize="26" fontWeight="700">
                {centerValue}
              </text>
              <text x={CX} y={CY + 15} textAnchor="middle" className="fill-zinc-400" fontSize="10">
                {centerLabel.length > 16 ? `${centerLabel.slice(0, 15)}…` : centerLabel}
              </text>
            </svg>
          </div>

          {/* Table */}
          <div className="w-full min-w-0 flex-1">
            <div className="overflow-hidden rounded-xl border border-zinc-100 dark:border-zinc-800">
              <table className="table-keep w-full text-[13px]">
                <thead>
                  <tr className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2 text-right">Hires</th>
                    <th className="px-3 py-2 text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {slices.map((s) => (
                    <tr
                      key={s.label}
                      onMouseEnter={() => setHovered(s.label)}
                      onMouseLeave={() => setHovered(null)}
                      className={cn(
                        'transition-colors',
                        hovered === s.label ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : '',
                      )}
                    >
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                          <span className={cn('truncate', s.muted ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200')}>
                            {s.label}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {s.count}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                        {pct(s.count)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-900/60">
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      Total{sumNamed < total ? ` (${sumNamed} sourced)` : ''}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{total}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
