'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import type { FeaturePermissionsMap, FeatureViewKey } from '@/lib/rbac/feature-permissions';
import {
  allowedTabsForUser,
  canAccessTabForUser,
  canEditTab as canEditTabFn,
} from '@/lib/rbac/view-tabs';
import { readRbacCache, writeRbacCache } from '@/lib/rbac/rbac-cache';

interface FeaturePermissionsState {
  roles: string[];
  perms: FeaturePermissionsMap;
  /** False until the roles + perms fetch settles. Gate any redirect/hide on
   *  this so the initial (empty) state doesn't transiently hide everything. */
  ready: boolean;
  loading: boolean;
}

/**
 * Fetches the viewer's role assignments + per-feature permission overlay once
 * and exposes the gating helpers bound to that data. Mirrors the parallel
 * fetch that `src/App.tsx` already does for accounting; lifting it into a hook
 * lets every dashboard (and its sidebar) share one source of truth instead of
 * each surface fetching `/api/employee-roles` independently.
 */
export function useFeaturePermissions(email: string | null | undefined) {
  const { data: session } = useSession();
  const sessionEmail = (session?.user?.email ?? '').trim().toLowerCase();
  const sessionRoles = (session?.user as { roles?: string[] } | undefined)?.roles ?? null;
  // Stable dependency: a fresh session-array identity each render must not re-run.
  const sessionRolesKey = (sessionRoles ?? []).join(',');

  const [state, setState] = useState<FeaturePermissionsState>({
    roles: [],
    perms: {},
    ready: false,
    loading: false,
  });

  useEffect(() => {
    const e = (email ?? '').trim();
    if (!e) {
      setState({ roles: [], perms: {}, ready: false, loading: false });
      return;
    }
    let cancelled = false;

    // Offline fallbacks used ONLY when a fetch fails (Supabase down): the JWT
    // session roles (when this hook resolves the session owner) and the
    // last-known-good cache. Feature perms aren't in the JWT (kept out to stay
    // under the cookie size limit), so the cache is their only offline source.
    const selfRoles =
      sessionRoles && sessionEmail && sessionEmail === e.toLowerCase() ? sessionRoles : null;
    const cached = readRbacCache(e);

    // Optimistic paint: seed from the JWT roles (session owner) + last-known-good
    // cache so this dashboard's tabs render on the FIRST frame of a re-visit
    // instead of waiting on the roles + perms round-trips. `ready` flips true only
    // when we actually have a seed; the live fetch below overwrites it on resolve.
    const seedRoles = selfRoles ?? cached?.roles ?? null;
    const seedPerms = cached?.perms ?? null;
    setState((s) => ({
      roles: seedRoles ?? s.roles,
      perms: seedPerms ?? s.perms,
      ready: seedRoles || seedPerms ? true : s.ready,
      loading: true,
    }));
    Promise.all([
      fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`roles ${r.status}`))))
        .then((j: { rows?: { role: string }[] }) =>
          Array.isArray(j.rows)
            ? j.rows.map((row) => row.role)
            : Promise.reject(new Error('roles shape')),
        )
        .catch(() => selfRoles ?? cached?.roles ?? null),
      fetch(`/api/employee-feature-permissions?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`perms ${r.status}`))))
        .then((j: { rows?: Array<{ view_key: string; feature: string; access: 'view' | 'edit' }> }) => {
          if (!Array.isArray(j.rows)) return Promise.reject(new Error('perms shape'));
          const out: FeaturePermissionsMap = {};
          for (const row of j.rows) {
            const view = row.view_key as FeatureViewKey;
            if (!out[view]) out[view] = {};
            (out[view] as Record<string, 'view' | 'edit'>)[row.feature] = row.access;
          }
          return out;
        })
        .catch(() => cached?.perms ?? null),
    ]).then(([rolesRes, permsRes]) => {
      if (cancelled) return;
      setState({ roles: rolesRes ?? [], perms: permsRes ?? {}, ready: true, loading: false });
      // Refresh the cache only from a live (non-null) fetch, so a failed request
      // never overwrites good cache with the outage fallback.
      if (rolesRes !== null || permsRes !== null) {
        writeRbacCache(e, {
          ...(rolesRes !== null ? { roles: rolesRes } : {}),
          ...(permsRes !== null ? { perms: permsRes } : {}),
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, sessionRolesKey, sessionEmail]);

  const { roles, perms, ready, loading } = state;
  return {
    roles,
    perms,
    ready,
    loading,
    allowedTabs: (view: FeatureViewKey) => allowedTabsForUser(view, roles, perms),
    canAccessTab: (view: FeatureViewKey, tabId: string) =>
      canAccessTabForUser(view, tabId, roles, perms),
    canEditTab: (view: FeatureViewKey, tabId: string) => canEditTabFn(view, tabId, roles, perms),
  };
}
