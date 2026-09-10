'use client';

import { useEffect, useState } from 'react';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';

export interface PayWeek {
  /** The upload's SUNDAY, e.g. "2026-08-30" — the date every stored KPI row is keyed on.
   *  (This used to say "Monday-anchored"; it never was. A Monday key is invisible to every
   *  reader — see scripts/audit-kpi-key-drift.mts.) */
  start: string;
  /** The Saturday six days after `start`. */
  end: string;
}

export interface PayWeeks {
  /** One entry per distinct uploaded Hubstaff CSV week, newest-first. */
  weekOptions: PayWeek[];
  /** The week of the batch accounting is currently dispatching (is_current), or
   *  null until the upload list resolves. */
  currentWeekStart: string | null;
  /** True once the upload list has been fetched (success or failure). */
  loaded: boolean;
  /** The ONE week after the live batch, offered so a manager can score it before its
   *  Hubstaff file exists. Null until the live week is known, and null again the moment a
   *  real file for that week is uploaded (it is then just another week). Kane, 2026-09-10. */
  upcomingWeek: PayWeek | null;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function weekEndFromStart(startIso: string): string {
  const [y, m, d] = startIso.split('-').map(Number);
  const end = new Date(y!, m! - 1, d! + 6);
  return toIso(end);
}

/**
 * The pay week after `currentWeekStart` — the live batch's Sunday plus seven days.
 *
 * This is the ONLY legitimate way to name a week that has no Hubstaff file yet.
 * It must be derived from a real upload's Sunday and never from the clock:
 * `isoWeekStart(new Date())` is Monday-anchored, and a KPI row written under a
 * Monday key is invisible to every reader forever (the stranded weeks in
 * scripts/audit-kpi-key-drift.mts). Sunday in, Sunday out — pinned by test.
 */
export function nextPayWeek(currentWeekStart: string): PayWeek {
  const [y, m, d] = currentWeekStart.split('-').map(Number);
  const start = toIso(new Date(y!, m! - 1, d! + 7));
  return { start, end: weekEndFromStart(start) };
}

/**
 * The upcoming week to OFFER, or null. Exactly one week ahead (Kane, 2026-09-10,
 * Q3), and only while no uploaded file already covers it — once the real file
 * lands it dedupes away and the week is ordinary.
 */
export function upcomingWeekFor(
  currentWeekStart: string | null,
  uploaded: readonly PayWeek[],
): PayWeek | null {
  if (!currentWeekStart) return null;
  const next = nextPayWeek(currentWeekStart);
  return uploaded.some((w) => w.start === next.start) ? null : next;
}

/**
 * The list of pay weeks the user can switch between — one per uploaded Hubstaff
 * CSV file — plus which week is the *live* (currently-dispatched) payroll batch.
 *
 * This is the same resolution the KPI Calculator uses internally
 * (`/api/hubstaff-hours?source_files=1` → parse filename date ranges →
 * `pickCurrentSourceFile` for the live batch). Extracted so the QC Overview's
 * period selector and the calculator stay in lock-step on what "a period" means.
 */
export function usePayWeeks(): PayWeeks {
  const [weekOptions, setWeekOptions] = useState<PayWeek[]>([]);
  const [currentWeekStart, setCurrentWeekStart] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' });
        const json = (await res.json()) as HubstaffSourceFilesResponse;

        // One entry per distinct uploaded Hubstaff week.
        const seen = new Set<string>();
        const weeks: PayWeek[] = [];
        const allFiles = [
          ...(json.uploads?.map((u) => u.source_file ?? '') ?? []),
          ...(json.files ?? []),
        ];
        for (const f of allFiles) {
          const range = f ? parseDateRangeFromFilename(f) : null;
          if (!range) continue;
          const startIso = toIso(range.start);
          if (seen.has(startIso)) continue;
          seen.add(startIso);
          weeks.push({ start: startIso, end: weekEndFromStart(startIso) });
        }
        weeks.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));

        // Pin the live week to the batch accounting is dispatching (is_current),
        // resolved the same way the Payroll Wizard does.
        const latest = pickCurrentSourceFile(json.uploads, json.files);
        const range = latest ? parseDateRangeFromFilename(latest) : null;
        if (!cancelled) {
          setWeekOptions(weeks);
          if (range) setCurrentWeekStart(toIso(range.start));
        }
      } catch {
        /* leave empty; the caller falls back to today's week */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { weekOptions, currentWeekStart, loaded, upcomingWeek: upcomingWeekFor(currentWeekStart, weekOptions) };
}
