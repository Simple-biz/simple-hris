import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;

export async function DELETE(req: Request) {
  try {
    const { workEmail, personalEmail, name } = await req.json();

    if (!workEmail && !personalEmail && !name) {
      return NextResponse.json(
        { error: "At least one identifier (workEmail, personalEmail, or name) is required" },
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

    // Delete from employee_hourly_rates by work email, then personal email
    if (workEmail) {
      const { error } = await supabase.from(ratesTable).delete().eq("Work Email", workEmail);
      if (error) errors.push(`${ratesTable} (work email): ${error.message}`);
    } else if (personalEmail) {
      const { error } = await supabase.from(ratesTable).delete().eq("Personal Email", personalEmail);
      if (error) errors.push(`${ratesTable} (personal email): ${error.message}`);
    }

    // Delete from global_master_list by personal email first, then name fallback
    if (personalEmail) {
      const { error } = await supabase.from(masterTable).delete().eq("Personal Email", personalEmail);
      if (error) errors.push(`${masterTable} (personal email): ${error.message}`);
    } else if (name) {
      const { error } = await supabase.from(masterTable).delete().eq("Name", name);
      if (error) errors.push(`${masterTable} (name): ${error.message}`);
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 500 });
    }

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'employee.delete',
      resource:    'global_master_list',
      resource_id: workEmail || personalEmail || name,
      details:     { name: name ?? null, work_email: workEmail ?? null, personal_email: personalEmail ?? null },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
