import 'server-only';

import { authenticateExternalRequest, messageForDenial, type ExternalDenial } from './authenticate';
import { normalizeGrant, type Grant } from './grants';
import { clampRateLimit, decideFromWindow, RATE_LIMIT_WINDOW_MS, type RateDecision } from './rate-limit';
import {
  countRecentCalls,
  insertExternalApiRequest,
  touchLastUsed,
  type ExternalApiClientRow,
} from '@/lib/supabase/external-api-db';
import { clientIp } from '@/lib/audit/context';

/**
 * The gate every external call passes — REST and MCP alike.
 *
 *   1. who is calling           authenticateExternalRequest (hash → row → revoked / expired / scope)
 *   2. what it may see          the row's granted_columns, normalised (a corrupt grant REFUSES)
 *   3. how often                countRecentCalls over the last 60 s + decideFromWindow, with
 *                               the row's own rate_limit_per_minute — ONE budget for both routes
 *   4. the log row              one per call, denied ones included, written before the answer
 *
 * FAILS CLOSED: a rate count that cannot be read is a 503, never a pass. Nothing is
 * cached between calls — a revoke, an expiry, a hidden column or a lower limit all
 * take effect on the next call.
 */

export type ExternalCallInfo = {
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, unknown> | null;
};

export type LogArgs = { status: number; rowCount: number | null; denial: string | null };

export type Admitted =
  | {
      ok: true;
      client: ExternalApiClientRow;
      grant: Grant;
      keyPrefix: string;
      rate: RateDecision;
      rateHeaders: Record<string, string>;
      /** Writes the request-log row for the FINAL outcome of this call. Await it. */
      log: (args: LogArgs) => Promise<void>;
      /** Best-effort last_used_at stamp; call on success only. */
      touch: () => void;
    }
  | {
      ok: false;
      status: 401 | 403 | 429 | 503;
      body: { error: string };
      headers: Record<string, string>;
    };

export const WWW_AUTHENTICATE = 'Bearer realm="simple-hris-external"';

export async function admitExternalCall(request: Request, info: ExternalCallInfo): Promise<Admitted> {
  const started = Date.now();
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? null;

  const write = async (clientId: string | null, keyPrefix: string | null, args: LogArgs) => {
    await insertExternalApiRequest({
      client_id: clientId,
      key_prefix: keyPrefix,
      method: info.method,
      path: info.path,
      query: info.query,
      status: args.status,
      row_count: args.rowCount,
      denial: args.denial,
      ip,
      user_agent: userAgent,
      duration_ms: Date.now() - started,
    });
  };

  const deny = async (
    clientId: string | null,
    keyPrefix: string | null,
    status: 401 | 403 | 429 | 503,
    denial: ExternalDenial | 'rate_limited',
    error: string,
    headers: Record<string, string> = {},
  ): Promise<Admitted> => {
    await write(clientId, keyPrefix, { status, rowCount: null, denial });
    return { ok: false, status, body: { error }, headers };
  };

  // 1. Who.
  const auth = await authenticateExternalRequest(request);
  if (!auth.ok) {
    return deny(null, auth.keyPrefix, auth.status, auth.denial, messageForDenial(auth.denial), {
      'WWW-Authenticate': WWW_AUTHENTICATE,
    });
  }
  const client = auth.client;

  // 2. What. A stored grant that no longer validates (a column renamed, a hand edit) is a
  //    refusal, never "whole table" — widening on error is the one thing this must not do.
  const grant = normalizeGrant(client.granted_columns);
  if (!grant.ok) {
    console.error('[external-api] stored granted_columns invalid for client', client.id, grant.error);
    return deny(client.id, auth.keyPrefix, 503, 'unavailable', messageForDenial('unavailable'));
  }

  // 3. How often — counted in the DB so every instance sees the same number.
  const now = Date.now();
  const recent = await countRecentCalls(client.id, new Date(now - RATE_LIMIT_WINDOW_MS).toISOString());
  if (recent.error !== null) {
    console.error('[external-api] rate count failed — refusing the call:', recent.error);
    return deny(client.id, auth.keyPrefix, 503, 'unavailable', messageForDenial('unavailable'));
  }
  const limit = clampRateLimit(client.rate_limit_per_minute);
  const rate = decideFromWindow({
    limit,
    countInWindow: recent.data.count,
    oldestInWindowMs: recent.data.oldestIso ? new Date(recent.data.oldestIso).getTime() : null,
    nowMs: now,
  });
  const rateHeaders = {
    'X-RateLimit-Limit': String(rate.limit),
    'X-RateLimit-Remaining': String(rate.remaining),
  };
  if (!rate.allowed) {
    return deny(
      client.id,
      auth.keyPrefix,
      429,
      'rate_limited',
      `Rate limit exceeded: ${rate.limit} requests per minute for this key. Retry after ${rate.retryAfterSeconds}s.`,
      { ...rateHeaders, 'Retry-After': String(rate.retryAfterSeconds) },
    );
  }

  return {
    ok: true,
    client,
    grant: grant.grant,
    keyPrefix: auth.keyPrefix,
    rate,
    rateHeaders,
    log: (args) => write(client.id, auth.keyPrefix, args),
    touch: () => void touchLastUsed(client.id),
  };
}
