import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { resolveTerminationFacts } from '@/lib/documents/termination/termination-facts';
import type { TerminationFactsResponse } from '@/lib/documents/termination/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * [TERMINATION-DOCS] The facts sheet the rep reviews before generating.
 *
 *   GET ?work_email=<work email> → { facts, blocked, error? }
 *
 * `view`, like every read on this surface. The argument is a WORK email only
 * (G1) — search hands the panel the identity, and `resolveTerminationFacts`
 * takes nothing else, so no printed fact can ever descend from a personal inbox.
 *
 * A refusal comes back **200 with `blocked` set**, not 409: this is the review
 * surface, and the panel renders the reason (still active, temporary pause,
 * ambiguous identity, …) in place of the sheet. 409 is reserved for the
 * generate POST, where a refusal aborts a mutation.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const workEmail = normEmail(req.nextUrl.searchParams.get('work_email'));
  if (!workEmail) {
    return NextResponse.json(
      { facts: null, blocked: null, error: 'work_email is required' } as TerminationFactsResponse,
      { status: 400 },
    );
  }

  const { facts, blocked, error } = await resolveTerminationFacts(workEmail);

  // The resolver's third arm is a genuine read failure, kept separate from a
  // refusal so a broken carrier is never displayed as "this person is fine".
  if (error) {
    return NextResponse.json(
      { facts: null, blocked: null, error } as TerminationFactsResponse,
      { status: 500 },
    );
  }

  return NextResponse.json({ facts, blocked } as TerminationFactsResponse);
}
