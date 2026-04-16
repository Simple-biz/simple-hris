import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const trim = (v: unknown) =>
      typeof v === "string" ? v.trim() : v === null || v === undefined ? v : v;
    const originalWorkEmail     = trim(body.originalWorkEmail) as string | null | undefined;
    const originalPersonalEmail = trim(body.originalPersonalEmail) as string | null | undefined;
    const name                  = trim(body.name) as string | null | undefined;
    const department            = trim(body.department) as string | null | undefined;
    const workEmail             = trim(body.workEmail) as string | null | undefined;
    const personalEmail         = trim(body.personalEmail) as string | null | undefined;
    const startDate             = trim(body.startDate) as string | null | undefined;

    if (!originalWorkEmail && !originalPersonalEmail) {
      return NextResponse.json(
        { error: "Original email is required to identify the employee" },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase client not initialized. Check environment variables." },
        { status: 500 },
      );
    }

    const ratesTable =
      process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
      "employee_hourly_rates";
    const masterTable =
      process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

    const errors: string[] = [];

    // ── employee_hourly_rates ────────────────────────────────────────────────
    // Update: Work Email, Personal Email, Department
    const ratesUpdate: Record<string, string | null> = {};
    if (workEmail !== undefined) ratesUpdate["Work Email"] = workEmail;
    if (personalEmail !== undefined) ratesUpdate["Personal Email"] = personalEmail;
    if (department !== undefined) ratesUpdate["Department"] = department;

    if (Object.keys(ratesUpdate).length > 0) {
      let matched = 0;
      if (originalWorkEmail) {
        const { data, error } = await supabase
          .from(ratesTable)
          .update(ratesUpdate)
          .ilike("Work Email", `%${originalWorkEmail.trim()}%`)
          .select("*");
        if (error) errors.push(`${ratesTable} (Work Email): ${error.message}`);
        else matched += data?.length ?? 0;
      }
      if (matched === 0 && originalPersonalEmail) {
        const { data, error } = await supabase
          .from(ratesTable)
          .update(ratesUpdate)
          .ilike("Personal Email", `%${originalPersonalEmail.trim()}%`)
          .select("*");
        if (error) errors.push(`${ratesTable} (Personal Email): ${error.message}`);
        else matched += data?.length ?? 0;
      }
      // 0 matches is fine — employee may not be in rates (US / no-rate).
    }

    // ── global_master_list ───────────────────────────────────────────────────
    // Update: Name, Department, Work Email, Personal Email, Start Date
    const masterUpdate: Record<string, string | null> = {};
    if (name !== undefined) masterUpdate["Name"] = name;
    if (department !== undefined) masterUpdate["Department"] = department;
    if (workEmail !== undefined) masterUpdate["Work Email"] = workEmail;
    if (personalEmail !== undefined) masterUpdate["Personal Email"] = personalEmail;
    if (startDate !== undefined) masterUpdate["Start Date"] = startDate;

    if (Object.keys(masterUpdate).length > 0) {
      let matched = 0;
      if (originalWorkEmail) {
        const { data, error } = await supabase
          .from(masterTable)
          .update(masterUpdate)
          .ilike("Work Email", `%${originalWorkEmail.trim()}%`)
          .select("*");
        if (error) errors.push(`${masterTable} (Work Email): ${error.message}`);
        else matched += data?.length ?? 0;
      }
      if (matched === 0 && originalPersonalEmail) {
        const { data, error } = await supabase
          .from(masterTable)
          .update(masterUpdate)
          .ilike("Personal Email", `%${originalPersonalEmail.trim()}%`)
          .select("*");
        if (error) errors.push(`${masterTable} (Personal Email): ${error.message}`);
        else matched += data?.length ?? 0;
      }
      if (matched === 0) {
        errors.push(
          `${masterTable}: no matching row for Work Email=${originalWorkEmail || "∅"} or Personal Email=${originalPersonalEmail || "∅"}. Check the original email value (case/whitespace) on the master row.`,
        );
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 500 });
    }

    // Build a concise map of what actually changed
    const changes: Record<string, unknown> = {};
    if (name !== undefined)         changes.name         = name;
    if (department !== undefined)   changes.department   = department;
    if (workEmail !== undefined)    changes.work_email   = workEmail;
    if (personalEmail !== undefined) changes.personal_email = personalEmail;
    if (startDate !== undefined)    changes.start_date   = startDate;

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'employee.profile.update',
      resource:    'global_master_list',
      resource_id: originalWorkEmail || originalPersonalEmail,
      details: {
        employee: originalWorkEmail || originalPersonalEmail,
        changes,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
