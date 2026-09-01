'use client';

import { useCallback, useRef, useState } from 'react';

import {
  bindManagerCacheIdentity,
  boundManagerCacheIdentity,
  getManagerCache,
  setManagerCache,
} from '@/lib/manager/tab-cache';

/**
 * Bind the Manager shell cache to the viewer, before anything can read it.
 *
 * ## Why this binds during render rather than in an effect
 *
 * The cache is **inert until bound** — that is what stops one manager's team
 * painting into another's shell on a shared machine. But consumers seed in
 * `useState` initialisers, which run during the first render, and effects run
 * after that. An effect-based bind would always be too late: every first paint
 * would read an inert cache and miss.
 *
 * Binding during render is safe because it is idempotent and touches no React
 * state: with the same email it only rewrites the storage marker, and with a
 * *different* email it purges — the correct outcome whether the render commits
 * or is discarded. Same deliberate exception the Employee portal's cache makes
 * (`docs/features/employee-dashboard-cache.md` → *Hydration*) and the KPI
 * calculator's (`useKpiCacheIdentity`).
 *
 * Call it at the TOP of `ManagerApp`, above every cached-state hook and before
 * any tab renders — hooks and children both run in order after it.
 *
 * @param viewerEmail the signed-in manager, or null while unresolved
 */
export function useManagerCacheIdentity(viewerEmail: string | null): void {
  const bound = useRef<string | null | undefined>(undefined);
  if (bound.current !== viewerEmail) {
    bound.current = viewerEmail;
    bindManagerCacheIdentity(viewerEmail);
  }
}

/**
 * `useState` that survives a tab switch and a reload, for one Manager dataset.
 *
 * Drop-in shaped: swap `useState(initial)` for
 * `useManagerCachedState(KEY, initial)` and the only behavioural change is that
 * the first render *after the viewer resolves* paints the last value seen in
 * this browser tab instead of the empty state. Every write goes through to the
 * cache, so the call site keeps its existing fetch effect untouched — which is
 * the whole point: **stale-while-revalidate falls out of the shape**, with no
 * way for a call site to accidentally skip its fetch.
 *
 * ## Why boundness is part of the key
 *
 * Unlike the Employee shell — which returns `null` until the viewer is known, so
 * no tab exists before identity is bound — `ManagerApp` renders its tabs
 * immediately and resolves `viewerEmail` in an effect. On the first render the
 * cache is therefore still inert, and a plain `useState` initialiser would miss
 * and never look again.
 *
 * So the hook folds "is the cache bound yet" into the key it tracks: while
 * unbound the effective key is `null` (the hook degrades to a plain `useState`),
 * and the render in which binding happens is a key *change*, which reseeds
 * through React's documented adjust-state-during-render path — before paint, not
 * a frame later.
 *
 * That also makes hydration safe by construction. During SSR and the first
 * client render nothing is bound, both produce `initial`, and no `sessionStorage`
 * value can differ between them.
 *
 * @param key     Stable cache key from `MANAGER_CACHE_KEYS`, or `null` to opt
 *                out of caching (e.g. while the parameters that select the
 *                dataset are still unknown).
 * @param initial Value to use when nothing is cached.
 */
export function useManagerCachedState<T>(
  key: string | null,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  // Held in a ref so a fresh object/array literal at the call site does not read
  // as a changed initial value on every re-render.
  const initialRef = useRef(initial);

  // A key is only usable once identity is bound; see the doc comment above.
  const effectiveKey = boundManagerCacheIdentity() === null ? null : key;

  const seed = (k: string | null): T => {
    if (k === null) return initialRef.current;
    const cached = getManagerCache<T>(k);
    // Explicit `!== undefined`, never `??`: a cached `null` is a real value.
    return cached !== undefined ? cached : initialRef.current;
  };

  // Value and the key it belongs to are ONE piece of state. Keeping them
  // together is what lets the setter file a write under the right key with no
  // window in which the two could disagree.
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
    key: effectiveKey,
    value: seed(effectiveKey),
  }));

  if (state.key !== effectiveKey) {
    // React's documented "adjust state directly during render" reset. React
    // re-runs this component immediately, so the stale value below is never
    // committed — and unlike an effect there is no frame in which the previous
    // dataset is on screen under the new key.
    //
    // Falling back to `initial` rather than keeping the old value is deliberate:
    // once the key changes, the previous value describes a different dataset,
    // and showing it would be a wrong answer, not merely a stale one.
    setState({ key: effectiveKey, value: seed(effectiveKey) });
  }

  const set = useCallback((next: T | ((previous: T) => T)) => {
    setState((previous) => {
      const resolved =
        typeof next === 'function' ? (next as (p: T) => T)(previous.value) : next;
      // Written against `previous.key` — the key this value actually describes —
      // so a set that lands during a key change cannot file the old dataset
      // under the new key. Repeating the write (StrictMode double-invokes
      // updaters) is harmless: same key, same value, only the `at` stamp moves.
      if (previous.key !== null) setManagerCache(previous.key, resolved);
      return { key: previous.key, value: resolved };
    });
  }, []);

  return [state.value, set];
}
