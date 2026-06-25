'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';

/** What a worker is doing right now, surfaced to the CEO live roster. */
export type PayrollSurface = 'wizard' | 'dispatch';

export interface PayrollLivePeer {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  surface: PayrollSurface | string;
  /** Free-text status, e.g. "412 left to pay" or "Validation step". */
  activity: string | null;
  online_at: string;
}

interface PresencePayload {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  surface: string;
  activity: string | null;
  online_at: string;
}

interface Args {
  selfEmail: string | null | undefined;
  /** When true, advertise self into the roster (a worker). The CEO reads
   *  read-only (publish=false) and never appears in the roster. */
  publish?: boolean;
  name?: string | null;
  avatarUrl?: string | null;
  surface?: PayrollSurface;
  activity?: string | null;
}

const CHANNEL = 'payroll-live';

/**
 * Presence layer for live payroll oversight. Everyone actively working a
 * payroll surface (the Payroll Wizard or Payment Dispatch) advertises
 * themselves here; the CEO Overview subscribes read-only to build the
 * "who's processing payroll right now" roster of watchable POVs.
 *
 * The actual screen stream rides the existing `accounting-cobrowse` channel
 * (see useCobrowse) — this channel only carries the lightweight roster.
 */
export function usePayrollLivePresence({
  selfEmail,
  publish = false,
  name = null,
  avatarUrl = null,
  surface = 'dispatch',
  activity = null,
}: Args): { peers: PayrollLivePeer[] } {
  const normSelf = useMemo(
    () => (selfEmail ? normEmail(selfEmail) ?? selfEmail.trim().toLowerCase() : null),
    [selfEmail],
  );
  const [peers, setPeers] = useState<PayrollLivePeer[]>([]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  // Keep self-meta in refs so we can re-track without tearing down the channel.
  const metaRef = useRef({ name, avatarUrl, surface, activity, publish });
  metaRef.current = { name, avatarUrl, surface, activity, publish };

  // Subscribe once per identity.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !normSelf) return;

    const ch = supabase.channel(CHANNEL, { config: { presence: { key: normSelf } } });
    channelRef.current = ch;

    const syncRoster = () => {
      const state = ch.presenceState<PresencePayload>();
      const list: PayrollLivePeer[] = [];
      for (const key of Object.keys(state)) {
        const meta = state[key]?.[0];
        if (!meta) continue;
        const email = normEmail(meta.email ?? key) ?? (meta.email ?? key).trim().toLowerCase();
        if (!email || email === 'anon') continue;
        list.push({
          email,
          name: meta.name ?? null,
          avatarUrl: meta.avatarUrl ?? null,
          surface: meta.surface ?? 'dispatch',
          activity: meta.activity ?? null,
          online_at: meta.online_at ?? '',
        });
      }
      list.sort((a, b) => a.email.localeCompare(b.email));
      setPeers(list);
    };

    ch.on('presence', { event: 'sync' }, syncRoster)
      .on('presence', { event: 'join' }, syncRoster)
      .on('presence', { event: 'leave' }, syncRoster)
      .subscribe((status: string) => {
        if (status !== 'SUBSCRIBED') return;
        const m = metaRef.current;
        if (m.publish) {
          void ch.track({
            email: normSelf,
            name: m.name,
            avatarUrl: m.avatarUrl,
            surface: m.surface,
            activity: m.activity,
            online_at: new Date().toISOString(),
          } satisfies PresencePayload);
        }
      });

    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [normSelf]);

  // Re-advertise (or withdraw) when our published meta changes.
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch || !normSelf) return;
    if (publish) {
      void ch.track({
        email: normSelf,
        name,
        avatarUrl,
        surface,
        activity,
        online_at: new Date().toISOString(),
      } satisfies PresencePayload);
    } else {
      void ch.untrack?.();
    }
  }, [publish, name, avatarUrl, surface, activity, normSelf]);

  return { peers };
}
