import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { closeMesaAccounts, openMesaAccount } from '@/lib/supabase/mesa-accounts';
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

    // MESA account lifecycle: opting in opens an account (a fresh YY-MM-#####
    // number unless one is already open); opting out CLOSES it — the account is
    // settled ("zeroed": balances aggregate ledger events from the OPEN
    // account's opened_on, so an ex-member re-joining starts a new account at
    // ₱0 with only the latest values). Best-effort: null until the
    // 2026-07-16_mesa_accounts migration has run.
    const accountEmail = (workEmail || personalEmail)!.trim().toLowerCase();
    let accountNumber: string | null = null;
    let closedAccounts: string[] = [];
    if (mesaMember) {
      const account = await openMesaAccount(accountEmail, name ?? null, sinceIso);
      accountNumber = account?.account_number ?? null;
    } else {
      closedAccounts = await closeMesaAccounts(accountEmail, manilaToday);
    }

    const update: Record<string, unknown> = { mesa_member: mesaMember };
    if (mesaMember) update.mesa_member_since = sinceIso;

    // Carry the current account number on the rates rows (same denormalized
    // path as mesa_member). Tiered like the roster selects: if the column
    // isn't there yet (migration pending), retry without it so enrollment
    // itself never breaks on deploy order.
    const doUpdate = (withAccount: boolean) =>
      supabase
        .from(RATES_TABLE)
        .update(withAccount ? { ...update, mesa_account_number: mesaMember ? accountNumber : null } : update)
        .eq(matchCol, matchVal);
    let { error } = await doUpdate(true);
    if (error && /mesa_account_number/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      ({ error } = await doUpdate(false));
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidateRateProfilesCache();

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: mesaMember ? 'employee.mesa.enroll' : 'employee.mesa.unenroll',
      resource: 'employee_hourly_rates',
      resource_id: workEmail || personalEmail,
      details: {
        name: name ?? null,
        work_email: workEmail ?? null,
        personal_email: personalEmail ?? null,
        mesa_member: mesaMember,
        mesa_member_since: mesaMember ? sinceIso : null,
        mesa_account_number: mesaMember ? accountNumber : null,
        mesa_accounts_closed: mesaMember ? null : closedAccounts,
      },
    });

    return NextResponse.json({ success: true, accountNumber: mesaMember ? accountNumber : null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
