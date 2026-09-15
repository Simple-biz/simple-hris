import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import {
  closeMesaAccounts,
  getLatestClosedMesaAccount,
  getOpenMesaAccount,
  openMesaAccount,
} from '@/lib/supabase/mesa-accounts';
import { releaseMesaBalanceOnClose } from '@/lib/mesa/release-balance';
import { closedStintConflict, openAccountConflict, resolveEnrollmentDate } from '@/lib/mesa/enrollment-date';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

// POST /api/toggle-mesa-member
// Body: { workEmail?: string; personalEmail?: string; mesaMember: boolean; name?: string; since?: string }
export async function POST(req: Request) {
  const authz = await requireFeatureEditAnyView('mesa');
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { workEmail, personalEmail, mesaMember, name, since } = (await req.json()) as {
      workEmail?: string;
      personalEmail?: string;
      mesaMember: boolean;
      name?: string;
      /**
       * Enrollment effective date, strict YYYY-MM-DD. Accounting picks it on
       * Non Members → Opt In (since 2026-09-15); other callers omit it and get
       * today in Manila. Ignored on unenroll. Stamped onto BOTH
       * `mesa_member_since` and the new account's `opened_on`.
       */
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
    //
    // The date is validated at this boundary, not by the database: it lands in
    // two DATE columns and mints the account number's YY-MM, so a sliced
    // timestamp or a typo must be refused here with a reason, not surface as a
    // Postgres error after the account row is already half-written.
    const manilaToday = manilaTodayIso();
    const resolved = resolveEnrollmentDate(since, manilaToday);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    let sinceIso = resolved.date;

    // MESA account lifecycle: opting in opens an account (a fresh YY-MM-#####
    // number unless one is already open); opting out CLOSES it — the account is
    // settled ("zeroed": balances aggregate ledger events from the OPEN
    // account's opened_on, so an ex-member re-joining starts a new account at
    // ₱0 with only the latest values). Best-effort: null until the
    // 2026-07-16_mesa_accounts migration has run.
    const accountEmail = (workEmail || personalEmail)!.trim().toLowerCase();
    let accountNumber: string | null = null;
    let closedAccounts: string[] = [];
    /** The payout raised for a departing member's balance, when there was one. */
    let releasedPayout: { amount_php: number; due_week_end: string } | null = null;
    if (mesaMember) {
      // An account already open means they are enrolled. Re-enrolling with no
      // date (HR re-approving a duplicate opt-in, a stale Non Members tab) is
      // idempotent and keeps mesa_member_since equal to the account's
      // opened_on — the two used to drift here, because "today" was stamped
      // over the original date. A DIFFERENT explicit date is refused: an open
      // account's window cannot be moved by re-enrolling.
      const open = await getOpenMesaAccount(accountEmail);
      const openConflict = openAccountConflict(sinceIso, !resolved.defaulted, open);
      if (openConflict) {
        return NextResponse.json({ error: openConflict }, { status: 409 });
      }
      if (open) {
        sinceIso = open.opened_on;
      } else {
        // The new stint must start strictly after the previous one closed.
        // Balances are the ledger sliced to events >= opened_on, and the
        // closed stint's balance was already RELEASED as an offboard_payout
        // when it closed — a window reaching back into it would count that
        // money a second time. Fails CLOSED: if the history cannot be read,
        // the member is not enrolled and nothing is written.
        const latest = await getLatestClosedMesaAccount(accountEmail);
        if (!latest.ok) {
          return NextResponse.json(
            {
              error:
                `Could not read this member's MESA account history, so they were NOT opted in. ` +
                `Nothing was changed. (${latest.error})`,
            },
            { status: 503 },
          );
        }
        const closedConflict = closedStintConflict(sinceIso, latest.account?.closed_on ?? null);
        if (closedConflict) {
          return NextResponse.json({ error: closedConflict }, { status: 400 });
        }
      }
      const account = await openMesaAccount(accountEmail, name ?? null, sinceIso);
      accountNumber = account?.account_number ?? null;
    } else {
      // RELEASE BEFORE CLOSING. Closing the account "zeroes" it — every balance
      // in the app aggregates events on/after the OPEN account's opened_on — so
      // if we close first and the release then fails, the money is invisible
      // and nothing records that it was owed. That is exactly the bug being
      // fixed: an approved opt-out used to close the account and move nothing.
      //
      // Fails CLOSED: if the balance cannot be read, or the obligation cannot
      // be written, we do NOT close. The member stays enrolled (recoverable,
      // and the ₱100 keeps running for a week at worst) rather than losing a
      // balance with no trace. Aliviah's rule, 2026-08-28: whoever leaves, for
      // whatever reason, is owed what they put in plus the match.
      const release = await releaseMesaBalanceOnClose(supabase, accountEmail, manilaToday);
      if (!release.ok) {
        return NextResponse.json(
          {
            error:
              `Could not release this member's MESA balance, so they were NOT opted out. ` +
              `Nothing was changed. (${release.error})`,
          },
          { status: 503 },
        );
      }
      releasedPayout = release.released;
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
        // Whether the caller chose the date or it defaulted to today (Manila).
        mesa_member_since_explicit: mesaMember ? !resolved.defaulted : null,
        mesa_account_number: mesaMember ? accountNumber : null,
        mesa_accounts_closed: mesaMember ? null : closedAccounts,
        mesa_balance_released_php: releasedPayout?.amount_php ?? null,
        mesa_payout_due_week_end: releasedPayout?.due_week_end ?? null,
      },
    });

    return NextResponse.json({
      success: true,
      accountNumber: mesaMember ? accountNumber : null,
      // The date actually stamped — the caller's pick, today (Manila), or the
      // already-open account's opened_on on an idempotent re-enroll.
      memberSince: mesaMember ? sinceIso : null,
      // So the caller can tell Accounting what was just promised to this person
      // instead of the balance appearing to vanish.
      releasedPayout,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
