import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;

export async function POST(req: Request) {
  try {
    const { name, department, workEmail, personalEmail, startDate, regularRate, otRate } =
      await req.json();

    if (!workEmail && !personalEmail) {
      return NextResponse.json(
        { error: "At least one email (work or personal) is required" },
        { status: 400 },
      );
    }

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
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

    // Insert into employee_hourly_rates
    const ratesRow: Record<string, string | null> = {};
    if (workEmail) ratesRow["Work Email"] = workEmail;
    if (personalEmail) ratesRow["Personal Email"] = personalEmail;
    if (regularRate) ratesRow["Regular Rate"] = regularRate;
    if (otRate) ratesRow["OT Rate"] = otRate;

    const { error: ratesError } = await supabase.from(ratesTable).insert(ratesRow);
    if (ratesError) errors.push(`${ratesTable}: ${ratesError.message}`);

    // Insert into global_master_list
    const masterRow: Record<string, string | null> = {};
    if (name) masterRow["Name"] = name;
    if (department) masterRow["Department"] = department;
    if (personalEmail) masterRow["Personal Email"] = personalEmail;
    if (startDate) masterRow["Start Date"] = startDate;

    const { error: masterError } = await supabase.from(masterTable).insert(masterRow);
    if (masterError) errors.push(`${masterTable}: ${masterError.message}`);

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 500 });
    }

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'employee.create',
      resource:    'global_master_list',
      resource_id: workEmail || personalEmail,
      details: {
        name,
        department:     department ?? null,
        work_email:     workEmail ?? null,
        personal_email: personalEmail ?? null,
        start_date:     startDate ?? null,
        regular_rate:   regularRate ?? null,
        ot_rate:        otRate ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
