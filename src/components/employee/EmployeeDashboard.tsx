'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  AlertCircle,
  CalendarDays,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  Laptop,
  FileText,
  RefreshCw,
  CircleHelp,
  Sparkles,
} from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import {
  OFFICIAL_USD_TO_PHP_RATE,
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
  parseDateRangeFromFilename,
  buildPabCalendarWeeks,
  pabDateKey,
  resolveCanonicalColumnsToIso,
  columnsAreAllCanonical,
} from '@/lib/hubstaff/calendar-column-dedupe';
import type { PabCalendarDay } from '@/lib/hubstaff/calendar-column-dedupe';
import { usePabPeriodSettings } from '@/hooks/usePabPeriodSettings';
import {
  disputeGrantsPabForgiveness,
  disputeIsAwaitingResolution,
  isOrphanageStyleReason,
} from '@/lib/supabase/pab-day-disputes';
import HiddenValue from './HiddenValue';
import GiftShippingCard, { type GiftShippingState } from './GiftShippingCard';
import { Gift } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  /**
   * Called when an employee taps a sub-7h day in the PAB calendar. Hands the
   * date (and Hubstaff seconds, for display) to the disputes page so the form
   * lands pre-filled.
   */
  onNavigateToDisputes?: (prefill?: { date: string; seconds?: number }) => void;
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

function hubstaffRowMatchesEmployee(
  r: Record<string, unknown>,
  employeeNorms: string | string[],
): boolean {
  const set = Array.isArray(employeeNorms) ? new Set(employeeNorms) : new Set([employeeNorms]);
  return collectHubstaffRowEmails(r).some((e) => {
    const n = normEmail(e);
    return n ? set.has(n) : false;
  });
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

const EMPLOYEE_MESSAGES: { heading: (name: string) => string; body: string }[] = [
  {
    heading: (name) => `Welcome back, ${name} — your work keeps this company moving. ✦`,
    body: "Track your hours, check your pay estimates, and keep your Perfect Attendance streak alive. Everything you need is right here.",
  },
  {
    heading: (name) => `Hi ${name} — consistency is your superpower. ✦`,
    body: "Every hour you log and every shift you show up for adds up. Your dashboard has the full picture — hours, pay, and attendance all in one place.",
  },
  {
    heading: (name) => `Good to see you, ${name} — keep showing up. ✦`,
    body: "Your effort is measured here, recognized, and rewarded. Check your current estimates and make sure everything looks right.",
  },
  {
    heading: (name) => `Hey ${name} — great work starts with knowing where you stand. ✦`,
    body: "Review your hours, estimated pay, and PAB status below. Reach out to your manager if anything looks off.",
  },
  {
    heading: (name) => `Welcome, ${name} — every shift counts and so do you. ✦`,
    body: "Your hours, bonuses, and attendance are tracked transparently here. Keep it going — you're doing great.",
  },
];

const SPARKLES_FLOAT = [
  { left: '4%',  delay: '0s',    dur: '4.1s', size: '18px' },
  { left: '12%', delay: '1.3s',  dur: '3.7s', size: '14px' },
  { left: '22%', delay: '2.6s',  dur: '4.5s', size: '22px' },
  { left: '35%', delay: '0.7s',  dur: '3.4s', size: '16px' },
  { left: '48%', delay: '2.0s',  dur: '4.0s', size: '12px' },
  { left: '60%', delay: '0.4s',  dur: '4.7s', size: '20px' },
  { left: '72%', delay: '2.9s',  dur: '3.8s', size: '15px' },
  { left: '83%', delay: '1.6s',  dur: '4.2s', size: '19px' },
  { left: '93%', delay: '3.3s',  dur: '3.6s', size: '13px' },
] as const;

export default function EmployeeDashboard({ employeeEmail, onNavigateToDisputes }: EmployeeDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [employeeStartDate, setEmployeeStartDate] = useState<Date | null>(null);
  // Shared mask state for the hero pay values (Take-Home, Regular, Overtime).
  // Default hidden on every mount so passers-by see masked amounts; one click
  // on the eye next to Take-Home reveals all three together.
  const [payValuesRevealed, setPayValuesRevealed] = useState(false);
  /** All normalized emails known for this employee (login + work + personal). */
  const [aliasEmails, setAliasEmails] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [rate, setRate] = useState<EmployeeHourlyRateRow | null>(null);
  const [usdToPhpRate, setUsdToPhpRate] = useState(OFFICIAL_USD_TO_PHP_RATE);
  const [dataError, setDataError] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [manualFileSelect, setManualFileSelect] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Merged row for this employee across ALL uploaded CSVs — used for full-month PAB. */
  const [pabMergedRow, setPabMergedRow] = useState<Record<string, unknown> | null>(null);
  const [pabMergedColumns, setPabMergedColumns] = useState<string[]>([]);
  const [pabMergeLoading, setPabMergeLoading] = useState(false);
  /** Accumulated pay breakdown across every source file for this employee. */
  const [allTimeTotalSeconds, setAllTimeTotalSeconds] = useState(0);
  const [allTimeRegularSec, setAllTimeRegularSec] = useState(0);
  const [allTimeOtSec, setAllTimeOtSec] = useState(0);

  const pabPeriodSettings = usePabPeriodSettings();

  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  const [myDisputes, setMyDisputes] = useState<import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow[]>([]);
  /** Mobile: PAB rules, bonus status, and pay numbers live in this sheet (charts stay on the main view). */
  const [mobileHelpOpen, setMobileHelpOpen] = useState(false);
  /** Master-list profile fields used to prefill the gift-shipping form. */
  const [profileForShipping, setProfileForShipping] = useState<{
    name: string | null;
    personalEmail: string | null;
    workEmail: string | null;
    department: string | null;
  }>({ name: null, personalEmail: null, workEmail: null, department: null });

  /** Gift-shipping dialog control — both the inline card CTA and the header
   *  bell icon flip this flag. */
  const [giftDialogOpen, setGiftDialogOpen] = useState(false);
  /** State summary emitted by GiftShippingCard so the bell can show a badge. */
  const [giftState, setGiftState] = useState<GiftShippingState>({
    status: 'none',
    milestoneMonths: null,
    needsAction: false,
  });

  // Fetch the employee's master row once to get their start_date
  // (used to gate Tech Bonus on the 30-day-of-service requirement).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employees', { cache: 'no-store' });
        const json = (await res.json()) as {
          employees?: {
            name?: string | null;
            work_email?: string | null;
            personal_email?: string | null;
            start_date?: string | null;
            department?: string | null;
          }[];
        };
        if (cancelled) return;
        const me = (json.employees ?? []).find((e) => {
          const we = normEmail(e.work_email ?? '');
          const pe = normEmail(e.personal_email ?? '');
          return we === email || pe === email;
        });
        const aliases = new Set<string>([email]);
        if (me) {
          const we = normEmail(me.work_email ?? '');
          const pe = normEmail(me.personal_email ?? '');
          if (we) aliases.add(we);
          if (pe) aliases.add(pe);
          setProfileForShipping({
            name: me.name ?? null,
            personalEmail: pe ?? we ?? null,
            workEmail: we ?? null,
            department: me.department ?? null,
          });
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
          setEmployeeStartDate(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

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
          setSelectedFile(files[0]); // latest (API returns newest-first)
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
  }, [email, aliasEmails]);

  // Load hours data for the selected source file
  const loadHoursData = React.useCallback(
    async (file: string | null, cancelled?: boolean, aliasOverride?: string[]) => {
    const emailsForMatch = aliasOverride ?? (aliasEmails.length ? aliasEmails : [email]);
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
        const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, emailsForMatch));

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
    },
    [email, aliasEmails],
  );

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
  // Requests run in parallel so the calendar is not blocked on N sequential round-trips.
  useEffect(() => {
    if (sourceFiles.length === 0) {
      setPabMergeLoading(false);
      setPabMergedRow(null);
      setPabMergedColumns([]);
      setAllTimeTotalSeconds(0);
      setAllTimeRegularSec(0);
      setAllTimeOtSec(0);
      return;
    }
    let cancelled = false;
    setPabMergeLoading(true);
    const emailsMatch = aliasEmails.length ? aliasEmails : [email];
    (async () => {
      try {
        const responses = await Promise.all(
          sourceFiles.map((file) =>
            fetch(
              `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
              { cache: 'no-store' },
            ).then(async (res) => {
              const json = (await res.json()) as {
                columns?: string[] | null;
                rows?: Record<string, unknown>[] | null;
              };
              return { file, json };
            }),
          ),
        );
        if (cancelled) return;

        const allCols = new Set<string>();
        let merged: Record<string, unknown> = {};
        let found = false;
        let cumulativeSeconds = 0;
        let cumulativeRegSec = 0;
        let cumulativeOtSec = 0;

        for (const { file, json } of responses) {
          if (!json.columns || !json.rows) continue;

          const myRow = json.rows.find((r) => hubstaffRowMatchesEmployee(r, emailsMatch));
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
        if (!cancelled) setPabMergeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFiles, email, aliasEmails]);

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
    const manualPab = pabPeriodSettings.validManualRange;
    if (manualPab) {
      groups = filterColumnGroupsByPabRange(groups, pabCols, manualPab.start, manualPab.end);
    } else {
      // PAB period: manual file selection → that file's inferred month;
      // otherwise → PAB month containing the latest date in merged uploads.
      const pabMonth = useSelected
        ? (getLatestPabMonthFromColumns(pabCols) ?? inferPabMonthFromColumns(pabCols))
        : (getLatestPabMonthFromColumns(pabCols) ?? getCurrentPabMonth());
      if (pabMonth) {
        const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
        groups = filterColumnGroupsByPabRange(groups, pabCols, start, end);
      }
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
  }, [pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect, pabPeriodSettings.validManualRange]);

  /** PAB month + date range for display.
   * Default: latest PAB period in merged CSV data (or today if none).
   * When user manually picks a CSV: use that file's inferred period. */
  const pabMonthRange = useMemo(() => {
    const manual = pabPeriodSettings.validManualRange;
    if (manual) {
      const { start, end } = manual;
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return {
        year: start.getFullYear(),
        month: start.getMonth(),
        start,
        end,
        monthName: monthNames[start.getMonth()] ?? '',
      };
    }
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
  }, [pabMergedColumns, columns, row, selectedFile, manualFileSelect, pabPeriodSettings.validManualRange]);

  const fetchMyDisputes = useCallback(() => {
    if (!pabMonthRange || !email) return;
    const s = pabMonthRange.start;
    const e = pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const to = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
    fetch(`/api/pab-disputes?email=${encodeURIComponent(email)}&from=${from}&to=${to}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows: import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow[] }) => {
        setMyDisputes(json.rows ?? []);
      })
      .catch(() => setMyDisputes([]));
  }, [pabMonthRange, email]);

  useEffect(() => { fetchMyDisputes(); }, [fetchMyDisputes]);

  const refreshDashboard = useCallback(async () => {
    setDataError(null);
    setRefreshing(true);
    try {
      const [empRes, ratesRes, fxRes, filesRes] = await Promise.all([
        fetch('/api/employees', { cache: 'no-store' }),
        fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
        fetch('/api/app-settings?key=usd_to_php_rate', { cache: 'no-store' }),
        fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, { cache: 'no-store' }),
      ]);

      const empJson = (await empRes.json()) as {
        employees?: {
          work_email?: string | null;
          personal_email?: string | null;
          start_date?: string | null;
          department?: string | null;
        }[];
      };
      const me = (empJson.employees ?? []).find((e) => {
        const we = normEmail(e.work_email ?? '');
        const pe = normEmail(e.personal_email ?? '');
        return we === email || pe === email;
      });
      const aliasSet = new Set<string>([email]);
      if (me) {
        const we = normEmail(me.work_email ?? '');
        const pe = normEmail(me.personal_email ?? '');
        if (we) aliasSet.add(we);
        if (pe) aliasSet.add(pe);
      }
      const aliases = [...aliasSet];
      setAliasEmails((prev) =>
        prev.length === aliases.length && prev.every((a, i) => a === aliases[i]) ? prev : aliases,
      );
      if (!me?.start_date) {
        setEmployeeStartDate(null);
      } else {
        const d = new Date(me.start_date);
        setEmployeeStartDate(Number.isNaN(d.getTime()) ? null : d);
      }

      const ratesJson = (await ratesRes.json()) as {
        rows?: EmployeeHourlyRateRow[];
        error?: string | null;
      };
      const fxJson = (await fxRes.json()) as { value: string | null };
      const filesJson = (await filesRes.json()) as { files?: string[]; error?: string | null };

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

      let nextSelected = selectedFile;
      if (nextSelected && nextSelected !== '__all__' && !files.includes(nextSelected)) {
        nextSelected = files.length > 0 ? files[0] : null;
        setSelectedFile(nextSelected);
      }

      const fileArg = nextSelected === '__all__' || nextSelected === null ? null : nextSelected;

      setFileLoading(true);
      try {
        await loadHoursData(fileArg, false, aliases);
      } finally {
        setFileLoading(false);
      }

      fetchMyDisputes();
    } catch (e) {
      setDataError(e instanceof Error ? e.message : 'Failed to refresh dashboard');
    } finally {
      setRefreshing(false);
    }
  }, [email, selectedFile, loadHoursData, fetchMyDisputes]);

  const disputesByDate = useMemo(() => {
    const map = new Map<string, import('@/lib/supabase/pab-day-disputes').PabDayDisputeRow>();
    for (const d of myDisputes) map.set(d.dispute_date, d);
    return map;
  }, [myDisputes]);

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

    // Apply approved dispute override_hours as a SET (replaces Hubstaff hours for that day).
    // `null` override = floor-drop only (no hour change). `0` = intentional zero-out. `>0` = replace.
    // Override writes apply to the exact dispute_date only; day-after forgiveness for orphanage
    // visits happens via the synthetic disputesByDate entry below (no hours change on day+1).
    // Note: dispute_date is ISO "YYYY-MM-DD" but hoursByDateKey uses pabDateKey ("YYYY-M-D", no
    // zero-padding). Convert before writing or the override silently falls through.
    for (const d of myDisputes) {
      if (!disputeGrantsPabForgiveness(d)) continue;
      const set = d.override_hours;
      if (set == null || set < 0) continue;
      const [y, m, day] = d.dispute_date.split('-').map(Number);
      if (!y || !m || !day) continue;
      const key = `${y}-${m}-${day}`;
      hoursByDateKey.set(key, set * 3600);
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
  }, [pabMonthRange, pabMergedRow, pabMergedColumns, row, columns, selectedFile, manualFileSelect, myDisputes]);

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

  /**
   * Selected weekly file's range. Prefer parsing the filename (`..._YYYY-MM-DD_to_YYYY-MM-DD.csv`)
   * and fall back to scanning the file's date columns so non-standard filenames still work.
   */
  const selectedFileWeek = useMemo(() => {
    if (!selectedFile || selectedFile === '__all__') return null;
    const fromName = parseDateRangeFromFilename(selectedFile);
    if (fromName) return fromName;
    // Fallback: derive from the selected file's date columns.
    let earliest: Date | null = null;
    let latest: Date | null = null;
    for (const c of columns) {
      const d = parseColDate(c);
      if (!d) continue;
      if (!earliest || d.getTime() < earliest.getTime()) earliest = d;
      if (!latest || d.getTime() > latest.getTime()) latest = d;
    }
    return earliest && latest ? { start: earliest, end: latest } : null;
  }, [selectedFile, columns]);

  /** PAB month containing this file's Monday — used to gate weekly bonuses. */
  const weekPabRange = useMemo(() => {
    if (pabPeriodSettings.validManualRange) {
      const { start, end } = pabPeriodSettings.validManualRange;
      return {
        pabMonth: { year: start.getFullYear(), month: start.getMonth() },
        start,
        end,
      };
    }
    if (!selectedFileWeek) return null;
    const ws = selectedFileWeek.start;
    const dow = ws.getDay();
    const daysBackToMon = dow === 0 ? 6 : dow - 1;
    const mon = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - daysBackToMon);
    return { pabMonth: { year: mon.getFullYear(), month: mon.getMonth() }, ...getPabMonthRange(mon.getFullYear(), mon.getMonth()) };
  }, [selectedFileWeek, pabPeriodSettings.validManualRange]);

  /** When viewing a specific weekly file, PAB attaches only to the final week of that week's PAB month. */
  const isFinalPabWeekForSelected = useMemo(() => {
    if (!selectedFileWeek || !weekPabRange) return false;
    return selectedFileWeek.end.getTime() >= weekPabRange.end.getTime();
  }, [selectedFileWeek, weekPabRange]);

  /**
   * Total PAB bonus in PHP. Rules:
   *  - Must be eligible (period concluded with all weekdays ≥7h).
   *  - Explicit all-time view: full monthly total (reflects what already posted to the employee).
   *  - Weekly file view: only on the final week of that file's PAB month.
   *  - Otherwise (file selected but week can't be derived, or nothing selected): 0 — never
   *    fall back to showing the monthly total on an arbitrary week.
   */
  // No rates row in Supabase → US / paid externally / unseeded. Hide PH-side
  // bonuses so the dashboard doesn't advertise amounts the paystub won't pay.
  const hasRates = !!(
    rate &&
    (parseRate(rate.regular_rate) != null || parseRate(rate.ot_rate) != null)
  );

  const pabBonusAmount = useMemo(() => {
    if (!hasRates) return 0;
    if (!isPAEligible) return 0;
    if (isAllTime) return pabEligibleCount * PERFECT_ATTENDANCE_BONUS_PHP;
    if (selectedFileWeek) return isFinalPabWeekForSelected ? PERFECT_ATTENDANCE_BONUS_PHP : 0;
    return 0;
  }, [hasRates, isPAEligible, isAllTime, selectedFileWeek, isFinalPabWeekForSelected, pabEligibleCount]);

  /**
   * Tech Bonus rules:
   *  - Paid only in the 3rd paycheck of the month (the weekly pay period whose
   *    Monday is the 3rd calendar week — week 1 = Mon–Sun week containing the
   *    1st, even if partial). Equality, not ≥.
   *  - Employee must have completed 30 days of service from their start_date.
   *
   *  All-time view uses today's PAB month for the week check (and always honors
   *  the 30-day requirement); weekly view uses the selected file's PAB month.
   */
  const isTechnologyBonusActive = useMemo(() => {
    // 30-day service gate — same for all views.
    if (!employeeStartDate) return false;
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    // Reference Monday of the pay-period week.
    // - Weekly view → the selected file's week start (already a Monday).
    // - All-time view → Monday of the most recently dispatched pay period
    //   (i.e. the Monday whose salary Tuesday = Mon + 8 has already arrived).
    const refMonday = (() => {
      if (selectedFileWeek) {
        const s = selectedFileWeek.start;
        return new Date(s.getFullYear(), s.getMonth(), s.getDate());
      }
      const today = new Date();
      // Most recent past Tuesday (or today if today is Tuesday).
      const dow = today.getDay(); // Sun=0..Sat=6
      const daysBackToTue = (dow - 2 + 7) % 7;
      const lastTuesday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToTue);
      // Salary Tuesday = pay-period Monday + 8, so Monday = lastTuesday − 8.
      return new Date(lastTuesday.getFullYear(), lastTuesday.getMonth(), lastTuesday.getDate() - 8);
    })();
    if (refMonday.getTime() < eligibleFrom.getTime()) return false;

    // Salary Date = the Tuesday after the pay-period Sunday (refMonday + 8).
    // Tech bonus fires when salary date falls in the 3rd Mon–Sun week of its month
    // (week 1 = the Mon–Sun week containing the 1st).
    const salaryDate = new Date(refMonday.getFullYear(), refMonday.getMonth(), refMonday.getDate() + 8);
    const first = new Date(salaryDate.getFullYear(), salaryDate.getMonth(), 1);
    const dow = first.getDay();
    const daysBack = dow === 0 ? 6 : dow - 1;
    const firstMon = new Date(first.getFullYear(), first.getMonth(), first.getDate() - daysBack);
    const thirdWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 14);
    const fourthWeekMon = new Date(firstMon.getFullYear(), firstMon.getMonth(), firstMon.getDate() + 21);
    const t = salaryDate.getTime();
    return t >= thirdWeekMon.getTime() && t < fourthWeekMon.getTime();
  }, [employeeStartDate, selectedFileWeek]);

  const technologyBonusAmount = isTechnologyBonusActive && hasRates ? TECHNOLOGY_BONUS_PHP : 0;

  /** 30-day service status for Tech Bonus eligibility (independent of week gating). */
  const techServiceStatus = useMemo<
    | { state: 'eligible'; eligibleFrom: Date }
    | { state: 'pending'; eligibleFrom: Date; daysRemaining: number }
    | { state: 'unknown' }
  >(() => {
    if (!employeeStartDate) return { state: 'unknown' };
    const eligibleFrom = new Date(
      employeeStartDate.getFullYear(),
      employeeStartDate.getMonth(),
      employeeStartDate.getDate() + 30,
    );
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (todayMid.getTime() >= eligibleFrom.getTime()) {
      return { state: 'eligible', eligibleFrom };
    }
    const daysRemaining = Math.ceil(
      (eligibleFrom.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000),
    );
    return { state: 'pending', eligibleFrom, daysRemaining };
  }, [employeeStartDate]);

  const maxBarSeconds = Math.max(...dailyHours.map((d) => d.seconds), 8 * 3600);

  const renderPabBonusStatusRows = () => {
    if (!row) return null;
    return (
      <>
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
                    <span className="font-semibold">
                      {pabMonthRange.monthName} {pabMonthRange.year}
                    </span>
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
                        {pabViolations.map((v) => formatPabCalendarDate(v.date)).join(', ')}
                      </span>
                    </>
                  )}
                </p>
              )}
              {perfectAttendanceBonusStatus === 'pending' && (
                <p className="text-xs text-indigo-700 dark:text-indigo-300">
                  This PAB period is still in progress — eligibility and bonus will be finalized once all Mon–Fri days
                  have elapsed. Not yet included in the pay summary.
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

        <div
          className={`flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${
            techServiceStatus.state === 'pending'
              ? 'border-amber-200/80 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/20'
              : 'border-zinc-200/90 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/40'
          }`}
        >
          <div className="flex min-w-0 flex-1 gap-2">
            <div
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                techServiceStatus.state === 'pending'
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
              }`}
            >
              <Laptop className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs font-medium text-zinc-900 dark:text-white">
                Technology Bonus · {formatPHP(TECHNOLOGY_BONUS_PHP).replace(/\.\d{2}$/, '')}
              </p>
              {techServiceStatus.state === 'pending' ? (
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Not eligible yet. You need 30 days of service before your first Tech Bonus — you&apos;ll become eligible
                  on{' '}
                  <span className="font-semibold">
                    {techServiceStatus.eligibleFrom.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>{' '}
                  ({techServiceStatus.daysRemaining} day{techServiceStatus.daysRemaining === 1 ? '' : 's'} to go). The
                  bonus is paid on the 3rd paycheck of the month.
                </p>
              ) : techServiceStatus.state === 'eligible' ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  You&apos;re past your 30-day service mark. ₱1,850 is paid on the 3rd paycheck of each month to help
                  cover your technology expenses (equipment, internet).
                </p>
              ) : (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Paid on the 3rd paycheck of each month, but only after 30 days of service. Your start date isn&apos;t on
                  file yet — please contact your coordinator.
                </p>
              )}
            </div>
          </div>
          <Badge
            variant="outline"
            className={`shrink-0 ${
              techServiceStatus.state === 'pending'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:border-amber-500/30 dark:text-amber-300'
                : techServiceStatus.state === 'eligible'
                  ? 'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:border-sky-500/30 dark:text-sky-300'
                  : 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
          >
            {techServiceStatus.state === 'pending'
              ? `Pending · ${techServiceStatus.daysRemaining}d left`
              : techServiceStatus.state === 'eligible'
                ? 'Eligible'
                : 'Start date unknown'}
          </Badge>
        </div>
      </>
    );
  };

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="box-border flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-3 sm:px-4 sm:py-4 md:px-5 dark:bg-none dark:bg-[#0d1117]"
      >
        {/* Branded header */}
        <div className="flex shrink-0 items-center gap-4 border-b border-zinc-200/70 pb-3 dark:border-zinc-800/70">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-gradient-to-br from-orange-500 via-amber-500 to-orange-600 text-xl font-bold text-white shadow-lg shadow-orange-400/25">
            s
            <div className="absolute inset-0 rounded-[13px] ring-[3px] ring-orange-400/20 ring-offset-2 ring-offset-white dark:ring-offset-[#0d1117]" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-orange-400 dark:bg-orange-500"
                  animate={{ opacity: [0.25, 1, 0.25], scale: [0.75, 1, 0.75] }}
                  transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity, ease: 'easeInOut' }}
                />
              ))}
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Loading dashboard…</span>
            </div>
            <div className="flex gap-2">
              <div className="h-3 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-16 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
            </div>
          </div>
        </div>

        {/* Bonus indicators skeleton — desktop only */}
        <div className="hidden shrink-0 rounded-xl border border-zinc-200/80 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/30 lg:block">
          <div className="mb-3 h-4 w-44 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="space-y-2.5">
            {[52, 40].map((w, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-zinc-200/60 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                <div className="flex-1 space-y-1.5">
                  <div className={`h-3.5 w-${w} animate-pulse rounded bg-zinc-200 dark:bg-zinc-800`} />
                  <div className="h-3 w-80 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                </div>
                <div className="h-6 w-16 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              </div>
            ))}
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
      </motion.div>
    );
  }

  const _welcomeMsg = EMPLOYEE_MESSAGES[Math.floor(Date.now() / 86400000) % EMPLOYEE_MESSAGES.length]!;
  const _rawFirst = email.includes('@')
    ? email.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0]!
    : 'there';
  const _greeting = _rawFirst.charAt(0).toUpperCase() + _rawFirst.slice(1);

  return (
    <div className="box-border flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 px-3 py-2 [@media(max-height:900px)]:gap-1.5 sm:px-4 sm:py-3 md:px-5 lg:gap-3 lg:py-3 dark:bg-none dark:bg-[#0d1117]">
      {/* ── Hero intro card ── */}
      <header className="relative shrink-0 overflow-hidden rounded-2xl border border-orange-200/80 bg-gradient-to-br from-orange-500 via-amber-500 to-zinc-900 px-5 py-6 text-white shadow-lg shadow-orange-500/20 dark:border-orange-900/50 dark:from-orange-600 dark:via-amber-800 dark:to-black sm:px-7">
        <style>{`
          @keyframes floatSparkle {
            0%   { transform: translateY(0)      scale(1);    opacity: 0; }
            12%  {                                             opacity: 0.5; }
            80%  { transform: translateY(-110px) scale(0.65); opacity: 0.2; }
            100% { transform: translateY(-130px) scale(0.45); opacity: 0; }
          }
        `}</style>
        {SPARKLES_FLOAT.map((s, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              position: 'absolute',
              bottom: '6px',
              left: s.left,
              fontSize: s.size,
              color: 'rgba(255,255,255,0.70)',
              animation: `floatSparkle ${s.dur} ${s.delay} infinite ease-in`,
              pointerEvents: 'none',
              userSelect: 'none',
              lineHeight: 1,
            }}
          >
            ✦
          </span>
        ))}
        {/* glow blobs */}
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-10 left-6 h-28 w-28 rounded-full bg-amber-300/20 blur-2xl" aria-hidden />

        <div className="relative flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-orange-100/90">
            <Sparkles className="h-3 w-3 shrink-0" />
            Employee dashboard
          </div>
          <h1 className="text-balance text-xl font-bold tracking-tight sm:text-2xl">
            {_welcomeMsg.heading(_greeting)}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-orange-100/80">
            {_welcomeMsg.body}
          </p>
        </div>
      </header>

      {/* Gift Tracker — 6-month milestone shipping form notification.
          Externally controlled so the header bell icon can also open the modal. */}
      <GiftShippingCard
        personalEmail={profileForShipping.personalEmail ?? email}
        startDate={employeeStartDate}
        prefill={{
          name: profileForShipping.name,
          workEmail: profileForShipping.workEmail,
          department: profileForShipping.department,
        }}
        dialogOpen={giftDialogOpen}
        onDialogOpenChange={setGiftDialogOpen}
        onStateChange={setGiftState}
      />

      {/* Header — editorial: eyebrow + display title + source picker; lg actions on the right */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-zinc-200/70 pb-2.5 dark:border-zinc-800/70 lg:flex-row lg:items-end lg:justify-between lg:gap-6 lg:pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-500/70">
                Employee
                {pabMonthRange ? (
                  <>
                    <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">/</span>
                    {pabMonthRange.monthName} {pabMonthRange.year}
                  </>
                ) : null}
              </p>
              <h1 className="mt-1 font-mono text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl lg:text-[2.25rem] lg:leading-none dark:text-white">
                Overview
              </h1>
              <p className="mt-1.5 hidden text-xs leading-snug text-zinc-500 lg:block dark:text-zinc-500">
                Hours, pay, and Perfect Attendance — figures are estimates until payroll confirms them.
              </p>
            </div>
            {/* Mobile-only action buttons */}
            <div className="flex shrink-0 items-center gap-1.5 lg:hidden">
              {giftState.status !== 'none' && (
                <GiftBellButton
                  state={giftState}
                  onClick={() => setGiftDialogOpen(true)}
                />
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-full border-zinc-200 bg-white/90 text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300"
                title="PAB rules, bonuses & pay snapshot"
                aria-label="Open PAB and bonus help"
                onClick={() => setMobileHelpOpen(true)}
              >
                <CircleHelp className="size-4.5" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-full border-zinc-200 bg-white/90 dark:border-zinc-800 dark:bg-zinc-900/70"
                disabled={refreshing}
                onClick={() => void refreshDashboard()}
                aria-label="Refresh dashboard data"
              >
                {refreshing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-4" aria-hidden />
                )}
              </Button>
            </div>
          </div>
          {/* Source file selector — minimal, inline */}
          {sourceFiles.length > 0 && (
            <div className="mt-3 flex max-w-xl items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Source
              </span>
              <div className="relative min-w-0 flex-1">
                <select
                  value={selectedFile ?? ''}
                  onChange={(e) => {
                    setSelectedFile(e.target.value || null);
                    setManualFileSelect(true);
                  }}
                  className="h-7 w-full appearance-none rounded-md border border-zinc-200/90 bg-white pl-2.5 pr-7 font-mono text-[11px] text-zinc-700 shadow-sm transition-colors hover:border-zinc-300 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:focus:border-orange-500/60"
                >
                  <option value="__all__">All Time · combined</option>
                  {sourceFiles.map((file, i) => (
                    <option key={file} value={file}>
                      {file}{i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
              </div>
              {fileLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-orange-500" />}
            </div>
          )}
        </div>
        {/* Right column — actions only (status badges now live in the data ribbon) */}
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          {giftState.status !== 'none' && (
            <GiftBellButton state={giftState} onClick={() => setGiftDialogOpen(true)} />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700"
            disabled={refreshing}
            onClick={() => void refreshDashboard()}
            aria-label="Refresh dashboard data"
          >
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-zinc-200 bg-white/70 text-xs font-medium text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-zinc-700"
            title="PAB rules, bonuses & pay snapshot — click to read"
            aria-label="Open PAB and bonus help"
            onClick={() => setMobileHelpOpen(true)}
          >
            <CircleHelp className="size-3.5" aria-hidden />
            Details
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-y-contain lg:gap-3 [scrollbar-gutter:stable]">
      {dataError && (
        <Card className="shrink-0 border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-950/20">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-800 dark:text-red-300">{dataError}</p>
          </CardContent>
        </Card>
      )}

      {!row && !dataError && !fileLoading ? (
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
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:gap-4">
          {/* Hero — editorial pay statement: typographic on the left, divided list on the right */}
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="grid shrink-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] lg:gap-8"
          >
            {/* Hero pay block */}
            <div className="relative min-w-0 border-l-2 border-emerald-500/80 pl-4 lg:pl-5 dark:border-emerald-400/70">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                Estimated Take-Home
              </p>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {totalPay != null ? (
                  <HiddenValue
                    revealed={payValuesRevealed}
                    onToggleRevealed={setPayValuesRevealed}
                    iconClass="h-5 w-5"
                    showLabel="Reveal pay amounts"
                    hideLabel="Hide pay amounts"
                    className="flex-wrap items-baseline gap-x-3 gap-y-1"
                    mask={
                      <>
                        <span className="break-words font-mono text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-400 sm:text-5xl lg:text-[3.5rem] xl:text-6xl dark:text-zinc-600">
                          ₱•••••••••
                        </span>
                        <span className="font-mono text-xs text-zinc-400 sm:text-sm dark:text-zinc-600">
                          ≈ $••••• USD
                        </span>
                      </>
                    }
                  >
                    <span
                      className="break-words font-mono text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-900 sm:text-5xl lg:text-[3.5rem] xl:text-6xl dark:text-white"
                      title={formatPHP(totalPay + pabBonusAmount + technologyBonusAmount)}
                    >
                      {formatPHP(totalPay + pabBonusAmount + technologyBonusAmount)}
                    </span>
                    <span className="font-mono text-xs text-zinc-500 sm:text-sm dark:text-zinc-500">
                      ≈ ${((totalPay + pabBonusAmount + technologyBonusAmount) / usdToPhpRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                    </span>
                  </HiddenValue>
                ) : (
                  <span className="break-words font-mono text-[2.25rem] font-bold tabular-nums leading-none tracking-tight text-zinc-900 sm:text-5xl lg:text-[3.5rem] xl:text-6xl dark:text-white">
                    —
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
                {totalPay != null
                  ? `${isAllTime ? 'All uploads · combined' : 'Selected upload'}${pabMonthRange ? ` · PAB ${pabMonthRange.monthName} ${pabMonthRange.year}` : ''} · FX ${formatPHP(usdToPhpRate)}/USD`
                  : 'Pending rate assignment — your hourly rate has not been set yet.'}
              </p>

              {/* Data ribbon */}
              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-zinc-200/80 pt-4 sm:grid-cols-4 sm:gap-x-6 dark:border-zinc-800/80">
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                    Regular
                  </dt>
                  <dd
                    className="mt-1 break-words font-mono text-base font-medium tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                    title={regularPay != null ? formatPHP(regularPay) : undefined}
                  >
                    {regularPay != null ? (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••••••</span>}
                      >
                        {formatPHP(regularPay)}
                      </HiddenValue>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {regularHours.toFixed(2)}h
                    {regularRate != null ? ` · ${formatPHP(regularRate)}/h` : ''}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                    Overtime
                  </dt>
                  <dd
                    className="mt-1 break-words font-mono text-base font-medium tabular-nums leading-tight text-zinc-900 sm:text-lg dark:text-white"
                    title={otPay != null ? formatPHP(otPay) : undefined}
                  >
                    {otPay != null ? (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••••••</span>}
                      >
                        {formatPHP(otPay)}
                      </HiddenValue>
                    ) : otHours > 0 ? (
                      '—'
                    ) : (
                      <HiddenValue
                        revealed={payValuesRevealed}
                        mask={<span className="text-zinc-400 dark:text-zinc-600">₱••••</span>}
                      >
                        {formatPHP(0)}
                      </HiddenValue>
                    )}
                  </dd>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {otHours > 0
                      ? `${otHours.toFixed(2)}h${otRate != null ? ` · ${formatPHP(otRate)}/h` : ''}`
                      : 'No overtime'}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className={`text-[10px] font-medium uppercase tracking-[0.14em] ${pabBonusAmount > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-zinc-500 dark:text-zinc-500'}`}>
                    PAB Bonus
                  </dt>
                  <dd
                    className={`mt-1 break-words font-mono text-base font-medium tabular-nums leading-tight sm:text-lg ${
                      pabBonusAmount > 0
                        ? 'text-indigo-700 dark:text-indigo-300'
                        : perfectAttendanceBonusStatus === 'pending'
                          ? 'text-indigo-500/80 dark:text-indigo-400/70'
                          : 'text-zinc-400 dark:text-zinc-600'
                    }`}
                  >
                    {perfectAttendanceBonusStatus === 'pending'
                      ? 'Pending'
                      : pabBonusAmount > 0
                        ? `+${formatPHP(pabBonusAmount)}`
                        : formatPHP(0)}
                  </dd>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {perfectAttendanceBonusStatus === 'pending'
                      ? 'Period in progress'
                      : isAllTime
                        ? pabEligibleCount > 0
                          ? `${pabEligibleCount} month${pabEligibleCount !== 1 ? 's' : ''} eligible`
                          : 'Not eligible'
                        : isPAEligible
                          ? 'Eligible this month'
                          : perfectAttendanceBonusStatus === 'unknown'
                            ? 'Pending data'
                            : 'Not eligible'}
                  </p>
                </div>
                <div className="min-w-0">
                  <dt className={`text-[10px] font-medium uppercase tracking-[0.14em] ${technologyBonusAmount > 0 ? 'text-sky-600 dark:text-sky-400' : 'text-zinc-500 dark:text-zinc-500'}`}>
                    Tech Bonus
                  </dt>
                  <dd
                    className={`mt-1 break-words font-mono text-base font-medium tabular-nums leading-tight sm:text-lg ${
                      technologyBonusAmount > 0 ? 'text-sky-700 dark:text-sky-300' : 'text-zinc-400 dark:text-zinc-600'
                    }`}
                  >
                    {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                  </dd>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {isTechnologyBonusActive ? 'Unlocked · week 3' : 'Unlocks week 3'}
                  </p>
                </div>
              </dl>
            </div>

            {/* Status panel — divide-y list, no card chrome */}
            <motion.aside
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-w-0 flex-col divide-y divide-zinc-200/80 rounded-md border border-zinc-200/70 bg-white/50 backdrop-blur-sm dark:divide-zinc-800/80 dark:border-zinc-800/70 dark:bg-zinc-900/30"
            >
              <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                  Hours
                </span>
                <span className="font-mono text-sm font-medium tabular-nums text-zinc-900 dark:text-white">
                  {totalHours.toFixed(2)}<span className="text-zinc-400">h</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                  Reg / OT
                </span>
                <span className="font-mono text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
                  {regularHours.toFixed(1)}<span className="text-zinc-400">h</span>
                  <span className="mx-1 text-zinc-300 dark:text-zinc-700">/</span>
                  {otHours.toFixed(1)}<span className="text-zinc-400">h</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                  Hourly
                </span>
                <span className="font-mono text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
                  {regularRate != null ? formatPHP(regularRate) : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">
                  PAB
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                    perfectAttendanceBonusStatus === 'eligible'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : perfectAttendanceBonusStatus === 'pending'
                        ? 'text-indigo-700 dark:text-indigo-300'
                        : perfectAttendanceBonusStatus === 'not_eligible'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-zinc-500 dark:text-zinc-500'
                  }`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      perfectAttendanceBonusStatus === 'eligible'
                        ? 'bg-emerald-500'
                        : perfectAttendanceBonusStatus === 'pending'
                          ? 'bg-indigo-500 animate-pulse'
                          : perfectAttendanceBonusStatus === 'not_eligible'
                            ? 'bg-amber-500'
                            : 'bg-zinc-400'
                    }`}
                  />
                  {perfectAttendanceBonusStatus === 'eligible'
                    ? 'Eligible'
                    : perfectAttendanceBonusStatus === 'pending'
                      ? 'In progress'
                      : perfectAttendanceBonusStatus === 'not_eligible'
                        ? 'Not met'
                        : 'Unknown'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-sky-600 dark:text-sky-400">
                  Tech
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                    isTechnologyBonusActive
                      ? 'text-sky-700 dark:text-sky-300'
                      : techServiceStatus.state === 'pending'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-zinc-500 dark:text-zinc-500'
                  }`}
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      isTechnologyBonusActive
                        ? 'bg-sky-500'
                        : techServiceStatus.state === 'pending'
                          ? 'bg-amber-500'
                          : 'bg-zinc-400'
                    }`}
                  />
                  {isTechnologyBonusActive
                    ? 'Unlocked'
                    : techServiceStatus.state === 'pending'
                      ? `${techServiceStatus.daysRemaining}d to go`
                      : 'Locked'}
                </span>
              </div>
              {pabMonthRange && (
                <div className="flex items-center justify-between gap-3 bg-amber-50/40 px-3.5 py-2 dark:bg-amber-950/20">
                  <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700/80 dark:text-amber-500/80">
                    Period
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-amber-800/90 dark:text-amber-300/90">
                    {pabMonthRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    <span className="mx-1 text-amber-400">–</span>
                    {pabMonthRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              )}
            </motion.aside>
          </motion.section>

          {/* Daily Hours + PAB Calendar — fills remaining vertical space; side-by-side on lg+, stacked below */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-3 xl:gap-4">
            {/* Daily Hours Bar Chart — always visible. On mobile we grow the
                card so all 7 weekday rows fit without an inner scroll. */}
            <Card
              size="sm"
              className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border-orange-100/80 bg-gradient-to-br from-white to-blue-50/20 shadow-md ring-1 ring-orange-500/5 dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/5 dark:ring-blue-950/30 sm:min-h-[20rem] lg:min-h-0 lg:rounded-xl lg:shadow-sm lg:ring-0"
            >
              <CardHeader className="shrink-0 px-4 pb-2 pt-3 max-lg:px-4 max-lg:pt-3.5 lg:px-3 lg:pb-1.5 lg:pt-2">
                <CardTitle className="text-sm font-semibold tracking-tight text-zinc-700 lg:text-xs lg:font-medium lg:tracking-normal dark:text-zinc-300 dark:lg:text-zinc-400">
                  Daily Hours Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-0 max-lg:px-4 max-lg:pb-4 lg:px-3 lg:pb-3">
                {dailyHours.length === 0 ? (
                  <div className="flex flex-1 items-center gap-2 py-8 text-sm text-zinc-500">
                    <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                    Daily breakdown not available
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-0">
                    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overflow-x-clip [-webkit-overflow-scrolling:touch] pr-0.5 sm:space-y-2 lg:space-y-1.5 lg:pr-2">
                    {dailyHours.map((day) => {
                      const hours = day.seconds / 3600;
                      const pct = maxBarSeconds > 0 ? (day.seconds / maxBarSeconds) * 100 : 0;
                      const meetsPA = day.weekday && day.seconds >= 7 * 3600;
                      const belowPA = day.weekday && day.seconds > 0 && day.seconds < 7 * 3600;
                      const showHoursInBar = pct >= 18 && hours > 0.5;
                      return (
                        <div
                          key={day.col}
                          className="flex min-w-0 items-center gap-2 sm:gap-2.5 lg:gap-2"
                        >
                          <span
                            className={`w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums leading-none sm:w-[2.5rem] sm:text-xs lg:w-10 lg:text-xs lg:font-medium ${
                              day.weekday
                                ? 'text-zinc-800 dark:text-zinc-200'
                                : 'text-zinc-400 dark:text-zinc-600'
                            }`}
                          >
                            {day.label}
                          </span>
                          <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800/60 sm:h-8 sm:rounded-lg lg:h-6 lg:rounded-md">
                            <div
                              className={`absolute inset-y-0 left-0 rounded-lg transition-all duration-500 lg:rounded-md ${
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
                            {showHoursInBar ? (
                              <span className="pointer-events-none absolute inset-y-0 left-2 flex max-w-[calc(100%-0.5rem)] items-center truncate text-xs font-semibold text-white drop-shadow-md lg:left-2 lg:text-[11px] lg:font-medium">
                                {`${hours.toFixed(1)}h`}
                              </span>
                            ) : null}
                          </div>
                          <span className="w-[3.5rem] shrink-0 text-right font-mono text-[11px] font-medium tabular-nums text-zinc-600 sm:w-[4.25rem] sm:text-xs lg:w-14 lg:text-[10px] lg:font-normal dark:text-zinc-400">
                            {secondsToDisplay(day.seconds)}
                          </span>
                        </div>
                      );
                    })}
                    </div>
                    <div className="mt-4 grid shrink-0 grid-cols-2 gap-x-4 gap-y-2.5 border-t border-zinc-200/90 pt-3 text-[10px] leading-snug text-zinc-600 dark:border-zinc-800 dark:text-zinc-500 sm:flex sm:flex-wrap sm:justify-center sm:gap-x-5 sm:gap-y-1 sm:text-[10px] lg:mt-2 lg:justify-start lg:gap-x-3 lg:pt-2 lg:text-[9px] dark:lg:text-zinc-600">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>≥ 7h (PA)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>&lt; 7h</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600 lg:h-1.5 lg:w-1.5" />{' '}
                        <span>Weekend</span>
                      </span>
                      <span className="flex col-span-2 items-center justify-center gap-1.5 sm:col-span-1 lg:col-span-1 lg:justify-start">
                        <span className="inline-block h-1.5 w-4 shrink-0 rounded-sm bg-red-400/60 lg:h-1 lg:w-3" />{' '}
                        <span>7h threshold</span>
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* PAB Calendar — beside Daily Hours on lg+, stacked on mobile.
                Bumped min-h on small screens so the full PAB month fits without
                a tight inner scroll. */}
            <Card
              size="sm"
              className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-md ring-1 ring-indigo-500/5 dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/5 dark:ring-indigo-950/30 sm:min-h-[20rem] lg:min-h-0 lg:rounded-xl lg:shadow-sm lg:ring-0"
            >
              <CardHeader className="shrink-0 pb-2 pt-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    PAB Calendar
                  </CardTitle>
                  <button
                    type="button"
                    onClick={() => void refreshDashboard()}
                    disabled={refreshing}
                    aria-label="Refresh PAB calendar"
                    title="Refresh PAB calendar"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-indigo-200 bg-white text-indigo-600 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
                  >
                    {refreshing ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="size-3" aria-hidden />
                    )}
                  </button>
                </div>
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
                {pabMergeLoading ? (
                  /* -------- Skeleton: only while merged Hubstaff loads (not file picker reloads) -------- */
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
                            const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                            const dispute = disputesByDate.get(dayIso);
                            const nowMid = new Date();
                            const todayMid = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate());
                            const cellMid = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
                            const isFutureOrToday = cellMid.getTime() >= todayMid.getTime();
                            const canDispute = day.hasData && !day.passes && !dispute && !isFutureOrToday;
                            const cellClickable = canDispute || !!dispute;

                            // Effective pass: either the day hit 7h on its own, OR an approved
                            // dispute brought it into the 4–7h "forgivable" zone. An approved
                            // dispute below 4h does NOT pass — the day still counts as a PAB fail.
                            const forgiven =
                              !!dispute &&
                              disputeGrantsPabForgiveness(dispute) &&
                              !day.passes &&
                              (isOrphanageStyleReason(dispute.reason) || day.seconds >= 4 * 3600);
                            const effectivelyPasses = day.passes || forgiven;

                            // Future / today with no data → neutral; pending dispute → amber;
                            // otherwise colour strictly by whether PAB is effectively passing.
                            let cellBorder: string;
                            if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                              cellBorder =
                                'border-amber-400 bg-amber-50 ring-1 ring-amber-400/35 dark:border-amber-600/60 dark:bg-amber-950/35';
                            } else if (effectivelyPasses) {
                              cellBorder = forgiven
                                ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-400/40 dark:border-emerald-600/60 dark:bg-emerald-950/30'
                                : 'border-emerald-300 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/30';
                            } else if (isFutureOrToday && !day.hasData) {
                              cellBorder =
                                'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
                            } else {
                              cellBorder =
                                'border-red-300 bg-red-50 dark:border-red-700/70 dark:bg-red-950/40';
                            }

                            return (
                              <div
                                key={di}
                                className={`flex h-10 flex-col items-center justify-center gap-px rounded-md border transition-all duration-300 ${cellBorder} ${cellClickable ? 'cursor-pointer hover:ring-2 hover:ring-orange-300/50' : ''}`}
                                title={`${day.dayLabel} ${day.dateStr}: ${secondsToDisplay(day.seconds)}${dispute ? ` (${dispute.status})` : day.passes ? ' ✓' : isFutureOrToday ? ' — not yet' : day.hasData ? ' ✗ needs 7h — click to dispute' : ' — no data'}`}
                                style={{ animation: `pab-cell-in 0.3s ease-out ${wi * 80 + di * 40}ms both` }}
                                onClick={cellClickable ? () => {
                                  onNavigateToDisputes?.({ date: dayIso, seconds: day.seconds });
                                } : undefined}
                              >
                                <span className="text-[7px] leading-none text-zinc-400 dark:text-zinc-500">
                                  {day.dateStr}
                                </span>
                                <span
                                  className={`font-mono text-[10px] font-bold leading-none ${
                                    dispute != null && disputeIsAwaitingResolution(dispute)
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : effectivelyPasses
                                        ? 'text-emerald-700 dark:text-emerald-400'
                                        : isFutureOrToday && !day.hasData
                                          ? 'text-zinc-400 dark:text-zinc-500'
                                          : 'text-red-600 dark:text-red-400'
                                  }`}
                                >
                                  {day.hasData ? `${hours.toFixed(1)}` : '—'}
                                </span>
                                {dispute != null && disputeIsAwaitingResolution(dispute) ? (
                                  <Clock className="h-2 w-2 text-amber-500" />
                                ) : effectivelyPasses ? (
                                  <CheckCircle2 className="h-2 w-2 text-emerald-500" />
                                ) : isFutureOrToday && !day.hasData ? null : day.hasData ? (
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
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Forgiven
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

          </div>
        </div>
      )}
      </div>

      <Dialog open={mobileHelpOpen} onOpenChange={setMobileHelpOpen}>
        <DialogContent
          className="max-h-[min(90vh,760px)] w-[calc(100vw-1.25rem)] max-w-md gap-0 overflow-y-auto border-orange-100/70 bg-gradient-to-br from-white via-orange-50/35 to-blue-50/25 p-0 sm:max-w-md dark:border-blue-950/50 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628]"
          showCloseButton
        >
          <DialogHeader className="border-b border-orange-100/60 px-4 py-3 dark:border-blue-950/50">
            <DialogTitle className="text-base text-zinc-900 dark:text-white">PAB &amp; bonuses</DialogTitle>
            <DialogDescription className="text-left text-xs text-zinc-600 dark:text-zinc-400">
              Rules and your status. On mobile, your dashboard shows the hours and PAB calendar charts first — open this
              anytime for eligibility, tech bonus, and pay snapshot.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-4 py-4">
            <section className="rounded-xl border border-zinc-200/80 bg-white/90 p-3 text-[11px] leading-relaxed text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
              <p className="font-semibold text-zinc-800 dark:text-zinc-200">Perfect Attendance (PAB)</p>
              <p className="mt-1.5">
                PAB uses every Mon–Fri in the PAB period (merged Hubstaff uploads); each weekday must be ≥ 7 hours. If the
                month doesn&apos;t start on a Monday, the first week is skipped and counting starts on the{' '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">second Monday</span> (e.g. March 2026: Mar
                9–Apr 3). Figures are estimates until payroll confirms them.
              </p>
              <p className="mt-3 font-semibold text-zinc-800 dark:text-zinc-200">Technology bonus</p>
              <p className="mt-1">
                {formatPHP(TECHNOLOGY_BONUS_PHP).replace(/\.\d{2}$/, '')} after 30 days of service, typically paid on the
                3rd paycheck of the month.
              </p>
            </section>

            {renderPabBonusStatusRows()}

            {!row && (
              <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
                When Hubstaff data is available, your personal eligibility appears here.
              </p>
            )}

            {row && (
              <section className="space-y-2 rounded-xl border border-orange-100/70 bg-white/80 p-3 dark:border-blue-950/50 dark:bg-blue-950/20">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
                  Pay snapshot
                </p>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Total hours</span>
                    <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{totalHours.toFixed(2)}h</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Regular pay</span>
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">
                      {regularPay != null ? formatPHP(regularPay) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">OT pay</span>
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">
                      {otPay != null ? formatPHP(otPay) : otHours > 0 ? '—' : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">PAB</span>
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">
                      {perfectAttendanceBonusStatus === 'pending'
                        ? '—'
                        : pabBonusAmount > 0
                          ? `+${formatPHP(pabBonusAmount)}`
                          : formatPHP(0)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Tech bonus</span>
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">
                      {technologyBonusAmount > 0 ? `+${formatPHP(technologyBonusAmount)}` : formatPHP(0)}
                    </span>
                  </div>
                  <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex justify-between gap-2">
                    <span className="font-medium text-zinc-900 dark:text-white">Total</span>
                    <span className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-400">
                      {totalPay != null
                        ? formatPHP(totalPay + pabBonusAmount + technologyBonusAmount)
                        : '—'}
                    </span>
                  </div>
                  {totalPay != null && (
                    <p className="text-right font-mono text-[10px] text-blue-600 dark:text-blue-400">
                      ≈{' '}
                      {((totalPay + pabBonusAmount + technologyBonusAmount) / usdToPhpRate).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      USD
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/**
 * Bell-style icon button shown in the dashboard header. Renders a tiny pink
 * (or amber, when rejected) badge dot whenever an action is pending. Click
 * opens the gift-shipping modal directly.
 */
function GiftBellButton({
  state,
  onClick,
}: {
  state: GiftShippingState;
  onClick: () => void;
}) {
  const tooltip = (() => {
    if (state.status === 'approved')
      return `${state.milestoneMonths}-month gift — approved`;
    if (state.status === 'rejected')
      return `${state.milestoneMonths}-month gift — needs revisions`;
    if (state.status === 'pending')
      return `${state.milestoneMonths}-month gift — pending review`;
    if (state.status === 'unsubmitted')
      return `${state.milestoneMonths}-month gift — confirm shipping details`;
    return 'Gift shipping';
  })();
  const badgeTone = state.status === 'rejected' ? 'bg-amber-500' : 'bg-pink-500';
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white/90 text-pink-600 shadow-sm transition hover:border-pink-300 hover:bg-pink-50 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-pink-300 dark:hover:border-pink-900/60 dark:hover:bg-pink-950/30"
    >
      <Gift className="size-4.5" aria-hidden />
      {state.needsAction && (
        <>
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900',
              badgeTone,
            )}
            aria-hidden
          />
          {/* Soft ping ring to draw the eye when action is needed. */}
          <span
            className={cn(
              'pointer-events-none absolute right-1 top-1 inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-75',
              badgeTone,
            )}
            aria-hidden
          />
        </>
      )}
    </button>
  );
}
