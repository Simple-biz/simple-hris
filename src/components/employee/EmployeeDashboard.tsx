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
  FileText,
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
import {
  groupDateColumnsByCalendarDay,
  pickPreferredHubstaffColumn,
  getPabMonthRange,
  inferPabMonthFromColumns,
  filterColumnGroupsByPabRange,
  parseColDate,
} from '@/lib/hubstaff/calendar-column-dedupe';

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

/** Full calendar date for PAB range labels (locale: en-US). */
function formatPabCalendarDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  /** Merged row for this employee across ALL uploaded CSVs — used for full-month PAB. */
  const [pabMergedRow, setPabMergedRow] = useState<Record<string, unknown> | null>(null);
  const [pabMergedColumns, setPabMergedColumns] = useState<string[]>([]);

  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  // Load rates, exchange rate, and source file list on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDataError(null);
      try {
        const [ratesRes, fxRes, filesRes] = await Promise.all([
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
          fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' }),
        ]);

        const ratesJson = (await ratesRes.json()) as {
          rows?: EmployeeHourlyRateRow[];
          error?: string | null;
        };
        const fxJson = (await fxRes.json()) as { value: string | null };
        const filesJson = (await filesRes.json()) as { files?: string[]; error?: string | null };
        if (cancelled) return;

        setUsdToPhpRate(effectiveUsdToPhpRateFromStored(fxJson.value));

        if (ratesJson.error) {
          setDataError(ratesJson.error);
        }
        const allRates = ratesJson.rows ?? [];
        const myRate = allRates.find((r) => {
          const we = normEmail(r.work_email);
          const pe = normEmail(r.personal_email);
          return we === email || pe === email;
        });
        if (myRate) setRate(myRate);

        const files = filesJson.files ?? [];
        setSourceFiles(files);
        if (files.length > 0) {
          setSelectedFile(files[files.length - 1]); // latest
        } else {
          // No source files — fall back to loading all data
          await loadHoursData(null, cancelled);
        }
      } catch (e) {
        if (!cancelled) {
          setDataError(e instanceof Error ? e.message : 'Failed to load dashboard data');
          setRow(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // Load hours data for the selected source file
  const loadHoursData = React.useCallback(async (file: string | null, cancelled?: boolean) => {
    try {
      const url = file
        ? `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`
        : `/api/hubstaff-hours?_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = (await res.json()) as {
        columns?: string[] | null;
        rows?: Record<string, unknown>[] | null;
        error?: string | null;
      };
      if (cancelled) return;

      if (!res.ok || json.error) {
        setDataError(json.error ?? `Hours request failed (${res.status})`);
        setRow(null);
      } else if (json.columns && json.rows) {
        setColumns(json.columns);
        const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, email));

        if (myRow) {
          const dateCols = json.columns.filter(isDateCol);
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
                  const mergedCols = [...new Set([...json.columns, ...savedCols])];
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
    } catch (e) {
      if (!cancelled) {
        setDataError(e instanceof Error ? e.message : 'Failed to load hours');
        setRow(null);
      }
    }
  }, [email]);

  // Reload hours when the selected file changes
  useEffect(() => {
    if (selectedFile === null) return;
    let cancelled = false;
    setFileLoading(true);
    setDataError(null);
    loadHoursData(selectedFile, false).finally(() => {
      if (!cancelled) setFileLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedFile, loadHoursData]);

  // Fetch ALL source files and merge this employee's daily columns for full-month PAB
  useEffect(() => {
    if (sourceFiles.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const allCols = new Set<string>();
        let merged: Record<string, unknown> = {};
        let found = false;

        for (const file of sourceFiles) {
          const res = await fetch(
            `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
            { cache: 'no-store' },
          );
          const json = (await res.json()) as {
            columns?: string[] | null;
            rows?: Record<string, unknown>[] | null;
          };
          if (cancelled) return;
          if (!json.columns || !json.rows) continue;

          for (const col of json.columns) allCols.add(col);
          const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, email));
          if (myRow) {
            found = true;
            merged = { ...merged, ...myRow };
          }
        }

        if (cancelled) return;
        setPabMergedColumns([...allCols]);
        setPabMergedRow(found ? merged : null);
      } catch {
        // PAB degrades gracefully — falls back to single-file check
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFiles, email]);

  // Compute daily hours breakdown (one bar per calendar day — dedupe ISO vs Mon 3/24 vs monday…)
  const dailyHours = useMemo<DayHours[]>(() => {
    if (!row) return [];
    const dateCols = columns.filter(isDateCol);
    const groups = groupDateColumnsByCalendarDay(dateCols, columns);
    return groups
      .map((group) => {
        const col = pickPreferredHubstaffColumn(group);
        const seconds = Math.max(
          ...group.map((c) => {
            const raw =
              getFieldFromRow(row, [c]) ??
              (Object.prototype.hasOwnProperty.call(row, c) ? row[c] : undefined);
            return parseHMS(raw);
          }),
        );
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

  /**
   * Full-month daily hours for PAB: uses merged data from ALL uploaded CSVs.
   * Falls back to single-file dailyHours if merged data isn't available.
   */
  const pabDailyHours = useMemo<DayHours[]>(() => {
    const pabRow = pabMergedRow ?? row;
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    if (!pabRow) return [];
    const dateCols = pabCols.filter(isDateCol);
    let groups = groupDateColumnsByCalendarDay(dateCols, pabCols);
    // Filter to PAB month boundaries (Mon–Fri days in range)
    const pabMonth = inferPabMonthFromColumns(pabCols);
    if (pabMonth) {
      const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
      groups = filterColumnGroupsByPabRange(groups, pabCols, start, end);
    }
    return groups
      .map((group) => {
        const col = pickPreferredHubstaffColumn(group);
        const seconds = Math.max(
          ...group.map((c) => {
            const raw =
              getFieldFromRow(pabRow, [c]) ??
              (Object.prototype.hasOwnProperty.call(pabRow, c) ? pabRow[c] : undefined);
            return parseHMS(raw);
          }),
        );
        const prefix = colDayPrefix(col);
        if (prefix) {
          return { col, label: prefix.label, seconds, weekday: prefix.weekday, order: prefix.order };
        }
        const iso = col.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
          const dow = isoDateToUtcDow(iso);
          if (dow === null) return null;
          const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return { col, label: labels[dow], seconds, weekday: dow >= 1 && dow <= 5, order: dow };
        }
        return null;
      })
      .filter((x): x is DayHours => x !== null)
      .sort((a, b) => {
        // Sort chronologically by parsed date; fall back to day-of-week order
        const da = parseColDate(a.col);
        const db = parseColDate(b.col);
        if (da && db) return da.getTime() - db.getTime();
        return a.order - b.order;
      });
  }, [pabMergedRow, pabMergedColumns, row, columns]);

  /** Inferred PAB month + computed date range for display. */
  const pabMonthRange = useMemo(() => {
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    if (!pabCols?.length) return null;
    const pabMonth = inferPabMonthFromColumns(pabCols);
    if (!pabMonth) return null;
    const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [pabMergedColumns, columns]);

  /** PAB: every Mon–Fri across the FULL MONTH must be ≥ 7h. */
  const pabWeekdayHours = pabDailyHours.filter((d) => d.weekday);
  const isPAEligible = pabWeekdayHours.length > 0 && pabWeekdayHours.every((d) => d.seconds >= 7 * 3600);

  const perfectAttendanceBonusStatus = useMemo<'eligible' | 'not_eligible' | 'unknown'>(() => {
    if (!row && !pabMergedRow) return 'unknown';
    const wh = pabDailyHours.filter((d) => d.weekday);
    if (wh.length === 0) return 'unknown';
    return wh.every((d) => d.seconds >= 7 * 3600) ? 'eligible' : 'not_eligible';
  }, [row, pabMergedRow, pabDailyHours]);

  /** Use PAB daily hours for the chart when available so the bars match the PAB evaluation. */
  const chartDailyHours = pabDailyHours.length > 0 ? pabDailyHours : dailyHours;
  const maxBarSeconds = Math.max(...chartDailyHours.map((d) => d.seconds), 8 * 3600);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="box-border flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto overscroll-y-contain bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-3 pb-5 sm:px-4 sm:py-4 sm:pb-6 md:px-5 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
            My Dashboard
          </h2>
          <p className="text-xs text-zinc-600 sm:text-sm dark:text-zinc-500">
            Hours, pay, and monthly Perfect Attendance (PAB). Pay totals follow the Hubstaff file you select; PAB uses all
            uploads for the month.
          </p>
          {pabMonthRange && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-indigo-800 dark:text-indigo-200">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
              <span>
                <span className="font-semibold">PAB period starts</span>{' '}
                {formatPabCalendarDate(pabMonthRange.start)}
                <span className="text-zinc-400 dark:text-zinc-500"> · </span>
                <span className="font-medium">ends</span> {formatPabCalendarDate(pabMonthRange.end)}
              </span>
            </p>
          )}
          {/* Source file selector */}
          {sourceFiles.length > 0 && (
            <div className="mt-2 flex max-w-xl flex-col gap-1">
              <div className="flex items-center gap-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                <select
                  value={selectedFile ?? ''}
                  onChange={(e) => setSelectedFile(e.target.value || null)}
                  className="h-7 rounded-md border border-zinc-200 bg-white px-2 pr-6 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  {[...sourceFiles].reverse().map((file, i) => (
                    <option key={file} value={file}>
                      {file}{i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
                {fileLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
              </div>
              <p className="pl-5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
                Monthly PAB merges every upload—this file only drives the hours/pay preview below.
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {row && perfectAttendanceBonusStatus === 'eligible' && (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400"
              title={pabMonthRange ? `${formatPabCalendarDate(pabMonthRange.start)} – ${formatPabCalendarDate(pabMonthRange.end)}` : undefined}
            >
              <Award className="h-3 w-3" />
              PAB eligible{pabMonthRange ? ` · ${pabMonthRange.monthName.slice(0, 3)}` : ''}
            </Badge>
          )}
          {row && perfectAttendanceBonusStatus === 'not_eligible' && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-800 dark:border-amber-500/30 dark:text-amber-400"
              title={pabMonthRange ? `${formatPabCalendarDate(pabMonthRange.start)} – ${formatPabCalendarDate(pabMonthRange.end)}` : undefined}
            >
              <XCircle className="h-3 w-3" />
              PAB not met{pabMonthRange ? ` · ${pabMonthRange.monthName.slice(0, 3)}` : ''}
            </Badge>
          )}
          {row && perfectAttendanceBonusStatus === 'unknown' && (
            <Badge
              variant="outline"
              className="gap-1 border-zinc-300 bg-zinc-100/80 px-3 py-1 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400"
            >
              <Info className="h-3 w-3" />
              PAB can&apos;t be assessed
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
            title={pabMonthRange ? `PAB: ${formatPabCalendarDate(pabMonthRange.start)} – ${formatPabCalendarDate(pabMonthRange.end)}` : undefined}
          >
            <CalendarDays className="mr-1 h-3 w-3" />
            {pabMonthRange && pabDailyHours.length > 0
              ? `PAB · starts ${formatPabCalendarDate(pabMonthRange.start)}`
              : 'Monthly PAB'}
          </Badge>
        </div>
      </div>

      {dataError && (
        <Card className="shrink-0 border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-950/20">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-800 dark:text-red-300">{dataError}</p>
          </CardContent>
        </Card>
      )}

      {!row && !dataError ? (
        <Card className="min-h-0 flex-1 overflow-y-auto border-amber-200 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 py-4 sm:py-6">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              No hours data found for <span className="font-mono font-medium">{email}</span>. Your hours will appear
              here once your manager uploads Hubstaff data. Use the same work email as in Hubstaff, or
              ensure your email is listed under Work Email or Personal Email in hourly rates.
            </p>
          </CardContent>
        </Card>
      ) : !row ? null : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Card
            size="sm"
            className="shrink-0 border-indigo-200/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-sm dark:border-indigo-950/50 dark:from-indigo-950/15 dark:to-indigo-950/5"
          >
            <CardHeader className="pb-2 pt-3">
              <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
                Monthly PAB &amp; other bonuses
              </CardTitle>
              <p className="text-[11px] font-normal leading-snug text-zinc-500 dark:text-zinc-400">
                PAB uses every Mon–Fri in the PAB period below (merged Hubstaff uploads); each day must be ≥ 7 hours. If
                the month doesn&apos;t start on a Monday, the first week is skipped and counting starts on the{' '}
                <span className="font-medium text-zinc-600 dark:text-zinc-300">second Monday</span> (e.g. March 2026:
                Mar 9–Apr 3). Figures here are estimates until payroll confirms them.
              </p>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              <div className="flex flex-col gap-2 rounded-lg border border-zinc-200/90 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex min-w-0 flex-1 gap-3">
                  <div
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      perfectAttendanceBonusStatus === 'eligible'
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : perfectAttendanceBonusStatus === 'not_eligible'
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    {perfectAttendanceBonusStatus === 'eligible' ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : perfectAttendanceBonusStatus === 'not_eligible' ? (
                      <XCircle className="h-4 w-4" />
                    ) : (
                      <Info className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs font-medium text-zinc-900 dark:text-white">
                      Monthly period Perfect Attendance Bonus ·{' '}
                      {formatPHP(PERFECT_ATTENDANCE_BONUS_PHP).replace(/\.\d{2}$/, '')}
                    </p>
                    {pabMonthRange && (
                      <p className="flex items-start gap-1 text-[10px] leading-relaxed text-indigo-600 dark:text-indigo-400">
                        <CalendarDays className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          <span className="font-semibold">{pabMonthRange.monthName} {pabMonthRange.year}</span>
                          {' · '}
                          <span className="font-medium">Start</span> {formatPabCalendarDate(pabMonthRange.start)}
                          {' · '}
                          <span className="font-medium">End</span> {formatPabCalendarDate(pabMonthRange.end)}
                          {' · '}
                          {pabWeekdayHours.length} Mon–Fri day{pabWeekdayHours.length !== 1 ? 's' : ''} in this PAB month
                        </span>
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'eligible' && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400">
                        Eligible: each Mon–Fri in the PAB date range above is logged at 7 hours or more.
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'not_eligible' && (
                      <p className="text-xs text-amber-800 dark:text-amber-300">
                        Not eligible: at least one weekday in the PAB period is under 7 hours. See the breakdown below.
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'unknown' && (
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">
                        Can&apos;t evaluate monthly PAB: need Mon–Fri daily hours in the merged Hubstaff uploads. If this
                        persists, ask your team to re-upload the CSVs.
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

              <div className="flex flex-col gap-2 rounded-lg border border-zinc-200/90 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex min-w-0 flex-1 gap-2">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400">
                    <Laptop className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-medium text-zinc-900 dark:text-white">
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

          {/* Stats — min-w-0 + responsive type so PHP amounts don’t overflow narrow cells */}
          <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
            {/* Total Hours */}
            <Card
              size="sm"
              className="min-w-0 border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30"
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  Total Hours
                </CardTitle>
                <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div className="break-words font-mono text-base font-bold tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white">
                  {totalHours.toFixed(2)}h
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  Reg {regularHours.toFixed(1)}h + OT {otHours.toFixed(1)}h
                </p>
              </CardContent>
            </Card>

            {/* Regular Pay */}
            <Card
              size="sm"
              className="min-w-0 border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30"
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  Regular Pay
                </CardTitle>
                <DollarSign className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div
                  className="break-words font-mono text-base font-bold tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                  title={regularPay != null ? formatPHP(regularPay) : undefined}
                >
                  {regularPay != null ? formatPHP(regularPay) : '—'}
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  {regularRate != null ? `${formatPHP(regularRate)}/hr × ${regularHours.toFixed(1)}h` : 'Rate not set'}
                </p>
              </CardContent>
            </Card>

            {/* OT Pay */}
            <Card
              size="sm"
              className="min-w-0 border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm transition-colors duration-300 hover:to-orange-50/60 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10 dark:hover:from-blue-950/30"
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  Overtime Pay
                </CardTitle>
                <TrendingUp className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div
                  className="break-words font-mono text-base font-bold tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                  title={otPay != null ? formatPHP(otPay) : undefined}
                >
                  {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  {otHours > 0
                    ? otRate != null
                      ? `${formatPHP(otRate)}/hr × ${otHours.toFixed(1)}h`
                      : 'OT rate not set'
                    : 'No overtime in this file'}
                </p>
              </CardContent>
            </Card>

            {/* Total Pay */}
            <Card
              size="sm"
              className="min-w-0 border-emerald-200/80 bg-gradient-to-br from-white to-emerald-50/30 shadow-sm transition-colors duration-300 hover:to-emerald-50/60 dark:border-emerald-950/60 dark:bg-none dark:from-emerald-950/20 dark:to-emerald-950/10 dark:hover:from-emerald-950/30"
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  Initial Pay
                </CardTitle>
                <DollarSign className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div
                  className="break-words font-mono text-base font-bold tabular-nums leading-tight text-emerald-700 sm:text-lg dark:text-emerald-400"
                  title={totalPay != null ? formatPHP(totalPay) : undefined}
                >
                  {totalPay != null ? formatPHP(totalPay) : '—'}
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  {totalPay != null
                    ? `≈ $${(totalPay / usdToPhpRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
                    : 'Pending rate assignment'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Daily Hours + Pay Summary — flex fills height; fixed-width summary on large screens */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-4">
            <Card
              size="sm"
              className="flex min-h-[12rem] flex-1 flex-col border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:min-h-0"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Daily Hours Breakdown
                  {pabMonthRange && pabDailyHours.length > 0 && (
                    <span className="font-normal text-indigo-500 dark:text-indigo-400">
                      · Start {formatPabCalendarDate(pabMonthRange.start)} – End {formatPabCalendarDate(pabMonthRange.end)}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
                {chartDailyHours.length === 0 ? (
                  <div className="flex flex-1 items-center gap-2 py-6 text-sm text-zinc-500">
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                    Daily breakdown not available
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className={`min-h-0 flex-1 overflow-y-auto overflow-x-clip pr-2 ${chartDailyHours.length > 7 ? 'space-y-1' : 'space-y-1.5'}`}>
                    {chartDailyHours.map((day) => {
                      const hours = day.seconds / 3600;
                      const pct = maxBarSeconds > 0 ? (day.seconds / maxBarSeconds) * 100 : 0;
                      const meetsPA = day.weekday && day.seconds >= 7 * 3600;
                      const belowPA = day.weekday && day.seconds > 0 && day.seconds < 7 * 3600;
                      const colDate = parseColDate(day.col);
                      const dateStr = colDate ? `${colDate.getMonth() + 1}/${colDate.getDate()}` : '';
                      return (
                        <div key={day.col} className="flex items-center gap-2">
                          <span
                            className={`shrink-0 text-right text-xs font-medium ${
                              dateStr ? 'w-16' : 'w-10'
                            } ${
                              day.weekday
                                ? 'text-zinc-700 dark:text-zinc-300'
                                : 'text-zinc-400 dark:text-zinc-600'
                            }`}
                          >
                            {day.label}{dateStr ? <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">{dateStr}</span> : ''}
                          </span>
                          <div className={`relative flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800/60 ${chartDailyHours.length > 7 ? 'h-5' : 'h-6'}`}>
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
                                title="7h PAB threshold"
                              />
                            )}
                            <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-medium text-white drop-shadow-sm">
                              {hours > 0.5 ? `${hours.toFixed(1)}h` : ''}
                            </span>
                          </div>
                          <span className="w-12 shrink-0 text-right font-mono text-[10px] text-zinc-500 sm:w-14 sm:text-xs dark:text-zinc-400">
                            {secondsToDisplay(day.seconds)}
                          </span>
                        </div>
                      );
                    })}
                    </div>
                    <div className="mt-2 flex shrink-0 flex-col gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-zinc-500 dark:text-zinc-600 sm:text-[10px]">
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h (PAB)
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 sm:h-2 sm:w-2" /> &lt; 7h
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600 sm:h-2 sm:w-2" /> Weekend
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-1 w-3 bg-red-400/50 sm:h-1.5" /> 7h
                        </span>
                      </div>
                      {pabMonthRange && (
                        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[9px] text-indigo-500 dark:text-indigo-400 sm:text-[10px]">
                          <CalendarDays className="h-3 w-3 shrink-0" />
                          <span>
                            PAB: <span className="font-medium">Start</span> {formatPabCalendarDate(pabMonthRange.start)}
                            {' · '}
                            <span className="font-medium">End</span> {formatPabCalendarDate(pabMonthRange.end)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pay Summary — natural height on mobile; fixed width on lg so chart gets the rest */}
            <Card
              size="sm"
              className="flex w-full min-w-0 shrink-0 flex-col border-orange-100/80 bg-gradient-to-br from-white to-orange-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:h-full lg:w-[min(100%,20rem)] xl:w-[22rem]"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <CardTitle className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Pay Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-clip overscroll-contain pr-2 [-webkit-overflow-scrolling:touch]">
                <div className="min-w-0 space-y-2.5 sm:space-y-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">Regular Rate</span>
                    <span className="max-w-[55%] break-words text-right font-mono text-xs font-medium text-zinc-900 sm:text-sm dark:text-white">
                      {regularRate != null ? `${formatPHP(regularRate)}/hr` : '—'}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">OT Rate</span>
                    <span className="max-w-[55%] break-words text-right font-mono text-xs font-medium text-zinc-900 sm:text-sm dark:text-white">
                      {otRate != null ? `${formatPHP(otRate)}/hr` : '—'}
                    </span>
                  </div>
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">Regular Pay</span>
                    <span className="max-w-[58%] break-words text-right font-mono text-xs text-zinc-700 sm:text-sm dark:text-zinc-300">
                      {regularPay != null ? formatPHP(regularPay) : '—'}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">OT Pay</span>
                    <span className="max-w-[58%] break-words text-right font-mono text-xs text-zinc-700 sm:text-sm dark:text-zinc-300">
                      {otPay != null ? formatPHP(otPay) : '—'}
                    </span>
                  </div>
                  {isPAEligible && (
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">PAB</span>
                      <span className="max-w-[58%] break-words text-right font-mono text-xs font-medium text-emerald-600 sm:text-sm dark:text-emerald-400">
                        {formatPHP(PERFECT_ATTENDANCE_BONUS_PHP)}
                      </span>
                    </div>
                  )}
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-white">Total</span>
                    <span className="max-w-[60%] break-words text-right font-mono text-base font-bold leading-tight text-emerald-700 sm:text-lg dark:text-emerald-400">
                      {totalPay != null
                        ? formatPHP(totalPay + (isPAEligible ? PERFECT_ATTENDANCE_BONUS_PHP : 0))
                        : '—'}
                    </span>
                  </div>
                  {totalPay != null && (
                    <p className="break-words text-right font-mono text-[10px] text-blue-500 dark:text-blue-400">
                      ≈ ${((totalPay + (isPAEligible ? PERFECT_ATTENDANCE_BONUS_PHP : 0)) / usdToPhpRate).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      USD
                    </p>
                  )}
                </div>

                <div className="shrink-0 rounded-lg border border-zinc-200 bg-zinc-50/80 px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <p className="text-[9px] leading-snug text-zinc-500 dark:text-zinc-500 sm:text-[10px]">
                    Exchange rate: <span className="font-mono font-medium">{formatPHP(usdToPhpRate)}</span> = $1 USD (default from policy: ₱
                    {PHILIPPINE_PESO_OFFICIAL.toLocaleString('en-PH')}
                    {` ÷ 10^${USD_TO_PHP_DECIMAL_SHIFT}`}).
                    Bonuses are applied during payroll processing and may vary.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
