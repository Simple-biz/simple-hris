'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildOrientationWeeks,
  type OrientationHire,
  type OrientationSummary,
} from '@/lib/manager/orientation-weekly';

/**
 * The orientation history behind Manager → My Team.
 *
 * Shared by the **Orientation** tab (the weekly tally + the PDF) and the **New
 * Hire Check List** tab, which needs the same two things for different reasons:
 * the checklist week map (its hire cards group by HR's week) and the no-show
 * rows (its No-shows section, which the actionable endpoint can never supply).
 *
 * One hook so the two tabs can never disagree about a week or a count. Each tab
 * mounts its own instance — inner tabs unmount on switch, so this is one fetch
 * per visit, matching how every other panel in this dashboard loads.
 *
 * `/api/manager/orientation-history` is deliberately NOT the actionable
 * `/api/manager/pending-hires` read: that one filters to what a manager can act
 * on right now (3 of the 40 people never marked attended as of 2026-08-24),
 * dropping every `promoted` and every `no_show` row.
 */
export interface OrientationHistoryState {
  hires: OrientationHire[];
  checklistWeeks: Map<string, string[]>;
  summary: OrientationSummary;
  /** First load only. A manual Refresh sets `refreshing`, not this — so the
   *  panel keeps rendering the numbers it already has instead of collapsing to
   *  a spinner and back. */
  loading: boolean;
  /** A Refresh over data that is already on screen. */
  refreshing: boolean;
  /** Non-null means the tally and the PDF must refuse to render. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOrientationHistory(enabled = true): OrientationHistoryState {
  const [hires, setHires] = useState<OrientationHire[]>([]);
  const [checklistWeeks, setChecklistWeeks] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/manager/orientation-history', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: OrientationHire[];
        checklistWeeks?: Record<string, string[]>;
        error?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setHires(json.rows ?? []);
      setChecklistWeeks(new Map(Object.entries(json.checklistWeeks ?? {})));
      setLoadedOnce(true);
    } catch (e) {
      // Cleared, never left stale. There is no safe degradation: falling back to
      // the hire's own dates is exactly the 46%-wrong week key this replaced,
      // and a tally built on a partial roster is worse than no tally.
      setError(e instanceof Error ? e.message : 'Failed to load orientation history');
      setHires([]);
      setChecklistWeeks(new Map());
      setLoadedOnce(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!enabled || loadedOnce) return;
    void load(false);
  }, [enabled, loadedOnce, load]);

  const summary = useMemo(
    () => buildOrientationWeeks({ hires, checklistWeeksByEmail: checklistWeeks }),
    [hires, checklistWeeks],
  );

  return { hires, checklistWeeks, summary, loading, refreshing, error, refresh };
}
