'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Share2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { addWeeks, formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';

/**
 * HR Overview → "Referrals": who referred friends to work at Simple, derived
 * from the New Hire Checklist `source` column (each Source value = a referrer).
 * Scoped by its own Sun–Sat week selector (or all-time), mirroring the hiring
 * section's selector. Defaults to the current week.
 */

type Referrer = { referrer: string; count: number; hires: string[] };

// RFC-4180-ish escaping: quote when the value carries a comma, quote, or newline.
function csvCell(v: string | number | null | undefined): string {
  const s = (v ?? '').toString();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ReferralsWeekSection() {
  const [currentSunday] = useState(() => sundayIso(new Date()));
  const [week, setWeek] = useState<string | null>(() => sundayIso(new Date()));
  const [referrers, setReferrers] = useState<Referrer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const badge = useMemo(() => {
    if (week === null) return null;
    if (week === currentSunday) return 'this week';
    if (week === addWeeks(currentSunday, 1)) return 'next week';
    return null;
  }, [week, currentSunday]);

  const load = () => {
    setLoading(true);
    setError(null);
    const url = week
      ? `/api/hr/new-hire-checklist/referrals?period=${encodeURIComponent(week)}`
      : '/api/hr/new-hire-checklist/referrals';
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { referrers?: Referrer[]; total?: number; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setReferrers(j.referrers ?? []);
        setTotal(j.total ?? 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load referrals'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [week]);

  const maxCount = useMemo(() => Math.max(1, ...referrers.map((r) => r.count)), [referrers]);
  const referred = useMemo(() => referrers.reduce((s, r) => s + r.count, 0), [referrers]);

  const copyCsv = async () => {
    const header = ['Referrer', 'Referred', 'Who they referred'];
    const lines = [
      header.join(','),
      ...referrers.map((r) => [r.referrer, r.count, r.hires.join('; ')].map(csvCell).join(',')),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\r\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast.success(`Copied ${referrers.length} ${referrers.length === 1 ? 'referrer' : 'referrers'} to clipboard`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <section className="flex flex-col gap-3">
      {/* Section header — title + week selector (own scope, mirrors Hiring) */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-emerald-700/80 dark:text-emerald-400/70">
            New Hire Checklist
          </p>
          <h2 className="mt-0.5 flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            <Share2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            Referrals
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Who referred friends to Simple — {week ? formatWeekLabel(week) : 'across all weeks'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={copyCsv}
            disabled={loading || referrers.length === 0}
            title="Copy the referrals table as CSV"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy CSV
              </>
            )}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh referrals"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>

          {/* All time / By week toggle */}
          <div className="flex items-center overflow-hidden rounded-lg border border-emerald-200 dark:border-emerald-800">
            <button
              type="button"
              onClick={() => setWeek(null)}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week === null
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-emerald-700 hover:bg-emerald-50 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
              )}
            >
              All time
            </button>
            <button
              type="button"
              onClick={() => setWeek((w) => w ?? currentSunday)}
              className={cn(
                'flex h-8 items-center px-2.5 text-[12px] font-medium transition-colors',
                week !== null
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-emerald-700 hover:bg-emerald-50 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
              )}
            >
              By week
            </button>
          </div>

          {week !== null && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, -1))}
                aria-label="Previous week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-2.5 text-[13px] font-medium text-zinc-800 dark:border-emerald-800 dark:bg-zinc-900 dark:text-zinc-100">
                <CalendarClock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="tabular-nums">{formatWeekLabel(week)}</span>
                {badge && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                    {badge}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setWeek((w) => addWeeks(w ?? currentSunday, 1))}
                aria-label="Next week"
                className="flex h-8 w-7 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Card — the referrals table */}
      <div className="overflow-hidden rounded-2xl border border-emerald-100/70 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950">
        {loading ? (
          <div className="px-5 py-4 sm:px-6">
            <div className="overflow-hidden rounded-xl border border-zinc-100 dark:border-zinc-800">
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex-1 space-y-1.5">
                      <span className="block h-3 w-1/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                      <span className="block h-1.5 w-full animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800" />
                    </div>
                    <span className="h-3 w-6 shrink-0 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                    <span className="h-3 w-24 shrink-0 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="px-6 py-12 text-center text-sm text-rose-600">{error}</div>
        ) : referrers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <Share2 className="h-8 w-8 text-emerald-200 dark:text-emerald-900" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No referral hires{week ? ` for ${formatWeekLabel(week)}` : ' yet'}. Tag a hire&apos;s{' '}
              <strong>Source</strong> as <strong>&ldquo;Referral&rdquo;</strong> in the New Hire Checklist and they&apos;ll
              appear here.
            </p>
          </div>
        ) : (
          <div className="px-5 py-4 sm:px-6">
            <div className="overflow-x-auto rounded-xl border border-zinc-100 dark:border-zinc-800">
              <table className="table-keep w-full text-[13px]">
                <thead>
                  <tr className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <th className="px-3 py-2">Referrer</th>
                    <th className="px-3 py-2 text-right">Referred</th>
                    <th className="px-3 py-2">Who they referred</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {referrers.map((r) => (
                    <tr key={r.referrer} className="align-top transition-colors hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20">
                      <td className="px-3 py-2">
                        {/* Name over a proportional bar so the leaderboard reads at a glance. */}
                        <div className="flex flex-col gap-1">
                          <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{r.referrer}</span>
                          <span className="h-1.5 w-full max-w-[10rem] overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                            <span
                              className="block h-full rounded-full bg-emerald-500"
                              style={{ width: `${Math.max((r.count / maxCount) * 100, 6)}%` }}
                            />
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {r.count}
                      </td>
                      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">
                        {r.hires.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {r.hires.map((h, i) => (
                              <span
                                key={`${h}-${i}`}
                                className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[12px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                              >
                                {h}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-900/60">
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      {referrers.length} {referrers.length === 1 ? 'referrer' : 'referrers'}
                      {referred < total ? (
                        <span className="ml-1 font-normal text-zinc-400">({total - referred} not referred)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{referred}</td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
