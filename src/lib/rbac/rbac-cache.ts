'use client';

import type { FeaturePermissionsMap } from '@/lib/rbac/feature-permissions';

/**
 * Last-known-good RBAC cache (localStorage).
 *
 * The client resolves the viewer's roles + per-tab feature permissions by
 * fetching /api/employee-roles and /api/employee-feature-permissions, which read
 * Supabase. When Supabase is unreachable those fetches fail and the gating logic
 * collapses to the most-restrictive fallback — the ViewSwitcher disappears (see
 * `useAvailableViews`) and every in-dashboard tab drops to the read-only Overview
 * (see `view-tabs.ts`). This cache persists the last successful resolution per
 * email so a returning user keeps their navigation through a Supabase outage.
 *
 * UX resilience only — NEVER a security boundary. Every mutating API
 * re-authorizes server-side off the JWT, so a tampered cache grants no real
 * access; the worst case is a tab that renders but whose reads/writes 401/500
 * while Supabase is down. Keyed by normalized email, so an admin browsing
 * `?email=other` reads the correct person's snapshot (not their own).
 */

const KEY_PREFIX = 'rbac.cache.v1:';

export interface RbacSnapshot {
  roles: string[];
  perms: FeaturePermissionsMap;
}

function keyFor(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

export function readRbacCache(email: string | null | undefined): RbacSnapshot | null {
  const e = (email ?? '').trim().toLowerCase();
  if (!e || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(keyFor(e));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RbacSnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      roles: Array.isArray(parsed.roles)
        ? parsed.roles.filter((r): r is string => typeof r === 'string')
        : [],
      perms:
        parsed.perms && typeof parsed.perms === 'object'
          ? (parsed.perms as FeaturePermissionsMap)
          : {},
    };
  } catch {
    return null;
  }
}

/**
 * Merge-write: pass only the fields you actually resolved (e.g. roles-only from
 * the ViewSwitcher) and the rest of the prior snapshot is preserved, so a
 * partial refresh never blanks the other half of the cache. No-op off the
 * browser / when storage is unavailable — the cache is strictly best-effort.
 */
export function writeRbacCache(
  email: string | null | undefined,
  patch: Partial<RbacSnapshot>,
): void {
  const e = (email ?? '').trim().toLowerCase();
  if (!e || typeof window === 'undefined') return;
  try {
    const prior = readRbacCache(e);
    const next: RbacSnapshot = {
      roles: patch.roles ?? prior?.roles ?? [],
      perms: patch.perms ?? prior?.perms ?? {},
    };
    window.localStorage.setItem(keyFor(e), JSON.stringify(next));
  } catch {
    /* quota exceeded / storage disabled — best-effort only */
  }
}

/** Convenience readers for callers that only need one half of the snapshot. */
export function readCachedRoles(email: string | null | undefined): string[] | null {
  return readRbacCache(email)?.roles ?? null;
}

export function readCachedPerms(
  email: string | null | undefined,
): FeaturePermissionsMap | null {
  return readRbacCache(email)?.perms ?? null;
}
