'use client';

import { useCallback, useRef, useState } from 'react';

import type { TabCache } from './create-tab-cache';

/**
 * The `useState` drop-in and the identity binder for a store built by
 * `createTabCache`, written once for the same reason the envelope is.
 *
 * ## Boundness is folded into the tracked key, and that is load-bearing
 *
 * These shells render their tabs BEFORE the viewer email resolves, so on the
 * first render the cache is still inert. A plain `useState` initialiser would
 * therefore miss and **never look again** — the feature would silently do
 * nothing, which is the failure `manager-dashboard-cache.md` warns about by
 * name. Treating the effective key as `null` while unbound makes the bind render
 * a key CHANGE, which reseeds through React's documented
 * adjust-state-during-render path: before paint, not a frame later.
 *
 * It also makes hydration safe by construction. During SSR and the first client
 * render nothing is bound, both produce `initial`, and no `sessionStorage` value
 * can differ between them.
 *
 * ## The fetch effect is left alone, always
 *
 * Seeding here and nowhere else is what keeps stale-while-revalidate true by
 * construction: there is no way for a call site to skip its fetch, because
 * nothing in this hook or its store can answer "already fetched".
 */
export function createCachedStateHook(cache: TabCache) {
  /**
   * Bind the store to the viewer, before anything can read it.
   *
   * Binds during render — idempotent, touches no React state — because consumers
   * seed in `useState` initialisers, which run before any effect. Call it at the
   * TOP of the shell, above every tab.
   */
  function useCacheIdentity(viewerEmail: string | null): void {
    const bound = useRef<string | null | undefined>(undefined);
    if (bound.current !== viewerEmail) {
      bound.current = viewerEmail;
      cache.bindIdentity(viewerEmail);
    }
  }

  /**
   * `useState` that survives a tab switch, a reload and a hop to another
   * dashboard.
   *
   * @param key     A stable key from the store's key map, or `null` to opt out
   *                (e.g. while the parameters selecting the dataset are unknown).
   * @param initial Value to use when nothing is cached.
   */
  function useCachedState<T>(
    key: string | null,
    initial: T,
  ): [T, (next: T | ((previous: T) => T)) => void] {
    // Held in a ref so a fresh object/array literal at the call site does not
    // read as a changed initial value on every re-render.
    const initialRef = useRef(initial);
    const effectiveKey = cache.boundIdentity() === null ? null : key;

    const seed = (k: string | null): T => {
      if (k === null) return initialRef.current;
      const cached = cache.get<T>(k);
      // Explicit `!== undefined`, never `??`: a cached `null` is a real value.
      return cached !== undefined ? cached : initialRef.current;
    };

    // Value and the key it belongs to are ONE piece of state, so the setter can
    // file a write under the right key with no window in which the two disagree.
    const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
      key: effectiveKey,
      value: seed(effectiveKey),
    }));

    if (state.key !== effectiveKey) {
      // Falling back to `initial` rather than keeping the old value is
      // deliberate: once the key changes, the previous value describes a
      // different dataset, and showing it would be a WRONG answer, not a stale
      // one.
      setState({ key: effectiveKey, value: seed(effectiveKey) });
    }

    const set = useCallback((next: T | ((previous: T) => T)) => {
      setState((previous) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(previous.value) : next;
        // Written against `previous.key` — the key this value actually describes
        // — so a set landing during a key change cannot file the old dataset
        // under the new key.
        if (previous.key !== null) cache.set(previous.key, resolved);
        return { key: previous.key, value: resolved };
      });
    }, []);

    return [state.value, set];
  }

  return { useCacheIdentity, useCachedState };
}
