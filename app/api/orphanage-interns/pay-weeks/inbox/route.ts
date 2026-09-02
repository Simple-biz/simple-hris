import { NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { listInternPayByStatus, listInternPayDispatchState } from '@/lib/supabase/orphanage-intern-pay-db';
import { reconcileInternPayRow } from '@/lib/interns/intern-week-pay';
import type { InternInboxRow, InternInboxWeek } from '@/lib/interns/intern-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * GET /api/orphanage-interns/pay-weeks/inbox
 *
 * Accounting's view of every locked intern week, grouped by file, with each
 * row RE-DERIVED from its own hours_by_day × rates on read. A disagreement with
 * the stored amount is reported (`reconcile.status`), never rewritten — the
 * `reconcileLockedOrphanageAmount` rule from day one. Dispatch state is joined
 * so a paid row is visible before anyone tries to reopen it.
 */
export async function GET() {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await listInternPayByStatus(['submitted', 'accepted', 'rejected']);
  if (error) return NextResponse.json({ weeks: [], error }, { status: 500 });
  const { byId, error: dErr } = await listInternPayDispatchState(rows.map((r) => r.id));
  if (dErr) return NextResponse.json({ weeks: [], error: dErr }, { status: 500 });

  const byFile = new Map<string, InternInboxRow[]>();
  for (const r of rows) {
    const list = byFile.get(r.source_file) ?? [];
    list.push({ ...r, reconcile: reconcileInternPayRow(r), dispatch: byId.get(r.id) ?? null });
    byFile.set(r.source_file, list);
  }

  const weeks: InternInboxWeek[] = [...byFile.entries()].map(([sourceFile, list]) => {
    const first = list[0];
    return {
      sourceFile,
      weekStart: first.week_start,
      weekEnd: first.week_end,
      status: first.status,
      submittedBy: first.submitted_by,
      submittedAt: first.submitted_at,
      decidedBy: first.decided_by,
      decidedAt: first.decided_at,
      decisionNote: first.decision_note,
      rows: list,
      totals: {
        interns: list.length,
        hoursPaid: round2(list.reduce((s, r) => s + r.hours_paid, 0)),
        payPhp: round2(list.reduce((s, r) => s + r.pay_php, 0)),
        pabPhp: round2(list.reduce((s, r) => s + r.pab_php, 0)),
        grossPhp: round2(list.reduce((s, r) => s + r.gross_php, 0)),
        orphanagePhp: round2(list.reduce((s, r) => s + r.orphanage_share_php, 0)),
        internPhp: round2(list.reduce((s, r) => s + r.intern_share_php, 0)),
      },
      mismatches: list.filter((r) => r.reconcile.status !== 'ok').length,
      paidRows: list.filter((r) => r.dispatch?.paid).length,
    };
  });
  weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));

  return NextResponse.json({ weeks, error: null });
}
