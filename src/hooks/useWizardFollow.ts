'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Collaborative "oversee" / follow mode for the Payroll Wizard.
 *
 * When processing is started (dispatch lock acquired), the operator who toggled
 * it becomes the "driver". Everyone else viewing the wizard becomes a
 * "spectator" whose step view mirrors the driver in real time, so the
 * accounting head can watch — in third person — how the operator works through
 * the wizard. The driver themselves is never a spectator.
 *
 * This hook only synchronises the active wizard step over a Supabase broadcast
 * channel. Cursor/click/save visuals are handled separately by
 * WizardCursorOverlay. The read-only blocking + observe banner live in the
 * PayrollWizard render.
 */

const CHANNEL = 'payroll-wizard-follow';

type FollowMsg =
  | { kind: 'step'; email: string; step: number }
  | { kind: 'hello'; email: string };

interface Args {
  selfEmail: string | null | undefined;
  /** Email of the operator who acquired the dispatch lock (the driver). */
  driverEmail: string | null | undefined;
  /** This client is the driver — broadcasts its step to spectators. */
  isDriver: boolean;
  /** This client is following the driver — mirrors the driver's step. */
  isSpectator: boolean;
  /** Current wizard step on this client (only meaningful for the driver). */
  currentStep: number;
  /** Called on spectators when the driver moves to a new step. */
  onRemoteStep: (step: number) => void;
}

export function useWizardFollow({
  selfEmail,
  driverEmail,
  isDriver,
  isSpectator,
  currentStep,
  onRemoteStep,
}: Args) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const stepRef = useRef(currentStep);
  const onRemoteStepRef = useRef(onRemoteStep);
  stepRef.current = currentStep;
  onRemoteStepRef.current = onRemoteStep;

  // (Re)subscribe whenever the participant's role or the driver changes.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !selfEmail) return;
    if (!isDriver && !isSpectator) return;

    const ch = supabase.channel(CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = ch;

    const send = (msg: FollowMsg) =>
      ch.send({ type: 'broadcast', event: 'wf', payload: msg });

    ch.on('broadcast', { event: 'wf' }, ({ payload }: { payload: FollowMsg }) => {
      if (!payload?.email) return;

      // Spectators mirror only the driver they are locked onto.
      const sameDriver =
        !!driverEmail &&
        payload.email.trim().toLowerCase() === driverEmail.trim().toLowerCase();
      if (isSpectator && payload.kind === 'step' && sameDriver) {
        onRemoteStepRef.current(payload.step);
      }

      // Driver answers a freshly-joined spectator with its current step so the
      // spectator snaps to the right place without waiting for the next move.
      if (isDriver && payload.kind === 'hello') {
        void send({ kind: 'step', email: selfEmail, step: stepRef.current });
      }
    }).subscribe((status: string) => {
      if (status !== 'SUBSCRIBED') return;
      if (isSpectator) void send({ kind: 'hello', email: selfEmail });
      if (isDriver) void send({ kind: 'step', email: selfEmail, step: stepRef.current });
    });

    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [selfEmail, driverEmail, isDriver, isSpectator]);

  // Driver: push every step change to spectators.
  useEffect(() => {
    if (!isDriver || !selfEmail) return;
    const ch = channelRef.current;
    if (!ch) return;
    void ch.send({
      type: 'broadcast',
      event: 'wf',
      payload: { kind: 'step', email: selfEmail, step: currentStep },
    });
  }, [currentStep, isDriver, selfEmail]);
}
