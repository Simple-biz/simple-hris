'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { viewsForNotificationType } from '@/lib/notifications/notification-views';
import type { AppView } from '@/lib/rbac/views';

type CountsByView = Partial<Record<AppView, number>>;

/**
 * Returns unread `employee_notifications` counts for `email`, bucketed by the
 * dashboard each notification belongs to (see notification-views.ts). Powers the
 * per-dashboard badges in the Switch View component.
 *
 * Refetches on Realtime postgres_changes for the recipient and every 60s as a
 * fallback. Returns an empty object when no email is supplied.
 */
export function useNotificationCountsByView(email?: string | null): CountsByView {
  const [counts, setCounts] = useState<CountsByView>({});
  const normalized = email ? email.trim().toLowerCase() : null;

  const refetch = useCallback(async () => {
    if (!normalized) {
      setCounts({});
      return;
    }
    try {
      const res = await fetch(
        `/api/employee-notifications?email=${encodeURIComponent(normalized)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        notifications?: { type: string; read_at: string | null }[];
      };
      const acc: CountsByView = {};
      for (const n of json.notifications ?? []) {
        if (n.read_at) continue;
        for (const view of viewsForNotificationType(n.type)) {
          acc[view] = (acc[view] ?? 0) + 1;
        }
      }
      setCounts(acc);
    } catch {
      /* keep prior counts */
    }
  }, [normalized]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!normalized) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`notif-counts-by-view-${normalized}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'employee_notifications',
          filter: `recipient_email=eq.${normalized}`,
        },
        () => {
          void refetch();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [normalized, refetch]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refetch();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  return counts;
}
