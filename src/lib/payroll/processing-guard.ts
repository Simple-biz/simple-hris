import 'server-only';

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';

/**
 * Server-side counterpart of the KPI/QC dashboard takeover: while the Payroll
 * Wizard's "Start processing" lock (`payroll.dispatch_locked`) is on, every
 * KPI/QC score mutation is rejected with 423 so the numbers being paid can't
 * shift mid-cycle — even from a stale tab or a hand-crafted request. Call at
 * the top of a route's POST/DELETE (after authz); returns null when writes may
 * proceed. Reads (GET) stay open — the Payroll Wizard itself consumes them.
 *
 * Admins bypass the lock: the `admin` role is trusted to correct numbers even
 * mid-cycle (same bypass the per-feature authorizer grants in
 * `authorize-feature.ts`). The lock exists to stop *other* operators from
 * shifting figures out from under an in-flight payroll run, not to fence out
 * the admin driving it.
 */
export async function rejectWhilePayrollProcessing(
  surface: string,
): Promise<NextResponse | null> {
  const lock = await getPayrollDispatchLock();
  if (!lock.locked) return null;

  // Admin bypass — resolve roles straight from the NextAuth JWT (no DB hit).
  try {
    const session = await getServerSession(authOptions);
    const roles = (session?.user as { roles?: string[] } | undefined)?.roles ?? [];
    if (roles.includes('admin')) return null;
  } catch {
    // If the session can't be resolved, fall through to the locked response —
    // failing closed keeps the guard's guarantee intact.
  }

  return NextResponse.json(
    {
      error: `Payroll is being processed right now, so ${surface} is temporarily locked. Please try again once processing is complete.`,
    },
    { status: 423 },
  );
}
