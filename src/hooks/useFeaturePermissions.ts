'use client';

import { useEffect, useState } from 'react';
import type { FeaturePermissionsMap, FeatureViewKey } from '@/lib/rbac/feature-permissions';
import {
  allowedTabsForUser,
  canAccessTabForUser,
  canEditTab as canEditTabFn,
} from '@/lib/rbac/view-tabs';

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
    setState((s) => ({ ...s, loading: true }));
    Promise.all([
      fetch(`/api/employee-roles?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { rows?: { role: string }[] }) => (j.rows ?? []).map((row) => row.role))
        .catch(() => [] as string[]),
      fetch(`/api/employee-feature-permissions?email=${encodeURIComponent(e)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { rows?: Array<{ view_key: string; feature: string; access: 'view' | 'edit' }> }) => {
          const out: FeaturePermissionsMap = {};
          for (const row of j.rows ?? []) {
            const view = row.view_key as FeatureViewKey;
            if (!out[view]) out[view] = {};
            (out[view] as Record<string, 'view' | 'edit'>)[row.feature] = row.access;
          }
          return out;
        })
        .catch(() => ({} as FeaturePermissionsMap)),
    ]).then(([roles, perms]) => {
      if (cancelled) return;
      setState({ roles, perms, ready: true, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

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
