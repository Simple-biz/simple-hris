'use client';

import { useCallback, useRef, useState } from 'react';

import {
  bindAdminCacheIdentity,
  boundAdminCacheIdentity,
  getAdminCache,
  setAdminCache,
} from '@/lib/admin/tab-cache';

/**
 * Bind the Admin shell cache to the viewer, before anything can read it.
 *
 * Binds during render (idempotent, touches no React state) because consumers
 * seed in `useState` initialisers, which run before any effect — the same
 * deliberate exception the Manager and Employee shells make. Call it at the TOP
 * of `AdminPageInner`, above every tab.
 */
export function useAdminCacheIdentity(viewerEmail: string | null): void {
  const bound = useRef<string | null | undefined>(undefined);
  if (bound.current !== viewerEmail) {
    bound.current = viewerEmail;
    bindAdminCacheIdentity(viewerEmail);
  }
}

/**
 * `useState` that survives a tab switch and a reload, for one Admin dataset.
 *
 * Drop-in shaped: swap `useState(initial)` for `useAdminCachedState(KEY, initial)`
 * and leave the fetch effect untouched — stale-while-revalidate falls out of the
 * shape. Boundness is folded into the tracked key (the Admin shell renders its
 * tabs before `adminEmail` resolves, so a plain initialiser would read an inert
 * cache and never look again); the render in which binding happens is a key
 * change and reseeds through React's adjust-state-during-render path.
 */
export function useAdminCachedState<T>(
  key: string | null,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const initialRef = useRef(initial);
  const effectiveKey = boundAdminCacheIdentity() === null ? null : key;

  const seed = (k: string | null): T => {
    if (k === null) return initialRef.current;
    const cached = getAdminCache<T>(k);
    return cached !== undefined ? cached : initialRef.current;
  };

  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
    key: effectiveKey,
    value: seed(effectiveKey),
  }));

  if (state.key !== effectiveKey) {
    setState({ key: effectiveKey, value: seed(effectiveKey) });
  }

  const set = useCallback((next: T | ((previous: T) => T)) => {
    setState((previous) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(previous.value) : next;
      if (previous.key !== null) setAdminCache(previous.key, resolved);
      return { key: previous.key, value: resolved };
    });
  }, []);

  return [state.value, set];
}
