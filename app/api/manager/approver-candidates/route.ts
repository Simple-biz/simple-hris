import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { normEmail } from '@/lib/email/norm-email';
import { listSecondApproverCandidates } from '@/lib/supabase/time-adjustments';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET — who a manager may name as the second approver on a time adjustment.
 *
 * The pool is people who ALREADY hold Manager dashboard access (an active
 * `manager` role plus an `edit` grant on manager/time_adjustments, or `admin`).
 * Naming someone confers NO access: granting access stays admin-only, the
 * "keystone anti-escalation guard" in `rbac-feature-permissions.md:66`. A manager
 * routes work to people an admin already provisioned — they cannot create an approver.
 *
 * Deliberately NOT department-scoped: picking a lead from another team is the whole
 * point of the feature (an "external" second approver, per the 2026-08-19 ruling).
 * The caller is excluded from their own list — two sign-offs need two people.
 */
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

    const { emails, error } = await listSecondApproverCandidates();
    if (error) return NextResponse.json({ candidates: [], error }, { status: 500 });

    const pool = emails.filter((e) => e !== sessionEmail);

    // Attach display names so the dropdown reads as people, not addresses. A candidate
    // with no roster row (service account, founder) still appears — the eligibility
    // rule is the role grant, not roster membership — it just shows its email.
    const profileByEmail = new Map<string, { name: string; department: string }>();
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && pool.length > 0) {
      const { data } = await supabase
        .from('active_employees')
        .select('"Work Email","Name","Department"')
        .in('"Work Email"', pool);
      for (const r of (data ?? []) as Array<Record<string, string | null>>) {
        const em = (r['Work Email'] ?? '').trim().toLowerCase();
        if (!em) continue;
        profileByEmail.set(em, {
          name: (r['Name'] ?? '').trim(),
          department: (r['Department'] ?? '').trim(),
        });
      }
    }

    const candidates = pool.map((email) => {
      const profile = profileByEmail.get(email);
      return {
        email,
        name: profile?.name || email,
        department: profile?.department ?? '',
      };
    });

    return NextResponse.json({ candidates, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ candidates: [], error: msg }, { status: 500 });
  }
}
