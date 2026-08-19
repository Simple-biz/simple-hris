import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { normEmail } from '@/lib/email/norm-email';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  listTimeAdjustments,
  signTimeAdjustmentImageUrls,
  type TimeAdjustmentStatus,
} from '@/lib/supabase/time-adjustments';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const sessionEmail = normEmail(user?.email ?? null);
    if (!sessionEmail) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }

    const roles = (user?.roles ?? []) as string[];
    if (!roles.includes('manager') && !hasElevatedRole(roles)) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    // Fetch pending requests plus the full decided history (no date restriction — time
    // adjustments can be for any past date). 'approved'/'denied' are the final Accounting
    // decisions; without them, a request would vanish from the manager view once Accounting acts.
    const { rows: all, error } = await listTimeAdjustments({
      statuses: [
        'pending',
        // Dual approval: a request the manager approved but the second approver has
        // not. Omitting it would make the row vanish from BOTH reviewers' screens.
        'awaiting_second_approval',
        'manager_approved',
        'manager_denied',
        'approved',
        'denied',
      ] as TimeAdjustmentStatus[],
      limit: 500,
    });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

    let rows = all;
    // Ids the caller may act on AS THE MANAGER (department scope). A row can also reach
    // them purely as the named second approver, and those two put different buttons on
    // the card — so the client is told which, rather than having to guess.
    let managedIds: string[] = all.map((r) => r.id);

    // Elevated users (HR/admin) see everything; managers see their departments PLUS any
    // request that names them as second approver — that assignment is what lets an
    // approver outside the employee's department review it, so it must widen the read
    // exactly as far as it widens the write, and no further.
    if (!hasElevatedRole(roles)) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      const managedDepts = assigns.map((a) => a.department.trim().toLowerCase());

      const isNamedSecondApprover = (r: (typeof all)[number]) =>
        (r.second_approver_email ?? '').trim().toLowerCase() === sessionEmail;

      // A manager with no department assignments can still be a named second approver,
      // so this can no longer short-circuit to an empty list.
      if (managedDepts.length === 0) {
        rows = all.filter(isNamedSecondApprover);
        managedIds = [];
      } else {
        // Look up each employee's department and filter.
        const supabase = createSupabaseServiceRoleClient();
        if (!supabase) return NextResponse.json({ rows: [], error: 'Supabase not configured' }, { status: 500 });

        // Batch-fetch departments for all unique emails in the result set.
        const emails = [...new Set(all.map((r) => r.work_email.toLowerCase()))];
        const deptMap = new Map<string, string>();
        if (emails.length > 0) {
          const { data } = await supabase
            .from('active_employees')
            .select('"Work Email","Department"')
            .in('"Work Email"', emails);
          for (const emp of (data ?? []) as Array<{ 'Work Email': string; Department: string }>) {
            const em = (emp['Work Email'] ?? '').trim().toLowerCase();
            const dept = (emp['Department'] ?? '').trim().toLowerCase();
            if (em) deptMap.set(em, dept);
          }
        }

        const managesRow = (r: (typeof all)[number]) => {
          const dept = deptMap.get(r.work_email.toLowerCase()) ?? '';
          return !!dept && managedDepts.includes(dept);
        };
        rows = all.filter((r) => managesRow(r) || isNamedSecondApprover(r));
        managedIds = rows.filter(managesRow).map((r) => r.id);
      }
    }

    // Generate signed URLs for all image evidence so the manager can view proof.
    const allPaths = rows.flatMap((r) => r.image_paths ?? []);
    const signedUrls = allPaths.length > 0 ? await signTimeAdjustmentImageUrls(allPaths) : {};

    // The client needs to know who it is rendering for: a row can be in this list
    // because the caller manages the department OR because it names them as second
    // approver, and those two put different buttons on the card.
    return NextResponse.json({
      rows,
      signedUrls,
      viewerEmail: sessionEmail,
      managedIds,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}
