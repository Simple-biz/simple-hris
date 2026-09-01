'use client';

import { useCallback, useRef, useState } from 'react';

import { getEmployeeCache, setEmployeeCache } from '@/lib/employee/tab-cache';

/**
 * `useState` that survives a page reload, for one Employee-portal dataset.
 *
 * Drop-in shaped: swap `useState(initial)` for
 * `useEmployeeCachedState(KEY, initial)` and the only behavioural change is that
 * the first render paints the last value seen in this browser tab instead of the
 * empty state. Every write goes through to the cache, so the call site keeps its
 * existing fetch effect untouched — which is the whole point:
 * **stale-while-revalidate falls out of the shape**, with no way for a call site
 * to accidentally skip its fetch and leave a stale pay figure on screen. See
 * `src/lib/employee/tab-cache.ts` for why that matters on this surface.
 *
 * ## Hydration
 *
 * Seeding happens in the `useState` initialiser, which reads `sessionStorage`.
 * That is safe here for the same reason `usePennyGreetingChips` is: no consumer
 * of this hook exists during hydration. `EmployeeApp.renderContent` returns
 * `null` until `employeeEmail` is set, and that is set inside an effect — so
 * every employee tab mounts strictly after the first client paint and is never
 * part of the server HTML.
 *
 * That same effect is where `bindEmployeeCacheIdentity` runs, so identity is
 * always bound before any read here can return a value. An unbound cache reads
 * as empty, which degrades this hook to a plain `useState`.
 *
 * @param key     Stable cache key from `EMPLOYEE_CACHE_KEYS`, or `null` to opt
 *                out of caching (e.g. while the parameters that select the
 *                dataset are still unknown).
 * @param initial Value to use when nothing is cached.
 */
export function useEmployeeCachedState<T>(
  key: string | null,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  // Held in a ref so a fresh object/array literal at the call site does not read
  // as a changed initial value on every re-render.
  const initialRef = useRef(initial);

  const seed = (k: string | null): T => {
    if (k === null) return initialRef.current;
    const cached = getEmployeeCache<T>(k);
    // Explicit `!== undefined`, never `??`: a cached `null` is a real value.
    return cached !== undefined ? cached : initialRef.current;
  };

  // Value and the key it belongs to are ONE piece of state. Keeping them
  // together is what lets the setter file a write under the right key with no
  // window in which the two could disagree.
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
    key,
    value: seed(key),
  }));

  if (state.key !== key) {
    // React's documented "adjust state directly during render" reset. React
    // re-runs this component immediately, so the stale value below is never
    // committed — and unlike an effect there is no frame in which the previous
    // dataset is on screen under the new key.
    //
    // Falling back to `initial` rather than keeping the old value is deliberate:
    // once the key changes, the previous value describes a different dataset,
    // and showing it would be a wrong answer, not merely a stale one.
    setState({ key, value: seed(key) });
  }

  const set = useCallback((next: T | ((previous: T) => T)) => {
    setState((previous) => {
      const resolved =
        typeof next === 'function' ? (next as (p: T) => T)(previous.value) : next;
      // Written against `previous.key` — the key this value actually describes —
      // so a set that lands during a key change cannot file the old dataset
      // under the new key. Repeating the write (StrictMode double-invokes
      // updaters) is harmless: same key, same value, only the `at` stamp moves.
      if (previous.key !== null) setEmployeeCache(previous.key, resolved);
      return { key: previous.key, value: resolved };
    });
  }, []);

  return [state.value, set];
}
