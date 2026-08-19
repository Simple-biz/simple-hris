import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { escapeLikePattern } from '@/lib/db/like-escape';
import {
  EMPLOYEE_PENNY_DAILY_LIMIT,
  manilaDayIso,
  manilaDayStartIso,
} from './employee-quota';

/**
 * The `penny_employee_usage` ledger — Employee Penny AI's daily meter.
 * See references/sql/create/2026-08-19_penny_employee_usage.sql.
 *
 * The COUNT of non-refunded rows for (session_email, Manila day) *is* the
 * allowance used. There is no counter to increment, so there is no lost-update
 * race between two open tabs.
 *
 * Reserve → settle. `reservePrompt` inserts before the model call (the claim);
 * `settlePrompt` records which tools ran; `refundPrompt` stamps `refunded_at`
 * when the turn produced no answer text, so a route error never costs an
 * employee one of their ten.
 */

const TABLE = 'penny_employee_usage';

/**
 * Charged prompts used by `sessionEmail` since Manila midnight.
 *
 * **Fails CLOSED.** A missing client, a query error, or a null count all return
 * the limit — i.e. "spent out". Mirrors the OTP send-cap
 * (`src/lib/bank-update/otp.ts`), where treating a read failure as "not
 * throttled" would have handed out the thing the cap exists to ration. Here the
 * cost of failing open is Anthropic spend with no ceiling; the cost of failing
 * closed is Penny politely declining until the DB answers again.
 */
export async function countUsedToday(
  sessionEmail: string,
  now: Date = new Date(),
): Promise<number> {
  const email = normEmail(sessionEmail);
  if (!email) return EMPLOYEE_PENNY_DAILY_LIMIT;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return EMPLOYEE_PENNY_DAILY_LIMIT;

  const { count, error } = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .ilike('session_email', escapeLikePattern(email))
    .is('refunded_at', null)
    .gte('asked_at', manilaDayStartIso(now));

  if (error || count == null) return EMPLOYEE_PENNY_DAILY_LIMIT;
  return count;
}

/**
 * Claim one prompt. Returns the row id to settle/refund against, or null when
 * the ledger is unavailable.
 *
 * A null return is NOT a licence to proceed unmetered — the caller treats it as
 * a hard failure, for the same fail-closed reason as above. Recording the spend
 * is a precondition of spending, not a side effect of it.
 */
export async function reservePrompt(params: {
  sessionEmail: string;
  subjectEmail: string;
  elevated: boolean;
  now?: Date;
}): Promise<string | null> {
  const sessionEmail = normEmail(params.sessionEmail);
  const subjectEmail = normEmail(params.subjectEmail) ?? sessionEmail;
  if (!sessionEmail || !subjectEmail) return null;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  const now = params.now ?? new Date();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      session_email: sessionEmail,
      subject_email: subjectEmail,
      elevated: params.elevated,
      asked_at: now.toISOString(),
      manila_day: manilaDayIso(now),
      tools_used: [],
    })
    .select('id')
    .maybeSingle();

  if (error || !data) return null;
  return (data as { id: string }).id;
}

/**
 * Record which tools ran on a charged prompt. Best-effort: the answer has
 * already been streamed to the employee, so a failed update must not surface as
 * an error — the row stays charged either way, which is the part that matters.
 */
export async function settlePrompt(id: string, toolsUsed: string[]): Promise<void> {
  if (!id) return;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  await supabase
    .from(TABLE)
    .update({ tools_used: toolsUsed })
    .eq('id', id);
}

/**
 * Un-charge a reserved prompt — the turn produced no answer text (upstream
 * error, aborted stream, or a tool loop that ran out of turns without writing
 * anything).
 *
 * Soft delete, matching `payroll_bank_exemptions.revoked_at`: the row survives
 * with a reason, so "I asked and got nothing but it still counted" is answerable
 * from the ledger rather than from guesswork.
 */
export async function refundPrompt(id: string, reason: string): Promise<void> {
  if (!id) return;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  await supabase
    .from(TABLE)
    .update({ refunded_at: new Date().toISOString(), refund_reason: reason.slice(0, 200) })
    .eq('id', id)
    .is('refunded_at', null);
}
