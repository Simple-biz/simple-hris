import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { listManagersForDepartment, splitManagerEmails } from '@/lib/supabase/leave-requests';
import {
  insertOffboardingQueueEntries,
  findEmailsWithActiveOffboarding,
} from '@/lib/supabase/offboarding-queue';
import {
  getResignationRequestById,
  decideResignationRequest,
  cancelResignationRequestIfOwned,
  type ResignationRequestRow,
} from '@/lib/supabase/resignation-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[]; name?: string | null } | null } | null;

/** Active work emails for everyone holding one of `roles`. Used to notify HR. */
async function recipientsForRoles(roles: string[]): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data } = await supabase
    .from('employee_roles')
    .select('work_email, role')
    .in('role', roles)
    .is('revoked_at', null);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ work_email?: string | null }>) {
    const e = (r.work_email ?? '').trim().toLowerCase();
    if (e) out.add(e);
  }
  return Array.from(out);
}

/** Whether `actor` is a manager of the resignation's department (or admin). */
async function isAuthorizedApprover(
  actor: string,
  roles: string[],
  row: ResignationRequestRow,
): Promise<boolean> {
  if (roles.includes('admin')) return true;
  const a = normEmail(actor) ?? actor.toLowerCase();
  if (!a) return false;
  if (splitManagerEmails(row.manager_email).includes(a)) return true;
  const live = await listManagersForDepartment(row.department);
  return live.includes(a);
}

/**
 * PATCH — advance a single resignation.
 *   action 'cancel'  : the employee withdraws their own pending request.
 *   action 'reject'  : the department manager declines (note = reason, required).
 *   action 'approve' : the department manager accepts → the person is inserted
 *                      into the offboarding_queue (reason 'resigned') so HR can
 *                      process the offboarding, and the queue id is linked back.
 * Body: { action, note? }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const session = (await getServerSession(authOptions)) as SessionLike;
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const body = (await request.json()) as { action?: string; note?: string | null };
    const action = body.action?.trim();
    const note = body.note?.trim() || null;

    const { row, error: fetchErr } = await getResignationRequestById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    // ── Employee self-withdraw ──
    if (action === 'cancel') {
      const owns = [row.employee_email, row.employee_work_email, row.employee_personal_email]
        .map((e) => normEmail(e ?? '') ?? '')
        .some((e) => e && e === sessionEmail);
      if (!owns) {
        return NextResponse.json({ error: 'Only the employee who filed this can withdraw it' }, { status: 403 });
      }
      if (row.status !== 'pending') {
        return NextResponse.json({ error: `Request is already ${row.status}` }, { status: 409 });
      }
      const { updated, error } = await cancelResignationRequestIfOwned({ id, emails: [sessionEmail] });
      if (error) return NextResponse.json({ error }, { status: 500 });
      if (updated === 0) {
        return NextResponse.json({ error: `Request is already ${row.status}` }, { status: 409 });
      }
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: 'Employee',
        action: 'resignation.cancelled',
        resource: 'resignation_requests',
        resource_id: id,
        details: { department: row.department },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── Manager decision (approve / reject) ──
    const authz = await requireFeatureEdit('manager', 'team');
    if (!authz.ok) return deniedResponse(authz);
    const roles = (authz as { roles?: string[] }).roles ?? [];

    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: "action must be 'approve', 'reject', or 'cancel'" }, { status: 400 });
    }
    if (action === 'reject' && !note) {
      return NextResponse.json({ error: 'A reason is required to reject' }, { status: 400 });
    }
    if (row.status !== 'pending') {
      return NextResponse.json({ error: `Request is already ${row.status}` }, { status: 409 });
    }
    if (!(await isAuthorizedApprover(sessionEmail, roles, row))) {
      return NextResponse.json(
        { error: 'Only a manager of this department can action this resignation.' },
        { status: 403 },
      );
    }

    const supabase = createSupabaseServiceRoleClient();
    const who = row.employee_name ?? row.employee_email;

    // ── Reject ──
    if (action === 'reject') {
      const { updated, error } = await decideResignationRequest({
        id,
        status: 'rejected',
        approver_email: sessionEmail,
        approver_note: note,
        offboarding_queue_id: null,
      });
      if (error) return NextResponse.json({ error }, { status: 500 });
      if (updated === 0) {
        return NextResponse.json({ error: 'Request was already processed by someone else' }, { status: 409 });
      }
      if (supabase) {
        await supabase.from('employee_notifications').insert({
          recipient_email: row.employee_email,
          type: 'resignation.rejected',
          tone: 'neutral',
          title: 'Resignation Declined',
          message: `Your manager declined your resignation${note ? `: "${note}"` : '.'}`,
          details: { request_id: id, processed_by: sessionEmail, note },
        });
      }
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: roles.includes('admin') ? 'Admin' : 'Manager',
        action: 'resignation.rejected',
        resource: 'resignation_requests',
        resource_id: id,
        details: { employee_email: row.employee_email, department: row.department, note },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── Approve → claim atomically, then queue for offboarding ──
    const { updated, error: decideErr } = await decideResignationRequest({
      id,
      status: 'approved',
      approver_email: sessionEmail,
      approver_note: note,
      offboarding_queue_id: null,
    });
    if (decideErr) return NextResponse.json({ error: decideErr }, { status: 500 });
    if (updated === 0) {
      return NextResponse.json({ error: 'Request was already processed by someone else' }, { status: 409 });
    }

    // Best identifying email (personal preferred), matching the offboarding POST.
    const identifying =
      normEmail(row.employee_personal_email ?? '') ||
      normEmail(row.employee_work_email ?? '') ||
      normEmail(row.employee_email ?? '') ||
      row.employee_email;

    // Skip the offboarding insert if the person already has an in-flight entry.
    const occupied = await findEmailsWithActiveOffboarding(
      [identifying, row.employee_work_email, row.employee_personal_email].filter(Boolean) as string[],
    );
    const alreadyQueued = [identifying, row.employee_work_email, row.employee_personal_email]
      .filter(Boolean)
      .some((e) => occupied.has(normEmail(e as string) ?? ''));

    let queuedId: string | null = null;
    if (!alreadyQueued) {
      const note_ = `Resigned — effective ${row.effective_date.slice(0, 10)}.${
        row.message ? ` Employee note: "${row.message}"` : ''
      }`;
      const { rows: qrows, error: qErr } = await insertOffboardingQueueEntries({
        entries: [
          {
            employee_email: identifying,
            employee_name: row.employee_name,
            employee_work_email: row.employee_work_email,
            employee_personal_email: row.employee_personal_email,
            department: row.department,
            reason: 'resigned',
            note: note_,
          },
        ],
        requested_by: sessionEmail,
        requested_by_name: session?.user?.name ?? null,
      });
      if (qErr) return NextResponse.json({ error: qErr }, { status: 500 });
      queuedId = qrows[0]?.id ?? null;

      // Link the queue row back onto the resignation for traceability.
      if (queuedId && supabase) {
        await supabase
          .from('resignation_requests')
          .update({ offboarding_queue_id: queuedId, updated_at: new Date().toISOString() })
          .eq('id', id);
      }

      // Notify HR/admins so their offboarding queue badge lights up.
      if (supabase) {
        const recipients = await recipientsForRoles(['hr_coordinator', 'admin']);
        if (recipients.length > 0) {
          await supabase.from('employee_notifications').insert(
            recipients.map((to) => ({
              recipient_email: to,
              type: 'offboarding.requested',
              tone: 'neutral',
              title: 'Offboarding Request',
              message: `${who} resigned (approved by ${sessionEmail}) — queued for offboarding.`,
              details: {
                count: 1,
                requested_by: sessionEmail,
                request_ids: queuedId ? [queuedId] : [],
                employees: [{ name: row.employee_name, email: identifying, reason: 'resigned' }],
                source: 'resignation',
              },
            })),
          );
        }
      }
    }

    // Notify the employee their resignation was approved.
    if (supabase) {
      await supabase.from('employee_notifications').insert({
        recipient_email: row.employee_email,
        type: 'resignation.approved',
        tone: 'neutral',
        title: 'Resignation Approved',
        message: `Your manager approved your resignation (effective ${row.effective_date.slice(0, 10)}). HR will handle your offboarding.`,
        details: {
          request_id: id,
          processed_by: sessionEmail,
          effective_date: row.effective_date.slice(0, 10),
          offboarding_queue_id: queuedId,
        },
      });
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: roles.includes('admin') ? 'Admin' : 'Manager',
      action: 'resignation.approved',
      resource: 'resignation_requests',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        department: row.department,
        effective_date: row.effective_date.slice(0, 10),
        offboarding_queue_id: queuedId,
        already_queued: alreadyQueued,
        note,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, offboarding_queue_id: queuedId, already_queued: alreadyQueued, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
