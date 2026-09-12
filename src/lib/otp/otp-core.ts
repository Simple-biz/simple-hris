import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Table-agnostic machinery for an emailed one-time code + a post-verification
 * session token.
 *
 * Extracted 2026-09-12 for the public /update-gift-address flow. The logic here
 * is lifted from `src/lib/bank-update/otp.ts`, which shipped 2026-06-29 and is
 * still the only caller of its own copy: that flow is a live money path, so it
 * was deliberately NOT migrated in the same change that introduced this module.
 * **Two copies of security-critical code is a known debt, recorded in
 * docs/features/gift-address-external-link.md § Deploy notes.** Fix a bug here
 * and check the bank copy for the same bug until they converge.
 *
 * THE PROPERTIES THIS FILE EXISTS TO HOLD
 * ---------------------------------------
 *  - **The code is never stored.** Only sha256(code · email · pepper), compared
 *    in constant time. A database leak does not hand anybody a live code.
 *  - **The session token is never stored either** — only its hash. The raw token
 *    exists once, in the browser that verified.
 *  - **The throttle fails CLOSED.** A count that errors or returns null is
 *    treated as "already at the cap", so a transient database fault cannot be
 *    used to email-bomb someone's inbox.
 *  - **Nothing here reveals whether an email exists.** That is the caller's job
 *    too, but the verify path deliberately reports "no such person" and "no live
 *    code" identically so the two cannot be told apart.
 *
 * This module performs NO authorization of its own. Resolving an email to a
 * person is injected by the caller, so the audience (active roster, a specific
 * department, anyone) is decided at the boundary and is visible there.
 *
 * NO `server-only` HERE, DELIBERATELY. This file touches no database and holds
 * no secret of its own — it is pure crypto over an injected {@link OtpStore},
 * which is exactly what makes it unit-testable. The `server-only` guard sits on
 * the module that binds a real table (`src/lib/gift-address/otp.ts`), which is
 * the boundary that actually matters. Do not import this from a client
 * component: `pepper()` reads a server env var and would silently fall back to
 * its literal default in a browser bundle.
 */

/** How long a freshly minted code stays usable. */
export const CODE_TTL_MS = 10 * 60_000;
/** How long a verified session lasts before the person must re-verify. */
export const SESSION_TTL_MS = 20 * 60_000;
/** Failed verifies before the code is killed outright. */
export const MAX_ATTEMPTS = 5;
/** Window the send cap is measured over. */
export const THROTTLE_WINDOW_MS = 15 * 60_000;
/** Codes mailed per email per window. */
export const MAX_SENDS_PER_WINDOW = 3;

/**
 * The minimum a store must do. Implemented once per table; kept this narrow so
 * a new flow cannot accidentally acquire a capability (deleting rows, reading
 * another email's codes) it has no reason to have.
 */
export interface OtpStore {
  /** Codes issued for this email since `sinceIso`, or null if the count failed. */
  countRecentSends(workEmail: string, sinceIso: string): Promise<number | null>;
  insertCode(row: {
    workEmail: string;
    codeHash: string;
    expiresAt: string;
    requestIp: string | null;
  }): Promise<boolean>;
  /** The newest UNCONSUMED code for this email, or null. */
  findLiveCode(workEmail: string): Promise<{
    id: string;
    codeHash: string;
    attempts: number;
    expiresAt: string;
  } | null>;
  recordFailedAttempt(id: string, attempts: number, killNowIso: string | null): Promise<void>;
  consume(row: {
    id: string;
    consumedAtIso: string;
    sessionTokenHash: string;
    sessionExpiresAtIso: string;
  }): Promise<boolean>;
  /** Resolve a hashed session token to its row, or null. */
  findSession(sessionTokenHash: string): Promise<{
    workEmail: string;
    consumedAt: string | null;
    sessionExpiresAt: string | null;
  } | null>;
}

/**
 * The pepper. A database leak still has to brute-force against a secret the
 * database does not contain — without it a 6-digit space is trivially reversed
 * from the hash alone.
 */
function pepper(): string {
  return process.env.NEXTAUTH_SECRET?.trim() || 'simple-hris-otp';
}

export function hashCode(code: string, workEmail: string): string {
  return createHash('sha256').update(`${code}.${workEmail}.${pepper()}`).digest('hex');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(`${token}.${pepper()}`).digest('hex');
}

/**
 * Constant-time hex comparison.
 *
 * `===` on a hash leaks, through timing, how many leading characters matched —
 * which turns a 6-digit search into a per-character one.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** A 6-digit numeric code, zero-padded. `randomInt` is CSPRNG-backed. */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Mint and persist a code. Returns the PLAINTEXT for the caller to email, or
 * null when throttled or the store failed.
 *
 * Null is deliberately indistinguishable from success at the route layer: the
 * caller answers generically either way, so being throttled does not tell an
 * attacker that the address is real.
 */
export async function issueCode(
  store: OtpStore,
  workEmail: string,
  requestIp: string | null,
  now: number = Date.now(),
): Promise<string | null> {
  const sinceIso = new Date(now - THROTTLE_WINDOW_MS).toISOString();
  const recent = await store.countRecentSends(workEmail, sinceIso);
  // FAIL CLOSED. A null here means the count did not happen; treating it as 0
  // would turn any transient database error into an uncapped mailer.
  if (recent === null || recent >= MAX_SENDS_PER_WINDOW) return null;

  const code = generateOtpCode();
  const ok = await store.insertCode({
    workEmail,
    codeHash: hashCode(code, workEmail),
    expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
    requestIp,
  });
  return ok ? code : null;
}

export type VerifyOutcome =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'locked' };

/**
 * Check a typed code and, on success, mint a session token.
 *
 * `expired` is returned both for a genuinely expired code and for an email with
 * no live code at all — including an email belonging to nobody. Distinguishing
 * them would make this endpoint an employee-directory oracle.
 */
export async function verifyCode(
  store: OtpStore,
  workEmail: string,
  supplied: string,
  now: number = Date.now(),
): Promise<VerifyOutcome> {
  const row = await store.findLiveCode(workEmail);
  if (!row) return { ok: false, reason: 'expired' };
  if (Date.parse(row.expiresAt) <= now) return { ok: false, reason: 'expired' };

  const typed = String(supplied ?? '').trim();
  const matches =
    /^\d{6}$/.test(typed) && constantTimeEqualHex(hashCode(typed, workEmail), row.codeHash);

  if (!matches) {
    const attempts = (row.attempts ?? 0) + 1;
    const kill = attempts >= MAX_ATTEMPTS ? new Date(now).toISOString() : null;
    await store.recordFailedAttempt(row.id, attempts, kill);
    return { ok: false, reason: attempts >= MAX_ATTEMPTS ? 'locked' : 'invalid' };
  }

  const sessionToken = randomBytes(32).toString('base64url');
  const consumed = await store.consume({
    id: row.id,
    consumedAtIso: new Date(now).toISOString(),
    sessionTokenHash: hashSessionToken(sessionToken),
    sessionExpiresAtIso: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  if (!consumed) return { ok: false, reason: 'invalid' };

  return { ok: true, sessionToken };
}

/**
 * Resolve a raw session token back to the work email it was minted for.
 *
 * **This is the ONLY trusted source of identity after verification.** Every
 * write path must call this and must never read a target email out of the
 * request body — that is the salary-redirect hole the bank flow closed, and the
 * same hole exists here for a delivery address.
 */
export async function resolveSession(
  store: OtpStore,
  rawToken: string,
  now: number = Date.now(),
): Promise<string | null> {
  const t = (rawToken ?? '').trim();
  if (!t) return null;

  const row = await store.findSession(hashSessionToken(t));
  if (!row || !row.consumedAt) return null;
  if (!row.sessionExpiresAt || Date.parse(row.sessionExpiresAt) <= now) return null;
  return row.workEmail;
}
