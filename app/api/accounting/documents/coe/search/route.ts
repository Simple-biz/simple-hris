import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { searchCoeCandidates, type CoeSearchResult } from '@/lib/documents/coe-admin-search';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Generate COE — person search.
 *
 *   GET ?q=<name or email fragment>
 *     → { candidates, matched, truncated, tooShort, error? }
 *
 * ACTIVE Global Master List people only (Kane 2026-09-01) — the GML's own
 * verdict via fetchGmlStatusMap, and the whole search FAILS CLOSED when that
 * verdict can't be read: no unvetted candidate may be offered a certificate of
 * current engagement. `truncated` and `tooShort` are stated rather than left to
 * read as "nobody found".
 *
 * Gated on the accounting `documents` feature at `view`, exactly like the
 * termination search beside it — the third argument is NOT optional
 * (`requireFeatureAccess` defaults to 'edit', which would 403 view-only reps),
 * and no new feature key exists here: an unknown key resolves to 'hidden' for
 * everyone who was never re-granted.
 *
 * A name or a personal email SEARCHES; a work email IDENTIFIES. The identity on
 * every candidate is the work email carried by the matched row, and the
 * preview/generate routes accept nothing else.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) {
    return NextResponse.json({
      candidates: [],
      matched: 0,
      truncated: false,
      tooShort: false,
      error: null,
    } as CoeSearchResult);
  }

  const result = await searchCoeCandidates(q);
  // Fail-closed read: an errored search returns NO candidates, so a 500 is the
  // honest shape — an empty 200 would read as "no such person".
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
