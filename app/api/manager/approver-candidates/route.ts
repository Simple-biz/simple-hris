import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { normEmail } from '@/lib/email/norm-email';
import { listSecondApproverCandidatesForRequest } from '@/lib/supabase/time-adjustments';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET ?requestId=... — who a manager may name as the second approver on ONE request.
 *
 * The pool is every ACTIVE member of that request's own team (Kane's ruling
 * 2026-08-27, replacing the original company-wide pool of people who already held
 * Manager access). Holding Manager access is no longer required: being named is itself
 * the authorization to countersign, and ONLY to countersign — the named approver reviews
 * time adjustments from their own employee portal and never enters this dashboard.
 * See `docs/features/time-adjustment-requests.md`.
 *
 * `requestId` is REQUIRED and the department is resolved from that row server-side. The
 * caller cannot name a department: that would turn this into a roster-enumeration
 * endpoint for teams the manager does not manage. `listSecondApproverCandidatesForRequest`
 * runs the same department-scope check as the approval itself before returning anyone.
 *
 * The caller and the employee who filed the request are both excluded — two signatures
 * need two people, and nobody approves their own hours.
 */
export async function GET(request: Request) {
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

    const requestId = new URL(request.url).searchParams.get('requestId')?.trim();
    if (!requestId) {
      return NextResponse.json(
        { candidates: [], department: null, error: 'requestId is required' },
        { status: 400 },
      );
    }

    const { emails, department, error } = await listSecondApproverCandidatesForRequest(
      requestId,
      sessionEmail,
    );
    if (error) {
      return NextResponse.json({ candidates: [], department, error }, { status: 400 });
    }

    // Attach display names so the dropdown reads as people, not addresses. A roster row
    // is what put them in the pool, so every candidate resolves — but a missing name
    // falls back to the email rather than rendering blank.
    const profileByEmail = new Map<string, string>();
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && emails.length > 0) {
      const { data } = await supabase
        .from('active_employees')
        .select('"Work Email","Name"')
        .in('"Work Email"', emails);
      for (const r of (data ?? []) as Array<Record<string, string | null>>) {
        const em = (r['Work Email'] ?? '').trim().toLowerCase();
        if (!em) continue;
        profileByEmail.set(em, (r['Name'] ?? '').trim());
      }
    }

    const candidates = emails.map((email) => ({
      email,
      name: profileByEmail.get(email) || email,
      department: department ?? '',
    }));

    return NextResponse.json({ candidates, department, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ candidates: [], department: null, error: msg }, { status: 500 });
  }
}
