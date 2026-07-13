import { NextResponse } from 'next/server';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';

/**
 * Server-side counterpart of the KPI/QC dashboard takeover: while the Payroll
 * Wizard's "Start processing" lock (`payroll.dispatch_locked`) is on, every
 * KPI/QC score mutation is rejected with 423 so the numbers being paid can't
 * shift mid-cycle — even from a stale tab or a hand-crafted request. Call at
 * the top of a route's POST/DELETE (after authz); returns null when writes may
 * proceed. Reads (GET) stay open — the Payroll Wizard itself consumes them.
 */
export async function rejectWhilePayrollProcessing(
  surface: string,
): Promise<NextResponse | null> {
  const lock = await getPayrollDispatchLock();
  if (!lock.locked) return null;
  return NextResponse.json(
    {
      error: `Payroll is being processed right now, so ${surface} is temporarily locked. Please try again once processing is complete.`,
    },
    { status: 423 },
  );
}
