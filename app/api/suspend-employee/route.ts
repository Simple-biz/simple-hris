import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { invalidateRateProfilesCache } from "@/lib/supabase/employee-rate-profiles";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getSessionActor } from '@/lib/auth/session-actor';
const RATES_TABLE  = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

// POST /api/suspend-employee
// Body: { workEmail?: string; personalEmail?: string; suspended: boolean; name?: string }
export async function POST(req: Request) {
  try {
    const { workEmail, personalEmail, suspended, name } = (await req.json()) as {
      workEmail?: string;
      personalEmail?: string;
      suspended: boolean;
      name?: string;
    };

    if (!workEmail && !personalEmail) {
      return NextResponse.json({ error: 'workEmail or personalEmail is required' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not initialized' }, { status: 500 });
    }

    // Match by work email first, fall back to personal email
    const matchCol = workEmail ? 'Work Email' : 'Personal Email';
    const matchVal = (workEmail || personalEmail)!;

    const { error } = await supabase
      .from(RATES_TABLE)
      .update({ suspended })
      .eq(matchCol, matchVal);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidateRateProfilesCache();

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name:   actor.user_name,
      user_role:   actor.user_role,
      action:      suspended ? 'employee.suspend' : 'employee.unsuspend',
      resource:    'employee_hourly_rates',
      resource_id: workEmail || personalEmail,
      details:     { name: name ?? null, work_email: workEmail ?? null, personal_email: personalEmail ?? null, suspended },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
