'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { AppView } from '@/lib/rbac/views';

/**
 * Counts unread `employee_notifications` rows for the given email. When `view`
 * is supplied, counts only the notifications that belong to that dashboard (the
 * server filters by view) so the sidebar badge matches what the panel shows —
 * a multi-dashboard user's badge reflects the current dashboard, not the total.
 * Refetches on Realtime postgres_changes for the recipient and every 60s
 * as a fallback. Returns 0 when no email is supplied.
 */
export function useEmployeeNotificationsUnread(email?: string | null, view?: AppView): number {
  const [count, setCount] = useState(0);
  const normEmail = email ? email.trim().toLowerCase() : null;

  const refetch = useCallback(async () => {
    if (!normEmail) {
      setCount(0);
      return;
    }
    try {
      const params = new URLSearchParams({ email: normEmail });
      if (view) params.set('view', view);
      const res = await fetch(
        `/api/employee-notifications?${params.toString()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { notifications?: { read_at: string | null }[] };
      setCount((json.notifications ?? []).filter(n => !n.read_at).length);
    } catch {
      /* keep prior count */
    }
  }, [normEmail, view]);

  useEffect(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!normEmail) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`employee-notifications-unread-${normEmail}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'employee_notifications',
          filter: `recipient_email=eq.${normEmail}`,
        },
        () => { void refetch(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [normEmail, refetch]);

  useEffect(() => {
    const id = window.setInterval(() => { void refetch(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  return count;
}
