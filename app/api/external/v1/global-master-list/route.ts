import { NextRequest, NextResponse } from 'next/server';
import { authenticateExternalRequest, messageForDenial } from '@/lib/external-api/authenticate';
import { applyGmlQuery, MAX_LIMIT, parseGmlQuery } from '@/lib/external-api/gml-query';
import { SlidingWindowLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '@/lib/external-api/rate-limit';
import { insertExternalApiRequest, readActiveGmlRows, touchLastUsed } from '@/lib/supabase/external-api-db';
import { clientIp } from '@/lib/audit/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/external/v1/global-master-list — the one endpoint outside systems get.
 *
 *   Authorization: Bearer hris_live_…
 *   ?department=  exact, case-insensitive
 *   ?email=       matches any of the four email columns
 *   ?search=      substring over Name + emails
 *   ?limit=       1–500 (default 100)
 *   ?cursor=      the previous page's `page.next_cursor`
 *
 * Read-only by construction: this file exports GET and nothing else, so every
 * other method is a framework 405. Off-boarded people are unreachable — filtered
 * in SQL and again in `applyGmlQuery`; no parameter widens it. All columns of
 * the active row are returned (Kane, 2026-09-16).
 *
 * Every call writes ONE `external_api_requests` row — success, 400, 401, 403,
 * 429, 500, 503 alike — carrying the presented key prefix, ip, user-agent and
 * duration. That table is the answer to "what system is using this and when".
 *
 * The SSO proxy lets `/api/external/*` through untouched; THIS is the gate.
 */

const limiter = new SlidingWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
let sweepCounter = 0;

const PATH = '/api/external/v1/global-master-list';

function queryRecord(params: URLSearchParams): Record<string, unknown> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v.slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  const params = req.nextUrl.searchParams;
  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent')?.slice(0, 300) ?? null;
  const query = queryRecord(params);

  const log = async (args: {
    clientId: string | null;
    keyPrefix: string | null;
    status: number;
    rowCount: number | null;
    denial: string | null;
  }) => {
    await insertExternalApiRequest({
      client_id: args.clientId,
      key_prefix: args.keyPrefix,
      method: 'GET',
      path: PATH,
      query,
      status: args.status,
      row_count: args.rowCount,
      denial: args.denial,
      ip,
      user_agent: userAgent,
      duration_ms: Date.now() - started,
    });
  };

  // 1. Who is calling.
  const auth = await authenticateExternalRequest(req);
  if (!auth.ok) {
    await log({ clientId: null, keyPrefix: auth.keyPrefix, status: auth.status, rowCount: null, denial: auth.denial });
    return NextResponse.json(
      { error: messageForDenial(auth.denial) },
      { status: auth.status, headers: { 'WWW-Authenticate': 'Bearer realm="simple-hris-external"' } },
    );
  }
  const client = auth.client;

  // 2. How often.
  if (++sweepCounter % 500 === 0) limiter.sweep();
  const rate = limiter.hit(client.id);
  const rateHeaders = {
    'X-RateLimit-Limit': String(rate.limit),
    'X-RateLimit-Remaining': String(rate.remaining),
  };
  if (!rate.allowed) {
    await log({ clientId: client.id, keyPrefix: auth.keyPrefix, status: 429, rowCount: null, denial: 'rate_limited' });
    return NextResponse.json(
      { error: `Rate limit exceeded: ${rate.limit} requests per minute per key. Retry after ${rate.retryAfterSeconds}s.` },
      { status: 429, headers: { ...rateHeaders, 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  // 3. What they asked for.
  const parsed = parseGmlQuery(params);
  if (!parsed.ok) {
    await log({ clientId: client.id, keyPrefix: auth.keyPrefix, status: 400, rowCount: null, denial: 'bad_request' });
    return NextResponse.json({ error: 'Invalid query', details: parsed.errors }, { status: 400, headers: rateHeaders });
  }

  // 4. The read. Active rows only, paged past the PostgREST cap.
  const { rows, error } = await readActiveGmlRows();
  if (error) {
    await log({ clientId: client.id, keyPrefix: auth.keyPrefix, status: 500, rowCount: null, denial: 'read_failed' });
    return NextResponse.json({ error: 'Could not read the master list' }, { status: 500, headers: rateHeaders });
  }

  const page = applyGmlQuery(rows, parsed.query);
  await log({ clientId: client.id, keyPrefix: auth.keyPrefix, status: 200, rowCount: page.rows.length, denial: null });
  void touchLastUsed(client.id);

  return NextResponse.json(
    {
      data: page.rows,
      page: {
        limit: parsed.query.limit,
        max_limit: MAX_LIMIT,
        returned: page.rows.length,
        total: page.total,
        next_cursor: page.nextCursor,
      },
      meta: {
        as_of: new Date().toISOString(),
        active_only: true,
        client: client.name,
      },
    },
    { status: 200, headers: { ...rateHeaders, 'Cache-Control': 'no-store' } },
  );
}
