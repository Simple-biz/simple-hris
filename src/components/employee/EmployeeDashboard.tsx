'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  DollarSign,
  AlertCircle,
  TrendingUp,
  CalendarDays,
  Award,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  Laptop,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import {
  OFFICIAL_USD_TO_PHP_RATE,
  PHILIPPINE_PESO_OFFICIAL,
  USD_TO_PHP_DECIMAL_SHIFT,
  effectiveUsdToPhpRateFromStored,
} from '@/lib/fx/usd-php';
import {
  phpHourlyPayFromSeconds,
  roundWorkedHoursForPay,
  splitRegularOvertimeSeconds,
} from '@/lib/payroll/money-php';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Matches PayrollWizard COMMON_BONUSES / BUSINESS_LOGIC.md */
const PERFECT_ATTENDANCE_BONUS_PHP = 5000;
const TECHNOLOGY_BONUS_PHP = 1850;

const DAY_NAMES: Record<string, { label: string; order: number; weekday: boolean }> = {
  mon: { label: 'Mon', order: 1, weekday: true },
  tue: { label: 'Tue', order: 2, weekday: true },
  wed: { label: 'Wed', order: 3, weekday: true },
  thu: { label: 'Thu', order: 4, weekday: true },
  fri: { label: 'Fri', order: 5, weekday: true },
  sat: { label: 'Sat', order: 6, weekday: false },
  sun: { label: 'Sun', order: 0, weekday: false },
};

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

/** Stable weekday columns from Supabase (matches hubstaff-hours-db Pass 3). */
const CANONICAL_WEEKDAY_COLS: Record<string, { label: string; order: number; weekday: boolean }> = {
  sunday: { label: 'Sun', order: 0, weekday: false },
  monday: { label: 'Mon', order: 1, weekday: true },
  tuesday: { label: 'Tue', order: 2, weekday: true },
  wednesday: { label: 'Wed', order: 3, weekday: true },
  thursday: { label: 'Thu', order: 4, weekday: true },
  friday: { label: 'Fri', order: 5, weekday: true },
  saturday: { label: 'Sat', order: 6, weekday: false },
};

function colDayPrefix(col: string): { label: string; order: number; weekday: boolean } | null {
  const trimmed = col.trim();
  const canon = CANONICAL_WEEKDAY_COLS[trimmed.toLowerCase()];
  if (canon) return canon;
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(trimmed);
  return m ? DAY_NAMES[m[1].toLowerCase()] ?? null : null;
}

function isDateCol(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DATE_COLS.has(lower)) return false;
  if (CANONICAL_WEEKDAY_COLS[lower]) return true;
  if (colDayPrefix(col)) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DayHours {
  col: string;
  label: string;
  seconds: number;
  weekday: boolean;
  order: number;
}

interface EmployeeDashboardProps {
  employeeEmail: string;
}

/** Align with mapHubstaffHoursRow / PayrollWizard so rows match after Supabase sync. */
const HUBSTAFF_EMAIL_KEYS = [
  'Email',
  'email',
  'Work Email',
  'work_email',
  'user_email',
] as const;

function collectHubstaffRowEmails(r: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t) seen.add(t);
  };
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(r, k)) add(String(r[k]));
  }
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(r)) {
    lower.set(k.toLowerCase(), v);
  }
  for (const alias of ['work email', 'personal email', 'work_email', 'personal_email']) {
    const v = lower.get(alias);
    if (v != null) add(String(v));
  }
  return [...seen];
}

function hubstaffRowMatchesEmployee(r: Record<string, unknown>, employeeNorm: string): boolean {
  return collectHubstaffRowEmails(r).some((e) => normEmail(e) === employeeNorm);
}

function getFieldFromRow(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  const lowerToKey = new Map<string, string>();
  for (const rk of Object.keys(row)) {
    lowerToKey.set(rk.toLowerCase(), rk);
  }
  for (const k of keys) {
    const rk = lowerToKey.get(k.toLowerCase());
    if (rk) {
      const v = row[rk];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

function getTotalWorkedRaw(row: Record<string, unknown>): unknown {
  return getFieldFromRow(row, [
    'Total worked',
    'total worked',
    'total_worked',
    'Hours',
    'hours',
    'decimal_hours',
  ]);
}

/** ISO YYYY-MM-DD → Sun=0 … Sat=6 in UTC (matches Hubstaff / hubstaff-hours-db). */
function isoDateToUtcDow(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.getUTCDay();
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function EmployeeDashboard({ employeeEmail }: EmployeeDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [columns, setColumns] = useState<string[]>([]);
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);
  const [dataError, setDataError] = useState<string | null>(null);

  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  // Fetch hours, rates, and exchange rate
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDataError(null);
      try {
        const [hoursRes, ratesRes, fxRes] = await Promise.all([
          fetch('/api/hubstaff-hours', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        ]);

        const hoursJson = (await hoursRes.json()) as {
          columns?: string[] | null;
          rows?: Record<string, unknown>[] | null;
          error?: string | null;
        };
        const ratesJson = (await ratesRes.json()) as {
          rows?: EmployeeHourlyRateRow[];
          error?: string | null;
        };
        const fxJson = (await fxRes.json()) as { value: string | null };
        if (cancelled) return;

        setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));

        if (!hoursRes.ok || hoursJson.error) {
          setDataError(hoursJson.error ?? `Hours request failed (${hoursRes.status})`);
          setRow(null);
        } else if (hoursJson.columns && hoursJson.rows) {
          setColumns(hoursJson.columns);
          const myRow = hoursJson.rows.find((r) => hubstaffRowMatchesEmployee(r, email));

          // If Supabase daily columns are empty, try the saved daily breakdown
          if (myRow) {
            const dateCols = hoursJson.columns.filter(isDateCol);
            const allEmpty =
              dateCols.length === 0 ||
              dateCols.every((c) => {
                const v = myRow[c];
                return v == null || String(v).trim() === '';
              });

            if (allEmpty) {
              try {
                const fbRes = await fetch('/api/app-settings?key=hubstaff_daily_breakdown', {
                  cache: 'no-store',
                });
                const fbJson = (await fbRes.json()) as { value: string | null };
                if (fbJson.value) {
                  const { dateCols: savedCols, daily } = JSON.parse(fbJson.value) as {
                    dateCols: string[];
                    daily: Record<string, Record<string, string | null>>;
                  };
                  const dayData = daily[email];
                  if (dayData && savedCols?.length) {
                    const merged = { ...myRow, ...dayData };
                    const mergedCols = [...new Set([...hoursJson.columns, ...savedCols])];
                    setColumns(mergedCols);
                    setRow(merged);
                  } else {
                    setRow(myRow);
                  }
                } else {
                  setRow(myRow);
                }
              } catch {
                setRow(myRow);
              }
            } else {
              setRow(myRow);
            }
          } else {
            setRow(null);
          }
        } else {
          setRow(null);
        }

        if (ratesJson.error) {
          setDataError((prev) =>
            prev ? `${prev} ${ratesJson.error}` : ratesJson.error ?? null,
          );
        }

        // Find rate
        const allRates = ratesJson.rows ?? [];
        const myRate = allRates.find((r) => {
          const we = normEmail(r.work_email);
          const pe = normEmail(r.personal_email);
          return we === email || pe === email;
        });
        if (myRate) setRate(myRate);
      } catch (e) {
        if (!cancelled) {
          setDataError(e instanceof Error ? e.message : 'Failed to load dashboard data');
          setRow(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  // Compute daily hours breakdown
  const dailyHours = useMemo<DayHours[]>(() => {
    if (!row) return [];
    const dateCols = columns.filter(isDateCol);
    return dateCols
      .map((col) => {
        const raw =
          getFieldFromRow(row, [col]) ??
          (Object.prototype.hasOwnProperty.call(row, col) ? row[col] : undefined);
        const seconds = parseHMS(raw);
        const prefix = colDayPrefix(col);
        if (prefix) {
          return { col, label: prefix.label, seconds, weekday: prefix.weekday, order: prefix.order };
        }
        const iso = col.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
          const dow = isoDateToUtcDow(iso);
          if (dow === null) return null;
          const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return {
            col,
            label: labels[dow],
            seconds,
            weekday: dow >= 1 && dow <= 5,
            order: dow,
          };
        }
        return null;
      })
      .filter((x): x is DayHours => x !== null)
      .sort((a, b) => a.order - b.order);
  }, [row, columns]);

  // Compute pay
  const totalSeconds = useMemo(() => {
    if (!row) return 0;
    const tw = getTotalWorkedRaw(row);
    if (tw != null && String(tw).trim() !== '') return parseHMS(tw);
    return dailyHours.reduce((s, d) => s + d.seconds, 0);
  }, [row, dailyHours]);

  const totalHours = roundWorkedHoursForPay(totalSeconds / 3600);
  const { regularSec, otSec } = splitRegularOvertimeSeconds(totalHours);
  const regularHours = regularSec / 3600;
  const otHours = otSec / 3600;

  const parseRate = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const regularRate = parseRate(rate?.regular_rate);
  const otRate = parseRate(rate?.ot_rate);
  const regularPay =
    regularRate != null ? phpHourlyPayFromSeconds(regularRate, regularSec) : null;
  const otPay =
    otSec > 0 ? (otRate != null ? phpHourlyPayFromSeconds(otRate, otSec) : null) : 0;
  const totalPay =
    regularPay != null && otPay != null
      ? Math.round((regularPay + otPay) * 100) / 100
      : null;

  /** Same rule as PayrollWizard `perfectAttendanceEligible`: every Mon–Fri column ≥ 7h. */
  const weekdayHours = dailyHours.filter((d) => d.weekday);
  const isPAEligible = weekdayHours.length > 0 && weekdayHours.every((d) => d.seconds >= 7 * 3600);

  const perfectAttendanceBonusStatus = useMemo<'eligible' | 'not_eligible' | 'unknown'>(() => {
    if (!row) return 'unknown';
    const wh = dailyHours.filter((d) => d.weekday);
    if (wh.length === 0) return 'unknown';
    return wh.every((d) => d.seconds >= 7 * 3600) ? 'eligible' : 'not_eligible';
  }, [row, dailyHours]);

  const maxBarSeconds = Math.max(...dailyHours.map((d) => d.seconds), 8 * 3600);

  if (loading) {
    return (
      <div className="min-h-full bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full space-y-8 overflow-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
            My Dashboard
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">
            Weekly hours, pay breakdown, and attendance
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {row && perfectAttendanceBonusStatus === 'eligible' && (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400"
            >
              <Award className="h-3 w-3" />
              PA bonus eligible
            </Badge>
          )}
          {row && perfectAttendanceBonusStatus === 'not_eligible' && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-800 dark:border-amber-500/30 dark:text-amber-400"
            >
              <XCircle className="h-3 w-3" />
              PA bonus not met
            </Badge>
          )}
          {row && perfectAttendanceBonusStatus === 'unknown' && (
            <Badge
              variant="outline"
              className="gap-1 border-zinc-300 bg-zinc-100/80 px-3 py-1 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400"
            >
              <Info className="h-3 w-3" />
              PA can&apos;t be assessed
            </Badge>
          )}
          {row && (
            <Badge
              variant="outline"
              className="gap-1 border-sky-500/25 bg-sky-500/10 px-3 py-1 text-sky-800 dark:border-sky-500/30 dark:text-sky-300"
              title="Technology Bonus is enabled by payroll each cycle; not calculated from hours here."
            >
              <Laptop className="h-3 w-3" />
              Tech bonus ({formatPHP(TECHNOLOGY_BONUS_PHP).replace(/\.\d{2}$/, '')})
            </Badge>
          )}
          <Badge
            variant="outline"
            className="border-orange-500/20 bg-gradient-to-r from-orange-500/10 to-blue-500/10 px-3 py-1 text-orange-700 dark:border-orange-500/30 dark:text-orange-400"
          >
            <CalendarDays className="mr-1 h-3 w-3" />
            This Week
          </Badge>
        </div>
      </div>

      {dataError && (
        <Card className="border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-950/20">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-800 dark:text-red-300">{dataError}</p>
          </CardContent>
        </Card>
      )}

      {!row && !dataError ? (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 py-6">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              No hours data found for <span className="font-mono font-medium">{email}</span>. Your hours will appear
              here once your manager uploads the weekly Hubstaff report. Use the same work email as in Hubstaff, or
              ensure your email is listed under Work Email or Personal Email in hourly rates.
            </p>
          </CardContent>
        </Card>
      ) : !row ? null : (
        <>
          <Card className="border-indigo-200/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-sm dark:border-indigo-950/50 dark:from-indigo-950/15 dark:to-indigo-950/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">
                Payroll bonus indicators
              </CardTitle>
              <p className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                Estimates from this week&apos;s Hubstaff data. Final bonuses are confirmed when payroll runs.
              </p>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              <div className="flex flex-col gap-3 rounded-lg border border-zinc-200/90 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="flex min-w-0 flex-1 gap-3">
                  <div
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      perfectAttendanceBonusStatus === 'eligible'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : perfectAttendanceBonusStatus === 'not_eligible'
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    {perfectAttendanceBonusStatus === 'eligible' ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : perfectAttendanceBonusStatus === 'not_eligible' ? (
                      <XCircle className="h-5 w-5" />
                    ) : (
                      <Info className="h-5 w-5" />
                    )}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-white">
                      Perfect Attendance Bonus · {formatPHP(PERFECT_ATTENDANCE_BONUS_PHP).replace(/\.\d{2}$/, '')}
                    </p>
                    {perfectAttendanceBonusStatus === 'eligible' && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400">
                        Eligible: Monday–Friday each show at least 7 hours logged this week (same rule as payroll).
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'not_eligible' && (
                      <p className="text-xs text-amber-800 dark:text-amber-300">
                        Not eligible: at least one weekday is under 7 hours. See the breakdown below.
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'unknown' && (
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">
                        Can&apos;t evaluate: need Mon–Fri daily hours in the uploaded report. If this persists, ask your
                        team to re-upload the Hubstaff CSV.
                      </p>
                    )}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={
                    perfectAttendanceBonusStatus === 'eligible'
                      ? 'shrink-0 border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                      : perfectAttendanceBonusStatus === 'not_eligible'
                        ? 'shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-300'
                        : 'shrink-0 border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                  }
                >
                  {perfectAttendanceBonusStatus === 'eligible'
                    ? 'Eligible'
                    : perfectAttendanceBonusStatus === 'not_eligible'
                      ? 'Not eligible'
                      : 'Unknown'}
                </Badge>
              </div>

              <div className="flex flex-col gap-3 rounded-lg border border-zinc-200/90 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="flex min-w-0 flex-1 gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400">
                    <Laptop className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-white">
                      Technology Bonus · {formatPHP(TECHNOLOGY_BONUS_PHP).replace(/\.\d{2}$/, '')}
                    </p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      This bonus isn&apos;t calculated from your hours here. Payroll applies it per cycle when your row is
                      selected—ask your coordinator if you expect this addition.
                    </p>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 border-sky-500/35 bg-sky-500/10 text-sky-900 dark:border-sky-500/30 dark:text-sky-300"
                >
                  Payroll discretion
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Stats Row */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {/* Total Hours */}
            <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Total Hours
                </CardTitle>
                <Clock className="h-4 w-4 text-zinc-500" />
              </CardHeader>
              <CardContent>
                <div className="font-mono text-2xl font-bold text-zinc-900 dark:text-white">
                  {totalHours.toFixed(2)}h
                </div>
                <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-600">
                  Reg {regularHours.toFixed(1)}h + OT {otHours.toFixed(1)}h
                </p>
              </CardContent>
            </Card>

            {/* Regular Pay */}
            <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Regular Pay
                </CardTitle>
                <DollarSign className="h-4 w-4 text-zinc-500" />
              </CardHeader>
              <CardContent>
                <div className="font-mono text-2xl font-bold text-zinc-900 dark:text-white">
                  {regularPay != null ? formatPHP(regularPay) : '—'}
                </div>
                <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-600">
                  {regularRate != null ? `${formatPHP(regularRate)}/hr x ${regularHours.toFixed(1)}h` : 'Rate not set'}
                </p>
              </CardContent>
            </Card>

            {/* OT Pay */}
            <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Overtime Pay
                </CardTitle>
                <TrendingUp className="h-4 w-4 text-zinc-500" />
              </CardHeader>
              <CardContent>
                <div className="font-mono text-2xl font-bold text-zinc-900 dark:text-white">
                  {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                </div>
                <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-600">
                  {otHours > 0
                    ? otRate != null
                      ? `${formatPHP(otRate)}/hr x ${otHours.toFixed(1)}h`
                      : 'OT rate not set'
                    : 'No overtime this week'}
                </p>
              </CardContent>
            </Card>

            {/* Total Pay */}
            <Card className="border-emerald-200/80 bg-gradient-to-br from-white to-emerald-50/30 shadow-sm transition-colors duration-300 hover:to-emerald-50/60 dark:border-emerald-950/60 dark:bg-none dark:from-emerald-950/20 dark:to-emerald-950/10 dark:hover:from-emerald-950/30">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Initial Pay
                </CardTitle>
                <DollarSign className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="font-mono text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                  {totalPay != null ? formatPHP(totalPay) : '—'}
                </div>
                <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-600">
                  {totalPay != null
                    ? `≈ $${(totalPay / usdToPhpRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
                    : 'Pending rate assignment'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Daily Hours Bar Chart */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Daily Hours Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                {dailyHours.length === 0 ? (
                  <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                    Daily breakdown not available
                  </div>
                ) : (
                  <div className="space-y-3">
                    {dailyHours.map((day) => {
                      const hours = day.seconds / 3600;
                      const pct = maxBarSeconds > 0 ? (day.seconds / maxBarSeconds) * 100 : 0;
                      const meetsPA = day.weekday && day.seconds >= 7 * 3600;
                      const belowPA = day.weekday && day.seconds > 0 && day.seconds < 7 * 3600;
                      return (
                        <div key={day.col} className="flex items-center gap-3">
                          <span
                            className={`w-10 shrink-0 text-right text-xs font-medium ${
                              day.weekday
                                ? 'text-zinc-700 dark:text-zinc-300'
                                : 'text-zinc-400 dark:text-zinc-600'
                            }`}
                          >
                            {day.label}
                          </span>
                          <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800/60">
                            <div
                              className={`absolute inset-y-0 left-0 rounded-md transition-all duration-500 ${
                                meetsPA
                                  ? 'bg-gradient-to-r from-emerald-400 to-emerald-500 dark:from-emerald-500 dark:to-emerald-600'
                                  : belowPA
                                    ? 'bg-gradient-to-r from-amber-400 to-amber-500 dark:from-amber-500 dark:to-amber-600'
                                    : day.weekday
                                      ? 'bg-gradient-to-r from-orange-400 to-orange-500 dark:from-orange-500 dark:to-orange-600'
                                      : 'bg-gradient-to-r from-zinc-300 to-zinc-400 dark:from-zinc-600 dark:to-zinc-700'
                              }`}
                              style={{ width: `${Math.max(pct, day.seconds > 0 ? 2 : 0)}%` }}
                            />
                            {/* 7h threshold marker for weekdays */}
                            {day.weekday && (
                              <div
                                className="absolute inset-y-0 w-px bg-red-400/50 dark:bg-red-500/50"
                                style={{ left: `${(7 * 3600 / maxBarSeconds) * 100}%` }}
                                title="7h PA threshold"
                              />
                            )}
                            <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-medium text-white drop-shadow-sm">
                              {hours > 0.5 ? `${hours.toFixed(1)}h` : ''}
                            </span>
                          </div>
                          <span className="w-14 shrink-0 text-right font-mono text-xs text-zinc-500 dark:text-zinc-400">
                            {secondsToDisplay(day.seconds)}
                          </span>
                        </div>
                      );
                    })}
                    <div className="mt-2 flex items-center gap-4 border-t border-zinc-200 pt-3 text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> ≥ 7h (PA eligible)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> &lt; 7h (below threshold)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-600" /> Weekend
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-3 bg-red-400/50" /> 7h line
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pay Summary Side Card */}
            <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  Pay Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Regular Rate</span>
                    <span className="font-mono text-sm font-medium text-zinc-900 dark:text-white">
                      {regularRate != null ? `${formatPHP(regularRate)}/hr` : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">OT Rate</span>
                    <span className="font-mono text-sm font-medium text-zinc-900 dark:text-white">
                      {otRate != null ? `${formatPHP(otRate)}/hr` : '—'}
                    </span>
                  </div>
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Regular Pay</span>
                    <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
                      {regularPay != null ? formatPHP(regularPay) : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">OT Pay</span>
                    <span className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
                      {otPay != null ? formatPHP(otPay) : '—'}
                    </span>
                  </div>
                  {isPAEligible && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">PA Bonus</span>
                      <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">
                        {formatPHP(PERFECT_ATTENDANCE_BONUS_PHP)}
                      </span>
                    </div>
                  )}
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-900 dark:text-white">Total</span>
                    <span className="font-mono text-lg font-bold text-emerald-700 dark:text-emerald-400">
                      {totalPay != null
                        ? formatPHP(totalPay + (isPAEligible ? PERFECT_ATTENDANCE_BONUS_PHP : 0))
                        : '—'}
                    </span>
                  </div>
                  {totalPay != null && (
                    <p className="text-right font-mono text-[10px] text-blue-500 dark:text-blue-400">
                      ≈ ${((totalPay + (isPAEligible ? PERFECT_ATTENDANCE_BONUS_PHP : 0)) / usdToPhpRate).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      USD
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                    Exchange rate: <span className="font-mono font-medium">{formatPHP(usdToPhpRate)}</span> = $1 USD (default from policy: ₱
                    {PHILIPPINE_PESO_OFFICIAL.toLocaleString('en-PH')}
                    {` ÷ 10^${USD_TO_PHP_DECIMAL_SHIFT}`}).
                    Bonuses are applied during payroll processing and may vary.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
