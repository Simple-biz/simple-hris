/**
 * GET /api/admin/diagnostics/cycle-performance — Admin → Diagnostics → Payroll
 * Cycles. What fraction of the people each closed pay week owed money to
 * actually got paid.
 *
 * ONE source: the close-out records in `app_settings`. See
 * `src/lib/admin/cycle-performance.ts` for why `disbursement_records` and
 * `payment_dispatches` are not read here — both were measured against live data
 * on 2026-09-04 and both misreport fully-paid weeks.
 *
 * The series therefore begins at the first filed close-out (2026-08-10). Weeks
 * before that are not estimated, back-filled, or inferred — they simply do not
 * appear. Kane, 2026-09-04: *"only when we started."* `coverage.firstPeriodEnd`
 * is what the UI uses to say so.
 *
 * Authorization: the same admin gate as `/api/admin/diagnostics` — elevated
 * session AND the `admin` role, enforced server-side, so the data is unreachable
 * from a non-admin session even if the client tab gate is bypassed.
 *
 * Security: this route family returns AGGREGATES ONLY. A close-out record
 * contains the unpaid payees' names and emails; `listCycleCloseouts` already
 * projects those away (`CycleCloseoutSummary` drops `unpaid.payees`), and
 * nothing here re-introduces them. No name, no email, ever.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { listCycleCloseouts } from '@/lib/payroll/cycle-closeout-store';
import { buildCyclePerformance } from '@/lib/admin/cycle-performance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireAdmin() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return { ok: false as const, response: deniedResponse(authz) };
  const session = await getServerSession(authOptions);
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes('admin')) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Admin role required' }, { status: 403 }),
    };
  }
  return { ok: true as const };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { closeouts, unreadable, error } = await listCycleCloseouts();

  // A failed read is NOT an empty series. Zero closed cycles and "we could not
  // read the closed cycles" render identically on a percentage screen, and one
  // of them is a lie — so the error rides in the payload and the UI refuses to
  // draw a rate.
  if (error) {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), performance: null, unreadable: [], error },
      { status: 500 },
    );
  }

  const performance = buildCyclePerformance(closeouts);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    performance,
    /**
     * Close-out keys whose stored JSON would not parse. Surfaced, never hidden:
     * an unreadable record is a cycle missing from the denominator, which
     * silently improves the rate.
     */
    unreadable,
    error: null,
  });
}
