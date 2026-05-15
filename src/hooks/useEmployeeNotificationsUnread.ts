'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Counts unread `employee_notifications` rows for the given email.
 * Refetches on Realtime postgres_changes for the recipient and every 60s
 * as a fallback. Returns 0 when no email is supplied.
 */
export function useEmployeeNotificationsUnread(email?: string | null): number {
  const [count, setCount] = useState(0);
  const normEmail = email ? email.trim().toLowerCase() : null;

  const refetch = useCallback(async () => {
    if (!normEmail) {
      setCount(0);
      return;
    }
    try {
      const res = await fetch(
        `/api/employee-notifications?email=${encodeURIComponent(normEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { notifications?: { read_at: string | null }[] };
      setCount((json.notifications ?? []).filter(n => !n.read_at).length);
    } catch {
      /* keep prior count */
    }
  }, [normEmail]);

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
