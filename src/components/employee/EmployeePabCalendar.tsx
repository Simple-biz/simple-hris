'use client';

/**
 * Self-contained PAB calendar grid for the employee.
 *
 * Mirrors the visual + interaction model of the calendar inside `EmployeeDashboard`,
 * but does its own data fetching so it can drop into other surfaces (e.g. the
 * disputes page) without dragging in the dashboard's file-picker state.
 *
 * Click model (forwarded to `onCellClick`):
 *   - Past sub-7h days, with or without an existing dispute → fires.
 *   - Today / future days → ignored.
 *   - Days that meet 7h on their own → ignored (nothing to dispute).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Hourglass, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { normEmail } from '@/lib/email/norm-email';
import {
  buildPabCalendarWeeks,
  columnsAreAllCanonical,
  getCurrentPabMonth,
  getLatestPabMonthFromColumns,
  getPabMonthRange,
  groupDateColumnsByCalendarDay,
  pabDateKey,
  parseColDate,
  resolveCanonicalColumnsToIso,
  type PabCalendarDay,
} from '@/lib/hubstaff/calendar-column-dedupe';
import {
  disputeGrantsPabForgiveness,
  disputeIsAwaitingResolution,
  isOrphanageStyleReason,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';

type EmployeePabCalendarProps = {
  employeeEmail: string;
  /** Cell click — only fires for past days that have a dispute or are sub-7h with hours data. */
  onCellClick?: (payload: { date: string; seconds: number; dispute: PabDayDisputeRow | null }) => void;
  /** Bumping this prop forces a re-fetch of disputes (e.g. after a successful submit). */
  refreshKey?: number;
  className?: string;
  /**
   * When true (default), only weeks up through today (or the latest day with hours)
   * are shown — keeps the employee's view focused on what has actually happened.
   * Pass `false` from admin/audit surfaces to render every week of the PAB period.
   */
  trimToElapsedWeeks?: boolean;
  /**
   * Force the calendar to display a specific PAB month (year + 0-based month index)
   * instead of inferring from merged columns. Use this when the calendar must
   * stay in sync with an external CSV / period picker.
   */
  pabMonthOverride?: { year: number; month: number } | null;
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

const HUBSTAFF_EMAIL_KEYS = ['Email', 'email', 'Work Email', 'work_email', 'user_email'] as const;

function rowMatchesEmployee(row: Record<string, unknown>, employeeNorms: Set<string>): boolean {
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t) seen.add(t);
  };
  for (const k of HUBSTAFF_EMAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, k)) add(String(row[k]));
  }
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lower.set(k.toLowerCase(), v);
  for (const alias of ['work email', 'personal email', 'work_email', 'personal_email']) {
    const v = lower.get(alias);
    if (v != null) add(String(v));
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

function formatPabCalendarDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function EmployeePabCalendar({
  employeeEmail,
  onCellClick,
  refreshKey = 0,
  className,
  trimToElapsedWeeks = true,
  pabMonthOverride = null,
}: EmployeePabCalendarProps) {
  const [aliasEmails, setAliasEmails] = useState<string[]>([]);
  const [mergedRow, setMergedRow] = useState<Record<string, unknown> | null>(null);
  const [mergedColumns, setMergedColumns] = useState<string[]>([]);
  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>([]);
  const [rateHistory, setRateHistory] = useState<Array<{
    effectiveFrom: Date;
    regularRate: number | null;
    otRate: number | null;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const email = useMemo(
    () => normEmail(employeeEmail) ?? employeeEmail.toLowerCase(),
    [employeeEmail],
  );

  // ── Aliases (work + personal email) ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employees?email=${encodeURIComponent(email)}&_=${Date.now()}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { row?: Record<string, unknown> | null };
        if (cancelled) return;
        const me = json.row ?? null;
        const aliases = new Set<string>([email]);
        if (me) {
          const we = normEmail(String(me.work_email ?? ''));
          const pe = normEmail(String(me.personal_email ?? ''));
          if (we) aliases.add(we);
          if (pe) aliases.add(pe);
        }
        setAliasEmails([...aliases]);
      } catch {
        if (!cancelled) setAliasEmails([email]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  // ── Rate history (drives per-day rate badges + tooltips) ────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/employee-rate-history?email=${encodeURIComponent(email)}&_=${Date.now()}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          rows?: Array<{ regular_rate: string | null; ot_rate: string | null; effective_from: string }>;
        };
        if (cancelled) return;
        const parsed: typeof rateHistory = [];
        for (const r of json.rows ?? []) {
          const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.effective_from ?? '');
          if (!m) continue;
          const num = (s: string | null) => {
            if (s == null) return null;
            const v = parseFloat(String(s).replace(/,/g, ''));
            return Number.isFinite(v) ? v : null;
          };
          parsed.push({
            effectiveFrom: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
            regularRate: num(r.regular_rate),
            otRate: num(r.ot_rate),
          });
        }
        parsed.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        setRateHistory(parsed);
      } catch {
        if (!cancelled) setRateHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [email]);

  const resolveRateForDate = useCallback(
    (date: Date): { reg: number | null; ot: number | null; isFlipDay: boolean } => {
      const t = date.getTime();
      for (let i = 0; i < rateHistory.length; i += 1) {
        const row = rateHistory[i];
        if (row.effectiveFrom.getTime() <= t) {
          const isFlipDay = row.effectiveFrom.getTime() === t && i < rateHistory.length - 1;
          return { reg: row.regularRate, ot: row.otRate, isFlipDay };
        }
      }
      return { reg: null, ot: null, isFlipDay: false };
    },
    [rateHistory],
  );

  const formatRatePHP = useCallback((n: number | null): string => {
    if (n == null) return '—';
    return '₱' + n.toLocaleString('en-PH', { maximumFractionDigits: 0 });
  }, []);

  // ── Source files → merged row + columns ─────────────────────────────────
  const fetchMerged = useCallback(async () => {
    if (aliasEmails.length === 0) return;
    const filesRes = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, {
      cache: 'no-store',
    });
    const filesJson = (await filesRes.json()) as { files?: string[] };
    const files = filesJson.files ?? [];
    if (files.length === 0) {
      setMergedRow(null);
      setMergedColumns([]);
      return;
    }

    const employeeNorms = new Set(aliasEmails);
    const responses = await Promise.all(
      files.map((file) =>
        fetch(`/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`, {
          cache: 'no-store',
        })
          .then(async (res) => {
            const json = (await res.json()) as {
              columns?: string[] | null;
              rows?: Record<string, unknown>[] | null;
            };
            return { file, json };
          })
          .catch(() => ({ file, json: { columns: null, rows: null } })),
      ),
    );

    const allCols = new Set<string>();
    let merged: Record<string, unknown> = {};
    let found = false;

    for (const { file, json } of responses) {
      if (!json.columns || !json.rows) continue;
      const myRow = json.rows.find((r) => rowMatchesEmployee(r, employeeNorms));
      if (!myRow) continue;
      found = true;
      const needsResolve = columnsAreAllCanonical(json.columns);
      const resolved = needsResolve ? resolveCanonicalColumnsToIso(myRow, file) : myRow;
      for (const col of needsResolve ? Object.keys(resolved) : json.columns) allCols.add(col);
      merged = { ...merged, ...resolved };
    }
    setMergedColumns([...allCols]);
    setMergedRow(found ? merged : null);
  }, [aliasEmails]);

  // ── Disputes ────────────────────────────────────────────────────────────
  const fetchDisputes = useCallback(async () => {
    try {
      const res = await fetch(`/api/pab-disputes?email=${encodeURIComponent(email)}&limit=200`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as { rows?: PabDayDisputeRow[] };
      setDisputes(json.rows ?? []);
    } catch {
      setDisputes([]);
    }
  }, [email]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await Promise.all([fetchMerged(), fetchDisputes()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMerged, fetchDisputes]);

  // Re-fetch disputes only when refreshKey bumps (e.g. after submit)
  useEffect(() => {
    if (refreshKey === 0) return;
    void fetchDisputes();
  }, [refreshKey, fetchDisputes]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchMerged(), fetchDisputes()]);
    } finally {
      setRefreshing(false);
    }
  }, [fetchMerged, fetchDisputes]);

  // ── Compute PAB month range — override > merged columns > current month ─
  const pabMonthRange = useMemo(() => {
    const cols = mergedColumns;
    const pabMonth: { year: number; month: number } =
      pabMonthOverride
      ?? (cols.length > 0 ? getLatestPabMonthFromColumns(cols) : null)
      ?? getCurrentPabMonth();
    const { start, end } = getPabMonthRange(pabMonth.year, pabMonth.month);
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [mergedColumns, pabMonthOverride]);

  // ── Build date → ISO map of disputes for quick lookup ───────────────────
  const disputesByDate = useMemo(() => {
    const map = new Map<string, PabDayDisputeRow>();
    for (const d of disputes) map.set(d.dispute_date, d);
    return map;
  }, [disputes]);

  // ── Build calendar weeks from merged row + month range ──────────────────
  const pabCalendar = useMemo<PabCalendarDay[][] | null>(() => {
    if (!pabMonthRange) return null;
    const cols = mergedColumns;
    if (!mergedRow || !cols.length) {
      const empty = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, new Map());
      return empty.length > 0 ? empty.slice(0, 1) : null;
    }
    const hoursByDateKey = new Map<string, number>();
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
        const raw = getFieldFromRow(mergedRow, [c])
          ?? (Object.prototype.hasOwnProperty.call(mergedRow, c) ? mergedRow[c] : undefined);
        maxS = Math.max(maxS, parseHMS(raw));
      }
      const key = pabDateKey(d);
      hoursByDateKey.set(key, Math.max(hoursByDateKey.get(key) ?? 0, maxS));
    }
    // Approved dispute override_hours = SET semantics
    for (const d of disputes) {
      if (!disputeGrantsPabForgiveness(d)) continue;
      const set = d.override_hours;
      if (set == null || set < 0) continue;
      const [y, m, day] = d.dispute_date.split('-').map(Number);
      if (!y || !m || !day) continue;
      const key = `${y}-${m}-${day}`;
      hoursByDateKey.set(key, set * 3600);
    }
    const weeks = buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, hoursByDateKey);

    if (!trimToElapsedWeeks) return weeks;

    // Trim to elapsed weeks (employee-facing view)
    let latest: Date | null = null;
    for (const [k, secs] of hoursByDateKey) {
      if (secs <= 0) continue;
      const [y, m, d] = k.split('-').map(Number);
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
  }, [mergedRow, mergedColumns, pabMonthRange, disputes, trimToElapsedWeeks]);

  const allPabDays = pabCalendar?.flat() ?? [];
  const isPAEligible = allPabDays.length > 0 && allPabDays.every((d) => d.passes);
  // Verdict: in-progress while today is on/before the period end.
  const verdict: 'eligible' | 'ineligible' | 'in_progress' = useMemo(() => {
    if (!pabMonthRange) return 'ineligible';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(pabMonthRange.end);
    end.setHours(0, 0, 0, 0);
    if (today.getTime() <= end.getTime()) return 'in_progress';
    return isPAEligible ? 'eligible' : 'ineligible';
  }, [pabMonthRange, isPAEligible]);

  return (
    <Card
      size="sm"
      className={`flex min-h-[8.5rem] flex-col rounded-xl border-indigo-100/80 bg-gradient-to-br from-white to-indigo-50/20 shadow-sm dark:border-indigo-950/60 dark:bg-none dark:from-indigo-950/20 dark:to-indigo-950/5 ${className ?? ''}`}
    >
      <CardHeader className="shrink-0 pb-2 pt-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            PAB Calendar
          </CardTitle>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing || loading}
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
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400">
          <CalendarDays className="h-3 w-3 shrink-0" />
          <span>
            <span className="font-semibold">
              {pabMonthRange.monthName} {pabMonthRange.year}
            </span>
            {' · '}
            {formatPabCalendarDate(pabMonthRange.start)} – {formatPabCalendarDate(pabMonthRange.end)}
          </span>
        </p>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
        {loading ? (
          <div className="flex flex-1 flex-col gap-0">
            <div className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1">
              <div />
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="mx-auto h-2 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              ))}
            </div>
            {Array.from({ length: 5 }, (_, wi) => (
              <div key={wi} className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1">
                <div className="flex items-center justify-end">
                  <div className="h-2 w-3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </div>
                {Array.from({ length: 5 }, (_, di) => (
                  <div
                    key={di}
                    className="h-14 animate-pulse rounded-md border border-zinc-200 bg-zinc-100/60 sm:h-16 dark:border-zinc-800 dark:bg-zinc-900/30"
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
                >
                  <div className="flex items-center justify-end text-[8px] font-medium text-zinc-400 dark:text-zinc-500">
                    {wi + 1}
                  </div>
                  {Array.from({ length: 5 }, (_, di) => {
                    const day: PabCalendarDay | undefined = week.find(
                      (d) => d.date.getDay() === di + 1,
                    );
                    if (!day) {
                      return (
                        <div
                          key={di}
                          className="flex h-14 items-center justify-center rounded-md border border-dashed border-zinc-200 bg-zinc-50/50 sm:h-16 dark:border-zinc-800 dark:bg-zinc-900/20"
                        >
                          <span className="text-xs text-zinc-300 tabular-nums dark:text-zinc-700">—</span>
                        </div>
                      );
                    }
                    const hours = day.seconds / 3600;
                    const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                    const dispute = disputesByDate.get(dayIso);
                    const nowMid = new Date();
                    const todayMid = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate());
                    const cellMid = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
                    const isToday = cellMid.getTime() === todayMid.getTime();
                    const isFutureOrToday = cellMid.getTime() >= todayMid.getTime();
                    // Week is "current" if it contains today's date
                    const isCurrentWeek = week.some((d) => {
                      const dm = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate());
                      return dm.getTime() === todayMid.getTime();
                    });
                    // In the current week, days with no meaningful data aren't red yet
                    const noMeaningfulData = !day.hasData || day.seconds === 0;
                    const stillInProgress = isCurrentWeek && noMeaningfulData && !isFutureOrToday;

                    const canDispute = day.hasData && !day.passes && !dispute && !isFutureOrToday && !isCurrentWeek;
                    const cellClickable = canDispute || !!dispute;

                    const forgiven =
                      !!dispute &&
                      disputeGrantsPabForgiveness(dispute) &&
                      !day.passes &&
                      (isOrphanageStyleReason(dispute.reason) || day.seconds >= 4 * 3600);
                    const effectivelyPasses = day.passes || forgiven;

                    let cellBorder: string;
                    if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                      cellBorder =
                        'border-amber-300 bg-amber-50 dark:border-amber-700/70 dark:bg-amber-950/40';
                    } else if (effectivelyPasses) {
                      cellBorder = isCurrentWeek
                        ? 'border-blue-300 bg-blue-50 dark:border-blue-700/70 dark:bg-blue-950/40'
                        : 'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
                    } else if (isToday) {
                      cellBorder =
                        'border-orange-300 bg-white dark:border-orange-700/60 dark:bg-zinc-900/40';
                    } else if (stillInProgress) {
                      cellBorder =
                        'border-orange-800/60 bg-orange-950/30 dark:border-orange-800/50 dark:bg-orange-950/20';
                    } else if (isFutureOrToday || !day.hasData) {
                      cellBorder =
                        'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
                    } else {
                      cellBorder =
                        'border-red-300 bg-red-50 dark:border-red-700/70 dark:bg-red-950/40';
                    }

                    const dayRate = resolveRateForDate(day.date);
                    // Show the rate badge whenever this day actually has data
                    // (faint gray), OR when this is the day a rate change took
                    // effect (always — emerald-ringed, even on today/empty
                    // cells, so a brand-new rate is immediately visible).
                    const rateBadge =
                      dayRate.reg != null && (day.hasData || dayRate.isFlipDay)
                        ? formatRatePHP(dayRate.reg)
                        : null;
                    const rateTooltip = dayRate.reg != null || dayRate.ot != null
                      ? ` • Rate: ${formatRatePHP(dayRate.reg)} / OT ${formatRatePHP(dayRate.ot)}${dayRate.isFlipDay ? ' (new today)' : ''}`
                      : '';

                    return (
                      <div
                        key={di}
                        className={`relative flex h-14 flex-col overflow-hidden rounded-md border transition-all duration-200 sm:h-16 ${cellBorder} ${cellClickable ? 'cursor-pointer hover:ring-2 hover:ring-orange-300/50' : ''}`}
                        title={`${day.dayLabel} ${day.dateStr}: ${secondsToDisplay(day.seconds)}${dispute ? ` (${dispute.status})` : day.passes ? ' ✓' : isToday ? ' — in progress' : isFutureOrToday ? ' — not yet' : day.hasData ? ' ✗ needs 7h — click to dispute' : ' — no data'}${rateTooltip}`}
                        onClick={
                          cellClickable
                            ? () =>
                                onCellClick?.({
                                  date: dayIso,
                                  seconds: day.seconds,
                                  dispute: dispute ?? null,
                                })
                            : undefined
                        }
                      >
                        <span className="pointer-events-none absolute left-1 top-0.5 max-w-[calc(100%-0.5rem)] truncate text-[7px] font-medium leading-none tracking-tight text-zinc-400 dark:text-zinc-500">
                          {day.dateStr}
                        </span>
                        {/* Today pulse indicator */}
                        {isToday && (
                          <span className="absolute right-1 top-1 flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
                          </span>
                        )}
                        <div className="flex flex-1 flex-col items-center justify-center px-0.5 pb-0.5 pt-3.5">
                          {isToday ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Hourglass
                                className="h-3.5 w-3.5 text-orange-400 dark:text-orange-300 sm:h-4 sm:w-4"
                                style={{ animation: 'hourglass-flip 2s ease-in-out infinite' }}
                              />
                              <span className="text-[8px] font-semibold uppercase tracking-wider text-orange-400 dark:text-orange-300">
                                In Progress
                              </span>
                            </div>
                          ) : (
                            <span
                              className={`text-center text-lg font-bold tabular-nums leading-none tracking-tight sm:text-xl ${
                                dispute != null && disputeIsAwaitingResolution(dispute)
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : effectivelyPasses
                                    ? (isCurrentWeek ? 'text-blue-700 dark:text-blue-400' : 'text-emerald-700 dark:text-emerald-400')
                                    : isToday || isFutureOrToday || stillInProgress
                                      ? 'text-zinc-400 dark:text-zinc-500'
                                      : !day.hasData
                                        ? 'text-zinc-400 dark:text-zinc-500'
                                        : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                            </span>
                          )}
                        </div>
                        {/* Per-day rate badge — surfaces the rate-history row in
                            effect on this date. Flip-day (effective_from = this
                            day) gets a green ring so a mid-cycle rate change is
                            visible at a glance. */}
                        {rateBadge && (
                          <span
                            className={`pointer-events-none absolute bottom-0.5 right-1 max-w-[calc(100%-0.5rem)] truncate rounded-sm px-1 text-[8px] font-semibold leading-tight tabular-nums ${
                              dayRate.isFlipDay
                                ? 'bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'
                                : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                          >
                            {rateBadge}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Legend */}
            <div className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 sm:h-2 sm:w-2" /> &lt; 7h
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Forgiven
              </span>
              <span className="ml-auto font-medium">
                {verdict === 'in_progress' ? (
                  <span className="text-amber-600 dark:text-amber-400">⏳ In Progress</span>
                ) : verdict === 'eligible' ? (
                  <span className="text-emerald-600 dark:text-emerald-400">PAB Eligible</span>
                ) : (
                  <span className="text-red-500 dark:text-red-400">PAB Not Met</span>
                )}
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
  );
}
