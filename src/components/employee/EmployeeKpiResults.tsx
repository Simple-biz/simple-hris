'use client';

// Employee "KPI Results" tab.
//
// A read-only window onto the employee's OWN KPI bonus outcomes. Results appear
// here only once their manager has marked the dept-week as ready (or it's been
// finalized/locked) — the server enforces that gate (see
// src/lib/supabase/employee-kpi-results.ts). The latest period is highlighted;
// everything before it forms a scrollable history. A manual Refresh button plus
// focus + Realtime refetch keep it current.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Trophy,
  RefreshCw,
  CheckCircle2,
  Lock,
  CalendarDays,
  TrendingUp,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { formatPeso } from '@/lib/hsl-bonus/schema';

interface KpiResultItem {
  label: string;
  amount: number | null;
  value: number | null;
  detail: string | null;
}

interface KpiResultPeriod {
  key: string;
  source: 'catalog' | 'hsl';
  department: string;
  departmentName: string;
  periodType: 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
  status: 'ready' | 'locked';
  statusAt: string | null;
  statusBy: string | null;
  total: number;
  items: KpiResultItem[];
}

const EASE = [0.22, 1, 0.36, 1] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "May 5 – 11, 2026" / "May 28 – Jun 3, 2026" / "Dec 30, 2025 – Jan 5, 2026". */
function formatPeriodRange(startIso: string, endIso: string): string {
  const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startIso);
  const e = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endIso);
  if (!s) return startIso;
  const sy = +s[1], sm = +s[2], sd = +s[3];
  if (!e) return `${MONTHS[sm - 1]} ${sd}, ${sy}`;
  const ey = +e[1], em = +e[2], ed = +e[3];
  const sM = MONTHS[sm - 1] ?? s[2];
  const eM = MONTHS[em - 1] ?? e[2];
  if (sy !== ey) return `${sM} ${sd}, ${sy} – ${eM} ${ed}, ${ey}`;
  if (sm !== em) return `${sM} ${sd} – ${eM} ${ed}, ${sy}`;
  return `${sM} ${sd} – ${ed}, ${sy}`;
}

function formatStatusAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortWho(who: string | null): string | null {
  if (!who) return null;
  const at = who.indexOf('@');
  return at > 0 ? who.slice(0, at) : who;
}

function StatusBadge({ status }: { status: 'ready' | 'locked' }) {
  if (status === 'locked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
        <Lock className="h-3 w-3" />
        Finalized
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </span>
  );
}

function ItemsList({ items }: { items: KpiResultItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        No itemized breakdown was recorded for this period.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li
          key={`${it.label}-${i}`}
          className="flex items-baseline justify-between gap-3 text-sm"
        >
          <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
            <span className="truncate">{it.label}</span>
            {it.detail && (
              <span className="ml-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">({it.detail})</span>
            )}
          </span>
          <span className="shrink-0 font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
            {it.amount != null ? formatPeso(it.amount) : it.value != null ? `× ${it.value}` : '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PeriodCard({ period, featured }: { period: KpiResultPeriod; featured?: boolean }) {
  const when = formatStatusAt(period.statusAt);
  const who = shortWho(period.statusBy);
  return (
    <div
      className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-zinc-950 sm:p-5 ${
        featured
          ? 'border-orange-200 ring-1 ring-orange-100 dark:border-orange-500/40 dark:ring-orange-500/10'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {period.departmentName}
            </h3>
            <StatusBadge status={period.status} />
            <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {period.periodType}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatPeriodRange(period.periodStart, period.periodEnd)}
          </p>
        </div>
        <div className="text-right">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            KPI bonus
          </span>
          <span
            className={`block font-bold tabular-nums ${
              featured ? 'text-2xl' : 'text-lg'
            } text-emerald-600 dark:text-emerald-400`}
          >
            {formatPeso(period.total)}
          </span>
        </div>
      </div>

      <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <ItemsList items={period.items} />
      </div>

      {(when || who) && (
        <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
          {period.status === 'locked' ? 'Finalized' : 'Published'}
          {who ? ` by ${who}` : ''}
          {when ? ` · ${when}` : ''}
        </p>
      )}
    </div>
  );
}

export default function EmployeeKpiResults({ employeeEmail }: { employeeEmail: string }) {
  const [periods, setPeriods] = useState<KpiResultPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  const fetchResults = useCallback(
    async (signal?: AbortSignal) => {
      if (loadedOnce.current) setRefreshing(true);
      try {
        const res = await fetch(
          `/api/kpi-results?email=${encodeURIComponent(employeeEmail)}`,
          { cache: 'no-store', signal },
        );
        const json = (await res.json()) as { periods?: KpiResultPeriod[]; error?: string | null };
        if (signal?.aborted) return;
        if (!res.ok) {
          setError(json.error ?? `Request failed (${res.status})`);
        } else {
          setError(json.error ?? null);
          setPeriods(json.periods ?? []);
        }
      } catch (e) {
        if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Failed to load KPI results');
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
          loadedOnce.current = true;
        }
      }
    },
    [employeeEmail],
  );

  // Initial load + refetch on window focus.
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchResults(ctrl.signal);
    const onFocus = () => void fetchResults();
    window.addEventListener('focus', onFocus);
    return () => {
      ctrl.abort();
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchResults]);

  // Realtime: a manager marking a week ready / applying bonuses refetches live.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`kpi-results-${employeeEmail}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hsl_bonus_period_status' }, () => void fetchResults())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bonus_catalog_applied' }, () => void fetchResults())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hsl_bonus_entries' }, () => void fetchResults())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchResults, employeeEmail]);

  const [latest, ...history] = periods;
  const totalEarned = useMemo(() => periods.reduce((s, p) => s + p.total, 0), [periods]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fafaf8] dark:bg-[#0d1117]">
      {/* Header */}
      <div className="shrink-0 border-b border-orange-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <Trophy className="h-5 w-5 text-orange-500" />
              KPI Results
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Your KPI bonus scores, published by your manager. New results appear here once a period is marked ready.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchResults()}
            disabled={refreshing}
            className="shrink-0 gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        {periods.length > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <TrendingUp className="h-3.5 w-3.5" />
            {formatPeso(totalEarned)} across {periods.length} period{periods.length === 1 ? '' : 's'}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-zinc-400">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Loading your KPI results…
          </div>
        ) : error ? (
          <div className="mx-auto max-w-md rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            Could not load your KPI results: {error}
          </div>
        ) : periods.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mx-auto max-w-md rounded-xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center dark:border-zinc-700 dark:bg-zinc-900/40"
          >
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-950/40">
              <Sparkles className="h-6 w-6 text-orange-500" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">No KPI results yet</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              If you have KPI bonuses assigned, your scores will show up here as soon as your manager marks the period ready. Check back, or hit Refresh.
            </p>
          </motion.div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-5">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={latest.key}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.26, ease: EASE }}
              >
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-orange-500">
                  <Sparkles className="h-3.5 w-3.5" />
                  Latest
                </div>
                <PeriodCard period={latest} featured />
              </motion.div>
            </AnimatePresence>

            {history.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  <CalendarDays className="h-3.5 w-3.5" />
                  History
                </div>
                <motion.div layout className="space-y-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {history.map((p, i) => (
                      <motion.div
                        key={p.key}
                        layout
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10, scale: 0.97 }}
                        transition={{ duration: 0.22, delay: Math.min(i * 0.03, 0.18), ease: EASE }}
                      >
                        <PeriodCard period={p} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </motion.div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
