import { NextResponse } from 'next/server';
import {
  listApplied,
  saveDeptPeriodApplied,
  summarizeApplied,
  deleteAppliedPeriod,
  type AppliedBonusRow,
} from '@/lib/supabase/bonus-catalog-applied-db';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET — read applied catalog bonuses. Any authenticated employee may read
 * (middleware gates /api); the surfaces that consume it are permission-scoped.
 *   ?summary=1&depts=a,b        -> per-(dept,period) rollups for Bonus History
 *   ?dept=X&period_start=Y      -> rows for one dept-week (calculator / history view)
 *   ?depts=a,b&period_start=Y   -> rows across depts for a week (Payroll Wizard)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const summary = searchParams.get('summary');
    const deptsParam = searchParams.get('depts');
    const dept = searchParams.get('dept');
    const periodStart = searchParams.get('period_start');

    if (summary === '1') {
      const depts = (deptsParam ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const rows = await summarizeApplied(depts);
      return NextResponse.json({ rows, error: null });
    }

    const depts = deptsParam ? deptsParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const rows = await listApplied({
      dept: dept ?? undefined,
      depts,
      periodStart: periodStart ?? undefined,
    });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

/**
 * POST — replace the applied-bonus set for one (department, period). Managers
 * with edit access to the `hsl_bonus` feature may write; the actor's email is
 * recorded as `applied_by`.
 */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    department?: string;
    period_start?: string;
    period_end?: string;
    rows?: AppliedBonusRow[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.department || !body.period_start || !body.period_end || !Array.isArray(body.rows)) {
    return NextResponse.json(
      { error: 'department, period_start, period_end, rows required' },
      { status: 400 },
    );
  }

  const { saved, error } = await saveDeptPeriodApplied({
    department: body.department,
    periodStart: body.period_start,
    periodEnd: body.period_end,
    rows: body.rows,
    actor: authz.sessionEmail,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ saved, error: null });
}

/** DELETE — remove a whole dept-week (?dept=X&period_start=Y). */
export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const dept = searchParams.get('dept');
  const periodStart = searchParams.get('period_start');
  if (!dept || !periodStart) {
    return NextResponse.json({ error: 'dept and period_start required' }, { status: 400 });
  }
  const { error } = await deleteAppliedPeriod(dept, periodStart);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
