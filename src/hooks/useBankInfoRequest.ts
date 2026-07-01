'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Whether the given employee has an UNREAD `bank_info.requested` notification —
 * i.e. Accounting/CEO asked them (from the People tab's "Missing bank info"
 * modal) to add their missing payout details. Drives the escalated rose "add
 * your bank info" blink on the employee dashboard's Profile → Payment section.
 *
 * Refetches on Realtime postgres_changes for the recipient and every 60s as a
 * fallback — mirrors useEmployeeNotificationsUnread. Returns false with no email.
 */
export function useBankInfoRequest(email?: string | null): boolean {
  const [requested, setRequested] = useState(false);
  const normEmail = email ? email.trim().toLowerCase() : null;

  const refetch = useCallback(async () => {
    if (!normEmail) {
      setRequested(false);
      return;
    }
    try {
      const res = await fetch(
        `/api/employee-notifications?email=${encodeURIComponent(normEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        notifications?: { type?: string | null; read_at: string | null }[];
      };
      // Existence-based, NOT unread-based: the Notifications panel auto-marks
      // everything read ~2s after it's viewed, so gating on `!read_at` would kill
      // the escalation the moment they merely open their bell. Instead the caller
      // ANDs this with `needsBank`, so the rose nudge clears precisely when they
      // add a payout method (needsBank flips false) — its intended trigger.
      setRequested((json.notifications ?? []).some((n) => n.type === 'bank_info.requested'));
    } catch {
      /* keep prior state */
    }
  }, [normEmail]);

  useEffect(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!normEmail) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`bank-info-request-${normEmail}`)
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

  return requested;
}
