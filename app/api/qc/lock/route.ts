import { NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listAllDepartmentManagers } from '@/lib/supabase/department-managers';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import {
  listQcAssignments,
  listQcOfficerLocks,
  setQcOfficerLock,
  QC_DEPT_KEYS,
} from '@/lib/supabase/qc-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

const QC_DEPT_SET = new Set<string>(QC_DEPT_KEYS);

/**
 * POST { period_start, status?: 'locked' | 'draft' }
 * A QC officer locks (or re-opens) their assigned batch for the week. On lock,
 * notifies the Leadgen/Callback/Discovery managers + admins so they can review.
 */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('qc', 'qc_calculator');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('QC scoring');
  if (processing) return processing;
  const officer = norm(authz.sessionEmail);

  let body: { period_start?: string; status?: 'locked' | 'draft' };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.period_start) {
    return NextResponse.json({ error: 'period_start required' }, { status: 400 });
  }
  const status = body.status === 'draft' ? 'draft' : 'locked';

  const assignments = await listQcAssignments(body.period_start);
  const memberCount = assignments.filter((a) => norm(a.qc_officer_email) === officer).length;

  // A QC officer with no assigned members for the week has nothing to lock —
  // block it so we don't pollute the lock log or fire a "0 members" notification.
  // Admins may still act (e.g. corrective unlock).
  if (status === 'locked' && memberCount === 0 && !(authz.roles ?? []).includes('admin')) {
    return NextResponse.json({ error: 'You have no members assigned to score this week.' }, { status: 403 });
  }

  // Detect the draft→locked transition so we only notify managers once (idempotent
  // re-locks / double-clicks must not re-notify).
  const wasLocked =
    (await listQcOfficerLocks(body.period_start)).find((l) => norm(l.qc_officer_email) === officer)?.status === 'locked';

  const { error } = await setQcOfficerLock({
    periodStart: body.period_start,
    officerEmail: officer,
    status,
    memberCount,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: officer,
    user_role: 'qc',
    action: status === 'locked' ? 'qc.scores.locked' : 'qc.scores.reopened',
    resource: 'qc_officer_locks',
    resource_id: `${body.period_start}:${officer}`,
    details: { period_start: body.period_start, member_count: memberCount },
  });

  // On a fresh lock, notify the QC department managers + admins so review can begin.
  if (status === 'locked' && !wasLocked) {
    void (async () => {
      try {
        const supabase = createSupabaseServiceRoleClient();
        if (!supabase) return;
        const { rows: dmRows } = await listAllDepartmentManagers();
        const recipients = new Set<string>();
        for (const dm of dmRows) {
          const k = normalizeDeptToKey(dm.department);
          if (k && QC_DEPT_SET.has(k)) {
            const e = norm(dm.manager_email);
            if (e) recipients.add(e);
          }
        }
        const { data: adminRows } = await supabase
          .from('employee_roles')
          .select('work_email')
          .in('role', ['admin'])
          .is('revoked_at', null);
        for (const r of (adminRows ?? []) as Array<{ work_email?: string | null }>) {
          const e = norm(r.work_email);
          if (e) recipients.add(e);
        }
        recipients.delete(officer);
        if (recipients.size === 0) return;
        await supabase.from('employee_notifications').insert(
          [...recipients].map((to) => ({
            recipient_email: to,
            type: 'qc.scores_submitted',
            tone: 'neutral',
            title: 'QC Scores Submitted',
            message: `A QC officer locked ${memberCount} member${memberCount === 1 ? '' : 's'} of KPI scores for the week of ${body.period_start}. Review them in the KPI Calculator.`,
            details: { period_start: body.period_start, member_count: memberCount },
          })),
        );
      } catch {
        /* non-fatal */
      }
    })();
  }

  return NextResponse.json({ status, memberCount, error: null });
}
