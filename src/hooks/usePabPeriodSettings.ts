'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchPabPeriodSettingsWithHealth,
  isValidManualPabRange,
  pabSettingsReadVerdict,
  samePabPeriodSettings,
  yearMonthKey,
  type PabOverridesMap,
  type PabPeriodFetchResult,
} from '@/lib/pab-period-settings';
import {
  PAB_PERIOD_LIVE_DEBOUNCE_MS,
  PAB_PERIOD_LIVE_EVENT,
  PAB_PERIOD_LIVE_POLL_MS,
  PAB_PERIOD_LIVE_TOPIC,
} from '@/lib/pab-period-live';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { getCurrentPabMonth, getPabMonthRange } from '@/lib/hubstaff/calendar-column-dedupe';

interface UsePabPeriodSettingsOptions {
  /**
   * Re-read the settings whenever the PAB period is saved anywhere (server
   * Broadcast on `PAB_PERIOD_LIVE_TOPIC`), on tab focus, and on a slow poll.
   * Off by default: the Payroll Wizard is the WRITER and re-reads after its own
   * saves, and its PAB tab gate depends on `loading` only moving when it asks.
   */
  live?: boolean;
}

// ONE channel per page, shared by every live instance. realtime-js returns the
// existing channel for a repeated topic, so per-instance channels would let the
// first instance to unmount `removeChannel` the topic out from under the rest.
const liveListeners = new Set<() => void>();
let liveTeardown: (() => void) | null = null;
/** Teardown is deferred one tick: `removeChannel` is async and `channel()`
 *  returns a still-leaving channel for the same topic, so an immediate
 *  unmount→remount (StrictMode, a tab remount) must reuse, not race, it. */
let pendingTeardown: number | null = null;

function joinPabPeriodLive(listener: () => void): () => void {
  liveListeners.add(listener);
  if (pendingTeardown !== null) {
    window.clearTimeout(pendingTeardown);
    pendingTeardown = null;
  }
  if (!liveTeardown) {
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const notifyAll = () => {
        for (const l of liveListeners) l();
      };
      let subscribedOnce = false;
      const channel = supabase
        .channel(PAB_PERIOD_LIVE_TOPIC)
        .on('broadcast', { event: PAB_PERIOD_LIVE_EVENT }, notifyAll);
      channel.subscribe((state) => {
        if (state !== 'SUBSCRIBED') return;
        // A RE-subscribe follows a drop, which can swallow a save — catch up.
        if (subscribedOnce) notifyAll();
        subscribedOnce = true;
      });
      liveTeardown = () => {
        void supabase.removeChannel(channel);
      };
    }
  }
  return () => {
    liveListeners.delete(listener);
    if (liveListeners.size > 0 || !liveTeardown || pendingTeardown !== null) return;
    pendingTeardown = window.setTimeout(() => {
      pendingTeardown = null;
      if (liveListeners.size === 0 && liveTeardown) {
        liveTeardown();
        liveTeardown = null;
      }
    }, 0);
  };
}

export function usePabPeriodSettings(options: UsePabPeriodSettingsOptions = {}) {
  const live = options.live === true;
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PabPeriodFetchResult>({
    manual: false,
    start: null,
    end: null,
    overrides: new Map() as PabOverridesMap,
    exclusions: new Map(),
    activeMonth: null,
    techWeekOverridesValue: null,
  });
  /** Issue order of reads — only the newest may write state. */
  const seqRef = useRef(0);
  /** Foreground (`refresh()`) reads in flight; `loading` is true while any is. */
  const foregroundRef = useRef(0);
  /** Whether what is on screen came from a read where every key answered. */
  const healthyRef = useRef(false);

  const load = useCallback(async (background: boolean) => {
    const seq = ++seqRef.current;
    if (!background) {
      foregroundRef.current += 1;
      setLoading(true);
    }
    try {
      const { result, failedKeys } = await fetchPabPeriodSettingsWithHealth();
      const degraded = failedKeys.length > 0;
      // Newest read only, and a degraded re-read never repaints a healthy
      // screen with the Mon→Fri default window (see pabSettingsReadVerdict).
      const verdict = pabSettingsReadVerdict({
        seq,
        latestSeq: seqRef.current,
        degraded,
        screenHealthy: healthyRef.current,
      });
      if (verdict !== 'apply') return;
      healthyRef.current = !degraded;
      // Same settings → same object, so no memo downstream re-runs.
      setData((prev) => (samePabPeriodSettings(prev, result) ? prev : result));
    } catch {
      // fetchPabPeriodSettingsWithHealth never rejects; this is a backstop so a
      // failure can never escape as an unhandled rejection (Next dev overlay).
    } finally {
      if (!background) {
        foregroundRef.current -= 1;
        if (foregroundRef.current === 0) setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Live: the route that saved the period broadcasts; this re-reads ───────
  // Broadcast, never `postgres_changes` — app_settings is RLS "Admins only",
  // so a row event never reaches the anon browser. The message is a re-read
  // signal only; the payload is never trusted as the value. The floor: a
  // catch-up read when the channel RE-subscribes (a drop can swallow a save),
  // on tab focus, and every PAB_PERIOD_LIVE_POLL_MS while visible.
  useEffect(() => {
    if (!live) return;
    let debounce: number | null = null;
    const fire = () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void load(true);
      }, PAB_PERIOD_LIVE_DEBOUNCE_MS);
    };

    const leave = joinPabPeriodLive(fire);

    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') fire();
    }, PAB_PERIOD_LIVE_POLL_MS);
    const onFocus = () => {
      if (document.visibilityState === 'visible') fire();
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      if (debounce !== null) window.clearTimeout(debounce);
      leave();
    };
  }, [live, load]);

  /** Legacy compat — valid single-range from the deprecated manual toggle. */
  const validManualRange = useMemo(
    () => (isValidManualPabRange(data) ? { start: data.start, end: data.end } : null),
    [data],
  );

  /**
   * The month the wizard should display. Falls back to today's PAB month if the
   * user hasn't explicitly set one yet. `isCurrent` reflects whether the active
   * month is today's PAB month.
   */
  const resolvedActiveMonth = useMemo(() => {
    const current = getCurrentPabMonth();
    const active = data.activeMonth ?? current;
    return {
      ...active,
      key: yearMonthKey(active.year, active.month),
      isCurrent: active.year === current.year && active.month === current.month,
    };
  }, [data.activeMonth]);

  /**
   * The PAB range for the active month: override if saved, otherwise the default
   * `getPabMonthRange()` window. Always non-null.
   */
  const activeRange = useMemo(() => {
    const override = data.overrides.get(resolvedActiveMonth.key);
    if (override) {
      return { start: override.start, end: override.end, isOverride: true };
    }
    const r = getPabMonthRange(resolvedActiveMonth.year, resolvedActiveMonth.month);
    return { start: r.start, end: r.end, isOverride: false };
  }, [data.overrides, resolvedActiveMonth]);

  return {
    loading,
    ...data,
    validManualRange,
    activeMonthResolved: resolvedActiveMonth,
    activeRange,
    refresh,
  };
}
