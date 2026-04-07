import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const {
      originalWorkEmail,
      originalPersonalEmail,
      name,
      department,
      workEmail,
      personalEmail,
      startDate,
    } = await req.json();

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
      let q = supabase.from(ratesTable).update(ratesUpdate);
      q = originalWorkEmail
        ? q.eq("Work Email", originalWorkEmail)
        : q.eq("Personal Email", originalPersonalEmail);
      const { error } = await q;
      if (error) errors.push(`${ratesTable}: ${error.message}`);
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
      let q = supabase.from(masterTable).update(masterUpdate);
      // global_master_list is keyed by Personal Email first, then Work Email
      q = originalPersonalEmail
        ? q.eq("Personal Email", originalPersonalEmail)
        : q.eq("Work Email", originalWorkEmail);
      const { error } = await q;
      if (error) errors.push(`${masterTable}: ${error.message}`);
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
