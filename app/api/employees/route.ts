import { getEmployees, getEmployeeMasterRecord, type EmployeeRow } from "@/lib/supabase/employees";
import { normEmail } from "@/lib/email/norm-email";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();

  // Single-employee lookup — used by the employee portal so it doesn't need to
  // download the full roster just to find itself. Falls back to scanning the
  // active list when the master-record path returns nothing (handles edge cases
  // where work/personal email differs from what master-record matched on).
  if (email) {
    const norm = normEmail(email) ?? email.toLowerCase();
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
    const { employee, error } = await getEmployeeMasterRecord(email);
    return NextResponse.json({ employees: employee ? [employee] : [], error: error ?? all.error });
  }

  const { employees, error } = await getEmployees();
  return NextResponse.json({ employees, error });
}
