'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Per-cycle "values locked" flag for Payment Dispatch, stored in `app_settings`
 * under `payroll.dispatch_lock.<sourceFile>` and propagated live via Supabase
 * Realtime (the same mechanism as the dispute-pause lock).
 *
 * - The Payroll Wizard's "Lock in Values & Send to Payment Dispatch" sets it
 *   `true`; an Unlock action sets it `false`.
 * - When `false` (or never set), Payment Dispatch shows NO queue data — just the
 *   "Payroll Wizard isn't ready yet" note. Changes reflect in real time across
 *   every open dashboard.
 *
 * `setLocked` writes through the elevated `/api/app-settings` endpoint, so only
 * payroll/admin (the wizard operator) can toggle it; the dispatch clerk reads.
 */
export interface WizardDispatchLockState {
  locked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
}

const EMPTY: WizardDispatchLockState = { locked: false, lockedAt: null, lockedBy: null };
const POLL_INTERVAL_MS = 30_000;

function lockKey(sourceFile: string): string {
  return `payroll.dispatch_lock.${sourceFile}`;
}

/** Parse the stored value (JSON object, legacy 'true'/'false', or null). */
function parseLock(value: string | null | undefined): WizardDispatchLockState {
  if (!value) return EMPTY;
  const trimmed = value.trim();
  if (trimmed === 'true') return { locked: true, lockedAt: null, lockedBy: null };
  if (trimmed === 'false' || trimmed === '') return EMPTY;
  try {
    const o = JSON.parse(trimmed) as Partial<WizardDispatchLockState>;
    return {
      locked: o.locked === true,
      lockedAt: o.lockedAt ?? null,
      lockedBy: o.lockedBy ?? null,
    };
  } catch {
    return EMPTY;
  }
}

interface UseWizardDispatchLockResult {
  state: WizardDispatchLockState;
  loading: boolean;
  /** Toggle the lock for this cycle (optimistic; reconciled via Realtime). */
  setLocked: (locked: boolean, by?: string | null) => Promise<void>;
}

/**
 * Subscribe to a cycle's lock flag. Pass the Hubstaff `sourceFile`; a null/empty
 * file leaves the hook inert (unlocked, not loading). Mount once per surface.
 */
export function useWizardDispatchLock(sourceFile: string | null | undefined): UseWizardDispatchLockResult {
  const [state, setState] = useState<WizardDispatchLockState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const instanceId = useId();
  const fileRef = useRef(sourceFile);
  fileRef.current = sourceFile;

  const refetch = useCallback(async () => {
    const file = fileRef.current;
    if (!file) {
      setState(EMPTY);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/app-settings?key=${encodeURIComponent(lockKey(file))}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as { value?: string | null };
      setState(parseLock(json.value));
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false);
    }
  }, []);

  // Hydrate on mount + whenever the cycle file changes.
  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [sourceFile, refetch]);

  // Realtime subscription scoped to this cycle's key.
  useEffect(() => {
    if (!sourceFile) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channelName = `wizard-dispatch-lock-${instanceId}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: `key=eq.${lockKey(sourceFile)}`,
        },
        () => {
          void refetch();
        },
      )
      .subscribe((status, err) => {
        // Surface channel health so a missing publication / RLS issue is obvious
        // in DevTools. SUBSCRIBED = live; otherwise the 30s poll covers it.
        if (status === 'SUBSCRIBED') {
          // eslint-disable-next-line no-console
          console.info(`[wizard-dispatch-lock] Realtime live (${lockKey(sourceFile)})`);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(
            `[wizard-dispatch-lock] Realtime ${status} — falling back to 30s poll. ` +
              `Ensure app_settings is in the supabase_realtime publication.`,
            err,
          );
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sourceFile, refetch, instanceId]);

  // Belt-and-braces poll + focus refetch in case Realtime is down.
  useEffect(() => {
    const id = window.setInterval(() => void refetch(), POLL_INTERVAL_MS);
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetch]);

  const setLocked = useCallback(
    async (locked: boolean, by?: string | null) => {
      const file = fileRef.current;
      if (!file) return;
      const next: WizardDispatchLockState = {
        locked,
        lockedAt: locked ? new Date().toISOString() : null,
        lockedBy: locked ? (by ?? null) : null,
      };
      setState(next); // optimistic
      try {
        const res = await fetch('/api/app-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: lockKey(file), value: JSON.stringify(next) }),
        });
        const json = (await res.json()) as { error?: string | null };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Could not update lock');
      } catch (e) {
        await refetch();
        throw e;
      }
    },
    [refetch],
  );

  return { state, loading, setLocked };
}
