'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildOrientationWeeks,
  type OrientationHire,
  type OrientationSummary,
} from '@/lib/manager/orientation-weekly';
import { useManagerCachedState } from '@/hooks/useManagerCachedState';
import { MANAGER_CACHE_KEYS } from '@/lib/manager/tab-cache';
import { toCachedHireRows } from '@/lib/manager/hire-row-cache';

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
 *
 * ## Painted from the Manager tab cache (2026-10-01)
 *
 * The RAW payload is cached under `MANAGER_CACHE_KEYS.orientationHistory`, so a
 * tab return or a reload paints the tally instead of a spinner. It still fetches
 * on every mount (the store has no skip flag). Two holds keep that honest:
 *
 * - **The rows are PROJECTED** (`toCachedHireRows`) before they are stored. The
 *   route passes pay rates through to a rate-visible viewer, and every row
 *   carries phone + location; none of it may reach `sessionStorage`.
 * - **A failure still CLEARS**, cache included (`null` is written back). A
 *   painted copy must never sit under an error card, and there is no safe
 *   fallback to a stale tally.
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
  /** True once THIS mount's read has answered. Until then `hires` may be a
   *  cache-painted copy (at most 12h old). */
  live: boolean;
  refresh: () => Promise<void>;
}

/** The raw route payload, as cached: rows projected, the week map a plain record. */
type OrientationHistoryPayload = {
  rows: OrientationHire[];
  checklistWeeks: Record<string, string[]>;
};

export function useOrientationHistory(enabled = true): OrientationHistoryState {
  // `null` = nothing to paint. Seeded from the cache once the viewer is bound.
  const [payload, setPayload] = useManagerCachedState<OrientationHistoryPayload | null>(
    MANAGER_CACHE_KEYS.orientationHistory,
    null,
  );
  // Whether this mount's read has answered. Never reset, so the spinner is
  // derived (`!settled && nothing to paint`) rather than re-asserted.
  const [settled, setSettled] = useState(false);
  const [live, setLive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/manager/orientation-history', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: OrientationHire[];
        checklistWeeks?: Record<string, string[]>;
        error?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPayload({
        rows: toCachedHireRows(json.rows ?? []),
        checklistWeeks: json.checklistWeeks ?? {},
      });
      setLoadedOnce(true);
      setLive(true);
    } catch (e) {
      // Cleared, never left stale — the cached copy too. There is no safe
      // degradation: falling back to the hire's own dates is exactly the
      // 46%-wrong week key this replaced, and a tally built on a partial roster
      // is worse than no tally.
      setError(e instanceof Error ? e.message : 'Failed to load orientation history');
      setPayload(null);
      setLoadedOnce(false);
      setLive(false);
    } finally {
      setSettled(true);
      setRefreshing(false);
    }
  }, [setPayload]);

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!enabled || loadedOnce) return;
    void load(false);
  }, [enabled, loadedOnce, load]);

  const hires = useMemo(() => payload?.rows ?? [], [payload]);
  const checklistWeeks = useMemo(
    () => new Map(Object.entries(payload?.checklistWeeks ?? {})),
    [payload],
  );
  const summary = useMemo(
    () => buildOrientationWeeks({ hires, checklistWeeksByEmail: checklistWeeks }),
    [hires, checklistWeeks],
  );
  // The skeleton is for having nothing to show, not for a request in flight.
  const loading = enabled && !settled && payload === null;

  return { hires, checklistWeeks, summary, loading, refreshing, error, live, refresh };
}
