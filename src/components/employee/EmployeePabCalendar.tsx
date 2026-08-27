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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Hourglass, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { normEmail } from '@/lib/email/norm-email';
import {
  buildPabCalendarWeeks,
  columnsAreAllCanonical,
  computeHslPabWeekInfo,
  getCurrentPabMonth,
  groupDateColumnsByCalendarDay,
  pabDateKey,
  parseColDate,
  parseDateRangeFromFilename,
  resolveCanonicalColumnsToIso,
  type HslPabWeekInfo,
  type PabCalendarDay,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { applyPabAdjustments, getHslAdjustedEnd } from '@/lib/payroll/dispatch-bonuses';
import {
  HSL_WEEK_MODEL_CUTOVER_KEY,
  resolveHslWeekModelWithDefault,
  type HslWeekModel,
} from '@/lib/payroll/hsl-week-model';
import {
  disputeGrantsPabForgiveness,
  disputeIsAwaitingResolution,
  isOrphanageStyleReason,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';
import {
  buildOrphanageHoursIndex,
  orphanageHoursByCoveredDate,
  orphanageCoversDay,
  type OrphanageHoursIndex,
} from '@/lib/payroll/orphanage-pab-coverage';
import {
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
  parseUsHolidaysList,
  getEnabledHolidayMap,
} from '@/lib/us-holidays';
import {
  PAB_PERIOD_OVERRIDES_KEY,
  parsePabPeriodOverrides,
  resolvePabMonthFromColumns,
  resolvePabRangeForMonth,
  type PabOverridesMap,
} from '@/lib/pab-period-settings';

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
  /** HSL employees use 5-of-7 Mon–Sun rule; overnight shifts (today + tomorrow ≥ 7h) show green. */
  isHsl?: boolean;
  /** Optional: notified whenever the initial-load state flips. Lets a host surface
   *  (e.g. the People dialog) drive its own progress UI. */
  onLoadingChange?: (loading: boolean) => void;
  /** Optional: real load progress 0→1 as the (dominant) hours fetch completes.
   *  Lets a host drive a genuine progress bar instead of a timed guess. */
  onProgress?: (fraction: number) => void;
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
  isHsl = false,
  onLoadingChange,
  onProgress,
}: EmployeePabCalendarProps) {
  // Live ref so fetchMerged can report progress without being recreated.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const [aliasEmails, setAliasEmails] = useState<string[]>([]);
  const [mergedRow, setMergedRow] = useState<Record<string, unknown> | null>(null);
  const [mergedColumns, setMergedColumns] = useState<string[]>([]);
  /** Latest day any uploaded Hubstaff file covers (max filename end date) —
   *  the verdict's evaluation ceiling, mirroring the Overview engine's clamp
   *  so a closed month whose final CSV hasn't landed isn't scored as failed. */
  const [latestFileEnd, setLatestFileEnd] = useState<Date | null>(null);
  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>([]);
  /** TEMPORARY orphanage → PAB coverage (see orphanage-pab-coverage.ts): the
   *  VIEWED employee's locked-in orphanage hours (accounting-gated ?all=1,
   *  filtered to their aliases). Best-effort — empty for non-accounting viewers. */
  const [orphanageHoursIndex, setOrphanageHoursIndex] = useState<OrphanageHoursIndex>(new Map());
  const [rateHistory, setRateHistory] = useState<Array<{
    effectiveFrom: Date;
    regularRate: number | null;
    otRate: number | null;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usHolidayDates, setUsHolidayDates] = useState<Map<string, string>>(new Map());
  const [pabOverrideMap, setPabOverrideMap] = useState<PabOverridesMap>(new Map());
  /** Raw `hsl.week_model_cutover` app-setting — resolves the HSL week anchor
   *  (Mon→Sun legacy vs Sun→Sat post-cutover) exactly like the Payroll Wizard. */
  const [hslCutoverSetting, setHslCutoverSetting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/app-settings?keys=${encodeURIComponent([US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY, PAB_PERIOD_OVERRIDES_KEY, HSL_WEEK_MODEL_CUTOVER_KEY].join(','))}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (cancelled) return;
        const values = json.values ?? {};
        const enabled = values[US_HOLIDAYS_ENABLED_KEY] === null || values[US_HOLIDAYS_ENABLED_KEY] === undefined
          ? true
          : values[US_HOLIDAYS_ENABLED_KEY] === 'true';
        setUsHolidayDates(getEnabledHolidayMap(parseUsHolidaysList(values[US_HOLIDAYS_LIST_KEY] ?? null), enabled));
        setPabOverrideMap(parsePabPeriodOverrides(values[PAB_PERIOD_OVERRIDES_KEY] ?? null));
        setHslCutoverSetting(values[HSL_WEEK_MODEL_CUTOVER_KEY] ?? null);
      } catch {
        if (!cancelled) {
          setUsHolidayDates(new Map());
          setPabOverrideMap(new Map());
          setHslCutoverSetting(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    const report = (f: number) => onProgressRef.current?.(Math.max(0, Math.min(1, f)));
    report(0.06);
    const filesRes = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, {
      cache: 'no-store',
    });
    const filesJson = (await filesRes.json()) as { files?: string[] };
    const files = filesJson.files ?? [];
    // Latest day Hubstaff has data for, parsed from `…_YYYY-MM-DD_to_YYYY-MM-DD`
    // filenames. Null when no filename parses (hand-named uploads) — the
    // verdict then falls back to clamping at today.
    let maxEnd: Date | null = null;
    for (const f of files) {
      const range = parseDateRangeFromFilename(f);
      if (range && (!maxEnd || range.end.getTime() > maxEnd.getTime())) maxEnd = range.end;
    }
    setLatestFileEnd(maxEnd);
    if (files.length === 0) {
      setMergedRow(null);
      setMergedColumns([]);
      report(1);
      return;
    }

    const employeeNorms = new Set(aliasEmails);
    report(0.12);
    let completed = 0;
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
          .catch(() => ({ file, json: { columns: null, rows: null } }))
          // Real per-file progress — files resolve over the wire, so the bar
          // climbs as each one lands (0.12 → 0.95 across all files).
          .finally(() => {
            completed += 1;
            report(0.12 + 0.83 * (completed / files.length));
          }),
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

  // TEMPORARY orphanage → PAB coverage: load the viewed employee's locked-in
  // orphanage hours (accounting-gated ?all=1, filtered to their aliases) so an
  // orphanage-excused day can be topped up to 7h — matching the wizard/server.
  useEffect(() => {
    const emps = new Set((aliasEmails.length ? aliasEmails : [email]).map((e) => e.trim().toLowerCase()));
    const ctrl = new AbortController();
    fetch('/api/orphanage-pay?all=1', { cache: 'no-store', signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((json: { rows?: { source_file: string | null; employee_email: string; hours: number }[] }) => {
        setOrphanageHoursIndex(
          buildOrphanageHoursIndex(
            (json.rows ?? [])
              .filter((r) => emps.has((r.employee_email ?? '').trim().toLowerCase()))
              .map((r) => ({ sourceFile: r.source_file, email, hours: r.hours })),
          ),
        );
      })
      .catch(() => setOrphanageHoursIndex(new Map()));
    return () => ctrl.abort();
  }, [aliasEmails, email]);

  // Initial load
  useEffect(() => {
    // Wait until aliases are resolved before flipping `loading` off. fetchMerged
    // early-returns with NO data while aliasEmails is still empty, so running on
    // that first pass would briefly report "loaded" over an empty grid (and
    // finish any host progress bar prematurely) before the real fetch reloads.
    // aliasEmails always settles to at least [email], so this never hangs.
    if (aliasEmails.length === 0) return;
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
  }, [aliasEmails, fetchMerged, fetchDisputes]);

  // Surface the initial-load state to an optional host (e.g. the People dialog's
  // 0–100% progress bar). No-op for callers that don't pass the prop.
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

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
      ?? (cols.length > 0 ? resolvePabMonthFromColumns(cols, pabOverrideMap) : null)
      ?? getCurrentPabMonth();
    const { start, end } = resolvePabRangeForMonth(pabMonth.year, pabMonth.month, pabOverrideMap);
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    return { ...pabMonth, start, end, monthName: monthNames[pabMonth.month] ?? '' };
  }, [mergedColumns, pabMonthOverride, pabOverrideMap]);

  // ── Build date → ISO map of disputes for quick lookup ───────────────────
  const disputesByDate = useMemo(() => {
    const map = new Map<string, PabDayDisputeRow>();
    for (const d of disputes) map.set(d.dispute_date, d);
    return map;
  }, [disputes]);

  // ── Approved time adjustments (SET hours per date) ──────────────────────
  // Wizard parity: `effectiveOverrides` overlays approved PAB disputes with
  // approved TIME ADJUSTMENTS — an adjustment wins on the same day (it is the
  // explicit "this is the real number" decision). Without this layer a worker
  // whose midnight-split hours were corrected via a time adjustment would show
  // ineligible here while the wizard pays the PAB. Best-effort: a failed fetch
  // leaves the map empty and the calendar behaves like before.
  const [timeAdjustments, setTimeAdjustments] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!pabMonthRange || aliasEmails.length === 0) return;
    let cancelled = false;
    const s = pabMonthRange.start;
    // Window through the HSL ADJUSTED end — the last HSL week extends past the
    // raw period end, and an adjustment on an extension day is still scored.
    const e = isHsl
      ? getHslAdjustedEnd(pabMonthRange.end, resolveHslWeekModelWithDefault(s, hslCutoverSetting))
      : pabMonthRange.end;
    const from = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    const dayAfterEnd = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
    const to = `${dayAfterEnd.getFullYear()}-${String(dayAfterEnd.getMonth() + 1).padStart(2, '0')}-${String(dayAfterEnd.getDate()).padStart(2, '0')}`;
    void (async () => {
      const results = await Promise.all(
        aliasEmails.map((a) =>
          fetch(
            `/api/time-adjustments?status=approved&email=${encodeURIComponent(a)}&from=${from}&to=${to}`,
            { cache: 'no-store' },
          )
            .then((r) => r.json() as Promise<{ rows?: { adjust_date: string; approved_hours: number | null }[] }>)
            .catch(() => ({ rows: [] as { adjust_date: string; approved_hours: number | null }[] })),
        ),
      );
      if (cancelled) return;
      const map = new Map<string, number>();
      for (const json of results) {
        for (const row of json.rows ?? []) {
          if (row.approved_hours == null || !row.adjust_date) continue;
          map.set(row.adjust_date, row.approved_hours);
        }
      }
      setTimeAdjustments(map);
    })();
    return () => { cancelled = true; };
  }, [aliasEmails, pabMonthRange]);

  // ── Build calendar weeks from merged row + month range ──────────────────
  // HSL runs the Payroll Wizard's mechanics: 7-day weeks (Sun→Sat post-cutover,
  // Mon→Sun legacy), the period end extended to close the last week, weekend +
  // overnight credit, and per-week ≥5-of-7 reconciliation that forgives short
  // weekdays inside a passing week.
  const {
    pabCalendar,
    overnightIsos,
    hslWeekInfo,
    hslSunSat,
    engineEligible,
  } = useMemo(() => {
    const empty = {
      pabCalendar: null as PabCalendarDay[][] | null,
      overnightIsos: new Set<string>(),
      hslWeekInfo: new Map<string, HslPabWeekInfo>(),
      hslSunSat: false,
      engineEligible: false,
    };
    if (!pabMonthRange) return empty;

    // Same resolver + anchor the Payroll Wizard / server engine use.
    const hslModel: HslWeekModel = resolveHslWeekModelWithDefault(pabMonthRange.start, hslCutoverSetting);
    const sunSat = isHsl && hslModel === 'sun_sat';
    // HSL periods extend to the day closing the last week (Sunday for mon_sun,
    // Saturday for sun_sat) so a full final week is always evaluated.
    const hslRangeEnd = isHsl ? getHslAdjustedEnd(pabMonthRange.end, hslModel) : pabMonthRange.end;

    // 7-day HSL weeks anchored exactly the way checkHslPabEligibility walks
    // them; non-HSL keeps the standard Mon–Fri grid.
    const buildWeeks = (hours: Map<string, number>): PabCalendarDay[][] => {
      if (!isHsl) return buildPabCalendarWeeks(pabMonthRange.start, pabMonthRange.end, hours);
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const cur = new Date(pabMonthRange.start.getFullYear(), pabMonthRange.start.getMonth(), pabMonthRange.start.getDate());
      const dow = cur.getDay();
      if (sunSat) cur.setDate(cur.getDate() - dow); // back to the Sunday opening the first week
      else cur.setDate(cur.getDate() + (dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow)); // forward to the first Monday
      const endT = hslRangeEnd.getTime();
      const weeks: PabCalendarDay[][] = [];
      let week: PabCalendarDay[] = [];
      while (cur.getTime() <= endT) {
        const key = pabDateKey(cur);
        const seconds = hours.get(key) ?? 0;
        week.push({
          date: new Date(cur),
          dateStr: `${cur.getMonth() + 1}/${cur.getDate()}`,
          dayLabel: dayNames[cur.getDay()],
          seconds,
          passes: seconds >= 7 * 3600,
          hasData: hours.has(key),
          // HSL grid: weekends genuinely earn a qualifying day, so every cell scores.
          scoring: true,
        });
        if (week.length === 7) {
          weeks.push(week);
          week = [];
        }
        cur.setDate(cur.getDate() + 1);
      }
      if (week.length > 0) weeks.push(week);
      return weeks;
    };

    const cols = mergedColumns;
    if (!mergedRow || !cols.length) {
      const weeks = buildWeeks(new Map());
      return { ...empty, hslSunSat: sunSat, pabCalendar: weeks.length > 0 ? weeks.slice(0, 1) : null };
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
    // Raw CSV hours, before any forgiveness — the eligibility engine applies
    // its own adjustments (dispute ≥4h→7h bump, orphanage, holidays) to THIS
    // map so the verdict matches dispatch-bonuses/Payroll Wizard exactly.
    const rawHours = new Map(hoursByDateKey);
    const forgivenDates = new Map<string, number | null>();
    for (const d of disputes) {
      if (disputeGrantsPabForgiveness(d)) forgivenDates.set(d.dispute_date, d.override_hours ?? null);
    }
    // Approved time adjustments overlay disputes on the same day (wizard's
    // effectiveOverrides ordering — the adjustment is the explicit number).
    for (const [iso, h] of timeAdjustments) forgivenDates.set(iso, h);
    const orphanageByIso = orphanageHoursIndex.size
      ? orphanageHoursByCoveredDate(orphanageHoursIndex, email)
      : new Map<string, number>();

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
    // Approved time adjustments = SET semantics too, winning over a same-day
    // dispute override — the displayed hours match what the wizard shows.
    for (const [iso, h] of timeAdjustments) {
      const [y, m, day] = iso.split('-').map(Number);
      if (!y || !m || !day) continue;
      hoursByDateKey.set(`${y}-${m}-${day}`, h * 3600);
    }
    // TEMPORARY orphanage → PAB coverage (AUTO mode): a weekday inside the
    // employee's orphanage-hours coverage window (file week + week before —
    // hours land one payroll run after the visit) whose time + orphanage hours
    // reaches 7h is bumped to a full pass. See orphanage-pab-coverage.ts.
    if (orphanageByIso.size) {
      for (const [isoDate, orphHours] of orphanageByIso) {
        const [y, m, day] = isoDate.split('-').map(Number);
        if (!y || !m || !day) continue;
        const key = `${y}-${m}-${day}`;
        const workedSec = hoursByDateKey.get(key) ?? 0;
        if (orphanageCoversDay(workedSec, orphHours)) hoursByDateKey.set(key, 7 * 3600);
      }
    }
    // US holidays: force-pass (treat as >= 7h) so the employee stays PAB-eligible
    for (const [iso] of usHolidayDates.entries()) {
      const [y, m, day] = iso.split('-').map(Number);
      if (!y || !m || !day) continue;
      const key = `${y}-${m}-${day}`;
      const existing = hoursByDateKey.get(key) ?? 0;
      if (existing < 7 * 3600) hoursByDateKey.set(key, 7 * 3600);
    }

    // Engine-parity effective hours: raw + forgiven (≥4h → 7h) + holiday +
    // orphanage — byte-identical semantics to the server's applyPabAdjustments.
    const effectiveHours = applyPabAdjustments(
      rawHours,
      forgivenDates.size ? forgivenDates : undefined,
      usHolidayDates.size ? new Set(usHolidayDates.keys()) : undefined,
      orphanageByIso.size ? orphanageByIso : undefined,
    );

    // HSL: per-week engine breakdown over the full adjusted window — drives
    // cell colouring (reconciled weekdays, overnight credit) like the wizard.
    const weekInfo = isHsl
      ? computeHslPabWeekInfo(pabMonthRange.start, hslRangeEnd, effectiveHours, hslModel)
      : new Map<string, HslPabWeekInfo>();
    const overnightSet = new Set<string>();
    for (const w of weekInfo.values()) {
      for (const iso of w.overnightIsos) overnightSet.add(iso);
    }

    // Verdict, clamped to what Hubstaff has uploaded (like the Overview
    // engine's evaluation ceiling) so a closed month whose final CSV hasn't
    // landed yet isn't scored as failed.
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const ceilingT = Math.min(todayMid.getTime(), (latestFileEnd ?? todayMid).getTime());
    let engineEligibleNow: boolean;
    if (isHsl) {
      let evalEnd: Date;
      // Gate completeness on the RAW period end (like the Overview engine):
      // once data reaches `end`, evaluate the full adjusted window so the final
      // week is scored whole — the extension days simply read 0h if absent.
      const rawEndT = new Date(
        pabMonthRange.end.getFullYear(),
        pabMonthRange.end.getMonth(),
        pabMonthRange.end.getDate(),
      ).getTime();
      if (ceilingT >= rawEndT) {
        evalEnd = hslRangeEnd;
      } else {
        // Clamp back to the last COMPLETED week-close day (Sunday for mon_sun,
        // Saturday for sun_sat) so an in-progress week isn't penalized.
        const ceil = new Date(ceilingT);
        const cDow = ceil.getDay();
        const daysBack = sunSat ? (cDow === 6 ? 0 : cDow + 1) : cDow;
        evalEnd = new Date(ceil.getFullYear(), ceil.getMonth(), ceil.getDate() - daysBack);
        if (evalEnd.getTime() < pabMonthRange.start.getTime()) {
          // Nothing evaluable yet — end BEFORE the first week's anchor so the
          // check sees an empty range. (`start - 1` is NOT empty under sun_sat:
          // the anchor Sunday sits on/before it → 1-day fragment week.)
          const anchor = new Date(
            pabMonthRange.start.getFullYear(),
            pabMonthRange.start.getMonth(),
            pabMonthRange.start.getDate(),
          );
          const aDow = anchor.getDay();
          if (sunSat) anchor.setDate(anchor.getDate() - aDow);
          else anchor.setDate(anchor.getDate() + (aDow === 0 ? 1 : aDow === 1 ? 0 : 8 - aDow));
          evalEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 1);
        }
      }
      const verdictWeeks = computeHslPabWeekInfo(pabMonthRange.start, evalEnd, effectiveHours, hslModel);
      engineEligibleNow = [...verdictWeeks.values()].every((w) => w.weekPasses);
    } else {
      const evalEnd = new Date(Math.min(pabMonthRange.end.getTime(), Math.max(ceilingT, pabMonthRange.start.getTime())));
      const flat = buildPabCalendarWeeks(pabMonthRange.start, evalEnd, effectiveHours).flat();
      engineEligibleNow = flat.length > 0 && flat.every((d) => d.passes);
    }

    const weeks = buildWeeks(hoursByDateKey);

    if (!trimToElapsedWeeks) {
      return { pabCalendar: weeks, overnightIsos: overnightSet, hslWeekInfo: weekInfo, hslSunSat: sunSat, engineEligible: engineEligibleNow };
    }

    // Trim to elapsed weeks (employee-facing view)
    let latest: Date | null = null;
    for (const [k, secs] of hoursByDateKey) {
      if (secs <= 0) continue;
      const [y, m, d] = k.split('-').map(Number);
      if (!y || !m || !d) continue;
      const dt = new Date(y, m - 1, d);
      if (!latest || dt.getTime() > latest.getTime()) latest = dt;
    }
    const cutoff = latest ?? todayMid;
    const trimmed = weeks.filter((week) => {
      const firstDay = week[0]?.date;
      if (!firstDay) return false;
      const weekStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate());
      return weekStart.getTime() <= cutoff.getTime();
    });
    return {
      pabCalendar: trimmed.length > 0 ? trimmed : weeks.slice(0, 1),
      overnightIsos: overnightSet,
      hslWeekInfo: weekInfo,
      hslSunSat: sunSat,
      engineEligible: engineEligibleNow,
    };
  }, [mergedRow, mergedColumns, pabMonthRange, disputes, timeAdjustments, trimToElapsedWeeks, usHolidayDates, isHsl, orphanageHoursIndex, email, hslCutoverSetting, latestFileEnd]);

  // ISO of the day that STARTS the HSL week containing `date` — must match the
  // computeHslPabWeekInfo anchor so a cell's week lookup lands on the right row.
  const hslWeekStartIso = useCallback(
    (date: Date): string => {
      const d = new Date(date);
      const dow = d.getDay(); // Sun=0 … Sat=6
      const daysBack = hslSunSat ? dow : (dow === 0 ? 6 : dow - 1);
      d.setDate(d.getDate() - daysBack);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    [hslSunSat],
  );

  // Verdict: in-progress while today is on/before the period end; after that,
  // the engine-parity eligibility (HSL 5-of-7 weeks / non-HSL every weekday).
  const verdict: 'eligible' | 'ineligible' | 'in_progress' = useMemo(() => {
    if (!pabMonthRange) return 'ineligible';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(pabMonthRange.end);
    end.setHours(0, 0, 0, 0);
    if (today.getTime() <= end.getTime()) return 'in_progress';
    return engineEligible ? 'eligible' : 'ineligible';
  }, [pabMonthRange, engineEligible]);

  // HSL renders the full 7-day week (weekends carry real credit under the
  // 5-of-7 rule); everyone else keeps the Mon–Fri strip.
  const dayCols = isHsl ? 7 : 5;
  const gridColsClass = isHsl
    ? 'grid-cols-[1.5rem_repeat(7,1fr)]'
    : 'grid-cols-[1.5rem_repeat(5,1fr)]';
  const headerLabels = isHsl
    ? (hslSunSat ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'])
    : ['M', 'T', 'W', 'T', 'F'];
  const dowOrder = isHsl
    ? (hslSunSat ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0])
    : [1, 2, 3, 4, 5];

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
          /* Skeleton mirrors the real layout below: same grid dims, header row,
             week rows of h-14/sm:h-16 cells, and the bottom legend strip — so
             the real grid swaps in without any layout reflow. */
          <div className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="min-h-0 flex-1 overflow-hidden">
              {/* Day-of-week header row — placeholder dots (7 cols for HSL) */}
              <div className={`sticky top-0 z-10 mb-1 grid ${gridColsClass} gap-1 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95`}>
                <div />
                {Array.from({ length: dayCols }, (_, i) => (
                  <div key={i} className="mx-auto h-2 w-2 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                ))}
              </div>
              {/* 5 week rows — week number + day cells matching real h-14/sm:h-16 */}
              {Array.from({ length: 5 }, (_, wi) => (
                <div key={wi} className={`mb-1 grid ${gridColsClass} items-stretch gap-1`}>
                  <div className="flex items-center justify-end">
                    <div className="h-2 w-1.5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                  {Array.from({ length: dayCols }, (_, di) => (
                    <div
                      key={di}
                      className="relative h-14 animate-pulse overflow-hidden rounded-md border border-zinc-200 bg-zinc-100/60 sm:h-16 dark:border-zinc-800 dark:bg-zinc-900/30"
                      style={{ animationDelay: `${(wi * dayCols + di) * 50}ms` }}
                    >
                      {/* Faint date-corner tick to hint at the real cell shape */}
                      <span className="absolute left-1 top-1 h-1 w-3 rounded-full bg-zinc-200/80 dark:bg-zinc-700/60" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {/* Legend skeleton — matches the real legend dot+label rhythm so the
                bottom strip doesn't pop in when data lands. */}
            <div className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] dark:border-zinc-800">
              {[
                'bg-emerald-200 dark:bg-emerald-900/40',
                'bg-red-200 dark:bg-red-900/40',
                'bg-amber-200 dark:bg-amber-900/40',
                'bg-emerald-200 dark:bg-emerald-900/40',
              ].map((dot, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full sm:h-2 sm:w-2 ${dot}`} />
                  <span className="h-2 w-6 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                </span>
              ))}
              <span className="ml-auto inline-flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin text-zinc-400" />
                <span className="h-2.5 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </span>
            </div>
          </div>
        ) : pabCalendar && pabCalendar.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip">
              {/* Column headers */}
              <div className={`sticky top-0 z-10 mb-1 grid ${gridColsClass} gap-1 bg-white/95 pb-0.5 dark:bg-[#0d1117]/95`}>
                <div />
                {headerLabels.map((d, i) => (
                  <div
                    key={i}
                    className={`text-center text-[8px] font-semibold ${
                      dowOrder[i] === 0 || dowOrder[i] === 6
                        ? 'text-zinc-300 dark:text-zinc-600'
                        : 'text-zinc-400 dark:text-zinc-500'
                    }`}
                  >
                    {d}
                  </div>
                ))}
              </div>
              {/* Week rows */}
              {pabCalendar.map((week, wi) => (
                <div
                  key={wi}
                  className={`mb-1 grid ${gridColsClass} items-stretch gap-1`}
                >
                  <div className="flex items-center justify-end text-[8px] font-medium text-zinc-400 dark:text-zinc-500">
                    {wi + 1}
                  </div>
                  {Array.from({ length: dayCols }, (_, di) => {
                    // Latest in-progress (past, no-data) WEEKDAY in this week —
                    // only that one gets the animated hourglass. Weekends never
                    // count: HSL's 5-of-7 rule can't fail on an empty weekend.
                    const _now = new Date();
                    const _todayMid = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
                    let latestInProgressTime = -Infinity;
                    for (const d of week) {
                      const dDow = d.date.getDay();
                      if (dDow === 0 || dDow === 6) continue;
                      const cm = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate());
                      if (cm.getTime() >= _todayMid.getTime()) continue;
                      if (d.hasData && d.seconds > 0) continue;
                      if (cm.getTime() > latestInProgressTime) latestInProgressTime = cm.getTime();
                    }
                    const day: PabCalendarDay | undefined = week.find(
                      (d) => d.date.getDay() === dowOrder[di],
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
                    const holidayName = usHolidayDates.get(dayIso) ?? null;
                    const isHoliday = !!holidayName;
                    const nowMid = new Date();
                    const todayMid = new Date(nowMid.getFullYear(), nowMid.getMonth(), nowMid.getDate());
                    const cellMid = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate());
                    const isToday = cellMid.getTime() === todayMid.getTime();
                    const isFutureOrToday = cellMid.getTime() >= todayMid.getTime();
                    // Week is "current" if today falls within its Mon–Sun span.
                    // `week` only contains M–F cells, so a Sat/Sun "today" never
                    // equals a cell — derive the span from the Monday entry.
                    const isCurrentWeek = (() => {
                      const mon = week[0]?.date;
                      if (!mon) return false;
                      const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
                      const end = new Date(start);
                      end.setDate(end.getDate() + 6);
                      return todayMid.getTime() >= start.getTime() && todayMid.getTime() <= end.getTime();
                    })();
                    // Week immediately before the current one — its days are over
                    // but Hubstaff hours may not be uploaded/processed yet, so any
                    // empty cell there is "Processing" rather than a real miss.
                    const isPreviousWeek = (() => {
                      const mon = week[0]?.date;
                      if (!mon) return false;
                      const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
                      const end = new Date(start);
                      end.setDate(end.getDate() + 6);
                      const nextMon = new Date(end);
                      nextMon.setDate(nextMon.getDate() + 1);
                      const nextSun = new Date(nextMon);
                      nextSun.setDate(nextSun.getDate() + 6);
                      return todayMid.getTime() >= nextMon.getTime() && todayMid.getTime() <= nextSun.getTime();
                    })();
                    // In the current week, days with no meaningful data aren't red yet
                    const noMeaningfulData = !day.hasData || day.seconds === 0;
                    const cellDow = day.date.getDay();
                    const isWeekendCell = cellDow === 0 || cellDow === 6;
                    const stillInProgress = isCurrentWeek && noMeaningfulData && !isFutureOrToday && !isWeekendCell;
                    const stillProcessing = isPreviousWeek && noMeaningfulData && !dispute && !isWeekendCell;

                    // For HSL: overnight-qualifying days (this day + next OR prev + this ≥ 7h combined)
                    const hslOvernight = isHsl && overnightIsos.has(dayIso);
                    // Wizard-parity reconciliation: a short day inside a week that
                    // already meets HSL's 5-of-7 quota (weekend/overnight credit)
                    // is forgiven — the person stays eligible, so never paint it red.
                    const hslWeekData = isHsl ? hslWeekInfo.get(hslWeekStartIso(day.date)) : undefined;
                    const hslReconciled =
                      isHsl &&
                      !day.passes &&
                      !hslOvernight &&
                      !!hslWeekData?.weekPasses &&
                      (isWeekendCell || day.hasData);
                    // Approved time adjustment on this date — SET hours already
                    // reflected in day.seconds; ≥4h keeps the day forgiven for
                    // PAB exactly like the wizard's effectiveOverrides layer.
                    const adjustedForgiven =
                      timeAdjustments.has(dayIso) && !day.passes && day.seconds >= 4 * 3600;
                    const forgiven =
                      adjustedForgiven ||
                      (!!dispute &&
                        disputeGrantsPabForgiveness(dispute) &&
                        !day.passes &&
                        (isOrphanageStyleReason(dispute.reason) || day.seconds >= 4 * 3600));
                    const canDispute =
                      day.hasData && !day.passes && !hslOvernight && !hslReconciled && !isWeekendCell &&
                      !dispute && !forgiven && !isFutureOrToday && !isCurrentWeek;
                    const cellClickable = canDispute || !!dispute;

                    const effectivelyPasses = day.passes || forgiven;

                    let cellBorder: string;
                    if (dispute != null && disputeIsAwaitingResolution(dispute)) {
                      cellBorder =
                        'border-amber-300 bg-amber-50 dark:border-amber-700/70 dark:bg-amber-950/40';
                    } else if (isHoliday) {
                      cellBorder =
                        'border-violet-300 bg-violet-50 dark:border-violet-700/70 dark:bg-violet-950/40';
                    } else if (hslOvernight && !day.passes) {
                      cellBorder =
                        'border-teal-300 bg-teal-50 dark:border-teal-700/70 dark:bg-teal-950/40';
                    } else if (effectivelyPasses) {
                      cellBorder = isCurrentWeek
                        ? 'border-orange-300 bg-orange-50 dark:border-orange-700/60 dark:bg-orange-950/30'
                        : 'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
                    } else if (hslReconciled) {
                      cellBorder =
                        'border-orange-300 bg-orange-100/70 dark:border-orange-700/60 dark:bg-orange-900/30';
                    } else if (isWeekendCell) {
                      // HSL weekend without credit — optional day, never a miss
                      cellBorder =
                        'border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/30';
                    } else if (isToday) {
                      cellBorder =
                        'border-orange-300 bg-white dark:border-orange-700/60 dark:bg-zinc-900/40';
                    } else if (stillInProgress) {
                      cellBorder =
                        'border-orange-300 bg-orange-50 dark:border-orange-700/60 dark:bg-orange-950/30';
                    } else if (stillProcessing) {
                      cellBorder =
                        'border-sky-300 bg-sky-50 dark:border-sky-700/60 dark:bg-sky-950/30';
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
                        title={`${day.dayLabel} ${day.dateStr}: ${secondsToDisplay(day.seconds)}${isHoliday ? ` — ${holidayName}` : ''}${dispute ? ` (${dispute.status})` : day.passes ? ' ✓' : hslOvernight ? ' → overnight shift (combined with adjacent day ≥ 7h)' : adjustedForgiven ? ' ★ forgiven — approved time adjustment' : hslReconciled ? ' ~ reconciled — week already has ≥5 qualifying days' : isWeekendCell ? ' — weekend (adds a qualifying day when ≥ 7h)' : isToday ? ' — in progress' : isFutureOrToday ? ' — not yet' : stillProcessing ? ' — processing' : day.hasData ? ' ✗ needs 7h — click to file an issue' : ' — no data'}${rateTooltip}`}
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
                        {isHoliday && (
                          <span className="pointer-events-none absolute left-1 top-3 max-w-[calc(100%-0.5rem)] truncate text-[6.5px] font-semibold leading-none tracking-tight text-violet-500 dark:text-violet-400">
                            {holidayName}
                          </span>
                        )}
                        {/* Today pulse indicator */}
                        {isToday && (
                          <span className="absolute right-1 top-1 flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
                          </span>
                        )}
                        {/* HSL credit markers — teal → for overnight, orange ~ for
                            week-reconciled (hidden on today: the pulse sits there) */}
                        {!isToday && hslOvernight && !day.passes && (
                          <span className="pointer-events-none absolute right-1 top-0.5 text-[9px] font-bold leading-none text-teal-600 dark:text-teal-400">→</span>
                        )}
                        {!isToday && hslReconciled && (
                          <span className="pointer-events-none absolute right-1 top-0.5 text-[9px] font-bold leading-none text-orange-500 dark:text-orange-400">~</span>
                        )}
                        <div className="flex flex-1 flex-col items-center justify-center px-0.5 pb-0.5 pt-3.5">
                          {(isToday || stillInProgress) && !isHoliday && !isWeekendCell ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Hourglass
                                className="h-3.5 w-3.5 text-orange-400 dark:text-orange-300 sm:h-4 sm:w-4"
                                style={
                                  isToday || cellMid.getTime() === latestInProgressTime
                                    ? { animation: 'hourglass-flip 2s ease-in-out infinite' }
                                    : undefined
                                }
                              />
                              <span className="text-[8px] font-semibold uppercase tracking-wider text-orange-400 dark:text-orange-300">
                                In Progress
                              </span>
                            </div>
                          ) : stillProcessing ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500 dark:text-sky-400 sm:h-4 sm:w-4" />
                              <span className="text-[8px] font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                                Processing
                              </span>
                            </div>
                          ) : (
                            <span
                              className={`text-center text-lg font-bold tabular-nums leading-none tracking-tight sm:text-xl ${
                                dispute != null && disputeIsAwaitingResolution(dispute)
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : isHoliday
                                    ? 'text-violet-700 dark:text-violet-400'
                                    : hslOvernight && !day.passes
                                      ? 'text-teal-700 dark:text-teal-400'
                                      : effectivelyPasses
                                    ? (isCurrentWeek ? 'text-orange-700 dark:text-orange-400' : 'text-emerald-700 dark:text-emerald-400')
                                    : hslReconciled
                                      ? 'text-orange-700 dark:text-orange-400'
                                      : isWeekendCell
                                        ? 'text-zinc-400 dark:text-zinc-500'
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
                        {/* HSL weekend premium hint — same +₱15/h marker the wizard shows */}
                        {isHsl && isWeekendCell && day.seconds > 0 && (
                          <span
                            className="pointer-events-none absolute bottom-0.5 left-1 rounded-sm bg-amber-500/15 px-1 text-[8px] font-semibold leading-tight text-amber-700 dark:text-amber-300"
                            title="+15 PHP/h weekend rate applied"
                          >
                            +₱15
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
              {isHsl && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500 sm:h-2 sm:w-2" /> Overnight
                </span>
              )}
              {isHsl && (
                <span className="flex items-center gap-1" title="Short day forgiven — its week already has ≥5 qualifying days (weekends count)">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-400 sm:h-2 sm:w-2" /> Reconciled
                </span>
              )}
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Forgiven
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500 sm:h-2 sm:w-2" /> Holiday
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
