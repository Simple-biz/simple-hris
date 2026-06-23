import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { buildPeopleStats, buildOtLeadersForFile } from '@/lib/people/people-roster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * People → Statistics tab. Carries pay figures, so it is gated to
 * RATE_VISIBLE_ROLES (admin / accounting / ceo).
 *
 *  - `GET`                    → the weekly OT trend (`points`) plus the
 *    cross-week aggregate leaderboard (`otLeaders`) and department rollup
 *    (`otDepts`), used for "All recent weeks".
 *  - `GET ?source_file=FILE`  → the ranked OT leaders (`leaders`) and department
 *    rollup (`depts`) for that one CSV period, so both tabs of the leaderboard
 *    can authoritatively follow the selector.
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim();
  if (sourceFile) {
    const { leaders, depts, error } = await buildOtLeadersForFile(sourceFile);
    return NextResponse.json({ leaders, depts, error });
  }

  const { points, otLeaders, otDepts, error } = await buildPeopleStats();
  return NextResponse.json({ points, otLeaders, otDepts, error });
}
