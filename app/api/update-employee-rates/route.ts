import { updateEmployeeRates } from "@/lib/supabase/employee-hourly-rates";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

export async function POST(req: Request) {
  try {
    const { workEmail, personalEmail, regularRate, otRate } = await req.json();

    if (!workEmail && !personalEmail) {
      return NextResponse.json(
        { error: "Work email or personal email is required" },
        { status: 400 }
      );
    }

    if (regularRate === undefined || otRate === undefined) {
      return NextResponse.json(
        { error: "Regular rate and OT rate are required" },
        { status: 400 }
      );
    }

    // Fetch existing rates for before/after audit trail
    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    let oldRegular: string | null = null;
    let oldOt: string | null = null;
    if (supabase) {
      const matchCol = workEmail ? 'Work Email' : 'Personal Email';
      const matchVal = workEmail || personalEmail;
      const { data } = await supabase
        .from(RATES_TABLE)
        .select('"Regular Rate", "OT Rate"')
        .eq(matchCol, matchVal)
        .maybeSingle();
      if (data) {
        oldRegular = (data as Record<string, unknown>)['Regular Rate'] as string | null;
        oldOt      = (data as Record<string, unknown>)['OT Rate']      as string | null;
      }
    }

    const { error } = await updateEmployeeRates({
      workEmail,
      personalEmail,
      regularRate,
      otRate,
    });

    if (error) {
      return NextResponse.json({ error }, { status: 500 });
    }

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'employee.rates.update',
      resource:    'employee_hourly_rates',
      resource_id: workEmail || personalEmail,
      details: {
        employee:  workEmail || personalEmail,
        before:    { regular_rate: oldRegular, ot_rate: oldOt },
        after:     { regular_rate: regularRate, ot_rate: otRate },
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
