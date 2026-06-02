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

    // Fetch all pending requests (no date restriction — time adjustments can be for any past date).
    const { rows: all, error } = await listTimeAdjustments({
      statuses: ['pending', 'manager_approved', 'manager_denied'] as TimeAdjustmentStatus[],
      limit: 500,
    });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

    let rows = all;

    // Elevated users (HR/admin) see everything; managers see only their departments.
    if (!hasElevatedRole(roles)) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      if (assigns.length === 0) {
        return NextResponse.json({ rows: [], signedUrls: {}, error: null });
      }
      const managedDepts = assigns.map((a) => a.department.trim().toLowerCase());

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

      rows = all.filter((r) => {
        const dept = deptMap.get(r.work_email.toLowerCase()) ?? '';
        return dept && managedDepts.includes(dept);
      });
    }

    // Generate signed URLs for all image evidence so the manager can view proof.
    const allPaths = rows.flatMap((r) => r.image_paths ?? []);
    const signedUrls = allPaths.length > 0 ? await signTimeAdjustmentImageUrls(allPaths) : {};

    return NextResponse.json({ rows, signedUrls, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}
