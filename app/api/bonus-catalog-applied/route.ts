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
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { notifyKpiScored } from '@/lib/notifications/kpi-scored';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET — read applied catalog bonuses. Any authenticated employee may read
 * (middleware gates /api); the surfaces that consume it are permission-scoped.
 *   ?summary=1&depts=a,b        -> per-(dept,period) rollups for Bonus History
 *                                  (+ &period_start=Y to scope to one pay week)
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
      // `period_start` is optional here: Bonus History wants every period, while
      // one-week callers (the Overview "Bonuses to score" panel) scope the query
      // so the DB doesn't return the whole applied-bonus history.
      const rows = await summarizeApplied(depts, periodStart ?? undefined);
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
  const processing = await rejectWhilePayrollProcessing('the KPI Calculator');
  if (processing) return processing;

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

  // This POST is also the KPI Calculator's autosave path, so it fires on every
  // score save — the notify helper makes that safe: it returns immediately
  // unless the dept-week is ALREADY ready/locked, and then notifies only people
  // whose visible total actually changed (a disputed bonus re-ordered onto a
  // published week — Kane's 2026-08-17 re-notify rule). Best-effort.
  try {
    await notifyKpiScored({ department: body.department, periodStart: body.period_start });
  } catch (e) {
    console.warn('[kpi.scored] notify on applied-bonus save failed:', e);
  }

  return NextResponse.json({ saved, error: null });
}

/** DELETE — remove a whole dept-week (?dept=X&period_start=Y). */
export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('the KPI Calculator');
  if (processing) return processing;

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
