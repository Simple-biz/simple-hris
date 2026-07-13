import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import {
  listQcSubmissions,
  saveQcSubmissions,
  listQcAssignments,
} from '@/lib/supabase/qc-db';
import type { AppliedBonusRow } from '@/lib/supabase/bonus-catalog-applied-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * GET — read STAGED QC scores.
 *   ?dept=X&period_start=Y     -> one dept-week (QC calc reload + manager prefill)
 *   ?depts=a,b&period_start=Y  -> across depts for a week
 * Readable by QC officers, the dept managers, and admins.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const roles = user?.roles ?? [];
  if (!norm(user?.email)) return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });
  if (!(roles.includes('qc') || roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ rows: [], error: 'QC, manager, or admin role required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const dept = searchParams.get('dept');
  const deptsParam = searchParams.get('depts');
  const periodStart = searchParams.get('period_start');
  const depts = deptsParam ? deptsParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  const rows = await listQcSubmissions({
    dept: dept ?? undefined,
    depts,
    periodStart: periodStart ?? undefined,
  });
  return NextResponse.json({ rows, error: null });
}

/**
 * POST — a QC officer saves their OWN staged scores for a (department, period).
 * The officer's email is recorded as `scored_by`. Rows are validated against the
 * officer's assignment so one officer can't overwrite another's members.
 */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('qc', 'qc_calculator');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('QC scoring');
  if (processing) return processing;
  const scoredBy = norm(authz.sessionEmail);

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
    return NextResponse.json({ error: 'department, period_start, period_end, rows required' }, { status: 400 });
  }

  // Guard: every row must be for a member assigned to THIS officer this week, so
  // an officer can't clobber a teammate's members (the upsert is keyed by member).
  // Admins bypass (they may hold the qc feature via bypass but have no assignment).
  if (!(authz.roles ?? []).includes('admin')) {
    const assignments = await listQcAssignments(body.period_start);
    const mine = new Set(
      assignments.filter((a) => norm(a.qc_officer_email) === scoredBy).map((a) => norm(a.member_email)),
    );
    const stray = body.rows.find((r) => !mine.has(norm(r.employeeEmail)));
    if (stray) {
      return NextResponse.json(
        { error: `Not assigned to score ${stray.employeeEmail} this period.` },
        { status: 403 },
      );
    }
  }

  const { saved, error } = await saveQcSubmissions({
    department: body.department,
    periodStart: body.period_start,
    periodEnd: body.period_end,
    rows: body.rows,
    scoredBy,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ saved, error: null });
}
