'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

const CHANNEL = 'payroll-wizard-follow';

type FollowMsg =
  | { kind: 'step';         email: string; step: number }
  | { kind: 'hello';        email: string }
  | { kind: 'lock_acquired'; email: string; step: number };

interface Args {
  selfEmail: string | null | undefined;
  driverEmail: string | null | undefined;
  isDriver: boolean;
  isSpectator: boolean;
  currentStep: number;
  onRemoteStep: (step: number) => void;
  /** Called immediately on spectators when lock_acquired is received,
   *  before Postgres Realtime confirms the lock state (~400ms earlier). */
  onLockAcquired?: (driverEmail: string, step: number) => void;
}

interface UseWizardFollowResult {
  broadcastLockAcquired: (step: number) => void;
}

export function useWizardFollow({
  selfEmail,
  driverEmail,
  isDriver,
  isSpectator,
  currentStep,
  onRemoteStep,
  onLockAcquired,
}: Args): UseWizardFollowResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef           = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendRef              = useRef<((msg: FollowMsg) => void) | null>(null);
  const stepRef              = useRef(currentStep);
  const isDriverRef          = useRef(isDriver);
  const isSpectatorRef       = useRef(isSpectator);
  const prevIsSpectatorRef   = useRef(isSpectator);
  const driverEmailRef       = useRef(driverEmail);
  const onRemoteStepRef      = useRef(onRemoteStep);
  const onLockAcqRef         = useRef(onLockAcquired);
  /** Last step received from the driver — cached even while observing=false
   *  so resume is instant with no round-trip. */
  const lastDriverStepRef    = useRef<number | null>(null);

  stepRef.current         = currentStep;
  isDriverRef.current     = isDriver;
  isSpectatorRef.current  = isSpectator;
  driverEmailRef.current  = driverEmail;
  onRemoteStepRef.current = onRemoteStep;
  onLockAcqRef.current    = onLockAcquired;

  // -- Subscribe once per selfEmail -- the channel stays open for the lifetime
  //    of the wizard session. Role/driver changes are handled via refs above,
  //    so there is no re-subscribe latency when the lock is acquired.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !selfEmail) return;

    const ch = supabase.channel(CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = ch;

    const send = (msg: FollowMsg) =>
      ch.send({ type: 'broadcast', event: 'wf', payload: msg });
    sendRef.current = send;

    ch.on('broadcast', { event: 'wf' }, ({ payload }: { payload: FollowMsg }) => {
      if (!payload?.email) return;

      const selfKey   = selfEmail.trim().toLowerCase();
      const senderKey = payload.email.trim().toLowerCase();
      if (senderKey === selfKey) return;

      if (payload.kind === 'lock_acquired') {
        lastDriverStepRef.current = payload.step;
        onLockAcqRef.current?.(payload.email, payload.step);
        onRemoteStepRef.current(payload.step);
        return;
      }

      const driverKey  = (driverEmailRef.current ?? '').trim().toLowerCase();
      const sameDriver = !!driverKey && senderKey === driverKey;

      if (payload.kind === 'step' && sameDriver) {
        // Always cache the driver's step, even while the spectator has opted out.
        lastDriverStepRef.current = payload.step;
        if (isSpectatorRef.current) {
          onRemoteStepRef.current(payload.step);
        }
      }

      // Driver answers a freshly-joined spectator (no cached step yet).
      if (payload.kind === 'hello' && isDriverRef.current) {
        void send({ kind: 'step', email: selfEmail, step: stepRef.current });
      }
    }).subscribe((status: string) => {
      if (status !== 'SUBSCRIBED') return;
      if (isSpectatorRef.current) void send({ kind: 'hello', email: selfEmail });
      if (isDriverRef.current)    void send({ kind: 'step',  email: selfEmail, step: stepRef.current });
    });

    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
      sendRef.current    = null;
    };
  }, [selfEmail]);

  // -- Detect isSpectator false->true transition (resume observing).
  //    Apply the cached driver step immediately -- no hello/step round-trip.
  useEffect(() => {
    const wasSpectator = prevIsSpectatorRef.current;
    prevIsSpectatorRef.current = isSpectator;

    if (!wasSpectator && isSpectator) {
      if (lastDriverStepRef.current !== null) {
        // We have a cached step -- apply it instantly.
        onRemoteStepRef.current(lastDriverStepRef.current);
      } else if (selfEmail && sendRef.current) {
        // Fresh join with no cache -- ask the driver.
        void sendRef.current({ kind: 'hello', email: selfEmail });
      }
    }
  }, [isSpectator, selfEmail]);

  // -- Driver: push every step change to spectators --
  useEffect(() => {
    if (!isDriver || !selfEmail || !sendRef.current) return;
    void sendRef.current({ kind: 'step', email: selfEmail, step: currentStep });
  }, [currentStep, isDriver, selfEmail]);

  const broadcastLockAcquired = useCallback((step: number) => {
    if (!selfEmail || !sendRef.current) return;
    void sendRef.current({ kind: 'lock_acquired', email: selfEmail, step });
  }, [selfEmail]);

  return { broadcastLockAcquired };
}
