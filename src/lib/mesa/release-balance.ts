// Server side of releasing a departing member's MESA balance.
//
// Reads the balance the same way every screen does, turns it into a payroll
// obligation, and reports failure loudly so the caller can refuse to close the
// account. The decision itself is pure and lives in ./offboard-payout.ts.

import type { SupabaseClient } from '@supabase/supabase-js';

import { mesaEmailAliasesFor } from '@/lib/mesa/email-aliases';
import {
  MESA_LEDGER_SELECT,
  summarizeMember,
  summarizeMemberAccount,
  type MesaLedgerEvent,
} from '@/lib/mesa/ledger';
import { planMesaOffboardPayout } from '@/lib/mesa/offboard-payout';

const OBLIGATIONS_TABLE = 'mesa_payroll_obligations';

export type ReleaseResult =
  | { ok: true; released: { amount_php: number; due_week_end: string } | null }
  | { ok: false; error: string };

/**
 * Raise an `offboard_payout` for whatever the member's OPEN account holds.
 *
 * Call this BEFORE closing the account. Closing zeroes every displayed figure,
 * so a release that runs afterwards and fails leaves money that is both unpaid
 * and invisible.
 *
 * Returns `{ ok: true, released: null }` when there is genuinely nothing to pay
 * (no open account, or a zero/overdrawn balance) — that is a success, and the
 * caller should carry on and close.
 */
export async function releaseMesaBalanceOnClose(
  supabase: SupabaseClient,
  email: string,
  closingOn: string,
): Promise<ReleaseResult> {
  const aliases = mesaEmailAliasesFor(email);
  const orFilter = aliases.map((e) => `email.ilike.${e}`).join(',');

  // The open account. Read directly rather than via getOpenMesaAccount(), which
  // returns null on a query error — indistinguishable from "no open account",
  // and here that difference decides whether someone is paid.
  const acct = await supabase
    .from('mesa_accounts')
    .select('account_number, opened_on')
    .or(orFilter)
    .is('closed_on', null)
    .limit(1)
    .maybeSingle();
  if (acct.error) return { ok: false, error: `account lookup failed: ${acct.error.message}` };

  const account = acct.data as { account_number: string; opened_on: string } | null;
  // No open account: nothing is being closed, so nothing is owed.
  if (!account) return { ok: true, released: null };

  const events: MesaLedgerEvent[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('mesa_ledger')
      .select(MESA_LEDGER_SELECT)
      .or(orFilter)
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: `ledger read failed: ${error.message}` };
    const batch = (data ?? []) as MesaLedgerEvent[];
    events.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Scoped by the SAME function the Active Members tab and the member's own
  // dashboard use, so what is paid out equals what everyone was shown.
  const summary = events.length
    ? summarizeMemberAccount(events, account)
    : { ...summarizeMember([]), balance: 0 };

  const plan = planMesaOffboardPayout({
    email,
    accountNumber: account.account_number,
    balance: summary.balance,
    closingOn,
  });
  if (!plan) return { ok: true, released: null };

  const { error } = await supabase.from(OBLIGATIONS_TABLE).insert(plan.obligation);
  if (error) {
    // A duplicate is not a failure: `mesa_obligations_one_open_payout_per_email`
    // means a payout is ALREADY outstanding for this person, which is the state
    // we wanted. Re-approving an opt-out must not promise the money twice.
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return { ok: true, released: null };
    }
    // Anything else and the caller must not close the account.
    return { ok: false, error: `could not record the payout: ${error.message}` };
  }

  return {
    ok: true,
    released: { amount_php: plan.obligation.amount_php, due_week_end: plan.obligation.due_week_end },
  };
}
