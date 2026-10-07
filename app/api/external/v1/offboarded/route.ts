import { NextRequest, NextResponse } from 'next/server';
import { executeOffboardedRead, parseOffboardedQuery } from '@/lib/external-api/offboarded';
import { admitExternalCall } from '@/lib/external-api/serve';
import { OFFBOARDED_SCOPE } from '@/lib/external-api/scopes';
import { readOffboardedLedgerRows } from '@/lib/supabase/external-api-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/external/v1/offboarded — the leavers list, for keys holding `offboarded.read`
 * (Kane, 2026-10-07: "lets add the offboarded list so that a key can be used to access this").
 *
 *   Authorization: Bearer hris_live_…
 *   ?email=        exact work email, case-insensitive
 *   ?department=   exact, case-insensitive
 *   ?reason=       a reason CATEGORY (ncns · resigned · end_of_contract · performance · attendance ·
 *                  time_manipulation · policy_violation · no_show · declined_offer · rescheduled · other)
 *   ?since= ?until=  YYYY-MM-DD, inclusive, on the date they left
 *   ?search=       substring over name + work email
 *   ?limit=        1–500 (default 100)
 *   ?cursor=       the previous page's `page.next_cursor`
 *
 * Source: the `offboarded_sheet` ledger — one row per recorded departure. Temporary
 * pauses and the other not-a-departure labels are never served; the stored reason
 * label goes out only as its category; personal email, the note and the actor are never
 * read (`offboarded.ts`). The fields are fixed — there is no per-field grant on this scope.
 *
 * Read-only by construction: GET only. Same gate, same per-client rate budget and the
 * same request log as the roster route (`serve.ts`); a key without this scope is a 403.
 * The SSO proxy lets `/api/external/*` through; `admitExternalCall` is the gate.
 */

const PATH = '/api/external/v1/offboarded';

function queryRecord(params: URLSearchParams): Record<string, unknown> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v.slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const admitted = await admitExternalCall(req, { scopes: [OFFBOARDED_SCOPE], method: 'GET', path: PATH, query: queryRecord(params) });
  if (!admitted.ok) return NextResponse.json(admitted.body, { status: admitted.status, headers: admitted.headers });
  const { client, rateHeaders, log, touch } = admitted;

  const parsed = parseOffboardedQuery(params);
  if (!parsed.ok) {
    await log({ status: 400, rowCount: null, denial: 'bad_request' });
    return NextResponse.json({ error: 'Invalid query', details: parsed.errors }, { status: 400, headers: rateHeaders });
  }

  const outcome = await executeOffboardedRead(readOffboardedLedgerRows, parsed.query);
  if (!outcome.ok) {
    await log({ status: outcome.status, rowCount: null, denial: outcome.denial });
    return NextResponse.json({ error: outcome.error }, { status: outcome.status, headers: rateHeaders });
  }

  await log({ status: 200, rowCount: outcome.data.length, denial: null });
  touch();

  return NextResponse.json(
    {
      data: outcome.data,
      page: outcome.page,
      meta: {
        as_of: new Date().toISOString(),
        dataset: 'offboarded',
        client: client.name,
        columns: outcome.columns,
        expires_at: client.expires_at,
      },
    },
    { status: 200, headers: { ...rateHeaders, 'Cache-Control': 'no-store' } },
  );
}
