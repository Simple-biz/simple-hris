'use client';

import { useEffect, useState } from 'react';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import {
  pickCurrentSourceFile,
  type HubstaffSourceFilesResponse,
} from '@/lib/hubstaff/current-upload';

export interface PayWeek {
  /** Monday-anchored ISO date, e.g. "2026-06-22". */
  start: string;
  /** Sunday ISO date six days after `start`. */
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

  return { weekOptions, currentWeekStart, loaded };
}
