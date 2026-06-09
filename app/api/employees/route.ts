import { getEmployees, getEmployeeMasterRecord, type EmployeeRow } from "@/lib/supabase/employees";
import { normEmail } from "@/lib/email/norm-email";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();

  // Single-employee lookup — used by the employee portal so it doesn't need to
  // download the full roster just to find itself. Falls back to scanning the
  // active list when the master-record path returns nothing (handles edge cases
  // where work/personal email differs from what master-record matched on).
  if (email) {
    // Self-or-elevated: a non-elevated caller may only resolve their own record.
    // The requested ?email= is authorized against the NextAuth session and
    // overridden to the session email for self-lookups, so a stale or spoofed
    // ?email= can never surface another employee's identity/department.
    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);
    const lookup = authz.effectiveEmail;
    const norm = normEmail(lookup) ?? lookup.toLowerCase();
    // Prefer the active-list match so the generated employee_id reflects the
    // serial numbering across same-month starters (getEmployeeMasterRecord
    // only sees one row and can't reproduce that ordering). Server-side filter
    // — response is one row even though getEmployees() scans the full view.
    const all = await getEmployees();
    const me = (all.employees ?? []).find((e: EmployeeRow) => {
      const we = normEmail(e.work_email ?? "");
      const pe = normEmail(e.personal_email ?? "");
      return we === norm || pe === norm;
    });
    if (me) return NextResponse.json({ employees: [me], error: all.error });

    // Fallback to global_master_list for people who fell off the latest upload
    // (e.g. internal devs not on the regular roster CSV).
    const { employee, error } = await getEmployeeMasterRecord(lookup);
    return NextResponse.json({ employees: employee ? [employee] : [], error: error ?? all.error });
  }

  const { employees, error } = await getEmployees();
  return NextResponse.json({ employees, error });
}
