import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { isValidOffboardReason } from '@/lib/hr/offboard-reasons';
import { fireOffboardWebhook, MANAGER_OFFBOARD_NOTIFY_SLUG } from '@/lib/hr/offboard-webhooks';
import {
  insertOffboardingQueueEntries,
  listAllOffboardingQueue,
  listOffboardingQueueByRequester,
  findEmailsWithActiveOffboarding,
  setOffboardingQueueBatchStatus,
  type NewOffboardingQueueEntry,
} from '@/lib/supabase/offboarding-queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[]; name?: string | null } | null } | null;
function rolesOf(session: SessionLike): string[] {
  return (session?.user?.roles ?? []) as string[];
}

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

/**
 * GET — list offboarding-queue rows.
 *   HR (hr_coordinator) / admin -> every row (the HR queue).
 *   manager                     -> their own raised requests (My Team badges).
 */
export async function GET() {
  const session = (await getServerSession(authOptions)) as SessionLike;
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });

  const roles = rolesOf(session);
  const isHr = roles.includes('hr_coordinator') || roles.includes('admin');
  const isManager = roles.includes('manager');

  if (isHr) {
    const { rows, error } = await listAllOffboardingQueue();
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, scope: 'all', error: null });
  }
  if (isManager) {
    const { rows, error } = await listOffboardingQueueByRequester(sessionEmail);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, scope: 'mine', error: null });
  }
  return NextResponse.json({ rows: [], error: 'Manager, HR, or admin role required' }, { status: 403 });
}

type IncomingItem = {
  employee_name?: string | null;
  employee_work_email?: string | null;
  employee_personal_email?: string | null;
  department?: string | null;
  reason?: string | null;
  note?: string | null;
};

/** POST — a manager queues one or more people for offboarding (sent to HR). */
export async function POST(request: Request) {
  try {
    const authz = await requireFeatureEdit('manager', 'team');
    if (!authz.ok) return deniedResponse(authz);

    const session = (await getServerSession(authOptions)) as SessionLike;
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const roles = rolesOf(session);
    const isManager = roles.includes('manager');
    const isAdmin = roles.includes('admin');
    if (!isManager && !isAdmin) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const body = (await request.json()) as { items?: IncomingItem[] };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return NextResponse.json({ error: 'No people selected' }, { status: 400 });
    }
    if (items.length > 100) {
      return NextResponse.json({ error: 'Too many people in one request (max 100)' }, { status: 400 });
    }

    // A department-scoped manager may only offboard people out of departments
    // they manage. Admins (and managers with no explicit assignments) unrestricted.
    let managedDepartments: string[] = [];
    if (!isAdmin) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      managedDepartments = assigns.map((a) => a.department.trim()).filter(Boolean);
    }
    const enforceScope = !isAdmin && managedDepartments.length > 0;

    // Normalize + validate each item.
    const prepared: (NewOffboardingQueueEntry & { _key: string })[] = [];
    for (const it of items) {
      const workEmail = normEmail(it.employee_work_email ?? '') || null;
      const personalEmail = normEmail(it.employee_personal_email ?? '') || null;
      const identifying = personalEmail ?? workEmail;
      const reason = (it.reason ?? '').trim();
      const note = (it.note ?? '').trim() || null;
      const dept = (it.department ?? '').trim() || null;

      if (!identifying) {
        return NextResponse.json({ error: 'Every selected person needs an email' }, { status: 400 });
      }
      if (!isValidOffboardReason(reason)) {
        return NextResponse.json(
          { error: `Invalid reason for ${it.employee_name ?? identifying}` },
          { status: 400 },
        );
      }
      if (reason === 'other' && !note) {
        return NextResponse.json(
          { error: `A note is required when the reason is "Other" (${it.employee_name ?? identifying})` },
          { status: 400 },
        );
      }
      if (enforceScope && !departmentMatchesManagedAssignments(dept ?? '', managedDepartments)) {
        return NextResponse.json(
          { error: `You can only offboard people in departments you manage (${it.employee_name ?? identifying})` },
          { status: 403 },
        );
      }
      prepared.push({
        _key: identifying,
        employee_email: identifying,
        employee_name: it.employee_name?.trim() || null,
        employee_work_email: workEmail,
        employee_personal_email: personalEmail,
        department: dept,
        reason,
        note,
      });
    }

    // Skip anyone who already has an in-flight (pending/processing) request.
    const candidateEmails = prepared.flatMap((p) =>
      [p.employee_email, p.employee_work_email, p.employee_personal_email].filter(Boolean) as string[],
    );
    const occupied = await findEmailsWithActiveOffboarding(candidateEmails);
    const isOccupied = (p: NewOffboardingQueueEntry) =>
      [p.employee_email, p.employee_work_email, p.employee_personal_email]
        .filter(Boolean)
        .some((e) => occupied.has((e as string)));

    const toInsert = prepared.filter((p) => !isOccupied(p));
    const skipped = prepared.length - toInsert.length;

    if (toInsert.length === 0) {
      return NextResponse.json(
        { success: true, inserted: 0, skipped, error: null, message: 'Everyone selected is already in the offboarding queue.' },
      );
    }

    const { rows, error } = await insertOffboardingQueueEntries({
      entries: toInsert,
      requested_by: sessionEmail,
      requested_by_name: session?.user?.name ?? null,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Notify HR (+ admins) that requests are waiting.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase) {
      const recipients = await recipientsForRoles(['hr_coordinator', 'admin']);
      if (recipients.length > 0) {
        const names = rows.map((r) => r.employee_name ?? r.employee_email);
        const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
        await supabase.from('employee_notifications').insert(
          recipients.map((to) => ({
            recipient_email: to,
            type: 'offboarding.requested',
            tone: 'neutral',
            title: rows.length === 1 ? 'Offboarding Request' : `${rows.length} Offboarding Requests`,
            message: `${session?.user?.name?.trim() || sessionEmail} requested offboarding for ${preview}.`,
            details: {
              count: rows.length,
              requested_by: sessionEmail,
              request_ids: rows.map((r) => r.id),
              employees: rows.map((r) => ({ name: r.employee_name, email: r.employee_email, reason: r.reason })),
            },
          })),
        );
      }
    }

    // Best-effort n8n notification: email alissar@simple.biz the COUNT only (no
    // names) that a manager wants to offboard someone. Fires on the actual insert
    // count for this submission. Never blocks the response.
    void fireOffboardWebhook(MANAGER_OFFBOARD_NOTIFY_SLUG, {
      event: 'manager.offboarding.requested',
      count: rows.length,
      manager: session?.user?.name?.trim() || sessionEmail,
      manager_email: sessionEmail,
      requested_at: new Date().toISOString(),
    });

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: isAdmin ? 'Admin' : 'Manager',
      action: 'offboarding.requested',
      resource: 'offboarding_queue',
      resource_id: rows[0]?.id,
      details: {
        inserted: rows.length,
        skipped,
        employees: rows.map((r) => ({ email: r.employee_email, reason: r.reason })),
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, inserted: rows.length, skipped, rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH — HR claims a batch of pending rows for processing, or releases them
 * back to pending (when they close the processor without finishing).
 * Body: { ids: string[], action: 'claim' | 'release' }
 */
export async function PATCH(request: Request) {
  try {
    const authz = await requireFeatureEdit('hr', 'offboarding');
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as { ids?: string[]; action?: string };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
    const action = body.action?.trim();
    if (ids.length === 0) return NextResponse.json({ error: 'No ids' }, { status: 400 });
    if (action !== 'claim' && action !== 'release') {
      return NextResponse.json({ error: "action must be 'claim' or 'release'" }, { status: 400 });
    }

    const { updated, error } =
      action === 'claim'
        ? await setOffboardingQueueBatchStatus({ ids, from: 'pending', to: 'processing' })
        : await setOffboardingQueueBatchStatus({ ids, from: 'processing', to: 'pending' });
    if (error) return NextResponse.json({ error }, { status: 500 });

    return NextResponse.json({ success: true, updated, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
