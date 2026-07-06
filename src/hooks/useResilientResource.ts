'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

// ---------------------------------------------------------------------------
// Resilient data-loading logic: keep the UI usable when the backend is down.
//
// The problem this solves: components that show a loading skeleton until a fetch
// succeeds get stuck on the skeleton forever when Supabase is unreachable, and
// components that reset their data to []/null on error blank the whole screen.
// Neither lets the user "still see the UI".
//
// This hook guarantees:
//   • skeleton ONLY on a cold start (no data yet) — never after a completed load;
//   • on a failed refresh, the LAST-KNOWN data is kept and flagged `stale`, so the
//     screen stays populated and usable (read-only) during an outage;
//   • a cold-start failure resolves to `error` (not a spinning skeleton), so the
//     caller can render an empty/error state + Retry.
//
// The state machine is a pure reducer (exported + unit-tested); the hook is a
// thin imperative wrapper that drives it and handles fetch cancellation.
// ---------------------------------------------------------------------------

export type ResourceStatus = 'loading' | 'ready' | 'stale' | 'error';

export interface ResourceState<T> {
  /** Last successfully-loaded data, the seed, or undefined on a cold-start failure. */
  data: T | undefined;
  status: ResourceStatus;
  /** Message from the most recent failed attempt; cleared once a load succeeds. */
  error: string | null;
  /** epoch ms of the last successful load, or null. */
  lastUpdatedAt: number | null;
}

export type ResourceEvent<T> =
  | { type: 'start' }
  | { type: 'success'; data: T; at: number }
  | { type: 'failure'; error: string };

export function initResourceState<T>(initial: T | undefined, at: number): ResourceState<T> {
  const has = initial !== undefined;
  return { data: initial, status: has ? 'ready' : 'loading', error: null, lastUpdatedAt: has ? at : null };
}

/** Pure state transitions — see the header comment for the guarantees. */
export function resourceReducer<T>(state: ResourceState<T>, event: ResourceEvent<T>): ResourceState<T> {
  switch (event.type) {
    case 'start':
      // Cold start → skeleton. A background refresh (we already have data) keeps
      // the current status so the screen never flashes back to a skeleton.
      return state.data === undefined ? { ...state, status: 'loading' } : state;
    case 'success':
      return { data: event.data, status: 'ready', error: null, lastUpdatedAt: event.at };
    case 'failure':
      // Keep last-known data + timestamp. Something to show → 'stale' (still
      // usable); nothing ever loaded → 'error' (caller renders an empty state).
      return { ...state, error: event.error, status: state.data === undefined ? 'error' : 'stale' };
    default:
      return state;
  }
}

export interface UseResilientResourceOptions<T> {
  /** Fetches the resource. Gets an AbortSignal; must throw/reject on failure. */
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Seed (SSR prefetch / client cache). When present, status starts at 'ready'. */
  initial?: T;
  /** Gate the hook — no fetch runs while false. Default true. */
  enabled?: boolean;
  /** Fetch once on mount even when seeded (to revalidate). Default true. Set false
   *  to trust the seed and only refresh via the returned `refresh` (e.g. a poll). */
  revalidateOnMount?: boolean;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface ResilientResource<T> extends ResourceState<T> {
  /** Convenience: `status === 'stale'`. */
  isStale: boolean;
  /** Trigger a (re)fetch. Safe to wire into a poll / focus refresh. */
  refresh: () => void;
}

export function useResilientResource<T>(opts: UseResilientResourceOptions<T>): ResilientResource<T> {
  const { initial, enabled = true, revalidateOnMount = true } = opts;

  // Hold the latest fetcher/clock in refs so `refresh` stays stable and never
  // re-triggers mount effects when the caller passes a fresh closure each render.
  const fetcherRef = useRef(opts.fetcher);
  fetcherRef.current = opts.fetcher;
  const nowRef = useRef(opts.now ?? Date.now);
  nowRef.current = opts.now ?? Date.now;

  const [state, dispatch] = useReducer(
    resourceReducer<T>,
    undefined,
    () => initResourceState<T>(initial, nowRef.current()),
  );

  const inFlight = useRef<AbortController | null>(null);
  // Whether we started with a seed — captured once so the mount effect can skip
  // the initial fetch when asked, without depending on (and re-firing on) `data`.
  const hadSeedRef = useRef(initial !== undefined);

  const refresh = useCallback(() => {
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    dispatch({ type: 'start' });
    void (async () => {
      try {
        const data = await fetcherRef.current(ac.signal);
        if (ac.signal.aborted) return;
        dispatch({ type: 'success', data, at: nowRef.current() });
      } catch (e) {
        if (ac.signal.aborted) return;
        dispatch({ type: 'failure', error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!revalidateOnMount && hadSeedRef.current) return;
    refresh();
    return () => inFlight.current?.abort();
  }, [enabled, revalidateOnMount, refresh]);

  return { ...state, isStale: state.status === 'stale', refresh };
}
