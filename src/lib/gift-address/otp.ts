import 'server-only';

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { escapeLikePattern } from '@/lib/db/like-escape';
import {
  issueCode,
  resolveSession,
  verifyCode,
  type OtpStore,
  type VerifyOutcome,
} from '@/lib/otp/otp-core';

/**
 * Binds the generic OTP core to `gift_address_otps` for the public
 * /update-gift-address flow.
 *
 * This is the file that carries `server-only` and the service-role client; the
 * core is deliberately free of both so it can be unit-tested.
 *
 * THE AUDIENCE IS THE ACTIVE ROSTER, AND THE CODE GOES TO A COMPANY INBOX.
 * A typed address is matched against `active_employees`, but the code is ALWAYS
 * mailed to that row's **Work Email**. Someone who types a personal address they
 * do not control still cannot receive the code, and the session that results is
 * bound to the company address — so the whole flow is gated on access to a
 * simple.biz inbox, which is what Kane asked for.
 */

const TABLE = 'gift_address_otps';

export interface GiftAddressPerson {
  /** The canonical company address. Every later step is keyed to this. */
  workEmail: string;
  name: string;
  /** The submissions table's key. May be blank — the save path handles that. */
  personalEmail: string | null;
  /** Raw master-list start date; the milestone walk needs it. */
  startDate: string | null;
}

/**
 * Resolve a typed email to an ACTIVE employee.
 *
 * Matches Work Email first, then Personal Email, but the returned `workEmail` is
 * always the company address. LIKE metacharacters are escaped so a value like
 * `%` cannot match an arbitrary employee — the master-list email columns are not
 * lowercased, so `ilike` is required and escaping is not optional.
 *
 * Returns null for anyone not on the active roster, including a real person who
 * has left. The route answers identically either way.
 */
export async function findActiveEmployeeByEmail(
  email: string,
): Promise<GiftAddressPerson | null> {
  const target = normEmail(email);
  if (!target) return null;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  const pattern = escapeLikePattern(target);
  const tryColumn = async (col: string) =>
    supabase
      .from('active_employees')
      .select('"Name","Work Email","Personal Email","Start Date"')
      .ilike(col, pattern)
      .limit(1)
      .maybeSingle();

  let res = await tryColumn('"Work Email"');
  if (!res.data && !res.error) res = await tryColumn('"Personal Email"');
  if (res.error || !res.data) return null;

  const row = res.data as Record<string, unknown>;
  const workEmail = normEmail((row['Work Email'] as string | null) ?? '');
  // No company inbox means no way to deliver a code. Refusing is correct.
  if (!workEmail) return null;

  return {
    workEmail,
    name: ((row['Name'] as string | null) ?? '').trim() || workEmail,
    personalEmail: normEmail((row['Personal Email'] as string | null) ?? '') || null,
    startDate: ((row['Start Date'] as string | null) ?? null),
  };
}

/** The `gift_address_otps` implementation of the core's storage contract. */
function store(): OtpStore | null {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  return {
    async countRecentSends(workEmail, sinceIso) {
      const { count, error } = await supabase
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .ilike('work_email', escapeLikePattern(workEmail))
        .gte('created_at', sinceIso);
      // null propagates a failure so the core can fail CLOSED.
      if (error || count == null) return null;
      return count;
    },
    async insertCode({ workEmail, codeHash, expiresAt, requestIp }) {
      const { error } = await supabase.from(TABLE).insert({
        work_email: workEmail,
        code_hash: codeHash,
        attempts: 0,
        expires_at: expiresAt,
        request_ip: requestIp,
      });
      return !error;
    },
    async findLiveCode(workEmail) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('id, code_hash, attempts, expires_at')
        .ilike('work_email', escapeLikePattern(workEmail))
        .is('consumed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        codeHash: String(row.code_hash),
        attempts: Number(row.attempts ?? 0),
        expiresAt: String(row.expires_at),
      };
    },
    async recordFailedAttempt(id, attempts, killNowIso) {
      const patch: Record<string, unknown> = { attempts };
      if (killNowIso) patch.expires_at = killNowIso;
      await supabase.from(TABLE).update(patch).eq('id', id);
    },
    async consume({ id, consumedAtIso, sessionTokenHash, sessionExpiresAtIso }) {
      const { error } = await supabase
        .from(TABLE)
        .update({
          consumed_at: consumedAtIso,
          session_token: sessionTokenHash,
          session_expires_at: sessionExpiresAtIso,
        })
        .eq('id', id);
      return !error;
    },
    async findSession(sessionTokenHash) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('work_email, consumed_at, session_expires_at')
        .eq('session_token', sessionTokenHash)
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      const workEmail = normEmail((row.work_email as string | null) ?? '');
      // A row with no usable work email is not a session anybody can act on.
      // Refusing beats coercing to '' — an empty identity that flowed onward
      // would match nobody and fail confusingly much further downstream.
      if (!workEmail) return null;
      return {
        workEmail,
        consumedAt: (row.consumed_at as string | null) ?? null,
        sessionExpiresAt: (row.session_expires_at as string | null) ?? null,
      };
    },
  };
}

/** Mint a code for a verified work email. Returns the plaintext to email, or null. */
export async function createGiftAddressOtp(
  workEmail: string,
  requestIp: string | null,
): Promise<string | null> {
  const s = store();
  if (!s) return null;
  const target = normEmail(workEmail);
  // Callers pass a value already resolved from the roster, so a blank here means
  // a caller bug. Refuse rather than mint a code nobody could ever verify.
  if (!target) return null;
  return issueCode(s, target, requestIp);
}

/**
 * Verify a typed code.
 *
 * An email belonging to nobody reports `expired` — exactly what a real employee
 * with no live code gets — so this cannot be used to tell who works here.
 */
export async function verifyGiftAddressOtp(
  email: string,
  code: string,
): Promise<VerifyOutcome & { person?: GiftAddressPerson }> {
  const person = await findActiveEmployeeByEmail(email);
  if (!person) return { ok: false, reason: 'expired' };

  const s = store();
  if (!s) return { ok: false, reason: 'invalid' };

  const out = await verifyCode(s, person.workEmail, code);
  return out.ok ? { ...out, person } : out;
}

/**
 * Resolve a session token to the person it was minted for.
 *
 * **The only trusted source of identity after verification.** Every read and
 * write behind the code must go through this and must never accept an email
 * from the request body — that is the redirect-someone-else's-gift hole.
 */
export async function resolveGiftAddressSession(
  token: string,
): Promise<GiftAddressPerson | null> {
  const s = store();
  if (!s) return null;
  const workEmail = await resolveSession(s, token);
  if (!workEmail) return null;
  // Re-read the roster rather than trusting anything cached on the OTP row: a
  // person offboarded mid-session must stop here.
  return findActiveEmployeeByEmail(workEmail);
}
