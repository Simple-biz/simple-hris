'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Drives the MESA tab's "new contribution" badge.
 *
 * MESA deposits land as new `mesa_ledger` rows (a weekly ₱100 worker + ₱300
 * match), loaded from the external MESA tracker CSV — there is no in-app write
 * event to hook, so we detect new activity by diffing the member's deposit
 * summary against what they last saw on this device (localStorage). The badge
 * clears when they open the MESA tab (`markSeen`).
 *
 * First run on a device silently baselines the current state so existing
 * contribution history never lights the badge — only deposits AFTER that point
 * alert. A re-join (which resets the open account to ₱0) rebaselines too.
 */

interface MesaSeen {
  depositCount: number;
  lastDeposit: string | null;
}

const KEY_PREFIX = 'hris.mesa.lastSeenDeposit.';
const storageKey = (email: string) => `${KEY_PREFIX}${email}`;

function readSeen(email: string): MesaSeen | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(email));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MesaSeen>;
    if (typeof parsed?.depositCount !== 'number') return null;
    return { depositCount: parsed.depositCount, lastDeposit: parsed.lastDeposit ?? null };
  } catch {
    return null;
  }
}

function writeSeen(email: string, seen: MesaSeen): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(email), JSON.stringify(seen));
  } catch {
    /* storage unavailable — badge just won't persist across reloads */
  }
}

export interface MesaNewDeposits {
  /** Deposit events that landed since the member last opened MESA. 0 = nothing new. */
  newCount: number;
  /** Mark the current deposit state as seen (clears the badge). Call when MESA opens. */
  markSeen: () => void;
}

export function useMesaNewDeposits(email?: string | null): MesaNewDeposits {
  const normEmail = email ? email.trim().toLowerCase() : null;
  const [newCount, setNewCount] = useState(0);
  // Latest fetched deposit state, so markSeen can persist exactly what's shown.
  const currentRef = useRef<MesaSeen | null>(null);

  const refetch = useCallback(async () => {
    if (!normEmail) {
      setNewCount(0);
      currentRef.current = null;
      return;
    }
    try {
      const res = await fetch(
        `/api/mesa-ledger?email=${encodeURIComponent(normEmail)}&events=0`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        summary?: { depositCount?: number; lastDeposit?: string | null } | null;
      };
      const current: MesaSeen = {
        depositCount: json.summary?.depositCount ?? 0,
        lastDeposit: json.summary?.lastDeposit ?? null,
      };
      currentRef.current = current;

      const seen = readSeen(normEmail);
      // First run on this device, or a re-join that reset the account to ₱0
      // (count dropped) — baseline silently, no badge.
      if (!seen || current.depositCount < seen.depositCount) {
        writeSeen(normEmail, current);
        setNewCount(0);
        return;
      }
      setNewCount(Math.max(0, current.depositCount - seen.depositCount));
    } catch {
      /* keep prior badge on transient failure */
    }
  }, [normEmail]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime: a new mesa_ledger row for this member (a CSV deposit load) → refetch.
  // Best-effort — the poll below is the guarantee (emails aren't always stored
  // lowercased, and the table may not be in the realtime publication).
  useEffect(() => {
    if (!normEmail) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`mesa-ledger-new-${normEmail}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'mesa_ledger',
          filter: `email=eq.${normEmail}`,
        },
        () => { void refetch(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [normEmail, refetch]);

  // Fallback poll — deposits arrive via offline CSV loads, not app writes.
  useEffect(() => {
    const id = window.setInterval(() => { void refetch(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  const markSeen = useCallback(() => {
    if (!normEmail) return;
    const current = currentRef.current;
    if (current) writeSeen(normEmail, current);
    setNewCount(0);
  }, [normEmail]);

  return { newCount, markSeen };
}
