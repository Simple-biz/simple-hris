'use client';

import { useSession } from 'next-auth/react';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import DispatchPaidToasts from '@/components/accounting/DispatchPaidToasts';

/**
 * Root-layout mount of the lower-left "X paid Y $Z" toast, so it shows on EVERY
 * dashboard (Kane, 2026-09-02: "elevated users should see this on every
 * dashboard if they have Accounting View access, not Edit").
 *
 * Who sees it is decided by the SERVER, not here: the hook's first poll of
 * `/api/payment-dispatches/recent-paid` is the probe — 200 = authorized
 * (a view-or-better grant on Accounting → Payment Dispatch, or admin), 401/403 =
 * nothing ever renders. This component only refuses to run at all without a
 * signed-in session, so public pages (login, onboarding) never probe or
 * subscribe.
 */
export default function DispatchPaidToastsGlobal() {
  const { data: session } = useSession();
  const email = session?.user?.email?.trim().toLowerCase() || null;
  if (!email) return null;
  return <DispatchPaidToastsMounted selfEmail={email} />;
}

function DispatchPaidToastsMounted({ selfEmail }: { selfEmail: string }) {
  const { state } = useDispatchLock();
  return <DispatchPaidToasts locked={state.locked} selfEmail={selfEmail} />;
}
