import { NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth/authorize-email';
import { syncHrisBoard } from '@/lib/monday/sync';
import { PLAN_EPICS, PLAN_TASKS } from '@/lib/monday/hris-plan';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Full reconcile is ~150 Monday mutations at 5-way concurrency (≈15–30 s).
export const maxDuration = 60;

/**
 * GET  /api/admin/monday-sync  — dry-run preview: what a sync would create,
 *                                plus the rollup numbers it would write.
 * POST /api/admin/monday-sync  — reconcile the live Monday boards against
 *                                src/lib/monday/hris-plan.ts.
 *
 * Semantics: missing items are created; existing items get structure patched
 * (SP / type / sprint / quarter / relations). Status + Actual SP of existing
 * items are never touched — the board owns execution state. Admin-only
 * (defense-in-depth on top of the /api/admin/* edge gate in proxy.ts).
 */
export async function GET() {
  const authz = await requireAdminSession();
  if (!authz.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  try {
    const report = await syncHrisBoard({ dryRun: true });
    return NextResponse.json({
      report,
      plan: { epics: PLAN_EPICS.length, tasks: PLAN_TASKS.length },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Monday preview failed' },
      { status: 502 },
    );
  }
}

export async function POST() {
  const authz = await requireAdminSession();
  if (!authz.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  try {
    const report = await syncHrisBoard({ dryRun: false });
    return NextResponse.json({ report });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Monday sync failed' },
      { status: 502 },
    );
  }
}
