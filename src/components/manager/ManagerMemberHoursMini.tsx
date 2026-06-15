'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import {
  getEnabledHolidayMap,
  parseUsHolidaysList,
  US_HOLIDAYS_ENABLED_KEY,
  US_HOLIDAYS_LIST_KEY,
} from '@/lib/us-holidays';

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

const SLIDE_TRANSITION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };
const LABEL_TRANSITION = { duration: 0.14, ease: 'easeOut' as const };

interface ManagerMemberHoursMiniProps {
  workEmail: string | null;
  personalEmail: string | null;
  /** Alternate work emails from the master sheet — gsuite aliases for the same
   *  human. Hubstaff tracks some people under an alias (e.g. kevin@) while their
   *  primary work email is different (kevt@), so they must be part of the match
   *  set or the hours calendar comes up empty. */
  alternateWorkEmail?: string | null;
  alternateWorkEmail2?: string | null;
  /** Department — drives the HSL-specific PAB attendance rule (weekend / overnight
   *  qualification) for the calendar cell colouring. */
  department?: string | null;
}

export default function ManagerMemberHoursMini({
  workEmail,
  personalEmail,
  alternateWorkEmail = null,
  alternateWorkEmail2 = null,
  department = null,
}: ManagerMemberHoursMiniProps) {
  const aliasNorms = useMemo(() => {
    const set = new Set<string>();
    for (const e of [workEmail, personalEmail, alternateWorkEmail, alternateWorkEmail2]) {
      const n = normEmail(e ?? '');
      if (n) set.add(n);
    }
    return set;
  }, [workEmail, personalEmail, alternateWorkEmail, alternateWorkEmail2]);

  const [mergedRow, setMergedRow] = useState<Record<string, unknown> | null>(null);
  const [mergedColumns, setMergedColumns] = useState<string[]>([]);
  const [usHolidayDates, setUsHolidayDates] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const init = useMemo(() => getCurrentPabMonth(), []);
  const [viewYear, setViewYear] = useState(init.year);
  const [viewMonth, setViewMonth] = useState(init.month);
  // +1 when navigating forward, -1 when going back; drives slide direction.
  const [navDirection, setNavDirection] = useState<1 | -1>(1);

  // Fetch hubstaff merged hours ONCE per member open. Month navigation is
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
        const filesRes = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const filesJson = (await filesRes.json()) as { files?: string[] };

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

  // Fetch holiday settings once — drives the violet holiday cells on the calendar.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/app-settings?keys=${encodeURIComponent([US_HOLIDAYS_ENABLED_KEY, US_HOLIDAYS_LIST_KEY].join(','))}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { values?: Record<string, string | null> };
        if (cancelled) return;
        const values = json.values ?? {};
        const enabled =
          values[US_HOLIDAYS_ENABLED_KEY] == null
            ? true
            : values[US_HOLIDAYS_ENABLED_KEY] === 'true';
        setUsHolidayDates(
          getEnabledHolidayMap(parseUsHolidaysList(values[US_HOLIDAYS_LIST_KEY] ?? null), enabled),
        );
      } catch {
        if (!cancelled) setUsHolidayDates(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  const isHslMember = (department ?? '').trim().toLowerCase() === 'hsl';

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
              <CalendarBody
                weeks={calendarWeeks}
                viewYear={viewYear}
                viewMonth={viewMonth}
                usHolidayDates={usHolidayDates}
                isHsl={isHslMember}
                hoursByDateKey={hoursByDateKey}
              />
            )}
          </motion.div>
        </AnimatePresence>
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
  usHolidayDates,
  isHsl,
  hoursByDateKey,
}: {
  weeks: PabCalendarDay[][];
  viewYear: number;
  viewMonth: number;
  usHolidayDates: Map<string, string>;
  isHsl: boolean;
  hoursByDateKey: Map<string, number>;
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

            const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
            const holidayName = inMonth ? (usHolidayDates.get(dayIso) ?? null) : null;
            const isHoliday = !!holidayName;

            // For HSL: if today has hours but < 7h, check forward (today + tomorrow)
            // and backward (yesterday + today) to catch overnight shift splits.
            const hslOvernightQualifies = isHsl && inMonth && day.hasData &&
              day.seconds > 0 && day.seconds < 7 * 3600 && (() => {
                const nextDay = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate() + 1);
                if (day.seconds + (hoursByDateKey.get(pabDateKey(nextDay)) ?? 0) >= 7 * 3600) return true;
                const prevDay = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate() - 1);
                const prevSec = hoursByDateKey.get(pabDateKey(prevDay)) ?? 0;
                return prevSec > 0 && prevSec < 7 * 3600 && prevSec + day.seconds >= 7 * 3600;
              })();

            let cellBorder: string;
            if (!inMonth) {
              cellBorder =
                'border border-dashed border-zinc-200/80 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/20';
            } else if (isHoliday) {
              cellBorder =
                'border-violet-300 bg-violet-50 dark:border-violet-700/70 dark:bg-violet-950/40';
            } else if (weekend) {
              const hslQualifies = isHsl && (hours >= 7 || hslOvernightQualifies);
              cellBorder = hslQualifies
                ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40'
                : hours > 0
                  ? 'border-zinc-300 bg-gradient-to-b from-zinc-50 to-orange-50/40 dark:border-zinc-600 dark:from-zinc-900/50 dark:to-orange-950/15'
                  : 'border-zinc-200/80 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900/20';
            } else if (day.passes || hslOvernightQualifies) {
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
            } else if (isHoliday) {
              hourText = 'text-violet-700 dark:text-violet-400';
            } else if ((day.passes || hslOvernightQualifies) && !weekend) {
              hourText = 'text-emerald-700 dark:text-emerald-400';
            } else if (weekend && hours > 0) {
              hourText = isHsl && (hours >= 7 || hslOvernightQualifies)
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-zinc-700 dark:text-zinc-200';
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
                  'relative flex h-9 flex-col items-center justify-center gap-px rounded-md border',
                  cellBorder,
                )}
                title={`${day.dayLabel} ${day.dateStr}: ${(day.seconds / 3600).toFixed(2)}h${hslOvernightQualifies ? ' · overnight (combined with next day)' : ''}${isHoliday ? ` — ${holidayName}` : ''}${
                  inMonth ? '' : ' · adj. month'
                }`}
              >
                {isHoliday && (
                  <span className="pointer-events-none absolute left-1 top-1 max-w-[calc(100%-0.25rem)] truncate text-[6px] font-semibold leading-none tracking-tight text-violet-500 dark:text-violet-400">
                    {holidayName}
                  </span>
                )}
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
