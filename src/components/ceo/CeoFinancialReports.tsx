'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  CalendarDays,
  ChevronDown,
  Clock,
  Coins,
  Download,
  LineChart as LineChartIcon,
  Minus,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getTabCache,
  setTabCache,
  hasFetchedThisSession,
  markFetchedThisSession,
} from '@/lib/accounting/tab-cache';
import AnimatedNumber from '@/components/payroll-clerk/AnimatedNumber';
import { PayoutTrendChart, type ChartPoint } from './financial-chart';
import type {
  FinancialReports,
  FinancialPeriodPoint,
  FinancialPeriodRecipient,
} from '@/lib/ceo/financial-reports';

const CACHE_KEY = 'ceo:financial-reports';

/* ── formatting ───────────────────────────────────────────────────────────── */

function fmtPhp(n: number): string {
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPhp0(n: number): string {
  return `₱${n.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}
function fmtUsd0(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
function fmtHours(n: number): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}h`;
}
/** "Apr 12" from an ISO date. */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${mo[+m[2]! - 1]} ${+m[3]!}`;
}
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Granularity = 'weekly' | 'monthly';
type Metric = 'payout' | 'people' | 'avg' | 'hours' | 'cumulative';
type TableView = 'timeline' | 'department' | 'recipients';

const METRICS: { key: Metric; label: string; accent: 'amber' | 'sky' | 'violet' | 'emerald' | 'rose' }[] = [
  { key: 'payout', label: 'Payout', accent: 'amber' },
  { key: 'cumulative', label: 'Cumulative', accent: 'emerald' },
  { key: 'people', label: 'People', accent: 'sky' },
  { key: 'avg', label: 'Avg / person', accent: 'violet' },
  { key: 'hours', label: 'Hours', accent: 'rose' },
];

/* ── monthly rollup ───────────────────────────────────────────────────────── */

/**
 * Roll the weekly cycles up into calendar-month points. Payout / paid / hours
 * are SUMMED (unambiguous monthly totals — the growth signal); headcount is the
 * MEAN weekly workforce (payroll people don't dedupe cleanly across weeks), and
 * avg/person is payout ÷ person-weeks (average weekly pay per active person).
 */
function rollupMonthly(weekly: FinancialPeriodPoint[]): FinancialPeriodPoint[] {
  const byMonth = new Map<string, FinancialPeriodPoint[]>();
  for (const p of weekly) {
    const key = (p.periodStart ?? p.sourceFile).slice(0, 7); // YYYY-MM
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(p);
  }
  const keys = Array.from(byMonth.keys()).sort();
  const out: FinancialPeriodPoint[] = [];
  let cumPhp = 0;
  let cumUsd = 0;
  let prevPayout = 0;
  let prevPeople = 0;

  for (const key of keys) {
    const weeks = byMonth.get(key)!;
    const payoutPhp = weeks.reduce((s, w) => s + w.payoutPhp, 0);
    const payoutUsd = weeks.reduce((s, w) => s + w.payoutUsd, 0);
    const paidPhp = weeks.reduce((s, w) => s + w.paidPhp, 0);
    const paidUsd = weeks.reduce((s, w) => s + w.paidUsd, 0);
    const paidCount = weeks.reduce((s, w) => s + w.paidCount, 0);
    const totalHours = weeks.reduce((s, w) => s + w.totalHours, 0);
    const personWeeks = weeks.reduce((s, w) => s + w.peopleCount, 0);
    const meanPeople = Math.round(personWeeks / weeks.length);
    cumPhp += payoutPhp;
    cumUsd += payoutUsd;

    // Merge department slices across the month.
    const deptMap = new Map<string, { people: number; payoutPhp: number; payoutUsd: number; hours: number; n: number }>();
    for (const w of weeks) {
      for (const d of w.byDepartment) {
        const cur = deptMap.get(d.department) ?? { people: 0, payoutPhp: 0, payoutUsd: 0, hours: 0, n: 0 };
        cur.people += d.peopleCount;
        cur.payoutPhp += d.payoutPhp;
        cur.payoutUsd += d.payoutUsd;
        cur.hours += d.hours;
        cur.n += 1;
        deptMap.set(d.department, cur);
      }
    }
    const byDepartment = Array.from(deptMap.entries())
      .map(([department, d]) => ({
        department,
        peopleCount: Math.round(d.people / d.n),
        payoutPhp: Math.round(d.payoutPhp * 100) / 100,
        payoutUsd: Math.round(d.payoutUsd * 100) / 100,
        hours: Math.round(d.hours * 100) / 100,
      }))
      .sort((a, b) => b.payoutPhp - a.payoutPhp);

    const [y, m] = key.split('-');
    out.push({
      sourceFile: `month:${key}`,
      reportName: `${MONTHS_LONG[+m! - 1]} ${y}`,
      periodStart: weeks[0]!.periodStart,
      periodEnd: weeks[weeks.length - 1]!.periodEnd,
      isCurrent: weeks.some((w) => w.isCurrent),
      payoutPhp: Math.round(payoutPhp * 100) / 100,
      payoutUsd: Math.round(payoutUsd * 100) / 100,
      paidPhp: Math.round(paidPhp * 100) / 100,
      paidUsd: Math.round(paidUsd * 100) / 100,
      paidCount,
      outstandingPhp: Math.round(Math.max(0, payoutPhp - paidPhp) * 100) / 100,
      outstandingUsd: Math.round(Math.max(0, payoutUsd - paidUsd) * 100) / 100,
      peopleCount: meanPeople,
      totalHours: Math.round(totalHours * 100) / 100,
      avgPerHeadPhp: personWeeks > 0 ? Math.round((payoutPhp / personWeeks) * 100) / 100 : 0,
      avgHoursPerHead: personWeeks > 0 ? Math.round((totalHours / personWeeks) * 100) / 100 : 0,
      cumulativePayoutPhp: Math.round(cumPhp * 100) / 100,
      cumulativePayoutUsd: Math.round(cumUsd * 100) / 100,
      payoutDeltaPct: prevPayout > 0 ? Math.round(((payoutPhp - prevPayout) / prevPayout) * 1000) / 10 : null,
      peopleDeltaPct: prevPeople > 0 ? Math.round(((meanPeople - prevPeople) / prevPeople) * 1000) / 10 : null,
      byDepartment,
    });
    prevPayout = payoutPhp;
    prevPeople = meanPeople;
  }
  return out;
}

/* ── delta chip ───────────────────────────────────────────────────────────── */

function DeltaChip({ pct, invertColor = false }: { pct: number | null; invertColor?: boolean }) {
  if (pct == null) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
        <Minus className="h-3 w-3" /> —
      </span>
    );
  }
  const up = pct > 0;
  const flat = pct === 0;
  // Growth framing: up = good (emerald). invertColor flips it (e.g. for costs).
  const good = invertColor ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums',
        flat
          ? 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
          : good
            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
      )}
    >
      <Icon className="h-3 w-3" />
      {up ? '+' : ''}
      {pct}%
    </span>
  );
}

/* ── KPI card ─────────────────────────────────────────────────────────────── */

function KpiCard({
  Icon,
  label,
  value,
  formatter,
  sub,
  delta,
  iconClass,
  index,
}: {
  Icon: LucideIcon;
  label: string;
  value: number;
  formatter: (n: number) => string;
  sub?: string;
  delta?: number | null;
  iconClass: string;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          <Icon className={cn('h-3.5 w-3.5', iconClass)} /> {label}
        </div>
        {delta !== undefined && <DeltaChip pct={delta} />}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-900 tabular-nums lg:text-[26px] dark:text-zinc-100">
        <AnimatedNumber value={value} formatter={formatter} />
      </div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-zinc-400">{sub}</div>}
    </motion.div>
  );
}

/* ── skeleton ─────────────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="flex flex-col gap-4 lg:gap-5" aria-busy="true">
      <div className="h-20 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
        ))}
      </div>
      <div className="h-[320px] animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-64 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}

/* ── main ─────────────────────────────────────────────────────────────────── */

export default function CeoFinancialReports({ viewerEmail: _viewerEmail }: { viewerEmail: string | null }) {
  const [data, setData] = useState<FinancialReports | null>(() => getTabCache<FinancialReports>(CACHE_KEY) ?? null);
  const [loading, setLoading] = useState(!data);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const [metric, setMetric] = useState<Metric>('payout');
  const [tableView, setTableView] = useState<TableView>('timeline');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback((background: boolean) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    fetch('/api/ceo/financial-reports', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: FinancialReports & { error?: string }) => {
        setErr(j.error ?? null);
        // An error body (HTTP 500 → `{ error }`, no periods/allTime) must NOT
        // replace good data — that would collapse the report to the empty ₱0
        // state and discard what's on screen (and in the cache). Keep last-good
        // and just surface the banner, mirroring the `.catch` branch below.
        if (!j.error) {
          setData(j);
          setTabCache(CACHE_KEY, j);
          markFetchedThisSession(CACHE_KEY);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    // A tab switch fully remounts this tab. If we already pulled the (heavy)
    // report from Supabase in this page session, `data` was seeded from the
    // in-memory cache above — repaint instantly and skip the refetch entirely.
    // A full reload clears the session flag (so it re-pulls once, fresh), and
    // the Refresh button always forces a re-pull on demand.
    if (hasFetchedThisSession(CACHE_KEY)) return;
    load(!!data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const weekly = data?.periods ?? [];
  const series = useMemo(
    () => (granularity === 'monthly' ? rollupMonthly(weekly) : weekly),
    [granularity, weekly],
  );

  // Jump to the most recent period whenever the granularity flips (weekly↔monthly).
  useEffect(() => {
    setSelectedIndex(series.length === 0 ? null : series.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity]);

  // Keep the selection valid when the data reloads (seed on first load, clamp otherwise).
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (series.length === 0) return null;
      if (prev == null) return series.length - 1;
      return Math.min(prev, series.length - 1);
    });
  }, [series.length]);

  const selected = selectedIndex != null ? series[selectedIndex] ?? null : null;

  if (loading && !data) return <PageShell><Skeleton /></PageShell>;

  const activeMetric = METRICS.find((m) => m.key === metric)!;
  const chartPoints: ChartPoint[] = series.map((p) => ({
    label: granularity === 'monthly' ? (p.reportName.split(' ')[0] ?? p.reportName).slice(0, 3) : shortDate(p.periodStart),
    fullLabel: p.reportName,
    value: metricValue(p, metric),
  }));

  const chartFormat = (v: number): string => {
    switch (metric) {
      case 'people': return fmtInt(v);
      case 'hours': return fmtHours(v);
      case 'avg':
      case 'payout':
      case 'cumulative':
      default: return fmtPhp0(v);
    }
  };

  const allTime = data?.allTime;

  return (
    <PageShell>
      {err && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          Some data may be incomplete: {err}
        </div>
      )}

      {/* Header + hero total */}
      <section className="relative overflow-hidden rounded-3xl border border-amber-100/80 bg-gradient-to-br from-white via-amber-50/40 to-emerald-50/20 p-5 shadow-[0_12px_32px_-16px_rgba(245,158,11,0.15)] lg:p-6 dark:border-amber-900/30 dark:from-zinc-950 dark:via-amber-950/15 dark:to-emerald-950/10">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }} className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-amber-300/25 blur-3xl dark:bg-amber-500/12" />
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 0.1 }} className="absolute -right-16 top-8 h-56 w-56 rounded-full bg-emerald-300/20 blur-3xl dark:bg-emerald-500/12" />
        </div>
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/80 bg-white/70 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:border-amber-900/40 dark:bg-zinc-900/60 dark:text-amber-400">
              <TrendingUp className="h-3.5 w-3.5" /> Payout growth · records
            </span>
            <h1 className="mt-3 text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl dark:text-zinc-100">
              Financial Reports
            </h1>
            <p className="mt-1 max-w-xl text-[13px] text-zinc-500 dark:text-zinc-400">
              The company's payout history over every pay period — what we pay our people, growing over time.
              {' '}<span className="text-zinc-400 dark:text-zinc-500">Revenue coming later.</span>
            </p>
          </div>
          <div className="flex flex-col items-start gap-1 lg:items-end">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-amber-700/80 dark:text-amber-400/80">
              Total paid out · all time
            </span>
            <div className="flex items-baseline">
              <span className="mr-1 text-2xl font-medium text-zinc-400 lg:text-3xl dark:text-zinc-500">₱</span>
              <span className="font-mono text-3xl font-bold tracking-tight text-zinc-900 lg:text-4xl dark:text-white">
                <AnimatedNumber value={allTime?.totalPayoutPhp ?? 0} formatter={(n) => n.toLocaleString('en-PH', { maximumFractionDigits: 0 })} />
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
              <span>≈ <strong className="font-mono text-zinc-700 dark:text-zinc-200">{fmtUsd0(allTime?.totalPayoutUsd ?? 0)}</strong></span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>{fmtInt(allTime?.periodCount ?? 0)} pay periods</span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>{fmtInt(allTime?.distinctPeople ?? 0)} people paid</span>
            </div>
          </div>
        </div>
      </section>

      {series.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950">
          <Coins className="mx-auto h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No pay periods have been recorded yet. Once payroll cycles are dispatched they'll appear here.
          </p>
        </div>
      ) : (
        <>
          {/* Control bar: CSV/period selector + granularity + refresh + export */}
          <div className="flex flex-wrap items-center gap-2.5">
            <PeriodSelector
              series={series}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              open={pickerOpen}
              setOpen={setPickerOpen}
              granularity={granularity}
            />

            {/* Prev / next stepper */}
            <div data-readonly-allow className="flex items-center overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setSelectedIndex((i) => (i == null ? null : Math.max(0, i - 1)))}
                disabled={selectedIndex == null || selectedIndex <= 0}
                className="px-2 py-1.5 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:opacity-30 dark:hover:bg-zinc-900"
                aria-label="Previous period"
              >
                <ArrowDownRight className="h-3.5 w-3.5 rotate-45" />
              </button>
              <div className="w-px self-stretch bg-zinc-200 dark:bg-zinc-800" />
              <button
                type="button"
                onClick={() => setSelectedIndex((i) => (i == null ? null : Math.min(series.length - 1, i + 1)))}
                disabled={selectedIndex == null || selectedIndex >= series.length - 1}
                className="px-2 py-1.5 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:opacity-30 dark:hover:bg-zinc-900"
                aria-label="Next period"
              >
                <ArrowUpRight className="h-3.5 w-3.5 -rotate-45" />
              </button>
            </div>

            {/* Granularity toggle */}
            <Segmented
              value={granularity}
              onChange={(v) => setGranularity(v as Granularity)}
              options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]}
              ariaLabel="Chart granularity"
            />

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => exportCsv(series, granularity)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </button>
              <button
                type="button"
                onClick={() => load(true)}
                disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Refresh
              </button>
            </div>
          </div>

          {/* KPI cards for the selected period */}
          {selected && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <KpiCard index={0} Icon={Banknote} iconClass="text-amber-500" label="Payout" value={selected.payoutPhp} formatter={fmtPhp} sub={`≈ ${fmtUsd0(selected.payoutUsd)}`} delta={selected.payoutDeltaPct} />
              <KpiCard index={1} Icon={Users} iconClass="text-sky-500" label={granularity === 'monthly' ? 'People / wk' : 'People paid'} value={selected.peopleCount} formatter={fmtInt} sub={granularity === 'monthly' ? 'avg workforce' : `${fmtInt(selected.paidCount)} dispatched`} delta={selected.peopleDeltaPct} />
              <KpiCard index={2} Icon={Wallet} iconClass="text-violet-500" label="Avg / person" value={selected.avgPerHeadPhp} formatter={fmtPhp} sub={`${selected.avgHoursPerHead.toFixed(1)}h avg`} />
              <KpiCard index={3} Icon={Clock} iconClass="text-rose-500" label="Total hours" value={selected.totalHours} formatter={(n) => fmtInt(n)} sub="worked this period" />
              <KpiCard index={4} Icon={TrendingUp} iconClass="text-emerald-500" label="Cumulative" value={selected.cumulativePayoutPhp} formatter={fmtPhp0} sub={`≈ ${fmtUsd0(selected.cumulativePayoutUsd)} to date`} />
            </div>
          )}

          {/* Trend chart */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm lg:p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                <LineChartIcon className="h-3.5 w-3.5 text-amber-500" /> {activeMetric.label} over time
                <span className="ml-1 text-zinc-300 dark:text-zinc-600">·</span>
                <span className="normal-case text-zinc-400">{granularity === 'monthly' ? 'monthly' : 'per pay period'}</span>
              </div>
              <Segmented
                value={metric}
                onChange={(v) => setMetric(v as Metric)}
                options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
                ariaLabel="Chart metric"
              />
            </div>
            <PayoutTrendChart
              points={chartPoints}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              accent={activeMetric.accent}
              formatValue={chartFormat}
              formatTooltip={(p) => chartFormat(p.value)}
            />
          </div>

          {/* Table switcher */}
          <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div role="tablist" aria-label="Report table views" className="flex items-center gap-1 border-b border-zinc-100 p-2 dark:border-zinc-800/80">
              {([
                { key: 'timeline', label: 'Timeline', Icon: CalendarDays },
                { key: 'department', label: 'By department', Icon: Activity },
                { key: 'recipients', label: 'Recipients', Icon: Users },
              ] as { key: TableView; label: string; Icon: LucideIcon }[]).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tableView === t.key}
                  onClick={() => setTableView(t.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                    tableView === t.key
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900',
                  )}
                >
                  <t.Icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              ))}
            </div>
            <div className="p-3 sm:p-4">
              <AnimatePresence mode="wait">
                <motion.div
                  key={tableView}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  {tableView === 'timeline' && (
                    <TimelineTable series={series} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
                  )}
                  {tableView === 'department' && selected && (
                    <DepartmentTable period={selected} />
                  )}
                  {tableView === 'recipients' && selected && (
                    <RecipientsTable period={selected} granularity={granularity} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

function metricValue(p: FinancialPeriodPoint, m: Metric): number {
  switch (m) {
    case 'payout': return p.payoutPhp;
    case 'cumulative': return p.cumulativePayoutPhp;
    case 'people': return p.peopleCount;
    case 'avg': return p.avgPerHeadPhp;
    case 'hours': return p.totalHours;
  }
}

/* ── layout shell ─────────────────────────────────────────────────────────── */

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 px-4 pb-10 pt-6 sm:px-6 lg:gap-5 lg:px-8 lg:pt-8">
      {children}
    </div>
  );
}

/* ── segmented control ────────────────────────────────────────────────────── */

function Segmented({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
              active ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${options.map((x) => x.value).join('-')}`}
                className="absolute inset-0 rounded-md bg-white shadow-sm dark:bg-zinc-950"
                transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── period (CSV) selector ────────────────────────────────────────────────── */

function PeriodSelector({
  series,
  selectedIndex,
  onSelect,
  open,
  setOpen,
  granularity,
}: {
  series: FinancialPeriodPoint[];
  selectedIndex: number | null;
  onSelect: (i: number) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  granularity: Granularity;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const selected = selectedIndex != null ? series[selectedIndex] ?? null : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  // Newest first in the menu.
  const items = series
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (q.trim() ? p.reportName.toLowerCase().includes(q.trim().toLowerCase()) : true))
    .reverse();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex min-w-[220px] items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-left shadow-sm transition-colors hover:border-amber-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-amber-800"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-amber-600 text-white">
          <CalendarDays className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[9.5px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
            {granularity === 'monthly' ? 'Month' : 'Pay period'}
          </span>
          <span className="block truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
            {selected?.reportName ?? 'Select…'}
          </span>
        </span>
        {selected?.isCurrent && (
          <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            Live
          </span>
        )}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full z-30 mt-1.5 w-[320px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search periods…"
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-[13px] outline-none focus:border-amber-400 dark:border-zinc-800 dark:bg-zinc-900"
                />
              </div>
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1.5">
              {items.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-zinc-400">No periods match.</p>
              ) : (
                items.map(({ p, i }) => (
                  <button
                    key={p.sourceFile}
                    type="button"
                    onClick={() => { onSelect(i); setOpen(false); setQ(''); }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      i === selectedIndex ? 'bg-amber-50 dark:bg-amber-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{p.reportName}</span>
                        {p.isCurrent && <span className="shrink-0 rounded-full bg-emerald-100 px-1 text-[8.5px] font-bold uppercase text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">Live</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">{fmtInt(p.peopleCount)} people · {fmtInt(p.totalHours)}h</div>
                    </div>
                    <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{fmtPhp0(p.payoutPhp)}</span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── timeline table ───────────────────────────────────────────────────────── */

function TimelineTable({
  series,
  selectedIndex,
  onSelect,
}: {
  series: FinancialPeriodPoint[];
  selectedIndex: number | null;
  onSelect: (i: number) => void;
}) {
  const rows = series.map((p, i) => ({ p, i })).reverse(); // newest first
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
            <th className="py-2 pr-3 font-semibold">Period</th>
            <th className="py-2 pr-3 text-right font-semibold">Payout ₱</th>
            <th className="py-2 pr-3 text-right font-semibold">≈ USD</th>
            <th className="py-2 pr-3 text-right font-semibold">People</th>
            <th className="py-2 pr-3 text-right font-semibold">Avg / head</th>
            <th className="py-2 pr-3 text-right font-semibold">Hours</th>
            <th className="py-2 text-right font-semibold">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, i }) => (
            <tr
              key={p.sourceFile}
              onClick={() => onSelect(i)}
              className={cn(
                'cursor-pointer border-b border-zinc-50 transition-colors dark:border-zinc-900',
                i === selectedIndex ? 'bg-amber-50/60 dark:bg-amber-950/25' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/60',
              )}
            >
              <td data-label="Period" className="py-2 pr-3">
                <span className="flex items-center gap-1.5">
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{p.reportName}</span>
                  {p.isCurrent && <span className="rounded-full bg-emerald-100 px-1 text-[8.5px] font-bold uppercase text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">Live</span>}
                </span>
              </td>
              <td data-label="Payout" className="py-2 pr-3 text-right font-mono font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{fmtPhp0(p.payoutPhp)}</td>
              <td data-label="≈ USD" className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{fmtUsd0(p.payoutUsd)}</td>
              <td data-label="People" className="py-2 pr-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{fmtInt(p.peopleCount)}</td>
              <td data-label="Avg / head" className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-300">{fmtPhp0(p.avgPerHeadPhp)}</td>
              <td data-label="Hours" className="py-2 pr-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{fmtInt(p.totalHours)}</td>
              <td data-label="Δ" className="py-2 text-right"><DeltaChip pct={p.payoutDeltaPct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── by-department table ──────────────────────────────────────────────────── */

function DepartmentTable({ period }: { period: FinancialPeriodPoint }) {
  const max = Math.max(1, ...period.byDepartment.map((d) => d.payoutPhp));
  return (
    <div>
      <p className="mb-3 text-[12px] text-zinc-400">
        Department breakdown · <span className="font-medium text-zinc-600 dark:text-zinc-300">{period.reportName}</span>
      </p>
      {period.byDepartment.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-400">No department data for this period.</p>
      ) : (
        <ul className="space-y-2.5">
          {period.byDepartment.map((d) => (
            <li key={d.department} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-zinc-700 dark:text-zinc-200" title={d.department}>{d.department}</span>
                  <span className="shrink-0 text-[11px] text-zinc-400">{fmtInt(d.peopleCount)} ppl · {fmtInt(d.hours)}h</span>
                </span>
                <span className="shrink-0 font-mono font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                  {fmtPhp0(d.payoutPhp)}
                  <span className="ml-1.5 text-[11px] font-normal text-zinc-400">{Math.round((d.payoutPhp / period.payoutPhp) * 100)}%</span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.max(2, (d.payoutPhp / max) * 100)}%` }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── recipients table (lazy) ──────────────────────────────────────────────── */

const STATUS_TONE: Record<string, string> = {
  paid: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  pending: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  not_paid: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  threshold: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  problem: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
};

const recipientCache = new Map<string, FinancialPeriodRecipient[]>();

function RecipientsTable({ period, granularity }: { period: FinancialPeriodPoint; granularity: Granularity }) {
  const [rows, setRows] = useState<FinancialPeriodRecipient[] | null>(() => recipientCache.get(period.sourceFile) ?? null);
  const [loading, setLoading] = useState(!rows);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    // Monthly points are synthetic (month:YYYY-MM) — no single CSV to load.
    if (granularity === 'monthly') { setRows([]); setLoading(false); return; }
    const cached = recipientCache.get(period.sourceFile);
    if (cached) { setRows(cached); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/ceo/financial-reports?recipients=${encodeURIComponent(period.sourceFile)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { recipients?: FinancialPeriodRecipient[]; error?: string }) => {
        if (!alive) return;
        if (j.error) setError(j.error);
        const list = j.recipients ?? [];
        recipientCache.set(period.sourceFile, list);
        setRows(list);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period.sourceFile, granularity]);

  if (granularity === 'monthly') {
    return <p className="py-8 text-center text-sm text-zinc-400">Switch to <strong className="text-zinc-500">Weekly</strong> to see per-recipient detail for a pay period.</p>;
  }
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}
      </div>
    );
  }
  if (error) return <p className="py-8 text-center text-sm text-rose-500">{error}</p>;

  const list = (rows ?? []).filter((r) => {
    const term = q.trim().toLowerCase();
    if (!term) return true;
    return (r.name ?? '').toLowerCase().includes(term) || r.email.toLowerCase().includes(term) || r.department.toLowerCase().includes(term);
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-zinc-400">
          {fmtInt((rows ?? []).length)} recipients · <span className="font-medium text-zinc-600 dark:text-zinc-300">{period.reportName}</span>
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, dept…"
            className="h-8 w-[220px] rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-[12.5px] outline-none focus:border-amber-400 dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-white dark:bg-zinc-950">
            <tr className="border-b border-zinc-100 text-left text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
              <th className="py-2 pr-3 font-semibold">Name</th>
              <th className="py-2 pr-3 font-semibold">Department</th>
              <th className="py-2 pr-3 text-right font-semibold">Hours</th>
              <th className="py-2 pr-3 text-right font-semibold">Payout ₱</th>
              <th className="py-2 pr-3 text-right font-semibold">≈ USD</th>
              <th className="py-2 text-right font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={6} className="py-8 text-center text-sm text-zinc-400">No recipients match.</td></tr>
            ) : (
              list.map((r) => (
                <tr key={r.email} className="border-b border-zinc-50 dark:border-zinc-900">
                  <td data-label="Name" className="py-2 pr-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">{r.name ?? r.email}</div>
                    <div className="text-[11px] text-zinc-400">{r.email}</div>
                  </td>
                  <td data-label="Department" className="py-2 pr-3 text-zinc-600 dark:text-zinc-300">{r.department}</td>
                  <td data-label="Hours" className="py-2 pr-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{r.hours.toFixed(1)}</td>
                  <td data-label="Payout" className="py-2 pr-3 text-right font-mono font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">{fmtPhp0(r.payoutPhp)}</td>
                  <td data-label="≈ USD" className="py-2 pr-3 text-right font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{fmtUsd0(r.payoutUsd)}</td>
                  <td data-label="Status" className="py-2 text-right">
                    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', STATUS_TONE[r.status] ?? STATUS_TONE.pending)}>
                      {r.status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── CSV export ───────────────────────────────────────────────────────────── */

function exportCsv(series: FinancialPeriodPoint[], granularity: Granularity) {
  const header = [
    granularity === 'monthly' ? 'Month' : 'Pay Period',
    'Period Start', 'Period End', 'Payout PHP', 'Payout USD',
    'Paid PHP', 'Outstanding PHP', 'People', 'Total Hours', 'Avg Per Head PHP',
    'Cumulative PHP', 'Payout Δ%',
  ];
  const lines = [header.join(',')];
  for (const p of series) {
    const cells = [
      p.reportName, p.periodStart ?? '', p.periodEnd ?? '',
      p.payoutPhp, p.payoutUsd, p.paidPhp, p.outstandingPhp,
      p.peopleCount, p.totalHours, p.avgPerHeadPhp, p.cumulativePayoutPhp,
      p.payoutDeltaPct ?? '',
    ].map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    lines.push(cells.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `financial-reports-${granularity}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
