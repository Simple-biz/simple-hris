/**
 * External API keys — generate, fingerprint, hash, verify.
 *
 * Pure: no `server-only`, no Supabase, so the tests run under `node --test`.
 * The route layer (`authenticate.ts`) owns the DB lookup.
 *
 * The key is never stored. `external_api_clients.key_hash` holds
 * sha256(key · pepper) and that is the ONLY thing a presented token is compared
 * with — the same shape the OTP flows use (`src/lib/otp/otp-core.ts`). A leaked
 * table still has to brute-force a 256-bit random key against a secret the
 * table does not contain.
 *
 * `readPepper` FAILS CLOSED: with no pepper configured there is nothing to hash
 * against, so no key can be issued and no key can verify. Never default it to a
 * literal — a known pepper makes the hash reproducible from the row alone.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** `hris_live_` + 43 base64url chars (32 CSPRNG bytes). */
export const KEY_PREFIX_LIVE = 'hris_live_';
/** Length of the displayed / logged fingerprint: `hris_live_` + 6 chars. */
export const KEY_PREFIX_LENGTH = KEY_PREFIX_LIVE.length + 6;
const KEY_BODY_BYTES = 32;
const KEY_SHAPE = /^hris_(live|test)_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(): string {
  return KEY_PREFIX_LIVE + randomBytes(KEY_BODY_BYTES).toString('base64url');
}

/** True when the string has the exact shape we issue — cheap pre-filter before any hashing. */
export function looksLikeApiKey(candidate: string): boolean {
  return KEY_SHAPE.test(candidate);
}

/**
 * The fingerprint shown in the admin table and written on every request-log
 * row, valid key or not. Six random chars — enough to tell two clients apart,
 * nowhere near enough to authenticate.
 */
export function keyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX_LENGTH);
}

export function hashApiKey(key: string, pepper: string): string {
  return createHash('sha256').update(`${key}.${pepper}`).digest('hex');
}

/** Constant-time hex comparison — `===` leaks the matching-prefix length through timing. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export type PepperResult = { ok: true; pepper: string } | { ok: false; reason: 'unconfigured' };

/**
 * `EXTERNAL_API_KEY_PEPPER` first; `NEXTAUTH_SECRET` as the fallback so a deploy
 * that has not added the dedicated variable still works (the OTP flows lean on
 * the same secret). Rotating whichever one is in use kills every issued key —
 * that is documented, and it is the correct consequence.
 */
export function readPepper(env: Record<string, string | undefined> = process.env): PepperResult {
  const dedicated = env.EXTERNAL_API_KEY_PEPPER?.trim();
  if (dedicated) return { ok: true, pepper: dedicated };
  const fallback = env.NEXTAUTH_SECRET?.trim();
  if (fallback) return { ok: true, pepper: fallback };
  return { ok: false, reason: 'unconfigured' };
}

/** Parse `Authorization: Bearer <key>`. Returns null when the header is absent or not Bearer. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return m ? m[1] : null;
}
