'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Search, Send, Eye, EyeOff, Clock, AlertTriangle, Users, Banknote, Loader2, Sparkles, RefreshCw, CalendarDays, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { TeamAvatar } from '@/components/team/team-ui';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { Skeleton } from '@/components/ui/skeleton';
import EmployeePabCalendar from '@/components/employee/EmployeePabCalendar';
import { getTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { cn } from '@/lib/utils';

type Currency = 'PHP' | 'USD' | 'COP';

interface Rate {
  regular: number | null;
  ot: number | null;
  currency: Currency;
  source: 'employee' | 'sheet' | 'department' | null;
}
interface Hours {
  thisWeek: number;
  ot: number;
  weekStart: string | null;
  weekEnd: string | null;
  inProgress: boolean;
  projectedHours: number | null;
  projectedOt: number | null;
}
interface RosterRow {
  employee_id: string | null;
  name: string | null;
  work_email: string | null;
  department: string | null;
  rate: Rate;
  hours: Hours;
  processor: string | null;
  hasBanking: boolean;
}
interface Banking {
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  swift_code: string | null;
  full_address: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  masked: boolean;
}
interface HistoryRow {
  source_file: string | null;
  kind: 'cycle' | 'special';
  note: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: number | null;
  regular_hours: number | null;
  ot_hours: number | null;
  amount_php: number | null;
  amount_usd: number | null;
  status: string | null;
  paid_amount_usd: number | null;
  paid_at: string | null;
}
interface Summary {
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
}
interface StatsLeader {
  name: string | null;
  email: string | null;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  weeks: number;
}
interface StatsPoint {
  sourceFile: string;
  weekStart: string;
  weekEnd: string;
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  /** Full ranked OT renderers for this week (top 5 feed the chart tooltip). */
  leaders: StatsLeader[];
  /** Per-department OT for this week — powers the department trend line graph. */
  depts: StatsDept[];
}
interface StatsDept {
  department: string;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  people: number;
}
type OtSort = 'hours' | 'pay';
type OtTab = 'people' | 'department';

function fmtMoney(amount: number | null | undefined, currency: Currency = 'PHP'): string {
  if (amount == null) return '—';
  const opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (currency === 'USD') return `$${amount.toLocaleString('en-US', opts)}`;
  if (currency === 'COP') return `COP ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `₱${amount.toLocaleString('en-PH', opts)}`;
}

function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

function todayIso(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a "YYYY-MM-DD" string as a LOCAL calendar date (no UTC/TZ shift). */
function parseIsoLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "2026-06-22" → "June 22, 2026". Falls back to the raw string if unparseable. */
function formatDay(iso: string | null | undefined): string {
  const d = parseIsoLocal(iso);
  if (!d) return iso ?? '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Friendly pay-period range:
 *   same month  → "April 5 - 10, 2026"
 *   cross month → "June 29 - July 5, 2026"
 *   cross year  → "Dec 30, 2025 - Jan 5, 2026"
 */
function formatPeriodRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const s = parseIsoLocal(startIso);
  const e = parseIsoLocal(endIso);
  if (!s || !e) return [startIso, endIso].filter(Boolean).join(' - ');
  const mLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  if (s.getFullYear() !== e.getFullYear()) return `${formatDay(startIso)} - ${formatDay(endIso)}`;
  if (s.getMonth() === e.getMonth()) return `${mLong(s)} ${s.getDate()} - ${e.getDate()}, ${s.getFullYear()}`;
  return `${mLong(s)} ${s.getDate()} - ${mLong(e)} ${e.getDate()}, ${s.getFullYear()}`;
}

/** A Hubstaff upload filename → friendly week label for the period selector. */
function labelForSourceFile(file: string): string {
  const m = file.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return formatPeriodRange(m[1], m[2]);
  return file.replace(/\.csv$/i, '');
}

interface Accent {
  ring: string;
  chipBg: string;
  chipText: string;
  btn: string;
  /** native accent-color for checkboxes/date pickers */
  check: string;
  /** solid color for the active tab underline */
  bar: string;
}

export default function PeopleTab({
  view,
  viewerEmail,
  canEdit,
}: {
  view: 'accounting' | 'ceo';
  viewerEmail: string | null;
  canEdit: boolean;
}) {
  void viewerEmail; // identity is derived server-side from the session
  const accent: Accent =
    view === 'ceo'
      ? {
          ring: 'focus-visible:ring-amber-500/40',
          chipBg: 'bg-amber-50 dark:bg-amber-950/30',
          chipText: 'text-amber-700 dark:text-amber-300',
          btn: 'bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-500 hover:to-amber-700 text-white',
          check: 'accent-amber-600',
          bar: 'bg-amber-500',
        }
      : {
          ring: 'focus-visible:ring-orange-500/40',
          chipBg: 'bg-orange-50 dark:bg-orange-950/30',
          chipText: 'text-orange-700 dark:text-orange-300',
          btn: 'bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white',
          check: 'accent-orange-600',
          bar: 'bg-orange-500',
        };

  const [rows, setRows] = useState<RosterRow[]>(() => getTabCache<RosterRow[]>(TAB_CACHE_KEYS.peopleRoster) ?? []);
  const [loading, setLoading] = useState(rows.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RosterRow | null>(null);
  const [transferFor, setTransferFor] = useState<RosterRow | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [deptFilter, setDeptFilter] = useState<string>('all');
  // Roster + stats share this: when on, only people who rendered OT are shown.
  const [otOnly, setOtOnly] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [periods, setPeriods] = useState<{ file: string; label: string }[]>([]);
  const [period, setPeriod] = useState('');
  const periodRef = useRef('');
  const defaultFileRef = useRef('');
  // Top-level mode: the roster vs the weekly Statistics graph.
  const [mode, setMode] = useState<'roster' | 'stats'>('roster');
  const [stats, setStats] = useState<StatsPoint[] | null>(null);
  const [statsLeaders, setStatsLeaders] = useState<StatsLeader[] | null>(null);
  const [statsDepts, setStatsDepts] = useState<StatsDept[] | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsFetchedRef = useRef(false);

  // Fetch the roster for a given week (`src` = Hubstaff source_file; '' = current).
  const loadFor = useCallback(async (src: string, quiet: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const url = src ? `/api/people?source_file=${encodeURIComponent(src)}` : '/api/people';
      const res = await fetch(url, { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: RosterRow[]; sourceFile?: string; summary?: Summary; error?: string;
      };
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      const next = json.rows ?? [];
      setRows(next);
      setSummary(json.summary ?? null);
      setError(json.error ?? null);
      // Cache only the current/default week so the next mount paints it instantly.
      if (!src || src === defaultFileRef.current) setTabCache(TAB_CACHE_KEYS.peopleRoster, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onPeriodChange = (v: string) => {
    setPeriod(v);
    periodRef.current = v;
    void loadFor(v, false);
  };

  // Statistics tab — lazy-fetch the weekly trend on first open.
  const openStats = () => {
    setMode('stats');
    if (statsFetchedRef.current) return;
    statsFetchedRef.current = true;
    setStatsLoading(true);
    fetch('/api/people/stats', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { points?: StatsPoint[]; otLeaders?: StatsLeader[]; otDepts?: StatsDept[]; error?: string }) => {
        setStats(j.points ?? []);
        setStatsLeaders(j.otLeaders ?? []);
        setStatsDepts(j.otDepts ?? []);
        setStatsError(j.error ?? null);
      })
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStatsLoading(false));
  };

  // Manual refresh — re-pull the SELECTED week in place (no skeleton flash) so a
  // change made in the Payroll Wizard shows up here without a full reload.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadFor(periodRef.current, true);
    } finally {
      setRefreshing(false);
    }
  };

  // On mount: populate the CSV period selector and load the current week.
  useEffect(() => {
    let alive = true;
    (async () => {
      let defaultFile = '';
      try {
        const r = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const j = (await r.json()) as {
          files?: string[];
          uploads?: { source_file: string | null; is_current: boolean }[];
        };
        const ups = j.uploads ?? [];
        const files = (j.files ?? ups.map((u) => u.source_file ?? '')).filter(Boolean) as string[];
        defaultFile = ups.find((u) => u.is_current)?.source_file ?? files[0] ?? '';
        if (alive) setPeriods(files.map((f) => ({ file: f, label: labelForSourceFile(f) })));
      } catch {
        /* selector stays empty; the roster still loads the current week below */
      }
      if (!alive) return;
      defaultFileRef.current = defaultFile;
      setPeriod(defaultFile);
      periodRef.current = defaultFile;
      void loadFor(defaultFile, rows.length > 0);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Distinct, alphabetised departments for the filter dropdown.
  const departments = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => (r.department ?? '').trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (deptFilter !== 'all' && (r.department ?? '').trim() !== deptFilter) return false;
        if (otOnly && (r.hours.projectedOt ?? r.hours.ot) <= 0) return false;
        if (!q) return true;
        const name = (r.name ?? '').toLowerCase();
        const email = (r.work_email ?? '').toLowerCase();
        const dept = (r.department ?? '').toLowerCase();
        const id = (r.employee_id ?? '').toLowerCase();
        return name.includes(q) || email.includes(q) || dept.includes(q) || id.includes(q);
      })
      // Always present names A→Z (case-insensitive), regardless of API order.
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
  }, [rows, query, deptFilter, otOnly]);

  // Reset to page 1 whenever the filters change so results never land on an
  // out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [query, deptFilter, otOnly]);

  // Paginate — 10 rows per page. safePage clamps after the result set shrinks.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const otWatch = useMemo(
    () => rows.filter((r) => (r.hours.projectedOt ?? r.hours.ot) > 0).length,
    [rows],
  );

  // Friendly label for the pay week chosen in the CSV period selector.
  const periodLabel = useMemo(
    () => periods.find((p) => p.file === period)?.label ?? (period ? labelForSourceFile(period) : 'Current week'),
    [periods, period],
  );

  // Payouts to be sent this week = people who logged Hubstaff hours in the
  // selected pay week AND are in the Global Master List. The roster is already
  // built only from master-list employees, so "in master list" is implicit.
  // The excluded set (no hours this week) powers the "Payouts to send" modal.
  const excludedRows = useMemo(() => rows.filter((r) => !(r.hours.thisWeek > 0)), [rows]);
  const payoutCount = rows.length - excludedRows.length;

  return (
    // data-readonly-allow: People is a read surface (browse, search, reveal-banking
    // is itself audited); the only mutation — special transfers — is gated on
    // `canEdit` + the server, so we don't want ReadOnlyTab swallowing row clicks.
    <div data-readonly-allow className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <Users className="h-5 w-5 shrink-0 text-zinc-400" /> People
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Everyone, searchable — hours this week, pay rate, banking, and one-off transfers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', accent.chipBg, accent.chipText)}>
              {rows.length} people
            </span>
            {otWatch > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:bg-red-950/30 dark:text-red-300">
                <AlertTriangle className="h-3 w-3" /> {otWatch} on track for OT
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2.5 text-[12px]"
              onClick={refresh}
              disabled={refreshing || (loading && rows.length === 0)}
              aria-label="Refresh roster"
              title="Pull the latest hours, rates, and payroll changes"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
        {/* Top-level tabs: Roster vs the weekly Statistics graph. */}
        <div role="tablist" className="mt-3 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
          {([['roster', 'Roster'], ['stats', 'Statistics']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => (id === 'stats' ? openStats() : setMode('roster'))}
              className={cn(
                'relative px-3 py-2 text-[13px] font-medium transition-colors',
                mode === id
                  ? 'text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {label}
              {mode === id && <span className={cn('absolute inset-x-2 -bottom-px h-0.5 rounded-full', accent.bar)} />}
            </button>
          ))}
        </div>

        {mode === 'roster' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              type="search"
              placeholder="Search name, work email, department, or ID…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={cn('pl-9', accent.ring)}
              aria-label="Search people"
            />
          </div>
          <SmoothSelect
            value={deptFilter}
            onChange={setDeptFilter}
            aria-label="Filter by department"
            className="w-full shrink-0 sm:w-48"
            options={[
              { value: 'all', label: 'All departments' },
              ...departments.map((d) => ({ value: d, label: d })),
            ]}
          />
          {/* Show only people who rendered (or are on track for) overtime. */}
          <Button
            type="button"
            variant="outline"
            onClick={() => setOtOnly((v) => !v)}
            aria-pressed={otOnly}
            title="Show only people with overtime this week"
            className={cn(
              'h-9 shrink-0 gap-1.5 px-3 text-[13px]',
              otOnly &&
                'border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60',
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" /> OT only
          </Button>
          {/* CSV period selector — scopes hours / OT / KPIs to a chosen week. */}
          <SmoothSelect
            value={period}
            onChange={onPeriodChange}
            aria-label="Pay week"
            className="w-full shrink-0 sm:w-56"
            options={
              periods.length
                ? periods.map((p) => ({ value: p.file, label: p.label }))
                : period
                  ? [{ value: period, label: labelForSourceFile(period) }]
                  : [{ value: '', label: 'Current week' }]
            }
          />
        </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {mode === 'stats' ? (
          <PeopleStatsChart points={stats} leaders={statsLeaders} depts={statsDepts} periods={periods} loading={statsLoading} error={statsError} accent={accent} />
        ) : (
        <>
        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Week KPI cards — overtime headcount + estimated OT payout for the
            selected week (USD primary, PHP small). */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Employees with overtime
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {summary?.otEmployees ?? 0}
              </span>
              <span className="text-[12px] text-zinc-400">
                of {rows.length} · {fmtHours(summary?.otHours ?? 0)} OT
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Banknote className="h-3.5 w-3.5 text-emerald-500" /> OT payout this week
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {fmtMoney(summary?.otPayoutUsd ?? 0, 'USD')}
              </span>
              <span className="text-[12px] tabular-nums text-zinc-400">{fmtMoney(summary?.otPayoutPhp ?? 0, 'PHP')}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowExcluded(true)}
            className="group rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-sky-300 hover:bg-sky-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-sky-800/70 dark:hover:bg-sky-950/20"
            title="See who has no payout this week and why"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                <Send className="h-3.5 w-3.5 text-sky-500" /> Payouts to send
              </div>
              <span className="flex items-center gap-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                {excludedRows.length} excluded
                <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {payoutCount}
              </span>
              <span className="text-[12px] text-zinc-400">of {rows.length}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
              <CalendarDays className="h-3 w-3 shrink-0" /> <span className="truncate">{periodLabel}</span>
            </div>
          </button>
        </div>

        {loading && rows.length === 0 ? (
          <RosterSkeleton />
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-sm text-zinc-500">
            {query.trim() || deptFilter !== 'all' || otOnly
              ? 'No people match the current filters.'
              : 'No people to show.'}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-3 py-2.5 font-medium">Person</th>
                  <th className="px-3 py-2.5 font-medium">Department</th>
                  <th className="px-3 py-2.5 font-medium">Hours this week</th>
                  <th className="px-3 py-2.5 font-medium">Pay rate</th>
                  <th className="px-3 py-2.5 font-medium">Payout</th>
                  <th className="px-3 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr
                    key={`${r.work_email ?? r.employee_id ?? r.name ?? 'row'}|${r.name ?? ''}`}
                    className="cursor-pointer border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                    onClick={() => setSelected(r)}
                  >
                    <td className="px-3 py-2.5" data-label="Person">
                      <div className="flex items-center gap-2.5">
                        <TeamAvatar name={r.name ?? ''} email={r.work_email} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">{r.work_email ?? r.employee_id ?? ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-300" data-label="Department">
                      {r.department ?? '—'}
                    </td>
                    <td className="px-3 py-2.5" data-label="Hours this week">
                      <HoursCell hours={r.hours} />
                    </td>
                    <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-200" data-label="Pay rate">
                      {r.rate.regular != null ? (
                        <span>
                          {fmtMoney(r.rate.regular, r.rate.currency)}
                          <span className="text-[11px] text-zinc-400">/hr</span>
                          {r.rate.ot != null && (
                            <span className="ml-1 text-[11px] text-zinc-400">
                              · OT {fmtMoney(r.rate.ot, r.rate.currency)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-zinc-400">not set</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5" data-label="Payout">
                      {r.processor ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          <Banknote className="h-3 w-3" /> {r.processor}
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-400">{r.hasBanking ? 'on file' : 'none'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right" data-label="">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[12px]"
                        onClick={(e) => { e.stopPropagation(); setSelected(r); }}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
            <span>
              Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[12px]"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                  Page {safePage} of {totalPages}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[12px]"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
          </>
        )}
        </>
        )}
      </div>

      {selected && (
        <PersonDetailDialog
          key={selected.work_email ?? selected.employee_id ?? selected.name ?? 'person'}
          row={selected}
          accent={accent}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
          onSendTransfer={() => setTransferFor(selected)}
        />
      )}

      {transferFor && (
        <SpecialTransferDialog
          row={transferFor}
          accent={accent}
          onClose={() => setTransferFor(null)}
          onDone={() => {
            setTransferFor(null);
            void loadFor(periodRef.current, true);
          }}
        />
      )}

      {showExcluded && (
        <ExcludedPayoutDialog
          rows={excludedRows}
          periodLabel={periodLabel}
          onClose={() => setShowExcluded(false)}
          onSelect={(r) => { setShowExcluded(false); setSelected(r); }}
        />
      )}
    </div>
  );
}

/* ── Excluded-from-payout modal ─────────────────────────────────────────── */

function ExcludedPayoutDialog({
  rows,
  periodLabel,
  onClose,
  onSelect,
}: {
  rows: RosterRow[];
  periodLabel: string;
  onClose: () => void;
  onSelect: (r: RosterRow) => void;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) =>
        (r.name ?? '').toLowerCase().includes(term) ||
        (r.work_email ?? '').toLowerCase().includes(term) ||
        (r.department ?? '').toLowerCase().includes(term),
    );
  }, [rows, q]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <DialogTitle className="text-lg">Not in this week&apos;s payout</DialogTitle>
            <DialogDescription>
              {rows.length} {rows.length === 1 ? 'person is' : 'people are'} in the Global Master List but logged no
              Hubstaff hours for {periodLabel}, so they have no payout to be sent this week.
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, or department…"
                className="h-9 pl-8 text-[13px]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {list.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">
                {rows.length === 0
                  ? 'Everyone in the Master List has Hubstaff hours this week.'
                  : 'No one matches your search.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((r) => {
                  const noRate = r.rate.regular == null && r.rate.ot == null;
                  return (
                    <li key={`${r.work_email ?? r.employee_id ?? r.name ?? 'row'}|${r.name ?? ''}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(r)}
                        className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
                      >
                        <TeamAvatar name={r.name ?? ''} email={r.work_email} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">
                            {r.department ?? '—'} · {r.work_email ?? r.employee_id ?? ''}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                          <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            No hours this week
                          </span>
                          {noRate && (
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              No pay rate
                            </span>
                          )}
                          {!r.hasBanking && (
                            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                              No payout details
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-200 px-5 py-3 text-[11px] text-zinc-400 dark:border-zinc-800">
            Showing {list.length} of {rows.length}. Click anyone to open their full record.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Round up to a clean axis maximum (1/2/5 × 10ⁿ). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function fmtUsdAxis(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}

/**
 * Weekly OT trend — a self-contained dual-axis SVG line chart (no chart lib).
 * Left axis + emerald line = OT payout (USD); right axis + amber line = number
 * of people on overtime. One point per recent payroll week.
 */
function PeopleStatsChart({
  points,
  leaders,
  depts,
  periods,
  loading,
  error,
  accent,
}: {
  points: StatsPoint[] | null;
  leaders: StatsLeader[] | null;
  depts: StatsDept[] | null;
  periods: { file: string; label: string }[];
  loading: boolean;
  error: string | null;
  accent: Accent;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [sort, setSort] = useState<OtSort>('hours');
  const [tab, setTab] = useState<OtTab>('people');
  const [leaderPage, setLeaderPage] = useState(1);
  const [leaderQuery, setLeaderQuery] = useState('');
  const LEADERS_PER_PAGE = 10;
  // CSV period the leaderboard follows. '' = the cross-week aggregate ("All
  // recent weeks"); any other value is a Hubstaff source_file fetched on demand
  // so both tabs are authoritatively scoped to the selected week.
  const [statsPeriod, setStatsPeriod] = useState('');
  const [weekData, setWeekData] = useState<Record<string, { leaders: StatsLeader[]; depts: StatsDept[] }>>({});
  const reduceMotion = useReducedMotion();

  // Fetch the selected week's OT leaders + department rollup on demand (cached
  // per file). '' uses the aggregates passed in, so it never fetches.
  useEffect(() => {
    const file = statsPeriod;
    if (!file || weekData[file]) return;
    let alive = true;
    fetch(`/api/people/stats?source_file=${encodeURIComponent(file)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { leaders?: StatsLeader[]; depts?: StatsDept[] }) => {
        if (alive) setWeekData((prev) => ({ ...prev, [file]: { leaders: j.leaders ?? [], depts: j.depts ?? [] } }));
      })
      .catch(() => { if (alive) setWeekData((prev) => ({ ...prev, [file]: { leaders: [], depts: [] } })); });
    return () => { alive = false; };
  }, [statsPeriod, weekData]);

  if (loading && !points) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Building weekly trend…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
        {error}
      </div>
    );
  }
  const data = points ?? [];
  if (data.length === 0) {
    return <div className="py-24 text-center text-sm text-zinc-500">No weekly payroll data to chart yet.</div>;
  }

  const W = 760;
  const H = 260;
  const padL = 56;
  const padR = 48;
  const padT = 14;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = data.length;
  const xAt = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));

  const usdTop = niceCeil(Math.max(1, ...data.map((d) => d.otPayoutUsd ?? 0)));
  const cntTop = niceCeil(Math.max(1, ...data.map((d) => d.otEmployees)));
  const yUsd = (v: number) => padT + plotH - (v / usdTop) * plotH;
  const yCnt = (v: number) => padT + plotH - (v / cntTop) * plotH;

  const payoutPts = data.map((d, i) => `${xAt(i)},${yUsd(d.otPayoutUsd ?? 0)}`).join(' ');
  const countPts = data.map((d, i) => `${xAt(i)},${yCnt(d.otEmployees)}`).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.ceil(n / 8);
  const latest = data[data.length - 1];
  const shortDay = (iso: string) => {
    const d = parseIsoLocal(iso);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : iso;
  };

  // Both tabs follow the CSV period selector authoritatively: '' uses the
  // cross-week aggregate; any other value is that week's server-fetched data.
  // The selector lists the same CSV periods as the roster.
  const isAggregate = statsPeriod === '';
  const activeLeaders = isAggregate ? leaders ?? [] : weekData[statsPeriod]?.leaders ?? [];
  const activeDepts = isAggregate ? depts ?? [] : weekData[statsPeriod]?.depts ?? [];
  const weekPending = !isAggregate && weekData[statsPeriod] === undefined;
  const statsPeriodOptions = [
    { value: '', label: 'All recent weeks' },
    ...periods.map((p) => ({ value: p.file, label: p.label })),
  ];
  const periodLabel = isAggregate
    ? `last ${n} week${n === 1 ? '' : 's'}`
    : periods.find((p) => p.file === statsPeriod)?.label ?? labelForSourceFile(statsPeriod);

  // Both lists rank by the chosen key. otPayoutUsd is FX-normalised so it ranks
  // correctly across currencies; fall back to PHP when no FX is available.
  const byMetric = <T extends { otHours: number; otPayoutPhp: number; otPayoutUsd: number | null }>(a: T, b: T) =>
    sort === 'pay'
      ? (b.otPayoutUsd ?? b.otPayoutPhp ?? 0) - (a.otPayoutUsd ?? a.otPayoutPhp ?? 0)
      : b.otHours - a.otHours;
  const lq = leaderQuery.trim().toLowerCase();

  const isPeople = tab === 'people';
  const sortedLeaders = activeLeaders.slice().sort(byMetric);
  const filteredLeaders = lq
    ? sortedLeaders.filter(
        (l) => (l.name ?? '').toLowerCase().includes(lq) || (l.email ?? '').toLowerCase().includes(lq),
      )
    : sortedLeaders;
  const sortedDepts = activeDepts.slice().sort(byMetric);
  const filteredDepts = lq ? sortedDepts.filter((d) => d.department.toLowerCase().includes(lq)) : sortedDepts;

  const activeCount = isPeople ? activeLeaders.length : activeDepts.length;
  const filteredCount = isPeople ? filteredLeaders.length : filteredDepts.length;
  const leaderTotalPages = Math.max(1, Math.ceil(filteredCount / LEADERS_PER_PAGE));
  const leaderSafePage = Math.min(leaderPage, leaderTotalPages);
  const leaderStart = (leaderSafePage - 1) * LEADERS_PER_PAGE;
  const pageLeaders = filteredLeaders.slice(leaderStart, leaderStart + LEADERS_PER_PAGE);
  const pageDepts = filteredDepts.slice(leaderStart, leaderStart + LEADERS_PER_PAGE);
  // Re-animate the standings body whenever the tab, period, sort, or page change
  // (but NOT on each search keystroke — that would feel janky).
  const contentKey = `${tab}|${statsPeriod}|${sort}|${leaderSafePage}`;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      {/* LEFT column: KPIs + the OT-by-employee chart + the OT-by-department chart. */}
      <div className="space-y-3 lg:space-y-4">
      {/* Latest-week headline */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <Banknote className="h-3.5 w-3.5 text-emerald-500" /> Latest week OT payout
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmtMoney(latest.otPayoutUsd ?? 0, 'USD')}</span>
            <span className="text-[12px] tabular-nums text-zinc-400">{fmtMoney(latest.otPayoutPhp ?? 0, 'PHP')}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{shortDay(latest.weekStart)} – {shortDay(latest.weekEnd)}</div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Latest week on overtime
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{latest.otEmployees}</span>
            <span className="text-[12px] text-zinc-400">people · {fmtHours(latest.otHours)} OT</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">across {n} week{n === 1 ? '' : 's'}</div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> OT payout (USD)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" /> Employees on OT</span>
        </div>
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Weekly overtime trend" onMouseLeave={() => setHover(null)}>
            {grid.map((g, gi) => {
              const y = padT + plotH - g * plotH;
              return (
                <g key={gi}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} />
                  <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-emerald-600 dark:fill-emerald-400" fontSize={10}>{fmtUsdAxis(g * usdTop)}</text>
                  <text x={W - padR + 8} y={y + 3} textAnchor="start" className="fill-amber-600 dark:fill-amber-400" fontSize={10}>{Math.round(g * cntTop)}</text>
                </g>
              );
            })}
            {data.map((d, i) =>
              i % labelEvery === 0 || i === n - 1 ? (
                <text key={`x${i}`} x={xAt(i)} y={H - padB + 16} textAnchor="middle" className={cn('fill-zinc-400', hover === i && 'fill-zinc-700 dark:fill-zinc-200')} fontSize={9}>
                  {shortDay(d.weekStart)}
                </text>
              ) : null,
            )}
            {/* hover guide */}
            {hover != null && (
              <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + plotH} stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth={1} strokeDasharray="3 3" />
            )}
            <polyline points={payoutPts} fill="none" stroke="currentColor" className="text-emerald-500" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={countPts} fill="none" stroke="currentColor" className="text-amber-500" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {data.map((d, i) => (
              <g key={`m${i}`}>
                <circle cx={xAt(i)} cy={yUsd(d.otPayoutUsd ?? 0)} r={hover === i ? 4 : 2.5} className={cn('fill-emerald-500', hover === i && 'stroke-white dark:stroke-zinc-950')} strokeWidth={hover === i ? 1.5 : 0} />
                <circle cx={xAt(i)} cy={yCnt(d.otEmployees)} r={hover === i ? 4 : 2.5} className={cn('fill-amber-500', hover === i && 'stroke-white dark:stroke-zinc-950')} strokeWidth={hover === i ? 1.5 : 0} />
              </g>
            ))}
            {/* transparent per-week hit areas (on top) for hover detection */}
            {data.map((d, i) => {
              const band = n > 1 ? plotW / (n - 1) : plotW;
              return (
                <rect
                  key={`hit${i}`}
                  x={xAt(i) - band / 2}
                  y={padT}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              );
            })}
          </svg>

          {/* Hover tooltip — week totals + top 5 OT renderers, tracking the point. */}
          {hover != null && (
            <div
              className="pointer-events-none absolute top-1 z-20 w-52 -translate-x-1/2"
              style={{ left: `${Math.min(84, Math.max(16, (xAt(hover) / W) * 100))}%` }}
            >
              <div className="rounded-lg border border-zinc-200 bg-white/95 p-2.5 text-[11px] shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
                <div className="font-semibold text-zinc-800 dark:text-zinc-100">
                  {shortDay(data[hover].weekStart)} – {shortDay(data[hover].weekEnd)}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-500">
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(data[hover].otPayoutUsd ?? 0, 'USD')}</span>
                  <span className="text-zinc-300 dark:text-zinc-600">·</span>
                  <span className="font-medium text-amber-600 dark:text-amber-400">{data[hover].otEmployees} on OT</span>
                </div>
                {(data[hover].leaders ?? []).length > 0 ? (
                  <div className="mt-1.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Top OT renderers</div>
                    <ul className="space-y-0.5">
                      {(data[hover].leaders ?? []).slice(0, 5).map((t, ti) => (
                        <li key={ti} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-200">
                            <span className="text-zinc-400">{ti + 1}.</span> {t.name ?? '—'}
                          </span>
                          <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{fmtHours(t.otHours)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="mt-1 text-[10px] text-zinc-400">No overtime this week.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* OT by department over time — stacked directly under the employee chart. */}
      <DeptTrendChart points={data} depts={depts} accent={accent} />
      </div>{/* end LEFT column */}

      {/* RIGHT column — OT leaderboard: everyone who rendered OT across the
          recent weeks, ranked by total OT hours or total OT pay (paginated to
          10). Only people with OT appear, so it is "OT only" by construction. */}
      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">OT standings</div>
            <div className="text-[11px] text-zinc-400">
              {weekPending ? '…' : activeCount}{' '}
              {isPeople
                ? activeCount === 1 ? 'person' : 'people'
                : activeCount === 1 ? 'department' : 'departments'}{' '}
              on overtime · {periodLabel}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* CSV period selector — same list as the roster; authoritatively
                scopes the leaderboard to one week (or the recent aggregate). */}
            <SmoothSelect
              value={statsPeriod}
              onChange={(v) => { setStatsPeriod(v); setLeaderPage(1); }}
              aria-label="Leaderboard pay week"
              className="w-full shrink-0 sm:w-52"
              options={statsPeriodOptions}
            />
            {/* Sort toggle so the two rankings can be told apart. */}
            <div className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {([['hours', 'Top OT hours'], ['pay', 'Top OT pay']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setSort(key); setLeaderPage(1); }}
                  aria-pressed={sort === key}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                    sort === key
                      ? cn('shadow-sm', accent.chipBg, accent.chipText)
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* People | Department tabs + a search bar scoped to the active tab. */}
        <div className="flex flex-col gap-2 border-b border-zinc-200 px-3 py-2 sm:flex-row sm:items-center dark:border-zinc-800">
          <div className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
            {([['people', 'People'], ['department', 'Department']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setLeaderPage(1); setLeaderQuery(''); }}
                aria-pressed={tab === key}
                className={cn(
                  'rounded-md px-3 py-1 text-[12px] font-medium transition-colors',
                  tab === key
                    ? cn('shadow-sm', accent.chipBg, accent.chipText)
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {!weekPending && activeCount > 0 && (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                type="search"
                placeholder={isPeople ? 'Search name or email…' : 'Search department…'}
                value={leaderQuery}
                onChange={(e) => { setLeaderQuery(e.target.value); setLeaderPage(1); }}
                className={cn('h-8 pl-8 text-[13px]', accent.ring)}
                aria-label={isPeople ? 'Search OT people' : 'Search OT departments'}
              />
            </div>
          )}
        </div>
        <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={contentKey}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
        {weekPending ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading {periodLabel}…
          </div>
        ) : activeCount === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            {isAggregate ? 'No overtime in the recent weeks.' : 'No overtime this week.'}
          </div>
        ) : filteredCount === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            No {isPeople ? 'one' : 'department'} matches “{leaderQuery.trim()}”.
          </div>
        ) : isPeople ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">Person</th>
                  <th className="px-3 py-2.5 font-medium text-right">OT hours</th>
                  <th className="px-4 py-2.5 font-medium text-right">OT pay</th>
                </tr>
              </thead>
              <tbody>
                {pageLeaders.map((l, i) => (
                  <tr
                    key={`${l.email ?? l.name ?? 'leader'}|${leaderStart + i}`}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-zinc-400" data-label="#">{leaderStart + i + 1}</td>
                    <td className="px-3 py-2.5" data-label="Person">
                      <div className="flex items-center gap-2.5">
                        <TeamAvatar name={l.name ?? ''} email={l.email} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">{l.name ?? '—'}</div>
                          <div className="truncate text-[11px] text-zinc-400">{l.email ?? ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-amber-600 dark:text-amber-400" data-label="OT hours">
                      {fmtHours(l.otHours)}
                    </td>
                    <td className="px-4 py-2.5 text-right" data-label="OT pay">
                      <div className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(l.otPayoutUsd ?? 0, 'USD')}</div>
                      <div className="text-[11px] tabular-nums text-zinc-400">{fmtMoney(l.otPayoutPhp ?? 0, 'PHP')}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-3 py-2.5 font-medium">Department</th>
                  <th className="px-3 py-2.5 font-medium text-right">People</th>
                  <th className="px-3 py-2.5 font-medium text-right">OT hours</th>
                  <th className="px-4 py-2.5 font-medium text-right">OT pay</th>
                </tr>
              </thead>
              <tbody>
                {pageDepts.map((d, i) => (
                  <tr
                    key={`${d.department}|${leaderStart + i}`}
                    className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
                  >
                    <td className="px-4 py-2.5 tabular-nums text-zinc-400" data-label="#">{leaderStart + i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-zinc-900 dark:text-zinc-100" data-label="Department">{d.department}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300" data-label="People">{d.people}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-amber-600 dark:text-amber-400" data-label="OT hours">
                      {fmtHours(d.otHours)}
                    </td>
                    <td className="px-4 py-2.5 text-right" data-label="OT pay">
                      <div className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(d.otPayoutUsd ?? 0, 'USD')}</div>
                      <div className="text-[11px] tabular-nums text-zinc-400">{fmtMoney(d.otPayoutPhp ?? 0, 'PHP')}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </motion.div>
        </AnimatePresence>
        {leaderTotalPages > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-2.5 text-[12px] text-zinc-500 dark:border-zinc-800">
            <span className="tabular-nums">
              {leaderStart + 1}–{Math.min(leaderStart + LEADERS_PER_PAGE, filteredCount)} of {filteredCount}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={leaderSafePage <= 1}
                onClick={() => setLeaderPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="tabular-nums text-zinc-600 dark:text-zinc-300">Page {leaderSafePage} of {leaderTotalPages}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={leaderSafePage >= leaderTotalPages}
                onClick={() => setLeaderPage((p) => Math.min(leaderTotalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stroke + dot palette for the department trend lines (and legend). */
const DEPT_COLORS = [
  { line: 'text-emerald-500', dot: 'bg-emerald-500' },
  { line: 'text-sky-500', dot: 'bg-sky-500' },
  { line: 'text-amber-500', dot: 'bg-amber-500' },
  { line: 'text-violet-500', dot: 'bg-violet-500' },
  { line: 'text-rose-500', dot: 'bg-rose-500' },
  { line: 'text-teal-500', dot: 'bg-teal-500' },
];

/**
 * Department OT trend — a multi-line chart (one line per top department) showing
 * how each department's OT pay or OT hours moves across the recent weeks. Sits
 * below the headline trend chart so you can see which departments drive OT.
 */
function DeptTrendChart({
  points,
  depts,
  accent,
}: {
  points: StatsPoint[];
  depts: StatsDept[] | null;
  accent: Accent;
}) {
  const [metric, setMetric] = useState<OtSort>('pay');
  const [hover, setHover] = useState<number | null>(null);

  const ranked = [...(depts ?? [])].sort((a, b) =>
    metric === 'pay'
      ? (b.otPayoutUsd ?? b.otPayoutPhp ?? 0) - (a.otPayoutUsd ?? a.otPayoutPhp ?? 0)
      : b.otHours - a.otHours,
  );
  const top = ranked.slice(0, DEPT_COLORS.length);
  if (points.length === 0 || top.length === 0) return null;

  const valueFor = (p: StatsPoint, dept: string) => {
    const d = (p.depts ?? []).find((x) => x.department === dept);
    if (!d) return 0;
    return metric === 'pay' ? d.otPayoutUsd ?? d.otPayoutPhp ?? 0 : d.otHours;
  };
  const series = top.map((d, idx) => ({
    dept: d.department,
    color: DEPT_COLORS[idx % DEPT_COLORS.length],
    values: points.map((p) => valueFor(p, d.department)),
  }));

  const W = 760;
  const H = 210;
  const padL = 52;
  const padR = 14;
  const padT = 12;
  const padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;
  const xAt = (i: number) => (n === 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));
  const top0 = niceCeil(Math.max(1, ...series.flatMap((s) => s.values)));
  const yAt = (v: number) => padT + plotH - (v / top0) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.ceil(n / 8);
  const shortDay = (iso: string) => {
    const d = parseIsoLocal(iso);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : iso;
  };
  const fmtVal = (v: number) => (metric === 'pay' ? fmtMoney(v, 'USD') : fmtHours(v));
  const fmtAxis = (v: number) => (metric === 'pay' ? fmtUsdAxis(v) : String(Math.round(v)));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
          OT by department over time
          <span className="ml-2 text-[11px] font-normal text-zinc-400">
            top {top.length} of {ranked.length}
          </span>
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
          {([['pay', 'OT pay'], ['hours', 'OT hours']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMetric(key)}
              aria-pressed={metric === key}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                metric === key
                  ? cn('shadow-sm', accent.chipBg, accent.chipText)
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
        {series.map((s) => (
          <span key={s.dept} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', s.color.dot)} />
            <span className="max-w-[120px] truncate">{s.dept}</span>
          </span>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Department overtime trend" onMouseLeave={() => setHover(null)}>
          {grid.map((g, gi) => {
            const y = padT + plotH - g * plotH;
            return (
              <g key={gi}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth={1} />
                <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-zinc-400" fontSize={10}>{fmtAxis(g * top0)}</text>
              </g>
            );
          })}
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={`x${i}`} x={xAt(i)} y={H - padB + 16} textAnchor="middle" className={cn('fill-zinc-400', hover === i && 'fill-zinc-700 dark:fill-zinc-200')} fontSize={9}>
                {shortDay(p.weekStart)}
              </text>
            ) : null,
          )}
          {hover != null && (
            <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + plotH} stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth={1} strokeDasharray="3 3" />
          )}
          {series.map((s) => (
            <polyline key={s.dept} points={s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')} fill="none" stroke="currentColor" className={s.color.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover != null &&
            series.map((s) => (
              <circle key={`dot-${s.dept}`} cx={xAt(hover)} cy={yAt(s.values[hover])} r={3.5} fill="currentColor" className={s.color.line} />
            ))}
          {points.map((p, i) => {
            const band = n > 1 ? plotW / (n - 1) : plotW;
            return <rect key={`hit${i}`} x={xAt(i) - band / 2} y={padT} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />;
          })}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute top-1 z-20 w-48 -translate-x-1/2" style={{ left: `${Math.min(86, Math.max(14, (xAt(hover) / W) * 100))}%` }}>
            <div className="rounded-lg border border-zinc-200 bg-white/95 p-2.5 text-[11px] shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
              <div className="font-semibold text-zinc-800 dark:text-zinc-100">
                {shortDay(points[hover].weekStart)} – {shortDay(points[hover].weekEnd)}
              </div>
              <ul className="mt-1 space-y-0.5">
                {series.map((s) => (
                  <li key={s.dept} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', s.color.dot)} />
                      <span className="truncate text-zinc-700 dark:text-zinc-200">{s.dept}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{fmtVal(s.values[hover])}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RosterSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-zinc-100 px-3 py-3 last:border-0 dark:border-zinc-900"
        >
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-2.5 w-52 max-w-[60%]" />
          </div>
          <Skeleton className="hidden h-3.5 w-24 sm:block" />
          <Skeleton className="hidden h-3.5 w-20 md:block" />
          <Skeleton className="h-7 w-14 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function HoursCell({ hours }: { hours: Hours }) {
  const ot = hours.projectedOt ?? hours.ot;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{fmtHours(hours.thisWeek)}</span>
        {hours.ot > 0 && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-950/30 dark:text-red-300">
            +{fmtHours(hours.ot)} OT
          </span>
        )}
      </div>
      {hours.inProgress && hours.projectedHours != null && (
        <span className="flex items-center gap-1 text-[10.5px] text-zinc-400">
          <Clock className="h-3 w-3" />
          on track for {fmtHours(hours.projectedHours)}
          {ot > 0 && <span className="text-red-500">({fmtHours(ot)} OT)</span>}
        </span>
      )}
    </div>
  );
}

/* ── Person detail (banking + payroll history) ──────────────────────────── */

function PersonDetailDialog({
  row,
  accent,
  canEdit,
  onClose,
  onSendTransfer,
}: {
  row: RosterRow;
  accent: Accent;
  canEdit: boolean;
  onClose: () => void;
  onSendTransfer: () => void;
}) {
  const [tab, setTab] = useState<'details' | 'pab'>('details');
  // Mount the PAB calendar on first visit, then keep it mounted (hidden when
  // inactive) so switching tabs never re-fetches its data.
  const [pabVisited, setPabVisited] = useState(false);
  const [pabLoading, setPabLoading] = useState(true);
  const [pabProgress, setPabProgress] = useState(0);
  const [showPabLoader, setShowPabLoader] = useState(true);
  const handlePabLoaderDone = useCallback(() => setShowPabLoader(false), []);
  const [banking, setBanking] = useState<Banking | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  // Banking & payout stays hidden until the viewer explicitly reveals it.
  const [showBanking, setShowBanking] = useState(false);
  const isHsl = (row.department ?? '').trim().toLowerCase() === 'hsl';
  const [histPage, setHistPage] = useState(1);
  const histDirRef = useRef<1 | -1>(1);
  const reduceMotion = useReducedMotion();
  const HIST_PAGE_SIZE = 5;
  const email = row.work_email ?? '';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/people/${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { banking?: Banking | null; history?: HistoryRow[] }) => {
        if (!alive) return;
        setBanking(j.banking ?? null);
        setHistory(j.history ?? []);
        setHistPage(1);
      })
      .catch(() => { if (alive) setBanking(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [email]);

  // Paginate the history list — 6 newest-first per page. safePage clamps if the
  // set shrinks (e.g. after a reveal/refresh) so we never land out of range.
  const histTotalPages = Math.max(1, Math.ceil(history.length / HIST_PAGE_SIZE));
  const histSafePage = Math.min(histPage, histTotalPages);
  const histStart = (histSafePage - 1) * HIST_PAGE_SIZE;
  const pagedHistory = history.slice(histStart, histStart + HIST_PAGE_SIZE);

  const goPage = (dir: 1 | -1) => {
    histDirRef.current = dir;
    setHistPage((p) => Math.min(histTotalPages, Math.max(1, p + dir)));
  };

  // Show only the bank the employee designated as preferred in their portal
  // (primary vs alternative slot) — not both. The alternative slot has no
  // SWIFT/address fields, so those collapse when it's the preferred one.
  const prefAlt = banking?.preferred_bank_slot === 'alternative';
  const prefBank = {
    name: (prefAlt ? banking?.alt_bank_name : banking?.bank_name) ?? null,
    holder: (prefAlt ? banking?.alt_account_holder_name : banking?.account_holder_name) ?? null,
    account: (prefAlt ? banking?.alt_account_number : banking?.account_number) ?? null,
    routing: (prefAlt ? banking?.alt_routing_number : banking?.routing_number) ?? null,
    swift: (prefAlt ? null : banking?.swift_code) ?? null,
    address: (prefAlt ? null : banking?.full_address) ?? null,
  };
  // Only the employee's CHOSEN processor's payout details are relevant. Other
  // columns can hold stale/duplicated data (legacy seeds), so we never show a
  // rail the employee didn't pick. `wires` → the preferred bank; otherwise the
  // single processor field. Unknown/empty processor falls back to a bank if one
  // exists, else nothing.
  const proc = (banking?.preferred_processor ?? '').trim().toLowerCase();
  const showBank = proc === 'wires' || (!proc && !!prefBank.name);

  const reveal = async () => {
    setRevealing(true);
    try {
      const res = await fetch(`/api/people/${encodeURIComponent(email)}/reveal-banking`, { method: 'POST' });
      const j = (await res.json()) as { banking?: Banking | null; error?: string };
      if (!res.ok) throw new Error(j.error || 'Reveal failed');
      if (j.banking) setBanking(j.banking);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reveal banking');
      return false;
    } finally {
      setRevealing(false);
    }
  };

  // Toggle the Banking & payout block. Revealing masked records fetches the
  // unmasked values first (audit-logged); hiding is purely visual.
  const toggleBanking = async () => {
    if (showBanking) { setShowBanking(false); return; }
    if (banking?.masked) {
      const ok = await reveal();
      if (!ok) return; // keep hidden if the reveal failed
    }
    setShowBanking(true);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
        <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <TeamAvatar name={row.name ?? ''} email={row.work_email} size="xl" />
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg">{row.name ?? '—'}</DialogTitle>
              <DialogDescription className="truncate">
                {row.department ?? '—'} · {row.work_email ?? row.employee_id ?? ''}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div role="tablist" className="flex shrink-0 gap-1 border-b border-zinc-200 px-3 dark:border-zinc-800">
          {([['details', 'Details'], ['pab', 'PAB Calendar']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => { setTab(id); if (id === 'pab') setPabVisited(true); }}
              className={cn(
                'relative px-3 py-2.5 text-[13px] font-medium transition-colors',
                tab === id
                  ? 'text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {label}
              {tab === id && <span className={cn('absolute inset-x-2 -bottom-px h-0.5 rounded-full', accent.bar)} />}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === 'details' && (
          <>
          {/* Snapshot cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Hours this week" value={fmtHours(row.hours.thisWeek)} sub={row.hours.ot > 0 ? `+${fmtHours(row.hours.ot)} OT` : 'no OT'} />
            <StatCard
              label="On track for"
              value={row.hours.inProgress && row.hours.projectedHours != null ? fmtHours(row.hours.projectedHours) : '—'}
              sub={
                row.hours.inProgress && (row.hours.projectedOt ?? 0) > 0
                  ? `${fmtHours(row.hours.projectedOt)} projected OT`
                  : row.hours.inProgress ? 'within 40h' : 'week complete'
              }
            />
            <StatCard
              label="Pay rate"
              value={row.rate.regular != null ? `${fmtMoney(row.rate.regular, row.rate.currency)}/hr` : 'not set'}
              sub={row.rate.ot != null ? `OT ${fmtMoney(row.rate.ot, row.rate.currency)}` : (row.rate.source ?? '')}
            />
          </div>

          {/* Banking */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Banking & payout</h3>
              {!loading && (
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={toggleBanking} disabled={revealing}>
                  {revealing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : showBanking ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                  {showBanking ? 'Hide' : 'Reveal'}
                </Button>
              )}
            </div>
            {loading ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="space-y-1.5">
                      <Skeleton className="h-2.5 w-16" />
                      <Skeleton className="h-3.5 w-32" />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
              {!showBanking ? (
                <motion.button
                  key="hidden"
                  type="button"
                  onClick={toggleBanking}
                  disabled={revealing}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.14 }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-4 text-[12px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Payout details hidden — click to reveal
                </motion.button>
              ) : (
                <motion.div
                  key="shown"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-900/40">
                {!banking ? (
                  <p className="mb-2 text-[11px] text-zinc-400">No payout details on file yet — these fields will populate once the employee completes their payout setup.</p>
                ) : banking.masked ? (
                  <p className="mb-2 text-[11px] text-zinc-400">Sensitive fields are masked. Reveal is recorded in the audit log.</p>
                ) : null}
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  <Field label="Processor" value={banking ? (banking.preferred_processor || 'Not set') : null} cap />
                  {/* No banking record → show the canonical bank/wires field set as
                      placeholders so the CEO sees where details are expected. */}
                  {(showBank || !banking) && (
                    <>
                      <Field label={`Bank${prefAlt ? ' (alternative)' : ''}`} value={prefBank.name} />
                      <Field label="Account holder" value={prefBank.holder} />
                      <Field label="Account no." value={prefBank.account} mono />
                      <Field label="SWIFT" value={prefBank.swift} mono />
                      <Field label="Routing" value={prefBank.routing} mono />
                      <Field label="Address" value={prefBank.address} wide />
                    </>
                  )}
                  {proc === 'hurupay' && <Field label="Hurupay email" value={banking?.hurupay_email ?? null} />}
                  {proc === 'wepay' && <Field label="WePay email" value={banking?.wepay_email ?? null} />}
                  {proc === 'higlobe' && (
                    <>
                      <Field label="HiGlobe email" value={banking?.higlobe_email ?? null} />
                      <Field label="HiGlobe account" value={banking?.higlobe_account_name ?? null} />
                    </>
                  )}
                  {proc === 'wise' && (
                    <>
                      <Field label="Wise email" value={banking?.wise_email ?? null} />
                      <Field label="Wise tag" value={banking?.wise_tag ?? null} />
                    </>
                  )}
                  {proc === 'jeeves' && <Field label="Phone" value={banking?.phone_number ?? null} mono />}
                </dl>
                </div>
                </motion.div>
              )}
              </AnimatePresence>
            )}
          </div>

          {/* Payroll history */}
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Payroll history</h3>
            {loading ? (
              <ul className="space-y-1.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-44" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="ml-auto h-3.5 w-20" />
                      <Skeleton className="ml-auto h-2.5 w-12" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : history.length === 0 ? (
              <p className="py-3 text-xs text-zinc-400">No payroll records yet.</p>
            ) : (
              <>
              <AnimatePresence mode="wait" custom={histDirRef.current} initial={false}>
              <motion.ul
                key={histSafePage}
                custom={histDirRef.current}
                variants={{
                  enter: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * 18 }),
                  center: { opacity: 1, x: 0 },
                  exit: (d: number) => (reduceMotion ? { opacity: 0 } : { opacity: 0, x: d * -18 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-1.5"
              >
                {pagedHistory.map((h, i) => (
                  <li
                    key={`${h.source_file}-${histStart + i}`}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]',
                      h.kind === 'special'
                        ? 'border-violet-200 bg-violet-50/60 dark:border-violet-900/40 dark:bg-violet-950/20'
                        : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {h.kind === 'special' && (
                          <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                            <Sparkles className="h-2.5 w-2.5" /> Special
                          </span>
                        )}
                        <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">
                          {h.kind === 'special' ? (h.note || 'Special transfer') : formatPeriodRange(h.period_start, h.period_end)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">
                        {h.kind === 'special'
                          ? formatDay(h.paid_at ?? h.period_start)
                          : `${fmtHours(h.total_hours)} · ${(h.status ?? 'pending')}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold text-zinc-900 dark:text-zinc-100">{fmtMoney(h.amount_php, 'PHP')}</div>
                      <div className={cn(
                        'text-[10.5px] font-medium',
                        h.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
                      )}>
                        {h.status ?? 'pending'}
                      </div>
                    </div>
                  </li>
                ))}
              </motion.ul>
              </AnimatePresence>
              {histTotalPages > 1 && (
                <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
                  <span>
                    Showing {histStart + 1}–{Math.min(histStart + HIST_PAGE_SIZE, history.length)} of {history.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={histSafePage <= 1}
                      onClick={() => goPage(-1)}
                    >
                      Prev
                    </Button>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                      {histSafePage} / {histTotalPages}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[12px]"
                      disabled={histSafePage >= histTotalPages}
                      onClick={() => goPage(1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
          </>
          )}

          {pabVisited && (
            <div className={cn('relative', tab === 'pab' ? '' : 'hidden')}>
              {/* Progress bar sits INSIDE the calendar box, centered over the
                  skeleton (which stays visible around it) — they load together,
                  and the bar only completes once the data actually lands. */}
              {showPabLoader && (
                <PabLoader progress={pabProgress} done={!pabLoading} accent={accent} onDone={handlePabLoaderDone} />
              )}
              <EmployeePabCalendar
                employeeEmail={email}
                isHsl={isHsl}
                trimToElapsedWeeks={false}
                onLoadingChange={setPabLoading}
                onProgress={setPabProgress}
              />
            </div>
          )}
        </div>

        {/* Footer — a plain section (NOT DialogFooter, whose -mx-4/-mb-4 breakout
            margins fight this p-0 + overflow-hidden dialog and clip the button
            against the edge). Mirrors the header: full-bleed border-t, tinted bar,
            helper text left + action right, stacking on mobile. */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-zinc-200 bg-zinc-50/70 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:border-zinc-800 dark:bg-zinc-900/40">
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            {canEdit
              ? 'One-off payment, recorded straight into payroll history.'
              : 'View only — special transfers require edit access.'}
          </p>
          {canEdit && (
            <Button
              type="button"
              onClick={onSendTransfer}
              className={cn(
                'h-10 shrink-0 gap-2 px-4 font-medium shadow-sm transition-transform active:scale-[0.98]',
                accent.btn,
              )}
            >
              <Send className="h-4 w-4" />
              Send special transfer
            </Button>
          )}
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Real-progress overlay for the PAB calendar's first load. Driven by the
 * calendar's actual hours-fetch progress (`progress` 0→1, climbs as each file
 * lands) so the bar genuinely TRAVELS instead of parking at a guessed ceiling. A
 * tiny time-based floor (0→15%) only covers the brief startup gap before the
 * fetch starts reporting. Snaps to 100% and fades once `done`. Live values flow
 * through refs so the rAF loop never restarts.
 */
function PabLoader({
  progress,
  done,
  accent,
  onDone,
}: {
  progress: number;
  done: boolean;
  accent: Accent;
  onDone: () => void;
}) {
  const reduce = useReducedMotion();
  const [pct, setPct] = useState(0);
  const progressRef = useRef(progress);
  const doneRef = useRef(done);
  const onDoneRef = useRef(onDone);
  progressRef.current = progress;
  doneRef.current = done;
  onDoneRef.current = onDone;

  useEffect(() => {
    if (reduce) {
      const id = window.setInterval(() => {
        if (doneRef.current) {
          setPct(100);
          window.clearInterval(id);
          window.setTimeout(() => onDoneRef.current(), 200);
        } else {
          setPct(Math.min(95, Math.round(progressRef.current * 95)));
        }
      }, 150);
      return () => window.clearInterval(id);
    }
    let raf = 0;
    let finished = false;
    let doneSince = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(80, now - last);
      last = now;
      setPct((p) => {
        const d = doneRef.current;
        if (d && !doneSince) doneSince = now;
        const stable = d && now - doneSince > 150;
        let next: number;
        if (stable) {
          next = p + (100 - p) * 0.25;
          if (next > 99.5) next = 100;
        } else {
          // Startup floor (→15%) keeps it moving before the hours fetch reports;
          // after that REAL file progress (progress*95) leads the bar.
          const floor = Math.min(15, p + dt * 0.03);
          const target = Math.max(floor, progressRef.current * 95);
          next = p + (target - p) * 0.16;
          if (next < p) next = p; // never go backwards
          else if (target > p && next - p < 0.06) next = p + 0.06; // a hair of motion
          if (next > 98) next = 98;
        }
        if (next >= 100 && !finished) {
          finished = true;
          window.setTimeout(() => onDoneRef.current(), 180);
        }
        return next;
      });
      if (!finished) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-300 motion-reduce:transition-none"
      style={{ opacity: pct >= 100 ? 0 : 1 }}
      aria-hidden
    >
      <div className="w-48 max-w-[70%] rounded-xl border border-zinc-200/80 bg-white/90 px-3.5 py-3 shadow-lg shadow-zinc-900/5 backdrop-blur-sm dark:border-zinc-800/80 dark:bg-zinc-950/90">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Loading…</span>
          <span className="text-[13px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{Math.round(pct)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className={cn('h-full rounded-full', accent.bar)} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function Field({ label, value, mono, cap, wide }: { label: string; value: string | null; mono?: boolean; cap?: boolean; wide?: boolean }) {
  const empty = !value;
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-[10.5px] uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd
        className={cn(
          empty
            ? 'italic text-zinc-400 dark:text-zinc-500'
            : cn('text-zinc-800 dark:text-zinc-100', mono && 'font-mono', cap && 'capitalize'),
        )}
      >
        {empty ? 'Not yet filled' : value}
      </dd>
    </div>
  );
}

/* ── Special transfer modal ─────────────────────────────────────────────── */

function SpecialTransferDialog({
  row,
  accent,
  onClose,
  onDone,
}: {
  row: RosterRow;
  accent: Accent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [fx, setFx] = useState<number | null>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/app-settings?keys=usd_to_php_rate', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { values?: Record<string, string | null> } | null) => {
        if (!alive || !j?.values) return;
        const n = parseFloat(String(j.values.usd_to_php_rate ?? ''));
        if (Number.isFinite(n) && n > 0) setFx(n);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const amountNum = parseFloat(amount.replace(/[^\d.]/g, ''));
  const usdPreview = fx && Number.isFinite(amountNum) && amountNum > 0 ? amountNum / fx : null;
  const valid = Number.isFinite(amountNum) && amountNum > 0 && !!date && reason.trim().length > 0;

  const submit = async () => {
    if (!valid || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/people/special-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: row.work_email,
          amount_php: amountNum,
          sent_date: date,
          reason: reason.trim(),
          notify,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; notified?: boolean };
      if (!res.ok || !j.ok) throw new Error(j.error || 'Transfer failed');
      toast.success(`Special transfer of ${fmtMoney(amountNum)} recorded for ${row.name ?? row.work_email}.`);
      onDone();
    } catch (e) {
      submittedRef.current = false;
      toast.error(e instanceof Error ? e.message : 'Could not record transfer');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="space-y-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className={cn('flex h-7 w-7 items-center justify-center rounded-full', accent.btn)}>
              <Send className="h-3.5 w-3.5" />
            </span>
            Special transfer
          </DialogTitle>
          <DialogDescription className="sr-only">
            Record a one-off payment to {row.name ?? row.work_email}.
          </DialogDescription>
          {/* Recipient context — confirm who's being paid before any numbers. */}
          <div className="flex items-center gap-2.5 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900/50">
            <TeamAvatar name={row.name ?? ''} email={row.work_email} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name ?? row.work_email}</div>
              <div className="truncate text-[11px] text-zinc-500">{row.department ?? row.work_email ?? ''}</div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {/* Amount — the primary value, given the most visual weight. */}
          <div>
            <label htmlFor="st-amount" className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Amount</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base font-medium text-zinc-400">₱</span>
              <Input
                id="st-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn('h-11 pl-8 text-lg font-semibold tabular-nums', accent.ring)}
                autoFocus
              />
            </div>
            {/* Fixed height so the preview appearing doesn't shift the form. */}
            <p className="mt-1 h-4 text-[11px] text-zinc-400">
              {usdPreview != null ? `≈ ${fmtMoney(usdPreview, 'USD')} at the current FX rate` : 'Philippine pesos'}
            </p>
          </div>

          <div>
            <label htmlFor="st-date" className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Date sent</label>
            <Input id="st-date" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className={accent.ring} />
          </div>

          <div>
            <label htmlFor="st-reason" className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">Reason</label>
            <textarea
              id="st-reason"
              rows={2}
              placeholder="e.g. Reimbursement for client travel"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={cn(
                'w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-offset-2 placeholder:text-zinc-400 focus-visible:ring-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
                accent.ring,
              )}
            />
            <p className="mt-1 text-[11px] text-zinc-400">Shown on the employee&apos;s pay history and the audit log.</p>
          </div>

          <label htmlFor="st-notify" className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                Notify {row.name?.split(' ')[0] ?? 'the employee'}
              </span>
              <span className="block text-[11px] text-zinc-500">Sends a notification to their portal.</span>
            </span>
            <input
              id="st-notify"
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              className={cn('h-4 w-4 shrink-0 rounded border-zinc-300', accent.check)}
            />
          </label>

          {/* Plain-language confirmation, shown once the form is valid. */}
          {valid && (
            <div className={cn('rounded-lg px-3 py-2 text-[13px]', accent.chipBg, accent.chipText)}>
              Recording <span className="font-semibold tabular-nums">{fmtMoney(amountNum)}</span> to{' '}
              <span className="font-medium">{row.name?.split(' ')[0] ?? row.work_email}</span> on {formatDay(date)}.
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-zinc-200 bg-zinc-50/70 px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6 dark:border-zinc-800 dark:bg-zinc-900/40">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!valid || submitting}
            className={cn('gap-2 font-medium shadow-sm transition-transform active:scale-[0.98]', accent.btn)}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Record transfer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
