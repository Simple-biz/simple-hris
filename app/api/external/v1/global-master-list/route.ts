import { NextRequest, NextResponse } from 'next/server';
import { parseGmlQuery } from '@/lib/external-api/gml-query';
import { executeGmlRead } from '@/lib/external-api/gml-read';
import { admitExternalCall } from '@/lib/external-api/serve';
import { readActiveGmlRows } from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/external/v1/global-master-list — the REST face of the external read API.
 *
 *   Authorization: Bearer hris_live_…
 *   ?department=  exact, case-insensitive          (only if the key can see Department)
 *   ?email=       matches any VISIBLE email column
 *   ?search=      substring over Name + visible email columns
 *   ?limit=       1–500 (default 100)
 *   ?cursor=      the previous page's `page.next_cursor`
 *
 * Read-only by construction: this file exports GET and nothing else, so every
 * other method is a framework 405. Off-boarded people are unreachable — filtered
 * in SQL and again in `applyGmlQuery`; no parameter widens it.
 *
 * Since 2026-09-17 the row carries ONLY the columns the client was granted
 * (`grants.ts`; `meta.columns` lists them), the key can expire, the rate limit
 * is the client's own and is shared with the MCP route, and a filter on a hidden
 * column is a 400 `column_not_granted`. Every call writes ONE
 * `external_api_requests` row — success, 400, 401, 403, 429, 500, 503 alike.
 *
 * The SSO proxy lets `/api/external/*` through untouched; `admitExternalCall` is
 * the gate.
 */

const PATH = '/api/external/v1/global-master-list';

function queryRecord(params: URLSearchParams): Record<string, unknown> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v.slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const admitted = await admitExternalCall(req, { method: 'GET', path: PATH, query: queryRecord(params) });
  if (!admitted.ok) return NextResponse.json(admitted.body, { status: admitted.status, headers: admitted.headers });
  const { client, grant, rateHeaders, log, touch } = admitted;

  const parsed = parseGmlQuery(params);
  if (!parsed.ok) {
    await log({ status: 400, rowCount: null, denial: 'bad_request' });
    return NextResponse.json({ error: 'Invalid query', details: parsed.errors }, { status: 400, headers: rateHeaders });
  }

  const outcome = await executeGmlRead(readActiveGmlRows, parsed.query, grant);
  if (!outcome.ok) {
    await log({ status: outcome.status, rowCount: null, denial: outcome.denial });
    return NextResponse.json(
      { error: outcome.error, ...(outcome.details ? { details: outcome.details } : {}) },
      { status: outcome.status, headers: rateHeaders },
    );
  }

  await log({ status: 200, rowCount: outcome.data.length, denial: null });
  touch();

  return NextResponse.json(
    {
      data: outcome.data,
      page: outcome.page,
      meta: {
        as_of: new Date().toISOString(),
        active_only: true,
        client: client.name,
        columns: outcome.columns,
        expires_at: client.expires_at,
      },
    },
    { status: 200, headers: { ...rateHeaders, 'Cache-Control': 'no-store' } },
  );
}
