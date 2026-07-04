import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

// POST /api/toggle-mesa-member
// Body: { workEmail?: string; personalEmail?: string; mesaMember: boolean; name?: string }
export async function POST(req: Request) {
  const authz = await requireFeatureEditAnyView('mesa');
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { workEmail, personalEmail, mesaMember, name, since } = (await req.json()) as {
      workEmail?: string;
      personalEmail?: string;
      mesaMember: boolean;
      name?: string;
      /** Optional enrollment effective date (YYYY-MM-DD). Defaults to today (Manila). */
      since?: string | null;
    };

    if (!workEmail && !personalEmail) {
      return NextResponse.json({ error: 'workEmail or personalEmail is required' }, { status: 400 });
    }
    if (typeof mesaMember !== 'boolean') {
      return NextResponse.json({ error: 'mesaMember must be a boolean' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase client not initialized' }, { status: 500 });
    }

    const matchCol = workEmail ? 'Work Email' : 'Personal Email';
    const matchVal = (workEmail || personalEmail)!;

    // On enroll, stamp the enrollment effective date so the Payroll Wizard only
    // deducts ₱100 for pay weeks on/after it (and the employee's MESA History
    // counts contributions from enrollment, not hire). Default to today in
    // Manila (the office timezone) — never the server's UTC "today", which can
    // roll a day off. On unenroll we leave the date in place; the deduction is
    // gated on `mesa_member` anyway, and keeping it preserves tenure if HR
    // revokes an opt-out and re-enrolls.
    const manilaToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const sinceIso = (since ?? '').trim().slice(0, 10) || manilaToday;

    const update: Record<string, unknown> = { mesa_member: mesaMember };
    if (mesaMember) update.mesa_member_since = sinceIso;

    const { error } = await supabase
      .from(RATES_TABLE)
      .update(update)
      .eq(matchCol, matchVal);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidateRateProfilesCache();

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: mesaMember ? 'employee.mesa.enroll' : 'employee.mesa.unenroll',
      resource: 'employee_hourly_rates',
      resource_id: workEmail || personalEmail,
      details: { name: name ?? null, work_email: workEmail ?? null, personal_email: personalEmail ?? null, mesa_member: mesaMember, mesa_member_since: mesaMember ? sinceIso : null },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
