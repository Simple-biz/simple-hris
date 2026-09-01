import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { searchTerminationCandidates } from '@/lib/documents/termination/termination-search';
import type { TerminationSearchResponse } from '@/lib/documents/termination/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * [TERMINATION-DOCS] Accounting → Documents → Termination Docs — person search.
 *
 *   GET ?q=<name, email, or any fragment of either>
 *     → { candidates, degraded, matched, truncated, tooShort, error? }
 *
 * `q` is matched as a PARTIAL value across every name and email column of the
 * master list, the offboarded sheet and the completed offboarding queue, so a
 * surname alone finds someone who left years ago. `truncated` means the
 * candidate cap bit and more identities matched than are listed; `tooShort`
 * means the fragment was under the minimum and NO read ran. Both are stated
 * rather than left to look like "nobody found".
 *
 * Gated on the accounting `documents` feature at `view`, exactly like the queue
 * route beside it. The third argument is NOT optional: `requireFeatureAccess`
 * defaults to `'edit'` (authorize-feature.ts:52), which would 403 every
 * view-only rep. No new feature key exists for this tab — a new key resolves to
 * `'hidden'` for everyone who was never re-granted.
 *
 * A name or a personal email SEARCHES; a work email IDENTIFIES (G1). This route
 * therefore returns a SET the rep disambiguates and never resolves facts itself:
 * one personal inbox — and one surname — backs several master identities, and
 * keying off either would issue a termination letter for a working employee. The
 * identity on every candidate is the WORK email carried by the matched row, and
 * the facts route accepts nothing else.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) {
    return NextResponse.json({
      candidates: [],
      degraded: [],
      matched: 0,
      truncated: false,
      tooShort: false,
    } as TerminationSearchResponse);
  }

  const { candidates, degraded, error, matched, truncated, tooShort } =
    await searchTerminationCandidates(q);

  // A partially-degraded read is NOT a failure: `selectAllPaged` returns the rows
  // it got alongside the error, and the panel must be able to say "this list may
  // be incomplete" instead of showing a confident "nobody found". Only a read
  // that produced nothing at all is a 500 — otherwise an empty result would be
  // indistinguishable from a genuine no-match.
  if (error && candidates.length === 0) {
    return NextResponse.json(
      {
        candidates: [],
        degraded,
        matched: 0,
        truncated: false,
        tooShort,
        error,
      } as TerminationSearchResponse,
      { status: 500 },
    );
  }

  // `matched`, `truncated` and `tooShort` always ride along: a rep who cannot
  // see a row concludes the person is not on file, so a capped list has to say
  // it is capped and a too-short query has to say so instead of reading as "no
  // such person".
  const body: TerminationSearchResponse = error
    ? { candidates, degraded, matched, truncated, tooShort, error }
    : { candidates, degraded, matched, truncated, tooShort };
  return NextResponse.json(body);
}
