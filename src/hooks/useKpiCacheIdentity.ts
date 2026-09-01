'use client';

import { useRef } from 'react';

import { bindKpiCacheIdentity } from '@/lib/manager/kpi-cache';

/**
 * Bind the Manager KPI cache to the viewer, before anything can read it.
 *
 * ## Why this binds during render rather than in an effect
 *
 * The cache is **inert until bound** — that is what stops one manager's branches
 * painting into another's calculator on a shared machine, and it has to hold on
 * a cold reload, when nothing has run yet. But the consumers seed their state in
 * `useState` initialisers, which run during the component's first render, and
 * effects run *after* that (child effects even run before the parent's). An
 * effect-based bind would therefore always be too late: every first paint would
 * read an inert cache and miss, and the feature would silently do nothing.
 *
 * Binding here is safe to do during render because it is idempotent and touches
 * no React state: with the same email it only rewrites the storage marker, and
 * with a *different* email it purges — which is the correct outcome whether the
 * render is committed or discarded. This is the same deliberate exception the
 * Employee portal's cache makes for its `useState` seeding
 * (`docs/features/employee-dashboard-cache.md` → *Hydration*).
 *
 * Passing `null` (viewer not resolved yet) purges and leaves the cache inert, so
 * a calculator mounted before its viewer is known simply behaves as it did
 * before this cache existed.
 *
 * @param viewerEmail the signed-in manager / officer, or null while unresolved
 */
export function useKpiCacheIdentity(viewerEmail: string | null): void {
  const bound = useRef<string | null | undefined>(undefined);
  if (bound.current !== viewerEmail) {
    bound.current = viewerEmail;
    bindKpiCacheIdentity(viewerEmail);
  }
}
