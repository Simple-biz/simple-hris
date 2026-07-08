'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Search,
  Share2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { addWeeks, formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';

/**
 * HR Overview → "Referrals": one row per hire who came in through a referral,
 * pairing the new hire with who referred them (from the checklist `referred_by`
 * column). Only referral hires appear. Scoped by its own Sun–Sat week selector
 * (or all-time), defaulting to the current week.
 */

type Referral = { hire: string; referredBy: string };

// RFC-4180-ish escaping: quote when the value carries a comma, quote, or newline.
function csvCell(v: string | number | null | undefined): string {
  const s = (v ?? '').toString();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ReferralsWeekSection() {
  const [currentSunday] = useState(() => sundayIso(new Date()));
  const [week, setWeek] = useState<string | null>(() => sundayIso(new Date()));
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');

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
      .then((j: { referrals?: Referral[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setReferrals(j.referrals ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load referrals'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [week]);

  // Filter by new-hire OR referrer name (case-insensitive substring).
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? referrals.filter((r) => r.hire.toLowerCase().includes(q) || r.referredBy.toLowerCase().includes(q))
        : referrals,
    [referrals, q],
  );

  const copyCsv = async () => {
    const header = ['New Hire that was Referred', 'Referred By'];
    const lines = [
      header.join(','),
      ...filtered.map((r) => [r.hire, r.referredBy].map(csvCell).join(',')),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\r\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast.success(`Copied ${filtered.length} ${filtered.length === 1 ? 'referral' : 'referrals'} to clipboard`);
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
            New hires who came in through a referral — {week ? formatWeekLabel(week) : 'across all weeks'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={copyCsv}
            disabled={loading || filtered.length === 0}
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

      {/* Card — New Hire that was Referred · Referred By */}
      <div className="overflow-hidden rounded-2xl border border-emerald-100/70 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950">
        {loading ? (
          <div className="px-5 py-4 sm:px-6">
            <div className="overflow-hidden rounded-xl border border-zinc-100 dark:border-zinc-800">
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="h-3 flex-1 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                    <span className="h-3 flex-1 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="px-6 py-12 text-center text-sm text-rose-600">{error}</div>
        ) : referrals.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <Share2 className="h-8 w-8 text-emerald-200 dark:text-emerald-900" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No referral hires{week ? ` for ${formatWeekLabel(week)}` : ' yet'}. Tag a hire&apos;s{' '}
              <strong>Source</strong> as <strong>&ldquo;Referral&rdquo;</strong> in the New Hire Checklist and fill in{' '}
              <strong>Referred By</strong>.
            </p>
          </div>
        ) : (
          <div className="px-5 py-4 sm:px-6">
            {/* Search — filter by new hire OR referrer name */}
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search new hire or referrer…"
                aria-label="Search referrals"
                className="h-9 w-full rounded-xl border border-zinc-300 bg-white pl-9 pr-9 text-[13px] text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-300/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-500"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                No referrals match &ldquo;{query.trim()}&rdquo;.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-zinc-100 dark:border-zinc-800">
                <table className="table-keep w-full text-[13px]">
                  <thead>
                    <tr className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      <th className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <UserPlus className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          New Hire that was Referred
                        </span>
                      </th>
                      <th className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          Referred By
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {filtered.map((r, i) => (
                      <tr
                        key={`${r.hire}-${r.referredBy}-${i}`}
                        className="transition-colors hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20"
                      >
                        <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-100">
                          {r.hire || <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {r.referredBy || <span className="text-zinc-400 dark:text-zinc-500">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-900/60">
                      <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300" colSpan={2}>
                        {filtered.length} {filtered.length === 1 ? 'referral' : 'referrals'}
                        {q && filtered.length !== referrals.length ? ` of ${referrals.length}` : ''}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
