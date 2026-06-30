import "server-only";

import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";
import { escapeLikePattern } from "@/lib/db/like-escape";

/**
 * Server-side machinery for the public /update-bank-info flow.
 *
 * Step 1 (request): resolve a typed email to an ACTIVE master-list employee,
 *   mint a 6-digit code, store its HASH, and hand the plaintext back to the
 *   route so it can be emailed to the employee's WORK inbox.
 * Step 2 (verify): match the code (constant-time), then mint a random session
 *   token so the prefill + save steps don't re-prompt for the code.
 * Step 3 (save): resolve the session token back to a work_email — the save
 *   endpoint trusts THIS, never a client-supplied email.
 *
 * Codes/sessions live in `bank_update_otps` (see
 * references/sql/migrate/2026-06-29_bank_update_external_link.sql).
 */

const OTP_TABLE = "bank_update_otps";

const CODE_TTL_MS = 10 * 60_000; // 10 minutes
const SESSION_TTL_MS = 20 * 60_000; // 20 minutes
const MAX_ATTEMPTS = 5; // failed verifies before a code is killed
const THROTTLE_WINDOW_MS = 15 * 60_000; // window for the send cap
const MAX_SENDS_PER_WINDOW = 3; // codes mailed per email per window

export interface ActiveEmployeeMatch {
  /** The canonical "Work Email" the code is mailed to. */
  workEmail: string;
  /** Display name for the email greeting / audit. */
  name: string;
  /** "Personal Email" on file — used only for the onboarding-submission prefill fallback. */
  personalEmail: string | null;
}

/** Pepper the hash with the deployment secret so a DB leak can't brute a 6-digit code offline cheaply. */
function pepper(): string {
  return process.env.NEXTAUTH_SECRET?.trim() || "bank-update-otp";
}

function hashCode(code: string, workEmail: string): string {
  return createHash("sha256").update(`${code}.${workEmail}.${pepper()}`).digest("hex");
}

/** Hash a session token so a DB leak yields no replayable token (the raw token lives only in the client). */
function hashSessionToken(token: string): string {
  return createHash("sha256").update(`${token}.${pepper()}`).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** A 6-digit numeric code, zero-padded (000000–999999). */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Resolve a typed email to an ACTIVE employee in the global master list.
 *
 * Matches on "Work Email" first, then "Personal Email" — but the returned
 * `workEmail` is ALWAYS the row's company address, so the code is delivered to
 * a company-controlled inbox even when the employee typed their personal email.
 * Returns null when there's no active match (or no work email to mail).
 */
export async function findActiveEmployeeByEmail(
  email: string,
): Promise<ActiveEmployeeMatch | null> {
  const target = normEmail(email);
  if (!target) return null;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  // active_employees = global_master_list filtered to the current upload and
  // not off-boarded. Select only columns guaranteed to exist. Escape LIKE
  // metacharacters so a value like "%" can't match an arbitrary employee
  // (the master-list email columns aren't lowercased, so we keep ilike).
  const pattern = escapeLikePattern(target);
  const tryColumn = async (col: string) =>
    supabase
      .from("active_employees")
      .select('"Name","Work Email","Personal Email"')
      .ilike(col, pattern)
      .limit(1)
      .maybeSingle();

  let res = await tryColumn('"Work Email"');
  if (!res.data && !res.error) res = await tryColumn('"Personal Email"');
  if (res.error || !res.data) return null;

  const row = res.data as Record<string, unknown>;
  const workEmail = normEmail((row["Work Email"] as string | null) ?? "");
  if (!workEmail) return null; // can't mail a code without a work inbox

  return {
    workEmail,
    name: ((row["Name"] as string | null) ?? "").trim() || workEmail,
    personalEmail: normEmail((row["Personal Email"] as string | null) ?? ""),
  };
}

/**
 * Mint + persist a code for a verified work email. Enforces a per-email send
 * cap (MAX_SENDS_PER_WINDOW per THROTTLE_WINDOW_MS). Returns the plaintext code
 * for the caller to email, or null when throttled / DB unavailable.
 */
export async function createOtpForEmail(
  workEmail: string,
  requestIp: string | null,
): Promise<string | null> {
  const target = normEmail(workEmail);
  if (!target) return null;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  // Throttle: how many codes were issued for this email recently? Fail CLOSED
  // (treat a count error / null as "throttled") so a transient DB error can't be
  // used to bypass the per-email send cap and email-bomb a victim's inbox.
  const sinceIso = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString();
  const { count, error: countError } = await supabase
    .from(OTP_TABLE)
    .select("id", { count: "exact", head: true })
    .ilike("work_email", escapeLikePattern(target))
    .gte("created_at", sinceIso);
  if (countError || count == null || count >= MAX_SENDS_PER_WINDOW) return null;

  const code = generateOtpCode();
  const nowMs = Date.now();
  const { error } = await supabase.from(OTP_TABLE).insert({
    work_email: target,
    code_hash: hashCode(code, target),
    attempts: 0,
    expires_at: new Date(nowMs + CODE_TTL_MS).toISOString(),
    request_ip: requestIp,
  });
  if (error) return null;

  return code;
}

export type VerifyResult =
  | { ok: true; workEmail: string; sessionToken: string; name: string; personalEmail: string | null }
  | { ok: false; reason: "invalid" | "expired" | "locked" };

/**
 * Verify a typed code against the latest live code for the email's work inbox.
 * On success consumes the code and mints a session token. On mismatch bumps the
 * attempt counter and kills the code once MAX_ATTEMPTS is hit.
 */
export async function verifyOtp(email: string, code: string): Promise<VerifyResult> {
  const match = await findActiveEmployeeByEmail(email);
  // Report a non-employee identically to "no live code" so verify can't be used
  // to distinguish real active employees from non-employees (enumeration).
  if (!match) return { ok: false, reason: "expired" };
  const workEmail = match.workEmail;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, reason: "invalid" };

  const nowMs = Date.now();
  const { data: row, error } = await supabase
    .from(OTP_TABLE)
    .select("id, code_hash, attempts, expires_at, consumed_at")
    .ilike("work_email", escapeLikePattern(workEmail))
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !row) return { ok: false, reason: "expired" };
  if (Date.parse(row.expires_at as string) <= nowMs) return { ok: false, reason: "expired" };

  const supplied = String(code ?? "").trim();
  const matches =
    /^\d{6}$/.test(supplied) && constantTimeEqualHex(hashCode(supplied, workEmail), row.code_hash as string);

  if (!matches) {
    const attempts = ((row.attempts as number) ?? 0) + 1;
    const patch: Record<string, unknown> = { attempts };
    // Kill the code once it's been guessed at too many times.
    if (attempts >= MAX_ATTEMPTS) patch.expires_at = new Date(nowMs).toISOString();
    await supabase.from(OTP_TABLE).update(patch).eq("id", row.id);
    return { ok: false, reason: attempts >= MAX_ATTEMPTS ? "locked" : "invalid" };
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const { error: consumeErr } = await supabase
    .from(OTP_TABLE)
    .update({
      consumed_at: new Date(nowMs).toISOString(),
      // Store only the HASH; the raw token is returned to the client once.
      session_token: hashSessionToken(sessionToken),
      session_expires_at: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    })
    .eq("id", row.id);
  if (consumeErr) return { ok: false, reason: "invalid" };

  return { ok: true, workEmail, sessionToken, name: match.name, personalEmail: match.personalEmail };
}

/**
 * Resolve a post-verification session token back to its work_email. Returns
 * null when the token is unknown, never verified, or past its TTL. The save
 * endpoint relies on this — it is the ONLY trusted source of the target email.
 */
export async function resolveSessionToken(token: string): Promise<string | null> {
  const t = (token ?? "").trim();
  if (!t) return null;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;

  const { data: row, error } = await supabase
    .from(OTP_TABLE)
    .select("work_email, session_expires_at, consumed_at")
    .eq("session_token", hashSessionToken(t))
    .limit(1)
    .maybeSingle();

  if (error || !row || !row.consumed_at) return null;
  if (!row.session_expires_at || Date.parse(row.session_expires_at as string) <= Date.now()) {
    return null;
  }
  return normEmail((row.work_email as string | null) ?? "");
}
