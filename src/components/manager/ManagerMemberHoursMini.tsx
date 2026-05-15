'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Wallet } from 'lucide-react';
import { normEmail } from '@/lib/email/norm-email';
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
import { phpHourlyPayFromSeconds } from '@/lib/payroll/money-php';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import { cn } from '@/lib/utils';

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

const CANONICAL_WEEKDAYS = new Set([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

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

const HUBSTAFF_EMAIL_KEYS = ['Email', 'email', 'Work Email', 'work_email', 'user_email'] as const;

function rowMatchesEmployee(
  row: Record<string, unknown>,
  employeeNorms: Set<string>,
): boolean {
  const seen = new Set<string>();
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v != null) seen.add(String(v));
    }
  }
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lower.set(k.toLowerCase(), v);
  for (const alias of ['work email', 'personal email', 'work_email', 'personal_email']) {
    const v = lower.get(alias);
    if (v != null) seen.add(String(v));
  }
  for (const e of seen) {
    const n = normEmail(e);
    if (n && employeeNorms.has(n)) return true;
  }
  return false;
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

function mondayOfWeekContaining(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  x.setDate(x.getDate() - daysBack);
  return x;
}

function formatPhp(n: number | null | undefined): string {
  if (n == null) return '—';
  return '₱' + n.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const SLIDE_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };
const LABEL_TRANSITION = { duration: 0.14, ease: 'easeOut' as const };

/** Slim shape of `/api/manager/member-monthly-pay` — only the fields the
 *  modal needs to render. Kept inline so the component file is self-contained. */
type MemberMonthlyPaySummary = {
  hasRate: boolean;
  startDate: string | null;
  totals: {
    regularSec: number;
    otSec: number;
    regularPayPHP: number | null;
    otPayPHP: number | null;
    weekendSec: number;
    weekendRegularSec: number;
    weekendOtSec: number;
    weekendPayPHP: number | null;
    pabBonusPHP: number;
    techBonusPHP: number;
    bonusTotalPHP: number;
    mesaDeductionPHP: number;
    mesaMember: boolean;
    grandTotalPayPHP: number | null;
  };
  weeks: {
    weekStart: string;
    weekEnd: string;
    isFinalPabWeek: boolean;
    isTechBonusWeek: boolean;
    isPabEligible: boolean;
    hasThirtyDays: boolean;
    pabMonthComplete: boolean;
    techSalaryReached: boolean;
    pabBonusPHP: number;
    techBonusPHP: number;
  }[];
};

interface ManagerMemberHoursMiniProps {
  workEmail: string | null;
  personalEmail: string | null;
  ratesHidden?: boolean;
}

export default function ManagerMemberHoursMini({
  workEmail,
  personalEmail,
  ratesHidden = false,
}: ManagerMemberHoursMiniProps) {
  const aliasNorms = useMemo(() => {
    const set = new Set<string>();
    const we = normEmail(workEmail ?? '');
    const pe = normEmail(personalEmail ?? '');
    if (we) set.add(we);
    if (pe) set.add(pe);
    return set;
  }, [workEmail, personalEmail]);

  const [mergedRow, setMergedRow] = useState<Record<string, unknown> | null>(null);
  const [mergedColumns, setMergedColumns] = useState<string[]>([]);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Authoritative server-side pay summary including PAB + Tech bonus gates.
  // Loaded per-month; the client-side calendar still drives navigation.
  const [serverPay, setServerPay] = useState<MemberMonthlyPaySummary | null>(null);
  const [serverPayLoading, setServerPayLoading] = useState(false);

  const init = useMemo(() => getCurrentPabMonth(), []);
  const [viewYear, setViewYear] = useState(init.year);
  const [viewMonth, setViewMonth] = useState(init.month);
  // +1 when navigating forward, -1 when going back; drives slide direction.
  const [navDirection, setNavDirection] = useState<1 | -1>(1);

  // Fetch hubstaff merged data + rate ONCE per member open. Month navigation is
  // purely derived state — no refetches → instant transitions.
  useEffect(() => {
    if (aliasNorms.size === 0) {
      setLoading(false);
      setMergedRow(null);
      setMergedColumns([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [filesRes, ratesRes] = await Promise.all([
          fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        ]);
        const filesJson = (await filesRes.json()) as { files?: string[] };
        const ratesJson = (await ratesRes.json()) as {
          rows?: EmployeeHourlyRateRow[];
        };

        const allRates = ratesJson.rows ?? [];
        const myRate = allRates.find((r) => {
          const we = normEmail(r.work_email);
          const pe = normEmail(r.personal_email);
          return (we && aliasNorms.has(we)) || (pe && aliasNorms.has(pe));
        });
        if (cancelled) return;
        setRate(myRate ?? null);

        const files = filesJson.files ?? [];
        if (files.length === 0) {
          setMergedRow(null);
          setMergedColumns([]);
          return;
        }

        const responses = await Promise.all(
          files.map((file) =>
            fetch(`/api/hubstaff-hours?source_file=${encodeURIComponent(file)}`, {
              cache: 'no-store',
            })
              .then(async (r) => ({
                file,
                json: (await r.json()) as {
                  columns?: string[] | null;
                  rows?: Record<string, unknown>[] | null;
                },
              }))
              .catch(() => ({
                file,
                json: { columns: null, rows: null } as {
                  columns: string[] | null;
                  rows: Record<string, unknown>[] | null;
                },
              })),
          ),
        );
        if (cancelled) return;

        const allCols = new Set<string>();
        let merged: Record<string, unknown> = {};
        let found = false;

        for (const { file, json } of responses) {
          if (!json.columns || !json.rows) continue;
          const myRow = json.rows.find((r) => rowMatchesEmployee(r, aliasNorms));
          if (!myRow) continue;
          found = true;
          const needsResolve = columnsAreAllCanonical(json.columns);
          const resolved = needsResolve
            ? resolveCanonicalColumnsToIso(myRow, file)
            : myRow;
          for (const col of needsResolve ? Object.keys(resolved) : json.columns) {
            allCols.add(col);
          }
          merged = { ...merged, ...resolved };
        }
        setMergedColumns([...allCols]);
        setMergedRow(found ? merged : null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to load hours');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aliasNorms]);

  // Fetch the authoritative server-side pay summary (regular + OT + PAB +
  // Tech bonus + 40h overtime cap, all gated against dispatch logic). Re-runs
  // on month change because bonus eligibility is per-week-per-month.
  useEffect(() => {
    const lookupEmail = workEmail?.trim() || personalEmail?.trim() || '';
    if (!lookupEmail) {
      setServerPay(null);
      return;
    }
    let cancelled = false;
    // Clear previous month/server snapshot immediately so we never render stale
    // bonus/pay values while a different month is loading.
    setServerPay(null);
    setServerPayLoading(true);
    const params = new URLSearchParams({
      email: lookupEmail,
      year: String(viewYear),
      month: String(viewMonth),
    });
    fetch(`/api/manager/member-monthly-pay?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { data?: MemberMonthlyPaySummary | null; error?: string | null }) => {
        if (cancelled) return;
        if (json.error || !json.data) {
          setServerPay(null);
        } else {
          setServerPay(json.data);
        }
      })
      .catch(() => {
        if (!cancelled) setServerPay(null);
      })
      .finally(() => {
        if (!cancelled) setServerPayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workEmail, personalEmail, viewYear, viewMonth]);

  // Derived per-day map — recomputed only when raw merged data changes, never on
  // month nav.
  const hoursByDateKey = useMemo(() => {
    const map = new Map<string, number>();
    if (!mergedRow || mergedColumns.length === 0) return map;
    const dateCols = mergedColumns.filter(isDateCol);
    const groups = groupDateColumnsByCalendarDay(dateCols, mergedColumns);
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
      map.set(key, Math.max(map.get(key) ?? 0, maxS));
    }
    return map;
  }, [mergedRow, mergedColumns]);

  const monthStart = useMemo(
    () => new Date(viewYear, viewMonth, 1),
    [viewYear, viewMonth],
  );
  const monthEnd = useMemo(
    () => new Date(viewYear, viewMonth + 1, 0),
    [viewYear, viewMonth],
  );

  const calendarWeeks = useMemo<PabCalendarDay[][] | null>(() => {
    const w = buildCalendarMonthWeeksIncludingWeekends(monthStart, monthEnd, hoursByDateKey);
    return w.length > 0 ? w : null;
  }, [hoursByDateKey, monthStart, monthEnd]);

  const monthAllDaysTotalSeconds = useMemo(() => {
    let s = 0;
    const cur = new Date(monthStart);
    while (cur.getTime() <= monthEnd.getTime()) {
      const key = pabDateKey(cur);
      s += hoursByDateKey.get(key) ?? 0;
      cur.setDate(cur.getDate() + 1);
    }
    return s;
  }, [monthStart, monthEnd, hoursByDateKey]);

  const monthPay = useMemo(() => {
    const regularRate = parseRate(rate?.regular_rate);
    const otRate = parseRate(rate?.ot_rate);

    // Bucket each day's seconds by week (Monday-anchored). We later iterate each
    // week chronologically so the 40h regular cap is filled in day-of-week order
    // (Mon → Sun) — that way Saturday/Sunday seconds correctly attribute to OT
    // when Mon-Fri already filled the cap.
    const daysByWeek = new Map<number, { date: Date; seconds: number }[]>();
    const cur = new Date(monthStart);
    while (cur.getTime() <= monthEnd.getTime()) {
      const key = pabDateKey(cur);
      const sec = hoursByDateKey.get(key) ?? 0;
      const wk = mondayOfWeekContaining(cur).getTime();
      const arr = daysByWeek.get(wk) ?? [];
      arr.push({ date: new Date(cur), seconds: sec });
      daysByWeek.set(wk, arr);
      cur.setDate(cur.getDate() + 1);
    }

    let regularSec = 0;
    let otSec = 0;
    let weekendRegularSec = 0;
    let weekendOtSec = 0;
    let weekdayRegularSec = 0;
    let weekdayOtSec = 0;
    let weekendTotalSec = 0;

    const REGULAR_WEEK_CAP_SEC = 40 * 3600;
    for (const days of daysByWeek.values()) {
      const sortedDays = [...days].sort((a, b) => a.date.getTime() - b.date.getTime());
      let usedThisWeek = 0;
      for (const d of sortedDays) {
        if (d.seconds <= 0) continue;
        const isWeekend = d.date.getDay() === 0 || d.date.getDay() === 6;
        if (isWeekend) weekendTotalSec += d.seconds;
        const remaining = Math.max(0, REGULAR_WEEK_CAP_SEC - usedThisWeek);
        const dayRegular = Math.min(d.seconds, remaining);
        const dayOt = d.seconds - dayRegular;
        regularSec += dayRegular;
        otSec += dayOt;
        if (isWeekend) {
          weekendRegularSec += dayRegular;
          weekendOtSec += dayOt;
        } else {
          weekdayRegularSec += dayRegular;
          weekdayOtSec += dayOt;
        }
        usedThisWeek += d.seconds;
      }
    }

    const regularPay =
      regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
    const otPay =
      otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
    const totalPay =
      regularPay != null && otPay != null
        ? Math.round((regularPay + otPay) * 100) / 100
        : null;

    const weekendPay =
      regularRate != null
        ? phpHourlyPayFromSeconds(regularRate, weekendRegularSec) +
          (otRate != null ? phpHourlyPayFromSeconds(otRate, weekendOtSec) : 0)
        : null;
    const weekdayPay =
      regularRate != null
        ? phpHourlyPayFromSeconds(regularRate, weekdayRegularSec) +
          (otRate != null ? phpHourlyPayFromSeconds(otRate, weekdayOtSec) : 0)
        : null;

    return {
      regularSec,
      otSec,
      regularPay,
      otPay,
      totalPay,
      weekendTotalSec,
      weekendRegularSec,
      weekendOtSec,
      weekendPay: weekendPay != null ? Math.round(weekendPay * 100) / 100 : null,
      weekdayPay: weekdayPay != null ? Math.round(weekdayPay * 100) / 100 : null,
      hasHours: monthAllDaysTotalSeconds > 0,
      hasRate: regularRate != null || otRate != null,
    };
  }, [rate, hoursByDateKey, monthStart, monthEnd, monthAllDaysTotalSeconds]);

  const goPrev = useCallback(() => {
    setNavDirection(-1);
    setViewMonth((m) => {
      if (m <= 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goNext = useCallback(() => {
    setNavDirection(1);
    setViewMonth((m) => {
      if (m >= 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  if (aliasNorms.size === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-4 py-10 text-center text-[12px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
        No work or personal email on file — hours can&rsquo;t be looked up.
      </div>
    );
  }

  const monthKey = `${viewYear}-${viewMonth}`;

  return (
    <div className="space-y-3">
      {/* Month picker */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            onClick={goPrev}
            className="rounded-l-lg p-1.5 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="relative inline-flex min-w-[8.5rem] transform-gpu items-center justify-center overflow-hidden border-x border-zinc-200 px-3 py-1 text-center text-[12px] font-semibold text-zinc-800 dark:border-zinc-700 dark:text-zinc-200">
            <AnimatePresence mode="wait" initial={false} custom={navDirection}>
              <motion.span
                key={`${monthKey}-label`}
                initial={{ opacity: 0, y: navDirection * 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: navDirection * -6 }}
                transition={LABEL_TRANSITION}
                className="inline-flex items-center gap-1"
              >
                {MONTH_NAMES[viewMonth]}{' '}
                <span className="font-mono tabular-nums">{viewYear}</span>
              </motion.span>
            </AnimatePresence>
          </span>
          <button
            type="button"
            onClick={goNext}
            className="rounded-r-lg p-1.5 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Next month"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="hidden items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400 sm:flex">
          <CalendarDays className="h-3 w-3" />
          {(monthAllDaysTotalSeconds / 3600).toFixed(1)}h month
        </div>
      </div>

      {/* Calendar grid — slides horizontally on month change */}
      <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
        <AnimatePresence mode="wait" initial={false} custom={navDirection}>
          <motion.div
            key={loading ? 'loading' : monthKey}
            custom={navDirection}
            initial={loading ? false : { opacity: 0, x: navDirection * 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: navDirection * -14 }}
            transition={SLIDE_TRANSITION}
            className="transform-gpu"
          >
            {loading ? (
              <CalendarSkeleton />
            ) : error ? (
              <p className="py-6 text-center text-[11px] text-rose-600 dark:text-rose-400">
                {error}
              </p>
            ) : !calendarWeeks ? (
              <p className="py-6 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
                No Hubstaff data for this month.
              </p>
            ) : (
              <CalendarBody weeks={calendarWeeks} viewYear={viewYear} viewMonth={viewMonth} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Pay summary */}
      <div className="overflow-hidden rounded-xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/50 to-white p-3 dark:border-emerald-900/40 dark:from-emerald-950/20 dark:to-zinc-950/40">
        <AnimatePresence mode="wait" initial={false} custom={navDirection}>
          <motion.div
            key={loading ? 'pay-loading' : `pay-${monthKey}`}
            custom={navDirection}
            initial={loading ? false : { opacity: 0, x: navDirection * 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: navDirection * -14 }}
            transition={SLIDE_TRANSITION}
            className="transform-gpu"
          >
            {loading || serverPayLoading ? (
              <PaySummarySkeleton />
            ) : !monthPay.hasHours ? (
              <p className="py-3 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
                No hours yet for this month.
              </p>
            ) : (
              (() => {
                // Server-side numbers are authoritative (regular/OT split + PAB
                // + Tech bonus gates). Fall back to client-side numbers while
                // the server fetch is in flight or if it failed.
                const sp = serverPay;
                // Server total already nets out MESA contributions across all
                // active weeks; only fall back to client-side flat-100 when
                // server data isn't loaded yet.
                const clientMesaFallback = rate?.mesa_member ? 100 : 0;
                const mesaDeduction = sp ? sp.totals.mesaDeductionPHP : clientMesaFallback;
                const isMesaMember = sp ? sp.totals.mesaMember : rate?.mesa_member === true;
                const totalPayPhp = sp
                  ? sp.totals.grandTotalPayPHP
                  : monthPay.totalPay != null
                    ? monthPay.totalPay - clientMesaFallback
                    : null;
                const regularSec = sp?.totals.regularSec ?? monthPay.regularSec;
                const otSec = sp?.totals.otSec ?? monthPay.otSec;
                const weekendSec = sp?.totals.weekendSec ?? monthPay.weekendTotalSec;
                const weekendRegSec =
                  sp?.totals.weekendRegularSec ?? monthPay.weekendRegularSec;
                const weekendOtSec = sp?.totals.weekendOtSec ?? monthPay.weekendOtSec;
                const weekendPay = sp?.totals.weekendPayPHP ?? monthPay.weekendPay;
                const pabPhp = sp?.totals.pabBonusPHP ?? 0;
                const techPhp = sp?.totals.techBonusPHP ?? 0;
                const hasRate = sp?.hasRate ?? monthPay.hasRate;

                // Per-week PAB / Tech context for the bonus rows so we can
                // explain *why* it's missing (e.g. "not eligible — perfect
                // attendance failed" vs "this month has no final PAB week").
                const pabWeek = sp?.weeks.find((w) => w.isFinalPabWeek);
                const techWeek = sp?.weeks.find((w) => w.isTechBonusWeek);

                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-emerald-700/80 dark:text-emerald-400/80">
                        Estimated pay
                      </span>
                      <Wallet className="h-3.5 w-3.5 text-emerald-600/70 dark:text-emerald-400/70" />
                    </div>
                    <div className="flex items-baseline gap-2 font-mono text-xl font-bold tabular-nums tracking-tight text-emerald-800 dark:text-emerald-300">
                      <span>{ratesHidden ? <span className="tracking-widest text-zinc-400 dark:text-zinc-600">••••••</span> : (totalPayPhp != null ? formatPhp(totalPayPhp) : '—')}</span>
                      <AnimatePresence>
                        {serverPayLoading && (
                          <motion.span
                            initial={{ opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.85 }}
                            transition={{ duration: 0.18 }}
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-200/70 bg-white/80 px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-emerald-700/80 shadow-sm dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-300/80"
                          >
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            Syncing
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                    <dl className="grid grid-cols-3 gap-1 border-t border-emerald-200/60 pt-2 text-[10.5px] dark:border-emerald-900/40">
                      <Stat label="Total" value={`${(monthAllDaysTotalSeconds / 3600).toFixed(2)}h`} />
                      <Stat label="Reg" value={`${(regularSec / 3600).toFixed(2)}h`} />
                      <Stat label="OT" value={`${(otSec / 3600).toFixed(2)}h`} />
                    </dl>

                    {/* Bonuses — PAB + Tech. Always shown when the modal can
                        speak to the server, so the manager sees both
                        "earned" and "didn't earn" cases with the gate reason.
                        Hidden when serverPay is unavailable (no point
                        guessing at bonuses client-side). */}
                    {sp && (
                      <div className="rounded-lg border border-violet-200/70 bg-gradient-to-br from-violet-50/70 to-fuchsia-50/30 p-2 dark:border-violet-900/40 dark:from-violet-950/20 dark:to-fuchsia-950/15">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-violet-700/85 dark:text-violet-300/85">
                            Bonuses
                          </span>
                          <span className="font-mono text-[11px] font-bold tabular-nums text-violet-800 dark:text-violet-200">
                            {ratesHidden ? <span className="tracking-widest text-zinc-400 dark:text-zinc-600">••••</span> : formatPhp(sp.totals.bonusTotalPHP)}
                          </span>
                        </div>
                        <BonusRow
                          label="PAB"
                          amount={pabPhp}
                          hidden={ratesHidden}
                          reason={
                            !pabWeek
                              ? 'No final PAB week falls in this month'
                              : !pabWeek.pabMonthComplete
                                ? 'Month in progress — PAB finalizes at month end'
                                : !pabWeek.isPabEligible
                                  ? 'Not eligible — perfect-attendance check failed'
                                  : null
                          }
                        />
                        <BonusRow
                          label="Tech"
                          amount={techPhp}
                          hidden={ratesHidden}
                          reason={
                            !techWeek
                              ? 'No 3rd-week salary date falls in this month'
                              : !techWeek.techSalaryReached
                                ? 'Pending — salary date not yet reached'
                                : !sp.startDate
                                  ? 'Not eligible — no start date on file'
                                  : !techWeek.hasThirtyDays
                                    ? `Not eligible — under 30 days of service (started ${sp.startDate})`
                                    : null
                          }
                        />
                        {isMesaMember && (
                          <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-teal-50/60 px-2 py-1 dark:bg-teal-950/30">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-teal-700/85 dark:text-teal-300/80">
                              MESA <span className="text-[9px] font-normal normal-case tracking-normal text-teal-600/70 dark:text-teal-400/70">(₱100/wk)</span>
                            </span>
                            <span className="font-mono text-[10.5px] font-semibold tabular-nums text-teal-800 dark:text-teal-200">
                              {ratesHidden ? <span className="tracking-widest text-zinc-400 dark:text-zinc-600">••••</span> : `−${formatPhp(mesaDeduction)}`}
                            </span>
                          </div>
                        )}
                        {!hasRate && (
                          <p className="mt-1 rounded-md bg-amber-50/70 px-2 py-1 text-[9.5px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                            No hourly rate on file — bonuses suppressed.
                          </p>
                        )}
                      </div>
                    )}

                    {/* Weekend breakdown — Sat+Sun hours and pay. Authoritative
                        when serverPay loaded, falls back to client-side. */}
                    {weekendSec > 0 && (
                      <div className="rounded-lg border border-orange-200/70 bg-gradient-to-br from-orange-50/70 to-amber-50/40 p-2 dark:border-orange-900/40 dark:from-orange-950/20 dark:to-amber-950/15">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-orange-700/85 dark:text-orange-400/85">
                            Weekend (Sat + Sun)
                          </span>
                          <span className="font-mono text-[11px] font-bold tabular-nums text-orange-800 dark:text-orange-300">
                            {weekendPay != null ? formatPhp(weekendPay) : '—'}
                          </span>
                        </div>
                        <dl className="grid grid-cols-3 gap-1 text-[10.5px]">
                          <Stat label="Hrs" value={`${(weekendSec / 3600).toFixed(2)}h`} />
                          <Stat label="Reg" value={`${(weekendRegSec / 3600).toFixed(2)}h`} />
                          <Stat label="OT" value={`${(weekendOtSec / 3600).toFixed(2)}h`} />
                        </dl>
                      </div>
                    )}

                    {!hasRate && (
                      <p className="rounded-md bg-amber-50/70 px-2 py-1 text-[10px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                        No hourly rate on file — PHP totals unavailable.
                      </p>
                    )}
                  </div>
                );
              })()
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function BonusRow({
  label,
  amount,
  reason,
  hidden,
}: {
  label: string;
  amount: number;
  reason: string | null;
  hidden?: boolean;
}) {
  const earned = amount > 0;
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'font-mono text-[10px] font-medium tabular-nums',
            earned
              ? 'text-violet-800 dark:text-violet-200'
              : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          {label}
        </span>
        {reason && (
          <span className="ml-1.5 text-[9.5px] italic text-zinc-500 dark:text-zinc-500">
            · {reason}
          </span>
        )}
      </div>
      <span
        className={cn(
          'font-mono text-[10.5px] tabular-nums',
          earned
            ? 'font-semibold text-violet-800 dark:text-violet-200'
            : 'text-zinc-400 dark:text-zinc-600',
        )}
      >
        {hidden ? <span className="tracking-widest text-zinc-400 dark:text-zinc-600">••••</span> : (earned ? formatPhp(amount) : '—')}
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9.5px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">{value}</dd>
    </div>
  );
}

function PaySummarySkeleton() {
  return (
    <div className="relative space-y-2">
      {/* Spinner overlay — sits over the shimmering bars so the user sees both
          "we're loading" and "here's the layout to come". */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-white/90 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-700 shadow-sm backdrop-blur-sm dark:border-emerald-800/60 dark:bg-emerald-950/70 dark:text-emerald-300">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading payment
        </div>
      </div>

      {/* Header line */}
      <div className="flex items-center justify-between gap-2">
        <div className="h-2.5 w-20 animate-pulse rounded bg-emerald-200/70 dark:bg-emerald-900/50" />
        <div className="h-3 w-3 animate-pulse rounded-full bg-emerald-200/70 dark:bg-emerald-900/50" />
      </div>
      {/* Big total */}
      <div className="h-7 w-40 animate-pulse rounded bg-emerald-200/70 dark:bg-emerald-900/50" />
      {/* 3-up stats */}
      <div className="grid grid-cols-3 gap-1 border-t border-emerald-200/60 pt-2 dark:border-emerald-900/40">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-1">
            <div
              className="h-1.5 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ animationDelay: `${i * 60}ms` }}
            />
            <div
              className="h-2.5 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ animationDelay: `${i * 60 + 30}ms` }}
            />
          </div>
        ))}
      </div>
      {/* Bonuses tile */}
      <div className="rounded-lg border border-violet-200/60 bg-gradient-to-br from-violet-50/60 to-fuchsia-50/30 p-2 dark:border-violet-900/40 dark:from-violet-950/20 dark:to-fuchsia-950/15">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="h-2 w-12 animate-pulse rounded bg-violet-200/80 dark:bg-violet-900/60" />
          <div className="h-2.5 w-14 animate-pulse rounded bg-violet-200/80 dark:bg-violet-900/60" />
        </div>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-2 py-0.5">
            <div
              className="h-2 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ animationDelay: `${i * 80}ms` }}
            />
            <div
              className="h-2 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ animationDelay: `${i * 80 + 40}ms` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="relative">
      {/* Spinner badge — same visual language as the pay-summary skeleton. */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white/90 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-700 shadow-sm backdrop-blur-sm dark:border-zinc-700/60 dark:bg-zinc-900/80 dark:text-zinc-300">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading hours
        </div>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-1">
        {Array.from({ length: 7 }, (_, i) => (
          <div
            key={i}
            className="mx-auto h-2 w-3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
          />
        ))}
      </div>
      {Array.from({ length: 5 }, (_, wi) => (
        <div key={wi} className="mb-1 grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, di) => (
            <div
              key={di}
              className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900/60"
              style={{ animationDelay: `${(wi * 7 + di) * 30}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function CalendarBody({
  weeks,
  viewYear,
  viewMonth,
}: {
  weeks: PabCalendarDay[][];
  viewYear: number;
  viewMonth: number;
}) {
  // Cache today midnight once — reading Date inside every cell is wasteful.
  const todayMid = useMemo(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  }, []);

  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div
            key={i}
            className="text-center text-[8px] font-semibold text-zinc-400 dark:text-zinc-500"
          >
            {d}
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="mb-1 grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, di) => {
            const day = week[di];
            if (!day) {
              return (
                <div
                  key={di}
                  className="h-9 rounded-md border border-dashed border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/20"
                />
              );
            }
            const inMonth =
              day.date.getMonth() === viewMonth && day.date.getFullYear() === viewYear;
            const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;
            const hours = day.seconds / 3600;
            const cellMid = new Date(
              day.date.getFullYear(),
              day.date.getMonth(),
              day.date.getDate(),
            ).getTime();
            const isFutureOrToday = cellMid >= todayMid;

            let cellBorder: string;
            if (!inMonth) {
              cellBorder =
                'border border-dashed border-zinc-200/80 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/20';
            } else if (weekend) {
              cellBorder =
                hours > 0
                  ? 'border-zinc-300 bg-gradient-to-b from-zinc-50 to-orange-50/40 dark:border-zinc-600 dark:from-zinc-900/50 dark:to-orange-950/15'
                  : 'border-zinc-200/80 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/20';
            } else if (day.passes) {
              cellBorder =
                'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
            } else if (isFutureOrToday && !day.hasData) {
              cellBorder =
                'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
            } else if (!day.hasData) {
              cellBorder =
                'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
            } else {
              cellBorder =
                'border-rose-300 bg-rose-50 dark:border-rose-700/70 dark:bg-rose-950/40';
            }

            let hourText: string;
            if (!inMonth) {
              hourText =
                hours > 0
                  ? 'text-zinc-600 dark:text-zinc-300'
                  : 'text-zinc-300 dark:text-zinc-600';
            } else if (day.passes && !weekend) {
              hourText = 'text-emerald-700 dark:text-emerald-400';
            } else if (weekend && hours > 0) {
              hourText = 'text-zinc-700 dark:text-zinc-200';
            } else if (isFutureOrToday && !day.hasData) {
              hourText = 'text-zinc-400 dark:text-zinc-500';
            } else if (weekend) {
              hourText = 'text-zinc-400 dark:text-zinc-500';
            } else {
              hourText = 'text-rose-600 dark:text-rose-400';
            }

            return (
              <div
                key={di}
                className={cn(
                  'flex h-9 flex-col items-center justify-center gap-px rounded-md border',
                  cellBorder,
                )}
                title={`${day.dayLabel} ${day.dateStr}: ${(day.seconds / 3600).toFixed(2)}h${
                  inMonth ? '' : ' · adj. month'
                }`}
              >
                <span className="text-[7px] leading-none text-zinc-400 dark:text-zinc-500">
                  {day.dateStr}
                </span>
                <span
                  className={cn(
                    'font-mono text-[9px] font-bold leading-none',
                    hourText,
                  )}
                >
                  {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
