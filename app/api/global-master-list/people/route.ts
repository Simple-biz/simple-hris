import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { normEmail } from "@/lib/email/norm-email";
import { listActiveMasterListPeople } from "@/lib/supabase/global-master-list-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/global-master-list/people → { profiles: EmployeeOption[] }
 *
 * Active people straight from the Global Master List (Name + Department +
 * work/personal email only — NEVER any pay data, same guarantee as
 * `listActiveMasterListPeople`). Shaped as the roster `EmployeeOption` the
 * orphanage "People involved" picker consumes, so the Create-Issues dialog and
 * its parents (OrphanageApp, OrphanageVisits) resolve people from the master
 * list rather than the rate-profile summary. Any signed-in session may read it —
 * the payload carries no sensitive fields.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const email = normEmail((session?.user as { email?: string | null } | undefined)?.email ?? "");
  if (!email) return NextResponse.json({ profiles: [], error: "Not signed in" }, { status: 401 });

  const { people, error } = await listActiveMasterListPeople();
  if (error) return NextResponse.json({ profiles: [], error }, { status: 500 });

  const profiles = people.map((p) => {
    const workEmail = p.work_email ?? null;
    const personalEmail = p.personal_email ?? null;
    // The master list has no separate id column; the work email (falling back to
    // personal email, then a name|dept composite) is a stable per-person key for
    // React lists. Selection itself keys on the normalized work email.
    const id = workEmail ?? personalEmail ?? `${p.name}|${p.department ?? ""}`;
    return {
      id,
      displayName: p.name,
      workEmail,
      personalEmail,
      department: p.department ?? null,
      suspended: false, // active-employees view only — offboarded rows never appear
    };
  });

  return NextResponse.json({ profiles, error: null });
}
