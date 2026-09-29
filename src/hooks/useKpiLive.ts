'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { joinSharedBroadcast } from '@/lib/supabase/shared-broadcast';
import {
  KPI_LIVE_DEBOUNCE_MS,
  KPI_LIVE_EVENT,
  KPI_LIVE_TOPIC,
  parseKpiLivePayload,
  type KpiLivePayload,
} from '@/lib/kpi-live';

interface UseKpiLiveOptions {
  /**
   * Re-read the surface's KPI data. Called debounced when a KPI week is marked
   * ready / locked / reopened (or a published week's bonus changes) anywhere,
   * and with `null` after the socket reconnects. The latest closure is always
   * used. It must be a BACKGROUND refresh — never a skeleton, never a reset of
   * unsaved edits.
   */
  onChange: (payload: KpiLivePayload | null) => void;
  /** Off until the surface is on screen, or while it must not move. */
  enabled?: boolean;
  /** Random 0..N ms before the re-read — employee surfaces only
   *  (`KPI_LIVE_EMPLOYEE_SPREAD_MS`); the topic reaches every open tab at once. */
  spreadMs?: number;
}

/**
 * Keeps a KPI figure live across dashboards: the routes that write a KPI status
 * or a published week's bonus broadcast `kpi-bonus-sync` from the server; this
 * joins that ONE shared page channel and re-reads on it.
 *
 * It is the fast path only. Each surface keeps the poll / focus refresh it
 * already had, so a lost message costs that surface's floor, never correctness.
 */
export function useKpiLive({ onChange, enabled = true, spreadMs = 0 }: UseKpiLiveOptions): void {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: KpiLivePayload | null = null;

    const leave = joinSharedBroadcast(
      KPI_LIVE_TOPIC,
      KPI_LIVE_EVENT,
      (raw) => {
        latest = parseKpiLivePayload(raw);
        if (timer !== null) clearTimeout(timer);
        const delay = KPI_LIVE_DEBOUNCE_MS + (spreadMs > 0 ? Math.floor(Math.random() * spreadMs) : 0);
        timer = setTimeout(() => {
          timer = null;
          cbRef.current(latest);
        }, delay);
      },
      getSupabaseBrowserClient,
    );

    return () => {
      if (timer !== null) clearTimeout(timer);
      leave();
    };
  }, [enabled, spreadMs]);
}
