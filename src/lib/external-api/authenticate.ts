import 'server-only';

import { findClientByKeyHash, type ExternalApiClientRow } from '@/lib/supabase/external-api-db';
import { bearerToken, constantTimeEqualHex, hashApiKey, keyPrefix, looksLikeApiKey, readPepper } from './keys';
import { isExpired } from './expiry';

/**
 * Turn `Authorization: Bearer <key>` into a live client row, or a typed denial.
 *
 * Outward, every 401 says the same sentence — `Invalid or revoked API key` —
 * so a caller cannot tell "no such key" from "revoked" from "wrong shape".
 * Inward, `denial` names the exact reason and is written to the request log,
 * which is where an admin reads it.
 *
 * FAILS CLOSED on every "we cannot tell" branch: no pepper, DB unreachable,
 * table not applied → 503, never a pass. The only 200 path is a hash match on
 * a row whose `revoked_at` is null, whose `expires_at` is null or in the future
 * (2026-09-17 — an unparseable stamp counts as expired), and whose scopes include
 * the read. Expiry is checked on every call against the row, so shortening it in
 * the admin panel takes effect on the next call, like a revoke.
 */

export const REQUIRED_SCOPE = 'global_master_list.read';

export type ExternalDenial =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'scope'
  | 'unconfigured'
  | 'unavailable';

export type ExternalAuth =
  | { ok: true; client: ExternalApiClientRow; keyPrefix: string }
  | { ok: false; denial: ExternalDenial; status: 401 | 403 | 503; keyPrefix: string | null };

export const DENIED_MESSAGE = 'Invalid or revoked API key';
export const UNCONFIGURED_MESSAGE = 'The external API is not configured on this deployment';
export const UNAVAILABLE_MESSAGE = 'The external API is temporarily unavailable';

export async function authenticateExternalRequest(request: Request): Promise<ExternalAuth> {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return { ok: false, denial: 'missing', status: 401, keyPrefix: null };
  if (!looksLikeApiKey(token)) return { ok: false, denial: 'malformed', status: 401, keyPrefix: null };
  const prefix = keyPrefix(token);

  const pepper = readPepper();
  if (!pepper.ok) return { ok: false, denial: 'unconfigured', status: 503, keyPrefix: prefix };

  const hash = hashApiKey(token, pepper.pepper);
  const found = await findClientByKeyHash(hash);
  if (found.error) return { ok: false, denial: 'unavailable', status: 503, keyPrefix: prefix };
  const client = found.data;
  if (!client) return { ok: false, denial: 'unknown', status: 401, keyPrefix: prefix };
  // The lookup was by equality already; this is the belt to that brace.
  if (!constantTimeEqualHex(client.key_hash, hash)) return { ok: false, denial: 'unknown', status: 401, keyPrefix: prefix };
  if (client.revoked_at) return { ok: false, denial: 'revoked', status: 401, keyPrefix: prefix };
  if (isExpired(client.expires_at)) return { ok: false, denial: 'expired', status: 401, keyPrefix: prefix };
  if (!Array.isArray(client.scopes) || !client.scopes.includes(REQUIRED_SCOPE)) {
    return { ok: false, denial: 'scope', status: 403, keyPrefix: prefix };
  }
  return { ok: true, client, keyPrefix: prefix };
}

export function messageForDenial(denial: ExternalDenial): string {
  if (denial === 'unconfigured') return UNCONFIGURED_MESSAGE;
  if (denial === 'unavailable') return UNAVAILABLE_MESSAGE;
  return DENIED_MESSAGE;
}
