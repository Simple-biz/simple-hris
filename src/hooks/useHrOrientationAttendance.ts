'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildOrientationWeeks,
  type OrientationHire,
  type OrientationSummary,
} from '@/lib/manager/orientation-weekly';
import { buildStagedWeekIndex } from '@/lib/hr/orientation-week-stats';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';

/**
 * The orientation attendance read behind HR → New Hire Checklist →
 * **Orientation**.
 *
 * The HR twin of `useOrientationHistory` (the manager hook). Two deliberate
 * differences, and nothing else:
 *
 *  - It reads `/api/hr/orientation-attendance` — company-wide, gated on the
 *    `hr`/`new_hire_checklist` feature rather than on `manager|admin`.
 *  - **It caches.** The payload is week-independent, so one fetch serves every
 *    week HR's selector can land on: switching weeks re-derives from memory and
 *    never refetches, and coming back to the tab paints instantly instead of
 *    re-flashing a skeleton. Same in-memory, per-page-session store every other
 *    HR tab uses (`src/lib/hr/tab-cache.ts`) — deliberately not persisted, so a
 *    full reload still pulls fresh data.
 *
 * The MODEL is shared, not copied: `buildOrientationWeeks` buckets the hires into
 * HR's checklist weeks here exactly as it does for the manager tally, so the two
 * surfaces cannot disagree about a week or a rate
 * (docs/features/manager-orientation-attendance.md).
 */
type CacheVal = {
  hires: OrientationHire[];
  checklistWeeks: Array<[string, string[]]>;
};

export interface HrOrientationAttendanceState {
  summary: OrientationSummary;
  /** `personal_email` → the week the model filed that staged hire under. */
  stagedWeekByEmail: Map<string, string>;
  loading: boolean;
  /** Non-null means the panel must refuse to render numbers. */
  error: string | null;
  /** True while a manual Refresh is in flight over already-loaded data. */
  refreshing: boolean;
  refresh: () => Promise<void>;
}

export function useHrOrientationAttendance(enabled = true): HrOrientationAttendanceState {
  const cached = getHrTabCache<CacheVal>(HR_TAB_CACHE_KEYS.orientationAttendance);
  const warm = hasHrTabCache(HR_TAB_CACHE_KEYS.orientationAttendance);

  const [hires, setHires] = useState<OrientationHire[]>(() => cached?.hires ?? []);
  const [checklistWeeks, setChecklistWeeks] = useState<Map<string, string[]>>(
    () => new Map(cached?.checklistWeeks ?? []),
  );
  const [loaded, setLoaded] = useState(warm);
  const [loading, setLoading] = useState(enabled && !warm);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/orientation-attendance', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: OrientationHire[];
        checklistWeeks?: Record<string, string[]>;
        error?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const rows = json.rows ?? [];
      const weeks = Object.entries(json.checklistWeeks ?? {});
      setHires(rows);
      setChecklistWeeks(new Map(weeks));
      setLoaded(true);
      // Write back through the same path that seeds it, so a Refresh warms the
      // cache for the next visit instead of leaving a stale copy behind it.
      setHrTabCache<CacheVal>(HR_TAB_CACHE_KEYS.orientationAttendance, {
        hires: rows,
        checklistWeeks: weeks,
      });
    } catch (e) {
      // Cleared, never left stale, and never degraded: the week key is HR's
      // `period_start`, and the only fallback available is the hire's own dates
      // — the 46%-wrong grouping this feature exists to replace.
      setError(e instanceof Error ? e.message : 'Failed to load orientation attendance');
      setHires([]);
      setChecklistWeeks(new Map());
      setLoaded(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || loaded) return;
    void load(false);
  }, [enabled, loaded, load]);

  const refresh = useCallback(() => load(true), [load]);

  const summary = useMemo(
    () => buildOrientationWeeks({ hires, checklistWeeksByEmail: checklistWeeks }),
    [hires, checklistWeeks],
  );
  const stagedWeekByEmail = useMemo(() => buildStagedWeekIndex(summary), [summary]);

  return { summary, stagedWeekByEmail, loading, error, refreshing, refresh };
}
