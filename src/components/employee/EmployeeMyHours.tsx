'use client';

/**
 * My Hours — full merged Hubstaff calendar by calendar month (Jan–Dec).
 * Grid UX matches the dashboard PAB calendar; month navigation is explicit.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, CalendarHeart, ChevronLeft, ChevronRight, Hourglass, Loader2, RefreshCw, TrendingUp, Trophy, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import { phpHourlyPayFromSeconds } from '@/lib/payroll/money-php';
import type { MemberMonthlyPay } from '@/lib/payroll/member-monthly-pay';
import {
  buildCalendarMonthWeeksIncludingWeekends,
  columnsAreAllCanonical,
  getCurrentPabMonth,
  groupDateColumnsByCalendarDay,
  pabDateKey,
  parseColDate,
  resolveCanonicalColumnsToIso,
  type PabCalendarDay,
} from '@/lib/hubstaff/calendar-column-dedupe';
import {
  PAB_PERIOD_OVERRIDES_KEY,
  parsePabPeriodOverrides,
  resolvePabRangeForMonth,
  type PabOverridesMap,
} from '@/lib/pab-period-settings';
import {
  disputeGrantsPabForgiveness,
  disputeIsAwaitingResolution,
  isOrphanageStyleReason,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';
import {
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  parseUsHolidaysList,
  getEnabledHolidayMap,
} from '@/lib/us-holidays';
import HiddenValue from './HiddenValue';
import DisputeDialog from './DisputeDialog';
import TimeAdjustmentDialog from './TimeAdjustmentDialog';
import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';

/** Matches PayrollWizard COMMON_BONUSES / EmployeeDashboard. */
const PERFECT_ATTENDANCE_BONUS_PHP = 5000;
const TECHNOLOGY_BONUS_PHP = 1850;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const NON_DATE_COLS = new Set([
  'id',
  'email',
  'member',
  'total worked',
  'activity',
  'organization',
  'time zone',
  'job type',
  'job title',
  'work email',
  'personal email',
  'employee id',
  'tax info',
  'location',
  'date added',
  'spent total',
  'currency',
]);

const CANONICAL_WEEKDAYS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

function isDateCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS.has(lower)) return false;
  if (CANONICAL_WEEKDAYS.has(lower)) return true;
  if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(col.trim())) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

function parseHMS(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

function secondsToDisplay(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function getFieldFromRow(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

function formatRangeDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Local calendar Monday for the week containing `d` (Mon–Sun weeks). */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function mondayOfWeekContaining(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  x.setDate(x.getDate() - daysBack);
  return x;
}

type EmployeeMyHoursProps = {
  employeeEmail: string;
};

/* ------------------------------------------------------------------ *
 * Weekly earnings rail (non-HSL): a Mon-Sun ladder that shows how much
 * an employee earns per day assuming a full 8h online shift (9AM-5PM
 * EDT). Today's row ticks live, second-by-second, off the current EDT
 * clock so the number visibly grows through the working day.
 * ------------------------------------------------------------------ */

const WORK_START_HOUR_EDT = 9; // 9 AM EDT
const WORK_HOURS_PER_DAY = 8; // 9 AM - 5 PM EDT
const DAY_LABELS_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Weekly pay cap: regular rate covers the first 40h of the Mon-Sun week, the OT
// rate the next 5h; hours past 45 in the week are unpaid. Both rates are
// per-employee (resolved from their rate history / cache).
const WEEKLY_REG_CAP_HOURS = 40;
const WEEKLY_OT_CAP_HOURS = 5;
const WEEKLY_PAID_CAP_HOURS = WEEKLY_REG_CAP_HOURS + WEEKLY_OT_CAP_HOURS; // 45

/**
 * Pay for `hours` worked starting at `startCum` cumulative hours into the week,
 * splitting across the regular band (0-40h) and OT band (40-45h). Hours beyond
 * 45h in the week earn nothing.
 */
function weeklyCappedPay(
  startCum: number,
  hours: number,
  regRate: number,
  otRate: number | null,
): number {
  const end = startCum + hours;
  const regH = Math.max(0, Math.min(end, WEEKLY_REG_CAP_HOURS) - Math.min(startCum, WEEKLY_REG_CAP_HOURS));
  const otH =
    Math.max(0, Math.min(end, WEEKLY_PAID_CAP_HOURS) - Math.max(startCum, WEEKLY_REG_CAP_HOURS));
  return regH * regRate + otH * (otRate ?? regRate);
}

/** Decompose an instant into America/New_York wall-clock parts. */
function edtNow(ms: number): { y: number; m: number; d: number; hoursOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    hoursOfDay: get('hour') + get('minute') / 60 + get('second') / 3600,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Loading shell for the weekly rail — mirrors the final card so the layout doesn't shift. */
function WeeklyEarningsRailSkeleton() {
  return (
    <Card
      size="sm"
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-2xl border-amber-100/80 bg-gradient-to-br from-white to-amber-50/30 shadow-md ring-1 ring-amber-500/10 dark:border-amber-950/50 dark:bg-none dark:from-amber-950/15 dark:to-amber-950/5 dark:ring-amber-950/20 lg:w-64 xl:w-72"
    >
      <CardHeader className="shrink-0 space-y-1 pb-2 pt-4 sm:pt-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <TrendingUp className="h-4 w-4" aria-hidden />
          </div>
          <CardTitle className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            This week
          </CardTitle>
        </div>
        <div className="space-y-1 pl-10">
          <div className="h-2 w-40 max-w-full animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
          <div className="h-2 w-28 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-4 pb-5 pt-0 sm:px-5">
        <ul className="flex flex-col gap-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-100 bg-white/60 px-2.5 py-2 dark:border-zinc-800/60 dark:bg-zinc-900/20"
            >
              <div className="flex items-center gap-1.5">
                <div
                  className="h-2.5 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                  style={{ animationDelay: `${i * 60}ms` }}
                />
                <div
                  className="h-2 w-4 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60"
                  style={{ animationDelay: `${i * 60}ms` }}
                />
              </div>
              <div
                className="h-2.5 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                style={{ animationDelay: `${i * 60 + 30}ms` }}
              />
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-1.5 border-t border-amber-200/50 pt-3 dark:border-amber-900/30">
          <div className="flex items-baseline justify-between gap-2">
            <div className="h-2 w-20 animate-pulse rounded bg-amber-200/60 dark:bg-amber-900/40" />
            <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950/40">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-200/80 dark:bg-amber-900/50" />
          </div>
          <div className="ml-auto h-2 w-28 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
        </div>
      </CardContent>
    </Card>
  );
}

function WeeklyEarningsRail({
  rateHistory,
  cacheRegularRate,
  cacheOtRate,
  isHsl,
  liveDays,
  loading,
}: {
  rateHistory: RateHistoryEntry[];
  cacheRegularRate: number | null;
  cacheOtRate: number | null;
  isHsl: boolean;
  /** Real Hubstaff tracked seconds by ISO date (live API overlay). When present the
   *  rail shows actual tracked time; when null it falls back to the 9-5 EDT clock
   *  projection (deployments without Hubstaff API credentials). */
  liveDays: Record<string, number> | null;
  /** True while rates / member-pay are still loading — renders the skeleton shell
   *  instead of nothing, so the rail doesn't pop in with a layout shift. */
  loading: boolean;
}) {
  // Per-second clock — drives the live ticker. Starts at a stable seed so the
  // first paint (and any SSR pass) is deterministic, then begins ticking.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const rateFor = useCallback(
    (date: Date): { reg: number; ot: number | null } | null => {
      const resolved = resolveRateAsOfLocal(rateHistory, date);
      const reg = resolved?.regularRate ?? cacheRegularRate;
      if (reg == null) return null;
      return { reg, ot: resolved?.otRate ?? cacheOtRate };
    },
    [rateHistory, cacheRegularRate, cacheOtRate],
  );

  const week = useMemo(() => {
    if (nowMs == null) return null;
    const edt = edtNow(nowMs);
    // Weekday of EDT "today" via a UTC-anchored date (no local-TZ drift).
    const anchor = new Date(Date.UTC(edt.y, edt.m - 1, edt.d));
    const dow = anchor.getUTCDay(); // 0=Sun..6=Sat
    const todayIdx = (dow + 6) % 7; // 0=Mon..6=Sun
    const elapsedToday = clamp(edt.hoursOfDay - WORK_START_HOUR_EDT, 0, WORK_HOURS_PER_DAY);

    // Walk Mon->Sun accumulating hours so the 40h regular / 5h OT weekly cap
    // applies in order. We track two cursors: `cumPot` (every day works a full
    // 8h — for the "potential" figure) and `cumWorked` (actual hours so far:
    // full for past days, live-elapsed for today, 0 for future).
    let cumPot = 0;
    let cumWorked = 0;
    const days = Array.from({ length: 7 }, (_, i) => {
      const offsetFromMon = i - todayIdx;
      const cell = new Date(Date.UTC(edt.y, edt.m - 1, edt.d + offsetFromMon));
      const localDate = new Date(cell.getUTCFullYear(), cell.getUTCMonth(), cell.getUTCDate());
      const r = rateFor(localDate);
      const state: 'past' | 'today' | 'future' =
        i < todayIdx ? 'past' : i === todayIdx ? 'today' : 'future';
      // With the live Hubstaff overlay, every day pays on REAL tracked hours
      // (today included — it grows as the tracker runs). Without it, fall back to
      // the legacy projection: full 8h for past days, elapsed 9-5 clock for today.
      const cellIso = cell.toISOString().slice(0, 10);
      const workedHours = liveDays
        ? (liveDays[cellIso] ?? 0) / 3600
        : state === 'past' ? WORK_HOURS_PER_DAY : state === 'today' ? elapsedToday : 0;

      const fullDay = r != null ? weeklyCappedPay(cumPot, WORK_HOURS_PER_DAY, r.reg, r.ot) : null;
      const earned = r != null ? weeklyCappedPay(cumWorked, workedHours, r.reg, r.ot) : null;
      cumPot += WORK_HOURS_PER_DAY;
      cumWorked += workedHours;

      return {
        label: DAY_LABELS_FULL[i],
        dateNum: cell.getUTCDate(),
        state,
        rate: r?.reg ?? null,
        fullDay,
        earned,
        workedHours,
        elapsedToday: state === 'today' ? (liveDays ? workedHours : elapsedToday) : null,
      };
    });

    const earnedSoFar = days.reduce((sum, d) => sum + (d.earned ?? 0), 0);
    const potential = days.reduce((sum, d) => sum + (d.fullDay ?? 0), 0);
    return { days, earnedSoFar, potential, elapsedToday };
  }, [nowMs, rateFor, liveDays]);

  // Only for non-HSL people with a known rate.
  if (isHsl) return null;
  if (loading) return <WeeklyEarningsRailSkeleton />;
  if (cacheRegularRate == null && rateHistory.length === 0) return null;
  // Data is loaded but the per-second clock hasn't ticked yet (first client
  // render) — hold the skeleton for that frame instead of flashing empty.
  if (!week) return <WeeklyEarningsRailSkeleton />;

  const pct = week.potential > 0 ? clamp((week.earnedSoFar / week.potential) * 100, 0, 100) : 0;

  return (
    <Card
      size="sm"
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-2xl border-amber-100/80 bg-gradient-to-br from-white to-amber-50/30 shadow-md ring-1 ring-amber-500/10 dark:border-amber-950/50 dark:bg-none dark:from-amber-950/15 dark:to-amber-950/5 dark:ring-amber-950/20 lg:w-64 xl:w-72"
    >
      <CardHeader className="shrink-0 space-y-1 pb-2 pt-4 sm:pt-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <TrendingUp className="h-4 w-4" aria-hidden />
          </div>
          <CardTitle className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            This week
          </CardTitle>
        </div>
        <p className="pl-10 text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
          {liveDays
            ? 'Real Hubstaff tracked time — today updates every few minutes while you track. Capped at 40h regular + 5h OT per week.'
            : 'Projected at a full 8h day (9 AM–5 PM EDT). Today ticks live. Capped at 40h regular + 5h OT per week.'}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-4 pb-5 pt-0 sm:px-5">
        <motion.ul
          className="flex flex-col gap-1.5"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.05 } } }}
        >
          {week.days.map((d, i) => {
            const isToday = d.state === 'today';
            const isFuture = d.state === 'future';
            return (
              <motion.li
                key={i}
                variants={{
                  hidden: { opacity: 0, x: -10 },
                  show: { opacity: 1, x: 0 },
                }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 transition-colors',
                  isToday
                    ? 'border-emerald-300 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-400/40 dark:border-emerald-800/70 dark:bg-emerald-950/40'
                    : isFuture
                      ? 'border-transparent bg-zinc-50/60 opacity-60 dark:bg-zinc-900/30'
                      : 'border-zinc-100 bg-white/60 dark:border-zinc-800/60 dark:bg-zinc-900/20',
                )}
              >
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'w-8 text-[11px] font-semibold',
                      isToday
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-zinc-600 dark:text-zinc-400',
                    )}
                  >
                    {d.label}
                  </span>
                  <span className="text-[9px] tabular-nums text-zinc-400 dark:text-zinc-600">
                    {d.dateNum}
                  </span>
                  {liveDays != null && d.workedHours > 0 && (
                    <span className="text-[9px] tabular-nums text-zinc-500 dark:text-zinc-500">
                      {secondsToDisplay(Math.round(d.workedHours * 3600))}
                    </span>
                  )}
                  {isToday && (
                    <span className="flex items-center gap-1 text-[8.5px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      </span>
                      {d.elapsedToday != null && d.elapsedToday >= WORK_HOURS_PER_DAY
                        ? 'Done'
                        : d.elapsedToday != null && d.elapsedToday <= 0
                          ? 'Soon'
                          : 'Live'}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    'font-mono text-[11px] tabular-nums',
                    isToday
                      ? 'text-sm font-bold text-emerald-700 dark:text-emerald-300'
                      : isFuture
                        ? 'text-zinc-400 dark:text-zinc-600'
                        : 'font-medium text-zinc-700 dark:text-zinc-300',
                  )}
                >
                  {d.earned == null
                    ? '--'
                    : isFuture
                      ? formatPHP(d.fullDay ?? 0)
                      : formatPHP(d.earned)}
                </span>
              </motion.li>
            );
          })}
        </motion.ul>

        <div className="mt-auto space-y-1.5 border-t border-amber-200/50 pt-3 dark:border-amber-900/30">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-amber-800/70 dark:text-amber-400/80">
              Earned so far
            </span>
            <span className="font-mono text-base font-bold tabular-nums text-amber-800 dark:text-amber-300">
              {formatPHP(week.earnedSoFar)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950/40">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-500"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <p className="text-right text-[9px] tabular-nums text-zinc-400 dark:text-zinc-600">
            of {formatPHP(week.potential)} potential
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** One row from `/api/employee-rate-history`. */
type RateHistoryEntry = {
  effectiveFrom: Date;
  regularRate: number | null;
  otRate: number | null;
};

function parseRateText(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the rate row that was in effect on `date`. Caller passes the
 *  per-employee history list sorted desc by `effectiveFrom`. */
function resolveRateAsOfLocal(
  history: RateHistoryEntry[],
  date: Date,
): { regularRate: number | null; otRate: number | null } | null {
  if (history.length === 0) return null;
  const t = date.getTime();
  for (const row of history) {
    if (row.effectiveFrom.getTime() <= t) {
      return { regularRate: row.regularRate, otRate: row.otRate };
    }
  }
  return null;
}

export default function EmployeeMyHours({ employeeEmail }: EmployeeMyHoursProps) {
  const [aliasEmails, setAliasEmails] = useState<string[]>([]);
  const [employeeStartDate, setEmployeeStartDate] = useState<Date | null>(null);
  const [mergedRow, setMergedRow] = useState<Record<string, unknown> | null>(null);
  const [mergedColumns, setMergedColumns] = useState<string[]>([]);
  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>([]);
  const [disputeDialog, setDisputeDialog] = useState<{ date: string; seconds: number; existingDispute: PabDayDisputeRow | null } | null>(null);
  const [timeAdjustments, setTimeAdjustments] = useState<TimeAdjustmentRow[]>([]);
  const [timeAdjustDialog, setTimeAdjustDialog] = useState<{ date: string; seconds: number; existing: TimeAdjustmentRow | null } | null>(null);
  const [orphanageVisits, setOrphanageVisits] = useState<PabDayDisputeRow[]>([]);
  const [orphanageLoading, setOrphanageLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Live per-day tracked seconds (ISO date → sec) from the Hubstaff API for the
   *  trailing two weeks — fills today/this week before accounting ingests the batch.
   *  Null when the deployment has no Hubstaff API credentials (overlay disabled). */
  const [liveHours, setLiveHours] = useState<{ days: Record<string, number>; asOf: string } | null>(null);
  const [usHolidayDates, setUsHolidayDates] = useState<Map<string, string>>(new Map());
  // Per-month PAB window overrides set by accounting in the Payroll Wizard's PAB
  // Calendar period setter (`pab_period_overrides`). Empty map → fall back to the
  // default `getPabMonthRange()` window. Keeps My Hours' PAB evaluation in lockstep
  // with the wizard + Employee Dashboard.
  const [pabOverrides, setPabOverrides] = useState<PabOverridesMap>(new Map());
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [rateHistory, setRateHistory] = useState<RateHistoryEntry[]>([]);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);
  const [ratesLoading, setRatesLoading] = useState(true);
  // Authoritative pay numbers from the SAME server calculator the manager
  // dashboard uses (member-monthly-pay.ts) — guarantees the pay summary matches
  // the manager view exactly: all 7 days counted, 40h/week regular cap, OT past
  // 40h, PAB/Tech bonuses + MESA, per-day rate proration.
  const [memberPay, setMemberPay] = useState<MemberMonthlyPay | null>(null);
  const [memberPayLoading, setMemberPayLoading] = useState(true);
  const [memberPayError, setMemberPayError] = useState<string | null>(null);

  const initPab = getCurrentPabMonth();
  const [viewYear, setViewYear] = useState(initPab.year);
  const [viewMonth, setViewMonth] = useState(initPab.month);
  /** +1 when navigating to next month, -1 for previous; drives slide direction. */
  const [navDirection, setNavDirection] = useState<1 | -1>(1);

  const email = useMemo(
    () => normEmail(employeeEmail) ?? employeeEmail.toLowerCase(),
    [employeeEmail],
  );

  /**
   * Resolve the master_list row for this employee. Reruns when the rates row loads so
   * we can match by `rate.work_email` / `rate.personal_email` too — handles email drift
   * between `employee_hourly_rates` and `global_master_list` (BUSINESS_LOGIC.md §
   * Email-drift). Without this bridge a master row keyed under a different email than
   * the login (e.g. `john@simple.biz` vs `johnr@simple.biz`) would silently flunk the
   * Tech Bonus 30-day gate as "no start date".
   */
  useEffect(() => {
    let cancelled = false;
    const candidates = new Set<string>([email]);
    if (rate) {
      const rw = normEmail(rate.work_email);
      const rp = normEmail(rate.personal_email);
      if (rw) candidates.add(rw);
      if (rp) candidates.add(rp);
    }
    (async () => {
      try {
        const res = await fetch(`/api/employees?_=${Date.now()}`, { cache: 'no-store' });
        const json = (await res.json()) as {
          employees?: {
            work_email?: string | null;
            personal_email?: string | null;
            alternate_work_email?: string | null;
            alternate_work_email_2?: string | null;
            start_date?: string | null;
          }[];
        };
        if (cancelled) return;
        const me = (json.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          return (we !== null && candidates.has(we)) || (pe !== null && candidates.has(pe));
        });
        const aliases = new Set<string>(candidates);
        if (me) {
          // Include gsuite alternate work emails — Hubstaff tracks some people
          // under an alias (e.g. kevin@) while their login/primary is kevt@.
          for (const e of [me.work_email, me.personal_email, me.alternate_work_email, me.alternate_work_email_2]) {
            const n = normEmail(e ?? '');
            if (n) aliases.add(n);
          }
        }
        setAliasEmails([...aliases]);
        if (!me?.start_date) {
          setEmployeeStartDate(null);
          return;
        }
        const d = new Date(me.start_date);
        setEmployeeStartDate(isNaN(d.getTime()) ? null : d);
      } catch {
        if (!cancelled) {
          setAliasEmails([...candidates]);
          setEmployeeStartDate(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, rate]);

  const fetchMerged = useCallback(async () => {
    // One email-filtered server query for this employee's rows across every
    // upload. The server expands aliases from the master list, so the login
    // email is enough — this no longer waits on /api/employees to resolve
    // aliasEmails first (that serial hop gated the whole calendar). Replaces the
    // old N-parallel `?source_file=...` fan-out. Mirrors EmployeeDashboard's PAB
    // merge so both surfaces read identical hours. See
    // app/api/hubstaff-hours/route.ts `merge_all` mode. Canonical weekday columns
    // are still resolved to ISO dates client-side (resolver needs the filename).
    const res = await fetch(
      `/api/hubstaff-hours?merge_all=1&email=${encodeURIComponent(email)}&_=${Date.now()}`,
      { cache: 'no-store' },
    );
    const json = (await res.json()) as {
      columns?: string[] | null;
      perFile?: { source_file: string; row: Record<string, unknown> | null }[] | null;
    };
    const perFile = json.perFile ?? [];
    if (perFile.length === 0) {
      setMergedRow(null);
      setMergedColumns([]);
      return;
    }

    const allCols = new Set<string>();
    let merged: Record<string, unknown> = {};
    let found = false;

    for (const { source_file: file, row: myRow } of perFile) {
      if (!myRow) continue;
      found = true;
      const rowCols = Object.keys(myRow);
      const needsResolve = columnsAreAllCanonical(rowCols);
      const resolved = needsResolve ? resolveCanonicalColumnsToIso(myRow, file) : myRow;
      for (const col of needsResolve ? Object.keys(resolved) : rowCols) allCols.add(col);
      merged = { ...merged, ...resolved };
    }
    setMergedColumns([...allCols]);
    setMergedRow(found ? merged : null);
  }, [email]);

  /**
   * Live overlay: this person's real tracked time straight from the Hubstaff API
   * (server-cached ~3 min org-wide). Uploaded batches stay authoritative — the
   * overlay only fills days the batches don't cover yet (today / this week).
   */
  const fetchLiveHours = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/hubstaff-hours?live=1&email=${encodeURIComponent(email)}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        configured?: boolean;
        days?: Record<string, number>;
        asOf?: string;
        error?: string | null;
      };
      if (!res.ok || !json.configured || json.error) {
        // Unconfigured or transiently failing — keep whatever overlay we had.
        if (!json.configured) setLiveHours(null);
        return;
      }
      setLiveHours({ days: json.days ?? {}, asOf: json.asOf ?? new Date().toISOString() });
    } catch {
      /* transient — the next poll retries */
    }
  }, [email]);

  useEffect(() => {
    void fetchLiveHours();
    const id = window.setInterval(() => void fetchLiveHours(), 180_000);
    const onFocus = () => void fetchLiveHours();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchLiveHours]);

  const fetchRatesAndFx = useCallback(async () => {
    setRatesLoading(true);
    try {
      const [ratesRes, fxRes, historyRes, empRes] = await Promise.all([
        fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        // Per-employee rate history — drives per-day prorating in the pay calc
        // so mid-cycle rate changes show up immediately in My Hours totals.
        fetch(`/api/employee-rate-history?email=${encodeURIComponent(email)}`, { cache: 'no-store' }),
        // Master row — lets us resolve this employee's gsuite alternate work
        // emails so a rate row keyed on an alias (e.g. kevin@) still matches the
        // login (kevt@). Resolved locally here to keep this callback's [email]
        // dependency stable (the aliasEmails state depends on `rate`, so reading
        // it here would create a setRate → aliasEmails → setRate loop).
        fetch(`/api/employees?_=${Date.now()}`, { cache: 'no-store' }),
      ]);
      const ratesJson = (await ratesRes.json()) as { rows?: EmployeeHourlyRateRow[] };
      const fxJson = (await fxRes.json()) as { value: string | null };
      const historyJson = (await historyRes.json()) as {
        rows?: Array<{ regular_rate: string | null; ot_rate: string | null; effective_from: string }>;
      };
      const empJson = (await empRes.json()) as {
        employees?: Array<{
          work_email?: string | null;
          personal_email?: string | null;
          alternate_work_email?: string | null;
          alternate_work_email_2?: string | null;
        }>;
      };
      setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));
      const allRates = ratesJson.rows ?? [];
      // Build the alias set from the login email + this employee's master row
      // (work / personal / alternate work emails). The rate row may be keyed on
      // a gsuite alternate (kevin@) while the login is the primary (kevt@).
      const aliasSet = new Set<string>([email]);
      const meRow = (empJson.employees ?? []).find((e) => {
        const we = normEmail(e.work_email ?? '');
        const pe = normEmail(e.personal_email ?? '');
        return we === email || pe === email;
      });
      if (meRow) {
        for (const e of [meRow.work_email, meRow.personal_email, meRow.alternate_work_email, meRow.alternate_work_email_2]) {
          const n = normEmail(e ?? '');
          if (n) aliasSet.add(n);
        }
      }
      const myRate = allRates.find((r) => {
        const we = normEmail(r.work_email);
        const pe = normEmail(r.personal_email);
        return (we != null && aliasSet.has(we)) || (pe != null && aliasSet.has(pe));
      });
      setRate(myRate ?? null);
      const parsed: RateHistoryEntry[] = [];
      for (const r of historyJson.rows ?? []) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.effective_from ?? '');
        if (!m) continue;
        parsed.push({
          effectiveFrom: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
          regularRate: parseRateText(r.regular_rate),
          otRate: parseRateText(r.ot_rate),
        });
      }
      // API already sorts desc, but be defensive.
      parsed.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
      setRateHistory(parsed);
    } catch {
      setRate(null);
      setRateHistory([]);
    } finally {
      setRatesLoading(false);
    }
  }, [email]);

  useEffect(() => {
    void fetchRatesAndFx();
  }, [fetchRatesAndFx]);

  /** Pull this month's pay from the manager dashboard's calculator so the
   *  numbers are identical to what a manager would see for this employee. */
  const fetchMemberPay = useCallback(async () => {
    setMemberPayLoading(true);
    setMemberPayError(null);
    try {
      const res = await fetch(
        `/api/manager/member-monthly-pay?email=${encodeURIComponent(email)}&year=${viewYear}&month=${viewMonth}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { data?: MemberMonthlyPay | null; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setMemberPay(json.data ?? null);
    } catch (e) {
      setMemberPayError(e instanceof Error ? e.message : 'Failed to load pay summary');
      setMemberPay(null);
    } finally {
      setMemberPayLoading(false);
    }
  }, [email, viewYear, viewMonth]);

  useEffect(() => {
    void fetchMemberPay();
  }, [fetchMemberPay]);

  const monthStart = useMemo(() => new Date(viewYear, viewMonth, 1), [viewYear, viewMonth]);
  const monthEnd = useMemo(() => new Date(viewYear, viewMonth + 1, 0), [viewYear, viewMonth]);

  const fetchDisputes = useCallback(async () => {
    try {
      const from = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-${String(monthStart.getDate()).padStart(2, '0')}`;
      const to = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;
      const res = await fetch(
        `/api/pab-disputes?email=${encodeURIComponent(email)}&from=${from}&to=${to}&limit=200`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: PabDayDisputeRow[] };
      setDisputes(json.rows ?? []);
    } catch {
      setDisputes([]);
    }
  }, [email, monthStart, monthEnd]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await fetchMerged();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMerged]);

  useEffect(() => {
    void fetchDisputes();
  }, [fetchDisputes]);

  const fetchTimeAdjustments = useCallback(async () => {
    try {
      const from = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-${String(monthStart.getDate()).padStart(2, '0')}`;
      const to = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;
      const res = await fetch(
        `/api/time-adjustments?email=${encodeURIComponent(email)}&from=${from}&to=${to}&limit=200`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: TimeAdjustmentRow[] };
      setTimeAdjustments(json.rows ?? []);
    } catch {
      setTimeAdjustments([]);
    }
  }, [email, monthStart, monthEnd]);

  useEffect(() => {
    void fetchTimeAdjustments();
  }, [fetchTimeAdjustments]);

  const fetchOrphanageVisits = useCallback(async () => {
    setOrphanageLoading(true);
    try {
      const res = await fetch('/api/pab-disputes/orphanage-visits', { cache: 'no-store' });
      const json = await res.json();
      const rows = (json.rows ?? []) as PabDayDisputeRow[];
      const empSet = new Set(aliasEmails.length ? aliasEmails : [email]);
      const mine = rows.filter((r) => {
        const we = normEmail(r.work_email ?? '') ?? (r.work_email ?? '').toLowerCase();
        return empSet.has(we);
      });
      setOrphanageVisits(mine);
    } catch {
      setOrphanageVisits([]);
    } finally {
      setOrphanageLoading(false);
    }
  }, [aliasEmails, email]);

  useEffect(() => {
    void fetchOrphanageVisits();
  }, [fetchOrphanageVisits]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/app-settings?keys=${encodeURIComponent([US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY, PAB_PERIOD_OVERRIDES_KEY].join(','))}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (cancelled) return;
        const values = json.values ?? {};
        const enabled =
          values[US_HOLIDAYS_ENABLED_KEY] == null ? true : values[US_HOLIDAYS_ENABLED_KEY] === 'true';
        setUsHolidayDates(getEnabledHolidayMap(parseUsHolidaysList(values[US_HOLIDAYS_LIST_KEY] ?? null), enabled));
        setPabOverrides(parsePabPeriodOverrides(values[PAB_PERIOD_OVERRIDES_KEY] ?? null));
      } catch {
        if (!cancelled) {
          setUsHolidayDates(new Map());
          setPabOverrides(new Map());
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchMerged(), fetchDisputes(), fetchTimeAdjustments(), fetchRatesAndFx(), fetchOrphanageVisits(), fetchMemberPay(), fetchLiveHours()]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchMerged, fetchDisputes, fetchRatesAndFx, fetchOrphanageVisits, fetchMemberPay, fetchLiveHours]);

  /**
   * Pay summary view-model, sourced entirely from the manager calculator so the
   * employee sees the same figures Lenny/the manager would. `hoursPay` =
   * regular + OT (pre-bonus); `takeHome` already nets bonuses and the MESA
   * deduction (grandTotalPayPHP).
   */
  const payView = useMemo(() => {
    const t = memberPay?.totals;
    if (!t) return null;
    const hoursPay =
      t.regularPayPHP != null && t.otPayPHP != null
        ? Math.round((t.regularPayPHP + t.otPayPHP) * 100) / 100
        : null;
    return {
      totalSec: t.totalSec,
      regularSec: t.regularSec,
      otSec: t.otSec,
      regularPay: t.regularPayPHP,
      otPay: t.otPayPHP,
      hoursPay,
      pab: t.pabBonusPHP,
      tech: t.techBonusPHP,
      mesa: t.mesaDeductionPHP,
      takeHome: t.grandTotalPayPHP,
      hasRate: memberPay?.hasRate ?? false,
      otRate: memberPay?.otRate ?? null,
      hasHours: t.totalSec > 0,
    };
  }, [memberPay]);

  const goPrevMonth = useCallback(() => {
    setNavDirection(-1);
    setViewMonth((m) => {
      if (m <= 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goNextMonth = useCallback(() => {
    setNavDirection(1);
    setViewMonth((m) => {
      if (m >= 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  const disputesByDate = useMemo(() => {
    const map = new Map<string, PabDayDisputeRow>();
    for (const d of disputes) map.set(d.dispute_date, d);
    return map;
  }, [disputes]);

  const adjustmentsByDate = useMemo(() => {
    const map = new Map<string, TimeAdjustmentRow>();
    for (const a of timeAdjustments) map.set(a.adjust_date, a);
    return map;
  }, [timeAdjustments]);

  /** Merged Hubstaff + live overlay + approved dispute overrides, all calendar days (for pay + calendar grid). */
  const mergedHoursByDateKey = useMemo(() => {
    const hoursByDateKey = new Map<string, number>();
    const cols = mergedColumns;

    if (mergedRow && cols.length) {
      const dateCols = cols.filter(isDateCol);
      const groups = groupDateColumnsByCalendarDay(dateCols, cols);
      for (const group of groups) {
        let d: Date | null = null;
        for (const c of group) {
          d = parseColDate(c);
          if (d) break;
        }
        if (!d) continue;
        let maxS = 0;
        for (const c of group) {
          const raw =
            getFieldFromRow(mergedRow, [c]) ??
            (Object.prototype.hasOwnProperty.call(mergedRow, c) ? mergedRow[c] : undefined);
          maxS = Math.max(maxS, parseHMS(raw));
        }
        const key = pabDateKey(d);
        hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, maxS));
      }
    }

    // Live Hubstaff overlay: real tracked time for the trailing window. `max` keeps
    // the uploaded batch authoritative once it lands (it may include manual edits),
    // while filling days no batch covers yet — i.e. today and the current week.
    if (liveHours) {
      for (const [isoDate, sec] of Object.entries(liveHours.days)) {
        if (!sec || sec <= 0) continue;
        const [y, m, day] = isoDate.split('-').map(Number);
        if (!y || !m || !day) continue;
        const key = `${y}-${m}-${day}`;
        hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, sec));
      }
    }

    for (const d of disputes) {
      if (!disputeGrantsPabForgiveness(d)) continue;
      const set = d.override_hours;
      if (set == null || set < 0) continue;
      const [y, m, day] = d.dispute_date.split('-').map(Number);
      if (!y || !m || !day) continue;
      const key = `${y}-${m}-${day}`;
      hoursByDateKey.set(key, set * 3600);
    }
    return hoursByDateKey;
  }, [mergedRow, mergedColumns, disputes, liveHours]);

  const isHsl = (memberPay?.department ?? '').trim().toLowerCase() === 'hsl';

  /** For HSL: ISO dates where overnight combination (today + tomorrow OR yesterday + today) reaches ≥ 7h. */
  const hslOvernightIsos = useMemo(() => {
    const set = new Set<string>();
    if (!isHsl) return set;
    for (const [key, sec] of mergedHoursByDateKey) {
      if (sec <= 0 || sec >= 7 * 3600) continue;
      const [y, m, d] = key.split('-').map(Number);
      // Forward
      const nextDay = new Date(y, m - 1, d + 1);
      const nextSec = mergedHoursByDateKey.get(pabDateKey(nextDay)) ?? 0;
      if (sec + nextSec >= 7 * 3600) { set.add(key); continue; }
      // Backward
      const prevDay = new Date(y, m - 1, d - 1);
      const prevSec = mergedHoursByDateKey.get(pabDateKey(prevDay)) ?? 0;
      if (prevSec > 0 && prevSec < 7 * 3600 && prevSec + sec >= 7 * 3600) set.add(key);
    }
    return set;
  }, [isHsl, mergedHoursByDateKey]);

  const hoursCalendar = useMemo<PabCalendarDay[][] | null>(() => {
    const weeks = buildCalendarMonthWeeksIncludingWeekends(monthStart, monthEnd, mergedHoursByDateKey);
    return weeks.length > 0 ? weeks : null;
  }, [mergedHoursByDateKey, monthStart, monthEnd]);

  const monthTotalSeconds = useMemo(() => {
    const days = hoursCalendar?.flat() ?? [];
    return days.reduce((s, d) => {
      if (d.date.getMonth() !== viewMonth || d.date.getFullYear() !== viewYear) return s;
      return s + d.seconds;
    }, 0);
  }, [hoursCalendar, viewMonth, viewYear]);

  /** All days in this calendar month (incl. weekends) for pay — same keys as Hubstaff merge. */
  const monthAllDaysTotalSeconds = useMemo(() => {
    let s = 0;
    const cur = new Date(monthStart);
    while (cur.getTime() <= monthEnd.getTime()) {
      const key = pabDateKey(cur);
      s += mergedHoursByDateKey.get(key) ?? 0;
      cur.setDate(cur.getDate() + 1);
    }
    return s;
  }, [monthStart, monthEnd, mergedHoursByDateKey]);

  /**
   * Pay for this calendar month only: every logged second whose date falls inside
   * [monthStart, monthEnd] is included. Hours are grouped by Mon–Sun week; each week bucket
   * contains **only this month’s days**, then the usual 40h regular cap applies per bucket.
   */
  const monthPayEstimate = useMemo(() => {
    // The Payment Catalog is the source of truth. When it covers this employee
    // for the viewed (live) month, server-side member-monthly-pay reports the
    // catalog rate (PHP-equivalent) and `rateFromCatalog: true` — use it for
    // every day and bypass the per-day history, mirroring the server. Otherwise
    // fall back to the sheet cache rate.
    const catalogActive = memberPay?.rateFromCatalog === true;
    const cacheRegularRate = catalogActive ? memberPay?.regularRate ?? null : parseRateText(rate?.regular_rate);
    const cacheOtRate = catalogActive ? memberPay?.otRate ?? null : parseRateText(rate?.ot_rate);

    // Group every in-month day under its Mon–Sun week so the 40h regular cap
    // applies per week — matches `member-monthly-pay.ts` semantics.
    const weekDays = new Map<number, Array<{ date: Date; sec: number }>>();
    const cur = new Date(monthStart);
    while (cur.getTime() <= monthEnd.getTime()) {
      const key = pabDateKey(cur);
      const sec = mergedHoursByDateKey.get(key) ?? 0;
      const mon = mondayOfWeekContaining(cur).getTime();
      const list = weekDays.get(mon);
      const entry = { date: new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()), sec };
      if (list) list.push(entry);
      else weekDays.set(mon, [entry]);
      cur.setDate(cur.getDate() + 1);
    }

    let regularSec = 0;
    let otSec = 0;
    let regularPayAcc = 0;
    let otPayAcc = 0;
    let anyRegRate = false;
    let anyOtRate = false;

    const REG_CAP_SEC = 40 * 3600;

    for (const days of weekDays.values()) {
      // Sort chronologically so the 40h cap fills earliest days first — the
      // standard "you hit 40h on Friday afternoon, the rest is OT" model.
      days.sort((a, b) => a.date.getTime() - b.date.getTime());
      let usedRegSec = 0;
      for (const d of days) {
        if (d.sec <= 0) continue;
        const remaining = Math.max(0, REG_CAP_SEC - usedRegSec);
        const dayReg = Math.min(d.sec, remaining);
        const dayOt = d.sec - dayReg;
        usedRegSec += dayReg;
        regularSec += dayReg;
        otSec += dayOt;

        // Per-day rate resolution: catalog (when active) wins for every day;
        // otherwise history wins, falling back to the cache row (today's rate)
        // when no history entry covers this day.
        const resolved = catalogActive ? null : resolveRateAsOfLocal(rateHistory, d.date);
        const dayRegRate = resolved?.regularRate ?? cacheRegularRate;
        const dayOtRate  = resolved?.otRate      ?? cacheOtRate;
        if (dayRegRate != null) {
          anyRegRate = true;
          regularPayAcc += phpHourlyPayFromSeconds(dayRegRate, dayReg);
        }
        if (dayOtRate != null) {
          anyOtRate = true;
          otPayAcc += phpHourlyPayFromSeconds(dayOtRate, dayOt);
        }
      }
    }

    const regularPay = anyRegRate ? regularPayAcc : null;
    const otPay = otSec > 0 ? (anyOtRate ? otPayAcc : null) : 0;
    const totalPay =
      regularPay != null && otPay != null
        ? Math.round((regularPay + otPay) * 100) / 100
        : null;

    return {
      regularSec,
      otSec,
      regularPay,
      otPay,
      totalPay,
      // `otRate` was previously used downstream just to detect whether the OT
      // rate is on file. Mirror that semantic by reporting the cache rate.
      otRate: cacheOtRate,
      hasHours: monthAllDaysTotalSeconds > 0,
    };
  }, [rate, rateHistory, mergedHoursByDateKey, monthStart, monthEnd, monthAllDaysTotalSeconds, memberPay]);

  /**
   * PAB evaluation window for the viewed month. Uses the accounting-set override
   * from the Payroll Wizard's PAB Calendar period setter (`pab_period_overrides`)
   * when present, otherwise the default Mon-based PAB month range. Mirrors
   * `member-monthly-pay.ts` + `usePabPeriodSettings` so My Hours' eligibility
   * status and the Employee Dashboard agree with what the wizard dispatches.
   */
  const pabRange = useMemo(
    () => resolvePabRangeForMonth(viewYear, viewMonth, pabOverrides),
    [pabOverrides, viewYear, viewMonth],
  );

  const isPAEligible = useMemo(() => {
    const toIso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    // Walk every Mon–Fri in the PAB period (not the raw calendar month) so the
    // status matches the wizard's window. A day passes on ≥7h, a US holiday, an
    // approved forgiving dispute, or (HSL) an overnight-qualifying pairing —
    // identical to the per-cell `effectivelyPasses` logic below.
    const cur = new Date(pabRange.start.getFullYear(), pabRange.start.getMonth(), pabRange.start.getDate());
    const end = pabRange.end.getTime();
    let anyWeekday = false;
    while (cur.getTime() <= end) {
      const dow = cur.getDay();
      if (dow >= 1 && dow <= 5) {
        anyWeekday = true;
        const iso = toIso(cur);
        const sec = mergedHoursByDateKey.get(pabDateKey(cur)) ?? 0;
        const dispute = disputesByDate.get(iso);
        const forgiven = !!dispute && disputeGrantsPabForgiveness(dispute);
        const hslOvernight = isHsl && hslOvernightIsos.has(iso);
        const passes = sec >= 7 * 3600 || usHolidayDates.has(iso) || forgiven || hslOvernight;
        if (!passes) return false;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return anyWeekday;
  }, [pabRange, mergedHoursByDateKey, usHolidayDates, disputesByDate, isHsl, hslOvernightIsos]);

  /** Hourly rates loaded — gates both PAB and Tech bonus visibility. */
  const hasRates = useMemo(() => {
    const parseRate = (v: string | null | undefined): number | null => {
      if (v == null) return null;
      const n = parseFloat(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    return !!(
      rate &&
      (parseRate(rate.regular_rate) != null || parseRate(rate.ot_rate) != null)
    );
  }, [rate]);

  // PAB + Tech amounts + per-department eligibility resolved server-side by
  // /api/manager/member-monthly-pay (Payment Catalog System Bonuses). Falls back
  // to the legacy constants + "applies to everyone" before the data loads.
  const pabBonusPhpAmt = memberPay?.pabBonusAmountPHP ?? PERFECT_ATTENDANCE_BONUS_PHP;
  const techBonusPhpAmt = memberPay?.techBonusAmountPHP ?? TECHNOLOGY_BONUS_PHP;
  const pabDeptOk = memberPay?.pabDeptEligible ?? true;
  const techDeptOk = memberPay?.techDeptEligible ?? true;

  /** PAB Bonus: paid once per calendar month if every weekday in the month logged ≥7h. */
  const pabBonusAmount = useMemo(() => {
    if (!hasRates) return 0;
    if (!isPAEligible) return 0;
    if (!pabDeptOk) return 0;
    return pabBonusPhpAmt;
  }, [hasRates, isPAEligible, pabDeptOk, pabBonusPhpAmt]);

  /** True once the displayed month has fully concluded (today is past its last day). */
  const monthHasEnded = useMemo(() => {
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return todayMid.getTime() > monthEnd.getTime();
  }, [monthEnd]);

  /**
   * Tech Bonus pay period for the displayed month. Salary Date = Tuesday in the
   * 3rd full Mon–Sun week of the month (week 1 = first Mon–Sun week whose
   * Monday is ≥ the 1st); pay-period Monday = Salary Date − 8 days. Per Carla
   * (May 2026), this lands tech bonus two weeks out from PAB. Mirrors
   * `dispatch-bonuses.ts → isTechBonusWeek`.
   */
  const techBonusPayPeriod = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const dow = first.getDay();
    // Days forward to first Monday ≥ the 1st. Sun=0→1, Mon=1→0, Tue=2→6, …
    const daysForward = (8 - dow) % 7;
    const firstMon = new Date(viewYear, viewMonth, 1 + daysForward);
    const week3Mon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const salaryDate = new Date(week3Mon.getFullYear(), week3Mon.getMonth(), week3Mon.getDate() + 1);
    const weekStart = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), salaryDate.getDate() - 8);
    return { salaryDate, weekStart };
  }, [viewYear, viewMonth]);

  /**
   * Tech Bonus eligibility (UI estimate — every calendar month gets one Tech Bonus).
   *  - No rates → suppressed (matches canonical no-rates rule).
   *  - Viewed month not yet fully past → hidden. The bonus only "appears" once the
   *    3rd-week paycheck and the rest of the month have actually concluded; current
   *    and future months stay blank to avoid claiming a bonus that hasn't landed yet.
   *  - Start date known → 30-day gate enforced against pay-period Monday
   *    (matches `PayrollWizard.hasThirtyDaysByWeek`).
   *  - Start date unknown (master-row miss / email drift / admin viewing) → assume
   *    past 30 days. Dispatch still enforces the gate authoritatively.
   */
  const isTechnologyBonusActive = useMemo(() => {
    if (!hasRates) return false;
    if (!techDeptOk) return false;
    if (!monthHasEnded) return false;
    if (!employeeStartDate) return true;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    return techBonusPayPeriod.weekStart.getTime() >= eligibleFrom.getTime();
  }, [hasRates, employeeStartDate, techBonusPayPeriod, monthHasEnded, techDeptOk]);

  const technologyBonusAmount = isTechnologyBonusActive ? techBonusPhpAmt : 0;

  /** Take-home estimate including bonuses. Null until rates are on file. */
  const monthTakeHomePay = useMemo(() => {
    if (monthPayEstimate.totalPay == null) return null;
    return Math.round((monthPayEstimate.totalPay + pabBonusAmount + technologyBonusAmount) * 100) / 100;
  }, [monthPayEstimate.totalPay, pabBonusAmount, technologyBonusAmount]);

  const hasAnyInMonthData = useMemo(
    () =>
      (hoursCalendar?.flat() ?? []).some(
        (d) =>
          d.hasData &&
          d.date.getMonth() === viewMonth &&
          d.date.getFullYear() === viewYear,
      ),
    [hoursCalendar, viewMonth, viewYear],
  );

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col overflow-y-scroll bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 [scrollbar-gutter:stable] dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto flex min-h-0 w-full max-w-[110rem] flex-1 flex-col gap-4 p-4 pb-8 sm:p-6">
        <header className="shrink-0 space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white sm:text-xl">
            My Hours
          </h1>
          <p className="text-xs text-zinc-600 dark:text-zinc-500">
            Merged Hubstaff — calendar days match your uploads; dashed cells are the adjacent month but still show that day&apos;s hours. Pay summary counts only days in the month you&apos;re viewing (e.g. all of March).
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:items-stretch lg:overflow-hidden">
        <WeeklyEarningsRail
          rateHistory={rateHistory}
          cacheRegularRate={parseRateText(rate?.regular_rate)}
          cacheOtRate={parseRateText(rate?.ot_rate)}
          isHsl={isHsl}
          liveDays={liveHours?.days ?? null}
          loading={ratesLoading || memberPayLoading}
        />
        <Card
          size="sm"
          className="flex min-h-[34rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-md ring-1 ring-indigo-500/5 [@media(max-height:850px)]:max-h-[calc(100dvh-9rem)] dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/5 dark:ring-indigo-950/30 sm:min-h-[28rem] lg:max-h-[calc(100dvh-8rem)]"
        >
          <CardHeader className="shrink-0 space-y-2 pb-2 pt-4 sm:pt-5">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                Hubstaff hours
                {liveHours != null && (
                  <span
                    title={`Today's time comes straight from Hubstaff (updated ${new Date(liveHours.asOf).toLocaleTimeString()}). Past weeks show the payroll batch.`}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-400"
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                    Live
                  </span>
                )}
              </CardTitle>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing || loading}
                aria-label="Refresh hours"
                title="Refresh hours"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-indigo-200 bg-white text-indigo-600 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
              >
                {refreshing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden />
                )}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                <button
                  type="button"
                  onClick={goPrevMonth}
                  className="rounded-l-lg p-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="relative inline-flex min-w-[10rem] items-center justify-center overflow-hidden border-x border-zinc-200 px-3 py-1.5 text-center text-xs font-semibold text-zinc-800 dark:border-zinc-700 dark:text-zinc-200 sm:min-w-[12rem] sm:text-sm">
                  <AnimatePresence mode="wait" initial={false} custom={navDirection}>
                    <motion.span
                      key={`${viewYear}-${viewMonth}-label`}
                      initial={{ opacity: 0, y: navDirection * 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: navDirection * -6 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="inline-flex items-center gap-1"
                    >
                      {MONTH_NAMES[viewMonth]}{' '}
                      <span className="font-mono tabular-nums">{viewYear}</span>
                    </motion.span>
                  </AnimatePresence>
                </span>
                <button
                  type="button"
                  onClick={goNextMonth}
                  className="rounded-r-lg p-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  aria-label="Next month"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <p className="flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400 sm:text-[11px]">
              <CalendarDays className="h-3 w-3 shrink-0" />
              <span>
                <span className="font-semibold">
                  {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
                {' · '}
              {formatRangeDate(monthStart)} – {formatRangeDate(monthEnd)}
              </span>
            </p>
            <p className="flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 sm:text-[11px]">
              <Trophy className="h-3 w-3 shrink-0 text-indigo-500/80 dark:text-indigo-400/80" />
              <span>
                PAB period: {formatRangeDate(pabRange.start)} – {formatRangeDate(pabRange.end)}
                {pabRange.isOverride ? (
                  <span className="ml-1 rounded bg-indigo-100 px-1 py-px text-[9px] font-semibold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                    custom
                  </span>
                ) : null}
              </span>
            </p>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
            <AnimatePresence mode="wait" initial={false} custom={navDirection}>
              <motion.div
                key={loading ? 'loading' : `${viewYear}-${viewMonth}`}
                custom={navDirection}
                initial={loading ? false : { opacity: 0, x: navDirection * 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: navDirection * -18 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex min-h-0 flex-1 flex-col"
              >
            {loading ? (
              <div className="flex flex-1 flex-col gap-0">
                <div className="mb-1 grid grid-cols-[1.25rem_repeat(7,minmax(0,1fr))] gap-0.5 sm:grid-cols-[1.5rem_repeat(7,minmax(0,1fr))] sm:gap-1">
                  <div />
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="mx-auto h-2 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  ))}
                </div>
                {Array.from({ length: 5 }, (_, wi) => (
                  <div key={wi} className="mb-1 grid grid-cols-[1.25rem_repeat(7,minmax(0,1fr))] gap-0.5 sm:grid-cols-[1.5rem_repeat(7,minmax(0,1fr))] sm:gap-1">
                    <div className="flex items-center justify-end">
                      <div className="h-2 w-3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </div>
                    {Array.from({ length: 7 }, (_, di) => (
                      <div
                        key={di}
                        className="h-10 animate-pulse rounded-md border border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/30"
                        style={{ animationDelay: `${(wi * 7 + di) * 40}ms` }}
                      />
                    ))}
                  </div>
                ))}
                <div className="mt-auto flex items-center justify-center gap-2 pt-2 text-[10px] text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading Hubstaff data…
                </div>
              </div>
            ) : hoursCalendar && hoursCalendar.length > 0 ? (
              <div className="flex min-h-0 flex-1 flex-col gap-0">
                <div className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll [scrollbar-gutter:stable]">
                  <div className="sticky top-0 z-10 mb-1 grid min-w-[280px] grid-cols-[1.25rem_repeat(7,minmax(0,1fr))] gap-0.5 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95 sm:min-w-0 sm:grid-cols-[1.5rem_repeat(7,minmax(0,1fr))] sm:gap-1">
                    <div />
                    {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                      <div key={i} className="text-center text-[7px] font-semibold text-zinc-400 dark:text-zinc-500 sm:text-[8px]">
                        {d}
                      </div>
                    ))}
                  </div>
                  {hoursCalendar.map((week, wi) => (
                    <div
                      key={wi}
                      className="mb-1 grid min-w-[280px] grid-cols-[1.25rem_repeat(7,minmax(0,1fr))] items-stretch gap-0.5 sm:min-w-0 sm:grid-cols-[1.5rem_repeat(7,minmax(0,1fr))] sm:gap-1"
                    >
                      <div className="flex items-center justify-end text-[7px] font-medium text-zinc-400 dark:text-zinc-500 sm:text-[8px]">
                        {wi + 1}
                      </div>
                      {Array.from({ length: 7 }, (_, di) => {
                        const day: PabCalendarDay | undefined = week[di];
                        if (!day) {
                          return (
                            <div
                              key={di}
                              className="flex h-10 items-center justify-center rounded-md border border-dashed border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/20"
                            >
                              <span className="text-[7px] text-zinc-300 dark:text-zinc-700">—</span>
                            </div>
                          );
                        }
                        const inMonth =
                          day.date.getMonth() === viewMonth && day.date.getFullYear() === viewYear;
                        const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
                        const hours = day.seconds / 3600;
                        const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                        const holidayName = inMonth ? (usHolidayDates.get(dayIso) ?? null) : null;
                        const isHoliday = !!holidayName;
                        const dispute = inMonth ? disputesByDate.get(dayIso) : undefined;
                        const nowMid = new Date();
                        const todayMid = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate());
                        const cellMid = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
                        const isFutureOrToday = cellMid.getTime() >= todayMid.getTime();
                        const isToday = cellMid.getTime() === todayMid.getTime();
                        // Previous Mon–Sun week — empty weekday cells here are
                        // awaiting Hubstaff upload / payroll processing, not a
                        // real miss. Show "Processing" (sky) instead of orange
                        // "Pending" so employees can tell the two states apart.
                        const isPreviousWeek = (() => {
                          const todayDow = nowMid.getDay();
                          const daysBackToMon = (todayDow + 6) % 7;
                          const thisWeekMon = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate() - daysBackToMon);
                          const prevWeekMon = new Date(thisWeekMon.getFullYear(), thisWeekMon.getMonth(), thisWeekMon.getDate() - 7);
                          const prevWeekSun = new Date(prevWeekMon.getFullYear(), prevWeekMon.getMonth(), prevWeekMon.getDate() + 6);
                          return cellMid.getTime() >= prevWeekMon.getTime() && cellMid.getTime() <= prevWeekSun.getTime();
                        })();
                        const canDispute =
                          inMonth &&
                          !weekend &&
                          day.hasData &&
                          !day.passes &&
                          !dispute &&
                          !isFutureOrToday;
                        // Time adjustment: any in-month, non-future day (works even with no
                        // Hubstaff data yet). Today is allowed; future days are not.
                        const adjustment = inMonth ? adjustmentsByDate.get(dayIso) : undefined;
                        const canRequestAdjust = inMonth && cellMid.getTime() <= todayMid.getTime();
                        const cellClickable = canRequestAdjust || canDispute || !!dispute || !!adjustment;
                        const handleCellClick = () => {
                          if (adjustment) {
                            setTimeAdjustDialog({ date: dayIso, seconds: day.seconds, existing: adjustment });
                            return;
                          }
                          if (canRequestAdjust) {
                            setTimeAdjustDialog({ date: dayIso, seconds: day.seconds, existing: null });
                            return;
                          }
                          if (canDispute || dispute) {
                            setDisputeDialog({ date: dayIso, seconds: day.seconds, existingDispute: dispute ?? null });
                          }
                        };

                        // Accounting's explicit approval is the definitive signal — no hour floor.
                        // The old 4h floor only applied to the implicit day-after orphanage rule (removed 2026-05-01).
                        const forgiven =
                          !!dispute &&
                          disputeGrantsPabForgiveness(dispute) &&
                          !day.passes;
                        // For HSL: overnight-qualifying days (today + tomorrow OR yesterday + today ≥ 7h) show green
                        const hslOvernight = isHsl && inMonth && hslOvernightIsos.has(dayIso);
                        const effectivelyPasses = day.passes || forgiven || hslOvernight;

                        let cellBorder: string;
                        if (!inMonth) {
                          if (hours > 0 && weekend) {
                            cellBorder =
                              'border border-dashed border-zinc-300/90 bg-gradient-to-b from-zinc-50/60 to-orange-50/25 opacity-90 dark:border-zinc-600 dark:from-zinc-900/40 dark:to-orange-950/15';
                          } else if (hours > 0) {
                            cellBorder =
                              'border border-dashed border-indigo-200/80 bg-indigo-50/35 opacity-90 dark:border-indigo-900/50 dark:bg-indigo-950/25';
                          } else {
                            cellBorder =
                              'border border-dashed border-zinc-200/90 bg-zinc-50/30 dark:border-zinc-800 dark:bg-zinc-900/15';
                          }
                        } else if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                          cellBorder =
                            'border-amber-300 bg-amber-50 dark:border-amber-700/70 dark:bg-amber-950/40';
                        } else if (isHoliday) {
                          cellBorder =
                            'border-blue-300 bg-blue-50 dark:border-blue-700/70 dark:bg-blue-950/40';
                        } else if (weekend && isHsl && effectivelyPasses) {
                          cellBorder =
                            'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
                        } else if (weekend) {
                          if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                            cellBorder =
                              'border-amber-300 bg-amber-50 dark:border-amber-700/70 dark:bg-amber-950/40';
                          } else if (hours > 0) {
                            cellBorder =
                              'border-zinc-300 bg-gradient-to-b from-zinc-50 to-orange-50/50 dark:border-zinc-600 dark:from-zinc-900/50 dark:to-orange-950/20';
                          } else {
                            cellBorder =
                              'border-zinc-200/80 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/25';
                          }
                        } else if (effectivelyPasses) {
                          cellBorder =
                            'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
                        } else if (isFutureOrToday && !day.hasData) {
                          cellBorder =
                            'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
                        } else if (!day.hasData && isPreviousWeek && !weekend) {
                          cellBorder =
                            'border-sky-300 bg-sky-50 dark:border-sky-700/60 dark:bg-sky-950/30';
                        } else if (!day.hasData) {
                          cellBorder =
                            'border-orange-300 bg-orange-50 dark:border-orange-700/70 dark:bg-orange-950/30';
                        } else if (isToday) {
                          // Today is still in progress — live tracked time below 7h
                          // stays orange (in-progress), never red (failed day).
                          cellBorder =
                            'border-orange-300 bg-orange-50 dark:border-orange-700/70 dark:bg-orange-950/30';
                        } else {
                          cellBorder =
                            'border-red-300 bg-red-50 dark:border-red-700/70 dark:bg-red-950/40';
                        }

                        let hourText: string;
                        if (!inMonth) {
                          hourText =
                            hours > 0
                              ? 'text-zinc-600 dark:text-zinc-300'
                              : 'text-zinc-300 dark:text-zinc-600';
                        } else if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                          hourText = 'text-amber-700 dark:text-amber-400';
                        } else if (isHoliday) {
                          hourText = 'text-blue-600 dark:text-blue-400';
                        } else if (effectivelyPasses && !weekend) {
                          hourText = 'text-emerald-700 dark:text-emerald-400';
                        } else if (weekend && isHsl && effectivelyPasses) {
                          hourText = 'text-emerald-700 dark:text-emerald-400';
                        } else if (weekend && hours > 0) {
                          hourText = 'text-zinc-700 dark:text-zinc-200';
                        } else if (isFutureOrToday && !day.hasData) {
                          hourText = 'text-zinc-400 dark:text-zinc-500';
                        } else if (weekend) {
                          hourText = 'text-zinc-400 dark:text-zinc-500';
                        } else if (isToday) {
                          hourText = 'text-orange-600 dark:text-orange-400';
                        } else {
                          hourText = 'text-red-600 dark:text-red-400';
                        }

                        const titleScope = inMonth ? '' : ' · other month (still your Hubstaff)';
                        const titleBody = `${day.dayLabel} ${day.dateStr}: ${secondsToDisplay(day.seconds)}${isHoliday ? ` — ${holidayName}` : ''}${titleScope}`;
                        const titleDispute = dispute
                          ? ` (${dispute.status})`
                          : inMonth && day.passes
                            ? ' · OK'
                            : inMonth && isToday
                              ? ' — in progress'
                            : inMonth && isFutureOrToday
                              ? ' — not yet'
                              : inMonth && day.hasData
                                ? ' · needs 7h weekdays — tap to file an issue'
                                : inMonth
                                  ? ' — no data'
                                  : '';

                        // Per-day rate badge for the My Hours calendar — matches
                        // the Overview / PAB Calendar / Manager modal styling.
                        // Faint gray on normal days, emerald-ringed on the flip
                        // day (the day a new rate took effect).
                        const dayRateResolved = resolveRateAsOfLocal(rateHistory, day.date);
                        const isRateFlipDay = (() => {
                          if (rateHistory.length < 2) return false;
                          const t = day.date.getTime();
                          for (let i = 0; i < rateHistory.length; i += 1) {
                            const r = rateHistory[i];
                            if (r.effectiveFrom.getTime() <= t) {
                              return r.effectiveFrom.getTime() === t && i < rateHistory.length - 1;
                            }
                          }
                          return false;
                        })();
                        const dayRegRate = dayRateResolved?.regularRate ?? null;
                        const showRateBadge =
                          dayRegRate != null && (day.hasData || isRateFlipDay);
                        const rateLabel = dayRegRate != null
                          ? '₱' + dayRegRate.toLocaleString('en-PH', { maximumFractionDigits: 0 })
                          : '';
                        const rateTooltip = dayRegRate != null
                          ? ` · Rate ${rateLabel}${isRateFlipDay ? ' (new today)' : ''}`
                          : '';

                        return (
                          <div
                            key={di}
                            className={`group relative flex h-10 flex-col items-center justify-center gap-px rounded-md border transition-all duration-200 ${cellBorder} ${cellClickable ? 'cursor-pointer hover:z-30 hover:ring-2 hover:ring-orange-300/50' : ''}`}
                            title={`${titleBody}${titleDispute}${rateTooltip}`}
                            onClick={cellClickable ? handleCellClick : undefined}
                          >
                            {cellClickable && (
                              <div className={`absolute left-1/2 z-40 hidden -translate-x-1/2 group-hover:block ${wi === 0 ? 'top-full pt-1' : 'bottom-full pb-1'}`}>
                                <div className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-left shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                                  <p className="whitespace-nowrap text-[10px] font-semibold text-zinc-700 dark:text-zinc-200">
                                    {day.dayLabel} {day.dateStr}
                                  </p>
                                  <p className="whitespace-nowrap text-[10px] text-zinc-500 dark:text-zinc-400">
                                    {hours > 0 ? `${hours.toFixed(1)}h tracked` : 'No hours tracked'}
                                  </p>
                                  {(adjustment || canRequestAdjust) && (
                                    <p className="mt-0.5 whitespace-nowrap text-[9.5px] font-medium text-orange-600 dark:text-orange-400">
                                      {adjustment ? 'Click to view your request' : 'Click to request time adjustment'}
                                    </p>
                                  )}
                                  {(canDispute || dispute) && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDisputeDialog({ date: dayIso, seconds: day.seconds, existingDispute: dispute ?? null });
                                      }}
                                      className="mt-1 w-full whitespace-nowrap rounded border border-zinc-200 px-1.5 py-0.5 text-[9.5px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                    >
                                      {dispute ? 'View PAB issue' : 'File PAB issue'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                            <span className="text-[7px] font-medium leading-none tabular-nums text-zinc-400 dark:text-zinc-500 sm:text-[8px]">
                              {day.dateStr}
                            </span>
                            {isHoliday && (
                              <span className="pointer-events-none max-w-[calc(100%-2px)] truncate text-[6px] font-semibold leading-none tracking-tight text-blue-500 dark:text-blue-400 sm:text-[7px]">
                                Holiday
                              </span>
                            )}
                            {forgiven && !isHoliday && (
                              <span className="pointer-events-none max-w-[calc(100%-2px)] truncate text-[6px] font-semibold leading-none tracking-tight text-emerald-600 dark:text-emerald-400 sm:text-[7px]">
                                Forgiven
                              </span>
                            )}
                            {isToday && !day.hasData ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <Hourglass
                                  className="h-3 w-3 text-orange-400 dark:text-orange-300"
                                  style={{ animation: 'hourglass-flip 2s ease-in-out infinite' }}
                                />
                                <span className="text-[6.5px] font-semibold uppercase tracking-wider leading-none text-orange-400 dark:text-orange-300 sm:text-[7.5px]">
                                  In Progress
                                </span>
                              </div>
                            ) : isToday ? (
                              // Live tracked time landed (timer running or paused) —
                              // show the contribution so far, still flagged in-progress.
                              <div className="flex flex-col items-center gap-px">
                                <span
                                  className={`font-mono text-[10px] font-bold leading-none tabular-nums sm:text-[11px] ${
                                    effectivelyPasses
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : 'text-orange-600 dark:text-orange-400'
                                  }`}
                                >
                                  {secondsToDisplay(day.seconds)}
                                </span>
                                <span
                                  className={`text-[6px] font-semibold uppercase tracking-wider leading-none sm:text-[7px] ${
                                    effectivelyPasses
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-orange-400 dark:text-orange-300'
                                  }`}
                                >
                                  In Progress
                                </span>
                              </div>
                            ) : inMonth && !weekend && !day.hasData && isPreviousWeek ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <Loader2 className="h-3 w-3 animate-spin text-sky-500 dark:text-sky-400" />
                                <span className="text-[6.5px] font-semibold uppercase tracking-wider leading-none text-sky-600 dark:text-sky-400 sm:text-[7.5px]">
                                  Processing
                                </span>
                              </div>
                            ) : inMonth && !weekend && !day.hasData && !isFutureOrToday ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <Hourglass className="h-3 w-3 text-orange-400 dark:text-orange-300" />
                                <span className="text-[6.5px] font-semibold uppercase tracking-wider leading-none text-orange-400 dark:text-orange-300 sm:text-[7.5px]">
                                  Pending
                                </span>
                              </div>
                            ) : (
                              <span className={`font-mono text-[11px] font-bold leading-none tabular-nums sm:text-[13px] ${hourText}`}>
                                {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                              </span>
                            )}
                            {isToday && (
                              <span className="pointer-events-none absolute right-1 top-1 flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
                              </span>
                            )}
                            {showRateBadge && (
                              <span
                                className={`pointer-events-none absolute bottom-0 left-0.5 rounded px-0.5 text-[7px] font-semibold leading-tight tabular-nums sm:text-[8px] ${
                                  isRateFlipDay
                                    ? 'bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/40'
                                    : 'text-zinc-400 dark:text-zinc-500'
                                }`}
                              >
                                {rateLabel}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-3 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h (Mon–Fri)
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 sm:h-2 sm:w-2" /> &lt; 7h
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 sm:h-2 sm:w-2" /> Sat / Sun
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 sm:h-2 sm:w-2" /> Holiday
                  </span>
                  <span className="flex items-center gap-1 max-sm:basis-full">
                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-sm border border-dashed border-zinc-400 bg-zinc-100 dark:border-zinc-500 dark:bg-zinc-800 sm:h-2 sm:w-2" /> Adj. month
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Forgiven
                  </span>
                  <span className="ml-auto font-mono text-[10px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                    Month: {(monthTotalSeconds / 3600).toFixed(2)}h
                  </span>
                  <span className="w-full text-right font-medium sm:w-auto sm:ml-0">
                    {isPAEligible ? (
                      <span className="text-emerald-600 dark:text-emerald-400">All weekdays ≥ 7h</span>
                    ) : hasAnyInMonthData ? (
                      <span className="text-zinc-500 dark:text-zinc-400">Some weekdays below 7h or pending</span>
                    ) : null}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
                <CalendarDays className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  No calendar rows for this month, or Hubstaff hasn&apos;t been uploaded yet.
                </p>
              </div>
            )}
              </motion.div>
            </AnimatePresence>

            <details className="group mt-3 shrink-0 rounded-lg border border-rose-100 bg-rose-50/40 dark:border-rose-950/50 dark:bg-rose-950/20">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-semibold text-rose-700 transition-colors hover:bg-rose-50/80 dark:text-rose-300 dark:hover:bg-rose-950/30">
                <CalendarHeart className="h-3.5 w-3.5" aria-hidden />
                <span>My Orphanage Visits</span>
                <span className="rounded-full bg-rose-100 px-1.5 py-px font-mono text-[9px] tabular-nums text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                  {orphanageLoading ? '…' : orphanageVisits.length}
                </span>
                <span className="ml-auto text-[9px] font-normal text-rose-600/80 transition-transform group-open:rotate-180 dark:text-rose-400/80">▾</span>
              </summary>
              <div className="border-t border-rose-100 px-3 py-2 dark:border-rose-950/50">
                <p className="mb-2 text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
                  Visit dates recorded by HR. The PAB 7-hour floor drops to 4 hours on the visit day and the day after.
                </p>
                {orphanageLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-zinc-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading visits…
                  </div>
                ) : orphanageVisits.length === 0 ? (
                  <p className="py-3 text-center text-[11px] text-zinc-500">
                    No orphanage visits recorded yet.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-rose-50/95 to-orange-50/60 backdrop-blur-sm dark:from-rose-950/40 dark:to-blue-950/40">
                        <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                          <TableHead className="h-7 px-2 text-[10px] text-zinc-600 dark:text-zinc-400">Visit</TableHead>
                          <TableHead className="h-7 px-2 text-[10px] text-zinc-600 dark:text-zinc-400">Forgiven on</TableHead>
                          <TableHead className="h-7 px-2 text-[10px] text-zinc-600 dark:text-zinc-400">Note</TableHead>
                          <TableHead className="h-7 px-2 text-[10px] text-zinc-600 dark:text-zinc-400">By</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {orphanageVisits.map((v) => (
                          <TableRow
                            key={v.id}
                            className={cn(
                              'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40',
                            )}
                          >
                            <TableCell className="whitespace-nowrap px-2 py-1.5 text-[11px] font-medium text-zinc-800 dark:text-zinc-200">
                              {v.dispute_date}
                            </TableCell>
                            <TableCell className="whitespace-nowrap px-2 py-1.5 text-[10px] text-zinc-600 dark:text-zinc-400">
                              {v.dispute_date} &amp; {addDaysIso(v.dispute_date, 1)}
                            </TableCell>
                            <TableCell
                              className="max-w-[180px] truncate px-2 py-1.5 text-[10px] text-zinc-600 dark:text-zinc-400"
                              title={v.decision_note ?? ''}
                            >
                              {v.decision_note || '—'}
                            </TableCell>
                            <TableCell className="px-2 py-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                              {v.decided_by ?? '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </details>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="flex w-full shrink-0 flex-col rounded-2xl border-emerald-100/80 bg-gradient-to-br from-white to-emerald-50/25 shadow-md ring-1 ring-emerald-500/10 dark:border-emerald-950/50 dark:bg-none dark:from-emerald-950/15 dark:to-emerald-950/5 dark:ring-emerald-950/20 lg:w-80 xl:w-[22rem]"
        >
          <CardHeader className="shrink-0 space-y-1 pb-2 pt-4 sm:pt-5">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                <Wallet className="h-4 w-4" aria-hidden />
              </div>
              <CardTitle className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                Pay summary
              </CardTitle>
            </div>
            <p className="pl-10 text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
              <span className="font-medium text-emerald-800/90 dark:text-emerald-400/90">
                {MONTH_NAMES[viewMonth]} {viewYear}
              </span>
              <span className="text-zinc-400"> · </span>
              All 7 days count (incl. Sat / Sun). OT applies only to the hours past 40h in a Mon–Sun week.
            </p>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pb-5 pt-0 sm:px-5">
            <AnimatePresence mode="wait" initial={false} custom={navDirection}>
              <motion.div
                key={memberPayLoading ? 'loading' : `${viewYear}-${viewMonth}`}
                custom={navDirection}
                initial={memberPayLoading ? false : { opacity: 0, x: navDirection * 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: navDirection * -18 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex flex-1 flex-col gap-4"
              >
            {memberPayLoading ? (
              <div className="flex flex-1 flex-col gap-4">
                {/* Estimated take-home block */}
                <div className="rounded-xl border border-emerald-200/50 bg-emerald-50/30 px-3 py-3 dark:border-emerald-900/30 dark:bg-emerald-950/15">
                  <div className="h-2 w-28 animate-pulse rounded bg-emerald-200/70 dark:bg-emerald-900/50" />
                  <div className="mt-2 h-7 w-36 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
                  <div className="mt-2 h-2 w-44 max-w-full animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                </div>
                {/* Hours + bonus line items */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-200/80 pb-2 dark:border-zinc-800">
                    <div className="h-2.5 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-2.5 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                  {Array.from({ length: 4 }, (_, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <div
                        className="h-2.5 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                        style={{ animationDelay: `${i * 70}ms` }}
                      />
                      <div
                        className="h-2.5 w-24 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800/80"
                        style={{ animationDelay: `${i * 70 + 35}ms` }}
                      />
                    </div>
                  ))}
                </div>
                {/* Footnote */}
                <div className="mt-auto space-y-1.5">
                  <div className="h-2 w-full animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                  <div className="h-2 w-5/6 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                  <div className="h-2 w-2/3 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                </div>
              </div>
            ) : memberPayError ? (
              <p className="py-6 text-center text-xs text-rose-500 dark:text-rose-400">
                {memberPayError}
              </p>
            ) : !payView || !payView.hasHours ? (
              <p className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-500">
                No Hubstaff hours in this month yet — pay will show once days are logged.
              </p>
            ) : (
              <>
                <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/40 px-3 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/25">
                  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-emerald-800/70 dark:text-emerald-400/80">
                    Estimated take-home
                  </p>
                  {payView.takeHome != null ? (
                    <HiddenValue
                      iconClass="h-4 w-4"
                      showLabel="Reveal monthly take-home"
                      hideLabel="Hide monthly take-home"
                      className="mt-1 inline-flex flex-wrap items-baseline gap-2"
                      mask={
                        <span className="block">
                          <span className="font-mono text-2xl font-bold tabular-nums tracking-tight text-emerald-800/40 dark:text-emerald-300/40">
                            ₱•••••••••
                          </span>
                          <span className="ml-2 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-600">
                            ≈ $••••• USD
                            <span className="text-zinc-300 dark:text-zinc-700">
                              {' '}@ {formatPHP(usdToPhpRate)}/USD
                            </span>
                          </span>
                        </span>
                      }
                    >
                      <span className="block">
                        <span className="font-mono text-2xl font-bold tabular-nums tracking-tight text-emerald-800 dark:text-emerald-300">
                          {formatPHP(payView.takeHome)}
                        </span>
                        <span className="ml-2 font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                          ≈{' '}
                          {(payView.takeHome / usdToPhpRate).toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          USD
                          <span className="text-zinc-400"> @ {formatPHP(usdToPhpRate)}/USD</span>
                        </span>
                      </span>
                    </HiddenValue>
                  ) : (
                    <p className="mt-1 font-mono text-2xl font-bold tabular-nums tracking-tight text-emerald-800 dark:text-emerald-300">
                      —
                    </p>
                  )}
                  {payView.takeHome != null && (payView.pab > 0 || payView.tech > 0 || payView.mesa > 0) && (
                    <p className="mt-1 text-[10px] text-emerald-700/80 dark:text-emerald-400/80">
                      Hours pay {formatPHP(payView.hoursPay ?? 0)}
                      {payView.pab > 0 ? ` + PAB ${formatPHP(payView.pab)}` : ''}
                      {payView.tech > 0 ? ` + Tech ${formatPHP(payView.tech)}` : ''}
                      {payView.mesa > 0 ? ` - MESA ${formatPHP(payView.mesa)}` : ''}
                    </p>
                  )}
                </div>

                <div className="space-y-2.5 text-xs">
                  <div className="flex justify-between gap-2 border-b border-zinc-200/80 pb-2 dark:border-zinc-800">
                    <span className="text-zinc-500 dark:text-zinc-400">Total hours (month)</span>
                    <span className="font-mono font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                      {(payView.totalSec / 3600).toFixed(2)}h
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Regular</span>
                    <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                      {(payView.regularSec / 3600).toFixed(2)}h
                      {payView.regularPay != null ? (
                        <span className="text-zinc-500"> · {formatPHP(payView.regularPay)}</span>
                      ) : (
                        <span className="text-zinc-400"> · —</span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Overtime</span>
                    <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                      {(payView.otSec / 3600).toFixed(2)}h
                      {payView.otPay != null && payView.otSec > 0 ? (
                        <span className="text-zinc-500"> · {formatPHP(payView.otPay)}</span>
                      ) : payView.otSec > 0 && payView.otRate == null ? (
                        <span className="text-amber-600 dark:text-amber-400"> · need OT rate</span>
                      ) : (
                        <span className="text-zinc-400"> · {formatPHP(0)}</span>
                      )}
                    </span>
                  </div>

                  <div className="my-1 h-px bg-zinc-200/80 dark:bg-zinc-800" />

                  <div className="flex justify-between gap-2">
                    <span className={payView.pab > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500 dark:text-zinc-400'}>
                      PAB Bonus
                    </span>
                    <span className="font-mono tabular-nums">
                      {payView.pab > 0 ? (
                        <span className="font-medium text-indigo-700 dark:text-indigo-300">
                          +{formatPHP(payView.pab)}
                        </span>
                      ) : !payView.hasRate ? (
                        <span className="text-zinc-400 dark:text-zinc-600">—</span>
                      ) : (
                        <span className="text-zinc-500" title="Needs ≥7h on every weekday once the PAB period closes">
                          {formatPHP(0)}
                          <span className="ml-1 text-[10px] text-zinc-400">· not yet</span>
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between gap-2">
                    <span className={payView.tech > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-zinc-500 dark:text-zinc-400'}>
                      Tech Bonus
                    </span>
                    <span className="font-mono tabular-nums">
                      {payView.tech > 0 ? (
                        <span className="font-medium text-sky-700 dark:text-sky-300">
                          +{formatPHP(payView.tech)}
                        </span>
                      ) : !payView.hasRate ? (
                        <span className="text-zinc-400 dark:text-zinc-600">—</span>
                      ) : (
                        <span className="text-zinc-500">
                          {formatPHP(0)}
                          <span className="ml-1 text-[10px] text-zinc-400">· not yet</span>
                        </span>
                      )}
                    </span>
                  </div>

                  {payView.mesa > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-teal-600 dark:text-teal-400">MESA</span>
                      <span className="font-mono tabular-nums font-medium text-teal-700 dark:text-teal-300">
                        -{formatPHP(payView.mesa)}
                      </span>
                    </div>
                  )}
                </div>

                {(payView.takeHome == null && payView.hasHours) ? (
                  <p className="rounded-lg border border-amber-200/70 bg-amber-50/50 px-2.5 py-2 text-[10px] leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200/90">
                    Hourly rates aren&apos;t on file for your email — ask HR to add you to{' '}
                    <span className="font-mono">employee_hourly_rates</span> to see PHP totals.
                  </p>
                ) : null}

                <p className="mt-auto text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-600">
                  Only days in{' '}
                  <span className="font-medium">
                    {MONTH_NAMES[viewMonth]} {viewYear}
                  </span>{' '}
                  are included — <em>every weekday and weekend</em> with logged hours counts toward the
                  weekly total. Hours are grouped by Mon–Sun calendar week; only the portion of a week&apos;s
                  total that exceeds <span className="font-medium">40h</span> is paid at the OT rate.
                  <span className="font-medium text-indigo-600/80 dark:text-indigo-400/80"> PAB</span> pays{' '}
                  {formatPHP(pabBonusPhpAmt).replace(/\.\d{2}$/, '')} when every weekday hits ≥7h;
                  <span className="font-medium text-sky-600/80 dark:text-sky-400/80"> Tech Bonus</span> pays{' '}
                  {formatPHP(techBonusPhpAmt).replace(/\.\d{2}$/, '')} once per month after 30 days of
                  service. Final pay may differ after payroll.
                </p>
              </>
            )}
              </motion.div>
            </AnimatePresence>
          </CardContent>
        </Card>
        </div>

      </div>

      {disputeDialog && (
        <DisputeDialog
          open
          onOpenChange={(open) => { if (!open) setDisputeDialog(null); }}
          employeeEmail={email}
          disputeDate={disputeDialog.date}
          hoursWorked={disputeDialog.seconds}
          existingDispute={disputeDialog.existingDispute}
          onSubmitted={() => {
            setDisputeDialog(null);
            void fetchDisputes();
          }}
        />
      )}

      {timeAdjustDialog && (
        <TimeAdjustmentDialog
          open
          onOpenChange={(open) => { if (!open) setTimeAdjustDialog(null); }}
          employeeEmail={email}
          adjustDate={timeAdjustDialog.date}
          hoursWorked={timeAdjustDialog.seconds}
          existingRequest={timeAdjustDialog.existing}
          onSubmitted={() => {
            setTimeAdjustDialog(null);
            void fetchTimeAdjustments();
          }}
        />
      )}
    </div>
  );
}
