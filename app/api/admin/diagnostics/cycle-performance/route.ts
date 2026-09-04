/**
 * GET /api/admin/diagnostics/cycle-performance — Admin → Diagnostics → Payroll
 * Cycles. What fraction of the people each closed pay week owed money to
 * actually got paid.
 *
 * ONE source for the RATE: the close-out records in `app_settings`. See
 * `src/lib/admin/cycle-performance.ts` for why no rate is derived from
 * `disbursement_records` or `payment_dispatches` — both were measured against
 * live data on 2026-09-04 and both misreport fully-paid weeks.
 *
 * Cycles that were never closed ARE listed (Kane, 2026-09-04: *"can we add the
 * unclosed? ... and still add the data in there"*), with their real paid
 * figures from `listObservedCycles` and **no denominator, therefore no rate**.
 * They never enter a month's or the all-time total's denominator. That split is
 * enforced in the pure builder, not here.
 *
 * A cycle observed under a source file that also has a close-out is dropped by
 * the builder — the declaration outranks the observation, so no week is ever
 * listed twice.
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
import { listObservedCycles } from '@/lib/payroll/cycle-inventory';
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

  const [closeoutRes, observedRes] = await Promise.all([
    listCycleCloseouts(),
    listObservedCycles(),
  ]);
  const { closeouts, unreadable, error } = closeoutRes;

  // A failed close-out read is NOT an empty series. Zero closed cycles and "we
  // could not read the closed cycles" render identically on a percentage
  // screen, and one of them is a lie — so the error rides in the payload and
  // the UI refuses to draw a rate.
  if (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        performance: null,
        unreadable: [],
        inventoryError: null,
        error,
      },
      { status: 500 },
    );
  }

  // The inventory is the opposite case and degrades rather than failing: it
  // only ADDS undeclared rows. Losing it costs visibility of unclosed cycles;
  // it cannot corrupt a rate, because those rows carry no denominator. The
  // error is still surfaced so the tab can say the list may be incomplete —
  // a silently short list of unclosed cycles reads as "we closed everything".
  const performance = buildCyclePerformance(closeouts, observedRes.cycles);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    performance,
    /**
     * Close-out keys whose stored JSON would not parse. Surfaced, never hidden:
     * an unreadable record is a cycle missing from the denominator, which
     * silently improves the rate.
     */
    unreadable,
    inventoryError: observedRes.error,
    error: null,
  });
}
