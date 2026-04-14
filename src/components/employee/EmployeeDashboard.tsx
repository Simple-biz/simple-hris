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
  getCurrentPabMonth,
  getLatestPabMonthFromColumns,
  getPabMonthRange,
  inferPabMonthFromColumns,
  filterColumnGroupsByPabRange,
  parseColDate,
  buildPabCalendarWeeks,
  pabDateKey,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
} from '@/lib/hubstaff/calendar-column-dedupe';
import type { PabCalendarDay } from '@/lib/hubstaff/calendar-column-dedupe';

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
  const [manualFileSelect, setManualFileSelect] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  /** Merged row for this employee across ALL uploaded CSVs — used for full-month PAB. */
  const [pabMergedRow, setPabMergedRow] = useState<Record<string, unknown> | null>(null);
  const [pabMergedColumns, setPabMergedColumns] = useState<string[]>([]);
  const [pabMergeLoading, setPabMergeLoading] = useState(false);
  /** Accumulated pay breakdown across every source file for this employee. */
  const [allTimeTotalSeconds, setAllTimeTotalSeconds] = useState(0);
  const [allTimeRegularSec, setAllTimeRegularSec] = useState(0);
  const [allTimeOtSec, setAllTimeOtSec] = useState(0);

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

  // Reload hours when the selected file changes (skip for "All Time")
  useEffect(() => {
    if (selectedFile === null || selectedFile === '__all__') return;
    let cancelled = false;
    setFileLoading(true);
    setDataError(null);
    loadHoursData(selectedFile, false).finally(() => {
      if (!cancelled) setFileLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedFile, loadHoursData]);

  // Fetch ALL source files and merge this employee's daily columns for full-month PAB.
  // When columns are canonical (`monday`, `tuesday`, …) we resolve them to ISO dates
  // using the date range embedded in each source filename so weeks don't overwrite each other.
  useEffect(() => {
    if (sourceFiles.length === 0) return;
    let cancelled = false;
    setPabMergeLoading(true);
    (async () => {
      try {
        const allCols = new Set<string>();
        let merged: Record<string, unknown> = {};
        let found = false;
        let cumulativeSeconds = 0;
        let cumulativeRegSec = 0;
        let cumulativeOtSec = 0;

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

          const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, email));
          if (!myRow) continue;
          found = true;

          // Accumulate per-file hours, split into regular/OT independently per file
          const tw = getTotalWorkedRaw(myRow);
          if (tw != null && String(tw).trim() !== '') {
            const fileSec = parseHMS(tw);
            cumulativeSeconds += fileSec;
            const fileHrs = roundWorkedHoursForPay(fileSec / 3600);
            const split = splitRegularOvertimeSeconds(fileHrs);
            cumulativeRegSec += split.regularSec;
            cumulativeOtSec += split.otSec;
          }

          // Resolve canonical day columns to ISO dates using the source filename
          const needsResolve = columnsAreAllCanonical(json.columns);
          const resolved = needsResolve ? resolveCanonicalColumnsToIso(myRow, file) : myRow;

          for (const col of (needsResolve ? Object.keys(resolved) : json.columns)) allCols.add(col);
          merged = { ...merged, ...resolved };
        }

        if (cancelled) return;
        setPabMergedColumns([...allCols]);
        setPabMergedRow(found ? merged : null);
        setAllTimeTotalSeconds(cumulativeSeconds);
        setAllTimeRegularSec(cumulativeRegSec);
        setAllTimeOtSec(cumulativeOtSec);
      } catch {
        // PAB degrades gracefully — falls back to single-file check
      } finally {
        setPabMergeLoading(false);
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

  const isAllTime = selectedFile === '__all__';

  // Compute pay — per-file values
  const fileSeconds = useMemo(() => {
    if (!row) return 0;
    const tw = getTotalWorkedRaw(row);
    if (tw != null && String(tw).trim() !== '') return parseHMS(tw);
    return dailyHours.reduce((s, d) => s + d.seconds, 0);
  }, [row, dailyHours]);

  const parseRate = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const regularRate = parseRate(rate?.regular_rate);
  const otRate = parseRate(rate?.ot_rate);

  // Switch between per-file and all-time totals.
  // All-time uses pre-split regular/OT (each file split independently at 40h).
  const totalSeconds = isAllTime ? allTimeTotalSeconds : fileSeconds;
  const totalHours = roundWorkedHoursForPay(totalSeconds / 3600);
  const regularSec = isAllTime ? allTimeRegularSec : splitRegularOvertimeSeconds(roundWorkedHoursForPay(fileSeconds / 3600)).regularSec;
  const otSec = isAllTime ? allTimeOtSec : splitRegularOvertimeSeconds(roundWorkedHoursForPay(fileSeconds / 3600)).otSec;
  const regularHours = regularSec / 3600;
  const otHours = otSec / 3600;

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
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    // Hours always come from merged data so every day in the PAB period fills.
    const pabRow = pabMergedRow ?? row;
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    if (!pabRow) return [];
    const dateCols = pabCols.filter(isDateCol);
    let groups = groupDateColumnsByCalendarDay(dateCols, pabCols);
    // PAB period: manual file selection → that file's inferred month;
    // otherwise → PAB month containing the latest date in merged uploads.
    const pabMonth = useSelected
      ? (getLatestPabMonthFromColumns(pabCols) ?? inferPabMonthFromColumns(pabCols))
      : (getLatestPabMonthFromColumns(pabCols) ?? getCurrentPabMonth());
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
  }, [pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect]);

  /** PAB month + date range for display.
   * Default: latest PAB period in merged CSV data (or today if none).
   * When user manually picks a CSV: use that file's inferred period. */
  const pabMonthRange = useMemo(() => {
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    // Selected file may have canonical day columns — resolve to ISO via filename
    // so we can derive a real date-based PAB month.
    let selCols = columns;
    if (useSelected && row && columns.length > 0 && columnsAreAllCanonical(columns)) {
      const resolved = resolveCanonicalColumnsToIso(row, selectedFile!);
      selCols = Object.keys(resolved);
    }
    const mergedCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    // In manual mode, prefer the selected file's columns but fall back to merged
    // (or today) if the selected file is still loading so we never stall on null.
    const pabMonth = useSelected
      ? (selCols?.length
          ? (getLatestPabMonthFromColumns(selCols)
              ?? inferPabMonthFromColumns(selCols)
              ?? getCurrentPabMonth())
          : (getLatestPabMonthFromColumns(mergedCols) ?? getCurrentPabMonth()))
      : (getLatestPabMonthFromColumns(mergedCols ?? []) ?? getCurrentPabMonth());
    if (!pabMonth) return null;
    const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [pabMergedColumns, columns, row, selectedFile, manualFileSelect]);

  /** PAB calendar grid: one row per Mon–Fri work week in the PAB range. */
  const pabCalendar = useMemo<PabCalendarDay[][] | null>(() => {
    if (!pabMonthRange) return null;
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    // Always use merged data for hours lookup so every week in the derived
    // PAB period is populated, regardless of which file drives the period.
    const pabRow = pabMergedRow ?? row;
    const pabCols = pabMergedColumns.length > 0 ? pabMergedColumns : columns;
    // When we have a month range but no row/cols yet, still render empty weeks
    // (placeholders with 0h) instead of looping the skeleton forever.
    if (!pabRow || !pabCols.length) {
      const empty = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, new Map());
      return empty.length > 0 ? [empty[0]] : null;
    }

    // Build date → seconds lookup directly from grouped columns + raw row data.
    // We try ALL columns in each group so that canonical names ("monday") get
    // resolved via their calendar-day key even if parseColDate doesn't recognise them.
    const hoursByDateKey = new Map<string, number>();
    const dateCols = pabCols.filter(isDateCol);
    const groups = groupDateColumnsByCalendarDay(dateCols, pabCols);
    for (const group of groups) {
      // Find a parseable date from any column in the group
      let d: Date | null = null;
      for (const c of group) {
        d = parseColDate(c);
        if (d) break;
      }
      if (!d) continue;
      // Max seconds across the group
      let maxS = 0;
      for (const c of group) {
        const raw = getFieldFromRow(pabRow, [c])
          ?? (Object.prototype.hasOwnProperty.call(pabRow, c) ? pabRow[c] : undefined);
        maxS = Math.max(maxS, parseHMS(raw));
      }
      const key = pabDateKey(d);
      hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, maxS));
    }
    const weeks = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, hoursByDateKey);

    // Manual file selection: show the full range for that file's period.
    if (useSelected) return weeks;

    // Trim to weeks that have elapsed so far: hide future weeks with no data yet.
    // Find the latest date that actually has logged hours (>0)
    let latest: Date | null = null;
    for (const [key, secs] of hoursByDateKey) {
      if (secs <= 0) continue;
      const [y, m, d] = key.split('-').map(Number);
      if (!y || !m || !d) continue;
      const dt = new Date(y, m - 1, d);
      if (!latest || dt.getTime() > latest.getTime()) latest = dt;
    }
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const cutoff = latest ?? todayMid;

    const trimmed = weeks.filter((week) => {
      const firstDay = week[0]?.date;
      if (!firstDay) return false;
      const weekStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate());
      return weekStart.getTime() <= cutoff.getTime();
    });
    return trimmed.length > 0 ? trimmed : weeks.slice(0, 1);
  }, [pabMonthRange, pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect]);

  /** PAB: every expected weekday in the PAB period must be ≥ 7 h. */
  const pabWeekdayHours = pabDailyHours.filter((d) => d.weekday);
  const allPabDays = pabCalendar?.flat() ?? [];

  /** Is the current PAB period still in progress? (today ≤ period end, viewing default period) */
  const isPabPeriodInProgress = useMemo(() => {
    if (!pabMonthRange) return false;
    const useSelected = !!selectedFile && selectedFile !== '__all__';
    if (useSelected) return false; // historical file — not pending
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endT = new Date(
      pabMonthRange.end.getFullYear(),
      pabMonthRange.end.getMonth(),
      pabMonthRange.end.getDate(),
    ).getTime();
    return t <= endT;
  }, [pabMonthRange, selectedFile, manualFileSelect]);

  /** Elapsed weekdays where hours were logged but fell below the 7h threshold — hard disqualifications. */
  const pabViolations = useMemo<PabCalendarDay[]>(() => {
    const days = pabCalendar?.flat() ?? [];
    const today = new Date();
    const todayT = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return days.filter((d) => {
      const dT = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate()).getTime();
      return dT <= todayT && d.hasData && !d.passes;
    });
  }, [pabCalendar]);

  const isPAEligible =
    !isPabPeriodInProgress && allPabDays.length > 0 && allPabDays.every((d) => d.passes);

  const perfectAttendanceBonusStatus = useMemo<
    'eligible' | 'not_eligible' | 'pending' | 'unknown'
  >(() => {
    if (!row && !pabMergedRow) return 'unknown';
    const days = pabCalendar?.flat();
    if (!days || days.length === 0) return 'unknown';
    // Any elapsed sub-7h weekday disqualifies the whole month immediately,
    // even while the period is still in progress.
    if (pabViolations.length > 0) return 'not_eligible';
    if (isPabPeriodInProgress) return 'pending';
    return days.every((d) => d.passes) ? 'eligible' : 'not_eligible';
  }, [row, pabMergedRow, pabCalendar, isPabPeriodInProgress, pabViolations]);

  /** Number of PAB-eligible months (currently 1 month evaluated). Pending periods don't count. */
  const pabEligibleCount = isPAEligible ? 1 : 0;
  /** Total PAB bonus in PHP. Excluded from pay summary while period is still in progress. */
  const pabBonusAmount = pabEligibleCount * PERFECT_ATTENDANCE_BONUS_PHP;

  /** Technology Bonus unlocks once the PAB period reaches its 3rd week. */
  const isTechnologyBonusActive = useMemo(() => {
    if (!pabCalendar || pabCalendar.length < 3) return false;
    const thirdWeekStart = pabCalendar[2]?.[0]?.date;
    if (!thirdWeekStart) return false;
    const today = new Date();
    const todayT = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const weekT = new Date(
      thirdWeekStart.getFullYear(),
      thirdWeekStart.getMonth(),
      thirdWeekStart.getDate(),
    ).getTime();
    return todayT >= weekT;
  }, [pabCalendar]);

  const technologyBonusAmount = isTechnologyBonusActive ? TECHNOLOGY_BONUS_PHP : 0;

  const maxBarSeconds = Math.max(...dailyHours.map((d) => d.seconds), 8 * 3600);

  if (loading) {
    return (
      <div className="box-border flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-3 sm:px-4 sm:py-4 md:px-5 dark:bg-none dark:bg-[#0d1117]">
        {/* Header skeleton */}
        <div className="flex shrink-0 flex-col gap-2">
          <div className="h-7 w-40 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-4 w-72 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
          <div className="h-3.5 w-48 animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/50" />
        </div>
        {/* Bonus indicators skeleton */}
        <div className="shrink-0 rounded-xl border border-zinc-200/80 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="mb-3 h-4 w-44 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 rounded-lg border border-zinc-200/60 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-52 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-3 w-80 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
              </div>
              <div className="h-6 w-16 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-zinc-200/60 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-3 w-64 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
              </div>
              <div className="h-6 w-24 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            </div>
          </div>
        </div>
        {/* Stats cards skeleton */}
        <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-5 md:gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="rounded-xl border border-zinc-200/60 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
              <div className="mb-2 flex items-center justify-between">
                <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-3.5 w-3.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
              <div className="h-6 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" style={{ animationDelay: `${i * 100}ms` }} />
              <div className="mt-1.5 h-2.5 w-32 animate-pulse rounded bg-zinc-200/50 dark:bg-zinc-800/50" />
            </div>
          ))}
        </div>
        {/* Chart + Calendar + Summary skeleton */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
          <div className="flex min-h-[10rem] flex-1 flex-col rounded-xl border border-zinc-200/60 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/30 lg:min-h-0">
            <div className="mb-3 h-3.5 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-3 w-8 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-5 flex-1 animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70" style={{ animationDelay: `${i * 80}ms` }} />
                  <div className="h-3 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
          <div className="flex min-h-[10rem] flex-1 flex-col rounded-xl border border-zinc-200/60 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/30 lg:min-h-0">
            <div className="mb-3 h-3.5 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="grid flex-1 grid-cols-5 gap-1">
              {Array.from({ length: 25 }, (_, i) => (
                <div key={i} className="h-8 animate-pulse rounded-md bg-zinc-200/60 dark:bg-zinc-800/60" style={{ animationDelay: `${i * 30}ms` }} />
              ))}
            </div>
          </div>
          <div className="flex w-full flex-col rounded-xl border border-zinc-200/60 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/30 lg:w-[20rem]">
            <div className="mb-3 h-3.5 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="space-y-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-3.5 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" style={{ animationDelay: `${i * 60}ms` }} />
                </div>
              ))}
            </div>
          </div>
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
                  onChange={(e) => {
                    setSelectedFile(e.target.value || null);
                    setManualFileSelect(true);
                  }}
                  className="h-7 rounded-md border border-zinc-200 bg-white px-2 pr-6 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  <option value="__all__">All Time (all uploads combined)</option>
                  {[...sourceFiles].reverse().map((file, i) => (
                    <option key={file} value={file}>
                      {file}{i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
                {fileLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" />}
              </div>
              <p className="pl-5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
                {isAllTime
                  ? 'Showing combined totals across all uploaded files. PAB calendar is unaffected.'
                  : 'Monthly PAB merges every upload — this file only drives the hours/pay cards below.'}
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
          {row && perfectAttendanceBonusStatus === 'pending' && (
            <Badge
              variant="outline"
              className="gap-1 border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-indigo-700 dark:border-indigo-500/30 dark:text-indigo-300"
              title={pabMonthRange ? `Period in progress: ${formatPabCalendarDate(pabMonthRange.start)} – ${formatPabCalendarDate(pabMonthRange.end)}` : undefined}
            >
              <CalendarDays className="h-3 w-3" />
              PAB in progress{pabMonthRange ? ` · ${pabMonthRange.monthName.slice(0, 3)}` : ''}
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
                          : perfectAttendanceBonusStatus === 'pending'
                            ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                            : 'bg-zinc-200/80 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    {perfectAttendanceBonusStatus === 'eligible' ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : perfectAttendanceBonusStatus === 'not_eligible' ? (
                      <XCircle className="h-4 w-4" />
                    ) : perfectAttendanceBonusStatus === 'pending' ? (
                      <CalendarDays className="h-4 w-4" />
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
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                        No longer Eligible for PAB, Try again next month
                        {pabViolations.length > 0 && (
                          <>
                            {' — '}
                            <span className="font-normal">
                              violated on{' '}
                              {pabViolations
                                .map((v) => formatPabCalendarDate(v.date))
                                .join(', ')}
                            </span>
                          </>
                        )}
                      </p>
                    )}
                    {perfectAttendanceBonusStatus === 'pending' && (
                      <p className="text-xs text-indigo-700 dark:text-indigo-300">
                        This PAB period is still in progress — eligibility and bonus will be finalized once all Mon–Fri days have elapsed. Not yet included in the pay summary.
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
                        : perfectAttendanceBonusStatus === 'pending'
                          ? 'shrink-0 border-indigo-500/40 bg-indigo-500/10 text-indigo-800 dark:text-indigo-300'
                          : 'shrink-0 border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                  }
                >
                  {perfectAttendanceBonusStatus === 'eligible'
                    ? 'Eligible'
                    : perfectAttendanceBonusStatus === 'not_eligible'
                      ? 'Not eligible'
                      : perfectAttendanceBonusStatus === 'pending'
                        ? 'In progress'
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
          <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-6 md:gap-3">
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
                    : isAllTime ? 'No overtime across all files' : 'No overtime in this file'}
                </p>
              </CardContent>
            </Card>

            {/* Perfect Attendance Bonus */}
            <Card
              size="sm"
              className={`min-w-0 shadow-sm transition-colors duration-300 ${
                isPAEligible
                  ? 'border-indigo-200/80 bg-gradient-to-br from-white to-indigo-50/30 hover:to-indigo-50/60 dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/10 dark:hover:from-indigo-950/30'
                  : 'border-zinc-200/80 bg-gradient-to-br from-white to-zinc-50/30 dark:border-zinc-800/60 dark:bg-none dark:from-zinc-900/20 dark:to-zinc-900/10'
              }`}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  PAB
                </CardTitle>
                <Award className={`h-3.5 w-3.5 shrink-0 ${isPAEligible ? 'text-indigo-500' : 'text-zinc-400'}`} />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div
                  className={`break-words font-mono text-base font-bold tabular-nums leading-tight sm:text-lg ${
                    pabBonusAmount > 0 ? 'text-indigo-700 dark:text-indigo-400' : 'text-zinc-400 dark:text-zinc-500'
                  }`}
                >
                  {perfectAttendanceBonusStatus === 'pending'
                    ? 'Pending'
                    : pabBonusAmount > 0
                      ? formatPHP(pabBonusAmount)
                      : formatPHP(0)}
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  {perfectAttendanceBonusStatus === 'pending'
                    ? 'Period in progress — not finalized'
                    : isAllTime
                      ? pabEligibleCount > 0
                        ? `${pabEligibleCount} month${pabEligibleCount !== 1 ? 's' : ''} eligible × ${formatPHP(PERFECT_ATTENDANCE_BONUS_PHP).replace(/\.\d{2}$/, '')}`
                        : 'Not eligible this period'
                      : isPAEligible
                        ? 'Eligible this month'
                        : perfectAttendanceBonusStatus === 'unknown'
                          ? 'Pending data'
                          : 'Not eligible'}
                </p>
              </CardContent>
            </Card>

            {/* Technology Bonus */}
            <Card
              size="sm"
              className={`min-w-0 shadow-sm transition-colors duration-300 ${
                isTechnologyBonusActive
                  ? 'border-sky-200/80 bg-gradient-to-br from-white to-sky-50/30 hover:to-sky-50/60 dark:border-sky-950/60 dark:bg-none dark:from-sky-950/20 dark:to-sky-950/10 dark:hover:from-sky-950/30'
                  : 'border-zinc-200/80 bg-gradient-to-br from-white to-zinc-50/30 dark:border-zinc-800/60 dark:bg-none dark:from-zinc-900/20 dark:to-zinc-900/10'
              }`}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-1 pb-1 pt-3">
                <CardTitle className="min-w-0 truncate text-[11px] font-medium leading-tight text-zinc-600 sm:text-xs dark:text-zinc-400">
                  Tech Bonus
                </CardTitle>
                <Laptop className={`h-3.5 w-3.5 shrink-0 ${isTechnologyBonusActive ? 'text-sky-500' : 'text-zinc-400'}`} />
              </CardHeader>
              <CardContent className="pb-3 pt-0">
                <div
                  className={`break-words font-mono text-base font-bold tabular-nums leading-tight sm:text-lg ${
                    technologyBonusAmount > 0 ? 'text-sky-700 dark:text-sky-400' : 'text-zinc-400 dark:text-zinc-500'
                  }`}
                >
                  {technologyBonusAmount > 0 ? formatPHP(technologyBonusAmount) : formatPHP(0)}
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-600">
                  {isTechnologyBonusActive
                    ? 'Unlocked · 3rd week reached'
                    : 'Unlocks on week 3 of PAB'}
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

          {/* Daily Hours + PAB Calendar + Pay Summary */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-4">
            {/* Daily Hours Bar Chart — always visible */}
            <Card
              size="sm"
              className="flex min-h-[12rem] flex-1 flex-col border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 lg:min-h-0"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <CardTitle className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Daily Hours Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
                {dailyHours.length === 0 ? (
                  <div className="flex flex-1 items-center gap-2 py-6 text-sm text-zinc-500">
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                    Daily breakdown not available
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overflow-x-clip pr-2">
                    {dailyHours.map((day) => {
                      const hours = day.seconds / 3600;
                      const pct = maxBarSeconds > 0 ? (day.seconds / maxBarSeconds) * 100 : 0;
                      const meetsPA = day.weekday && day.seconds >= 7 * 3600;
                      const belowPA = day.weekday && day.seconds > 0 && day.seconds < 7 * 3600;
                      return (
                        <div key={day.col} className="flex items-center gap-2">
                          <span
                            className={`w-10 shrink-0 text-right text-xs font-medium ${
                              day.weekday
                                ? 'text-zinc-700 dark:text-zinc-300'
                                : 'text-zinc-400 dark:text-zinc-600'
                            }`}
                          >
                            {day.label}
                          </span>
                          <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800/60">
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
                    <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h (PA)
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 sm:h-2 sm:w-2" /> &lt; 7h
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600 sm:h-2 sm:w-2" /> Weekend
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1 w-3 bg-red-400/50 sm:h-1.5" /> 7h line
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* PAB Calendar — beside Daily Hours */}
            <Card
              size="sm"
              className="flex min-h-[12rem] flex-1 flex-col border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-sm dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/5 lg:min-h-0"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <CardTitle className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  PAB Calendar
                </CardTitle>
                {pabMonthRange ? (
                  <p className="mt-0.5 flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    <span>
                      <span className="font-semibold">{pabMonthRange.monthName} {pabMonthRange.year}</span>
                      {' · '}
                      {formatPabCalendarDate(pabMonthRange.start)} – {formatPabCalendarDate(pabMonthRange.end)}
                    </span>
                  </p>
                ) : (
                  <div className="mt-1 h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                )}
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
                {pabMergeLoading || fileLoading ? (
                  /* -------- Skeleton loading state -------- */
                  <div className="flex flex-1 flex-col gap-0">
                    {/* Skeleton header row */}
                    <div className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1">
                      <div />
                      {Array.from({ length: 5 }, (_, i) => (
                        <div key={i} className="mx-auto h-2 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                      ))}
                    </div>
                    {/* Skeleton week rows */}
                    {Array.from({ length: 5 }, (_, wi) => (
                      <div key={wi} className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1">
                        <div className="flex items-center justify-end">
                          <div className="h-2 w-3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                        </div>
                        {Array.from({ length: 5 }, (_, di) => (
                          <div
                            key={di}
                            className="h-10 animate-pulse rounded-md border border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/30"
                            style={{ animationDelay: `${(wi * 5 + di) * 50}ms` }}
                          />
                        ))}
                      </div>
                    ))}
                    <div className="mt-auto flex items-center justify-center gap-2 pt-2 text-[10px] text-zinc-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading PAB data…
                    </div>
                  </div>
                ) : pabCalendar && pabCalendar.length > 0 ? (
                  /* -------- PAB Calendar Grid -------- */
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip">
                      {/* Column headers */}
                      <div className="sticky top-0 z-10 mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95">
                        <div />
                        {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
                          <div key={i} className="text-center text-[8px] font-semibold text-zinc-400 dark:text-zinc-500">
                            {d}
                          </div>
                        ))}
                      </div>
                      {/* Week rows */}
                      {pabCalendar.map((week, wi) => (
                        <div
                          key={wi}
                          className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] items-stretch gap-1"
                          style={{ animation: `pab-row-in 0.35s ease-out ${wi * 80}ms both` }}
                        >
                          <div className="flex items-center justify-end text-[8px] font-medium text-zinc-400 dark:text-zinc-500">
                            {wi + 1}
                          </div>
                          {Array.from({ length: 5 }, (_, di) => {
                            const day: PabCalendarDay | undefined = week.find(
                              d => d.date.getDay() === di + 1,
                            );
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
                            const hours = day.seconds / 3600;
                            return (
                              <div
                                key={di}
                                className={`flex h-10 flex-col items-center justify-center gap-px rounded-md border transition-all duration-300 ${
                                  day.passes
                                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/30'
                                    : day.hasData
                                      ? 'border-red-300 bg-red-50 dark:border-red-800/60 dark:bg-red-950/30'
                                      : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40'
                                }`}
                                title={`${day.dayLabel} ${day.dateStr}: ${secondsToDisplay(day.seconds)}${day.passes ? ' ✓' : day.hasData ? ' ✗ needs 7h' : ' — no data'}`}
                                style={{ animation: `pab-cell-in 0.3s ease-out ${wi * 80 + di * 40}ms both` }}
                              >
                                <span className="text-[7px] leading-none text-zinc-400 dark:text-zinc-500">
                                  {day.dateStr}
                                </span>
                                <span
                                  className={`font-mono text-[10px] font-bold leading-none ${
                                    day.passes
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : day.hasData
                                        ? 'text-red-600 dark:text-red-400'
                                        : 'text-zinc-400 dark:text-zinc-500'
                                  }`}
                                >
                                  {day.hasData ? `${hours.toFixed(1)}` : '—'}
                                </span>
                                {day.passes ? (
                                  <CheckCircle2 className="h-2 w-2 text-emerald-500" />
                                ) : day.hasData ? (
                                  <XCircle className="h-2 w-2 text-red-400" />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    {/* Legend + status */}
                    <div className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 sm:h-2 sm:w-2" /> &lt; 7h
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600 sm:h-2 sm:w-2" /> N/A
                      </span>
                      <span className="ml-auto font-medium">
                        {isPAEligible
                          ? <span className="text-emerald-600 dark:text-emerald-400">PAB Eligible</span>
                          : <span className="text-red-500 dark:text-red-400">PAB Not Met</span>}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
                    <CalendarDays className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">
                      PAB calendar will appear once<br />Hubstaff data is uploaded
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pay Summary — fixed width on lg */}
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
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className={`shrink-0 text-xs ${pabBonusAmount > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      PAB{isAllTime && pabEligibleCount > 0 ? ` (${pabEligibleCount}×)` : ''}
                      {perfectAttendanceBonusStatus === 'pending' ? ' (pending)' : ''}
                    </span>
                    <span className={`max-w-[58%] break-words text-right font-mono text-xs sm:text-sm ${pabBonusAmount > 0 ? 'font-medium text-indigo-600 dark:text-indigo-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                      {perfectAttendanceBonusStatus === 'pending'
                        ? '—'
                        : pabBonusAmount > 0
                          ? `+${formatPHP(pabBonusAmount)}`
                          : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className={`shrink-0 text-xs ${technologyBonusAmount > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      Tech Bonus{isTechnologyBonusActive ? '' : ' (locked)'}
                    </span>
                    <span className={`max-w-[58%] break-words text-right font-mono text-xs sm:text-sm ${technologyBonusAmount > 0 ? 'font-medium text-sky-600 dark:text-sky-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                      {technologyBonusAmount > 0
                        ? `+${formatPHP(technologyBonusAmount)}`
                        : formatPHP(0)}
                    </span>
                  </div>
                  <div className="h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-white">Total</span>
                    <span className="max-w-[60%] break-words text-right font-mono text-base font-bold leading-tight text-emerald-700 sm:text-lg dark:text-emerald-400">
                      {totalPay != null
                        ? formatPHP(totalPay + pabBonusAmount + technologyBonusAmount)
                        : '—'}
                    </span>
                  </div>
                  {totalPay != null && (
                    <p className="break-words text-right font-mono text-[10px] text-blue-500 dark:text-blue-400">
                      ≈ ${((totalPay + pabBonusAmount + technologyBonusAmount) / usdToPhpRate).toLocaleString('en-US', {
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
