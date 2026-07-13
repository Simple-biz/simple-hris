import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  listQcReviewStatus,
  setQcReviewStatus,
  listQcAssignments,
  listManagedQcDepts,
} from '@/lib/supabase/qc-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** GET ?period_start= — per-dept review status for a week (qc/manager/admin). */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const roles = user?.roles ?? [];
  if (!norm(user?.email)) return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });
  if (!(roles.includes('qc') || roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ rows: [], error: 'QC, manager, or admin role required' }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const periodStart = searchParams.get('period_start');
  if (!periodStart) return NextResponse.json({ rows: [], error: 'period_start required' }, { status: 400 });
  let rows = await listQcReviewStatus(periodStart);
  // A plain dept manager only sees the review status for departments they manage.
  // Admins and QC officers (scorers) see all QC departments.
  if (!roles.includes('admin') && !roles.includes('qc')) {
    const managed = new Set(await listManagedQcDepts(norm(user?.email)));
    rows = rows.filter((r) => managed.has(r.department));
  }
  return NextResponse.json({ rows, error: null });
}

/**
 * POST { period_start, department, status: 'accepted'|'returned'|'pending', note? }
 * The dept manager records their decision. On `returned`, the assigned QC
 * officers for that dept-week are notified to revise.
 */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('QC review');
  if (processing) return processing;
  const reviewer = norm(authz.sessionEmail);

  let body: {
    period_start?: string;
    department?: string;
    status?: 'accepted' | 'returned' | 'pending';
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.period_start || !body.department || !body.status) {
    return NextResponse.json({ error: 'period_start, department, status required' }, { status: 400 });
  }
  if (!['accepted', 'returned', 'pending'].includes(body.status)) {
    return NextResponse.json({ error: 'status must be accepted | returned | pending' }, { status: 400 });
  }

  // A manager may only act on the department(s) they actually manage. Without
  // this, any manager with hsl_bonus edit could accept/return another dept's QC.
  // Admins bypass. `department` arrives as a dept key (lead_gen/callback/discovery).
  if (!(authz.roles ?? []).includes('admin')) {
    const managed = await listManagedQcDepts(reviewer);
    if (!managed.includes(body.department)) {
      return NextResponse.json(
        { error: 'You are not the manager of this department.' },
        { status: 403 },
      );
    }
  }

  // Only notify on an actual transition INTO 'returned' (idempotent re-posts and
  // double-clicks must not spam the officers).
  const wasReturned =
    body.status === 'returned' &&
    (await listQcReviewStatus(body.period_start)).find((r) => r.department === body.department)?.status === 'returned';

  const { error } = await setQcReviewStatus({
    periodStart: body.period_start,
    department: body.department,
    status: body.status,
    reviewedBy: reviewer,
    note: body.note ?? null,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: reviewer,
    user_role: 'manager',
    action: `qc.review.${body.status}`,
    resource: 'qc_review_status',
    resource_id: `${body.period_start}:${body.department}`,
    details: { period_start: body.period_start, department: body.department, note: body.note ?? null },
  });

  // On a fresh return, notify the QC officers responsible for this dept-week.
  if (body.status === 'returned' && !wasReturned) {
    void (async () => {
      try {
        const supabase = createSupabaseServiceRoleClient();
        if (!supabase) return;
        const assignments = await listQcAssignments(body.period_start!);
        const officers = new Set(
          assignments
            .filter((a) => a.department === body.department)
            .map((a) => norm(a.qc_officer_email))
            .filter(Boolean),
        );
        officers.delete(reviewer);
        if (officers.size === 0) return;
        await supabase.from('employee_notifications').insert(
          [...officers].map((to) => ({
            recipient_email: to,
            type: 'qc.scores_returned',
            tone: 'alert',
            title: 'QC Scores Returned',
            message: `The manager returned the ${body.department} KPI scores for the week of ${body.period_start} for revision.${body.note ? ` Note: ${body.note}` : ''}`,
            details: { period_start: body.period_start, department: body.department, note: body.note ?? null },
          })),
        );
      } catch {
        /* non-fatal */
      }
    })();
  }

  return NextResponse.json({ status: body.status, error: null });
}
