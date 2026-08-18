import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { computePayoutExtras } from '@/lib/payroll/payout-extras';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Money the Overview hero's hours×rates sum can't see — bonuses, adjustments,
 * orphanage, MESA, and the cycle's paid urgent one-offs — summed from the
 * wizard's own staged/live figures (see src/lib/payroll/payout-extras.ts).
 * Rate-visible only (admin / accounting / ceo), same gate as the other
 * payroll-figure endpoints.
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = (req.nextUrl.searchParams.get('source_file') ?? '').trim();
  if (!sourceFile || sourceFile === '__all__') {
    return NextResponse.json({ error: 'A concrete source_file is required' }, { status: 400 });
  }

  try {
    const extras = await computePayoutExtras(sourceFile);
    // The per-person map is ~1,000 entries and the Overview polls this route
    // every 30s — only the table CSV export (per_person=1) needs it.
    if (req.nextUrl.searchParams.get('per_person') === '1') {
      return NextResponse.json(extras);
    }
    const { byEmail: _omit, ...aggregate } = extras;
    return NextResponse.json(aggregate);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to compute payout extras' },
      { status: 500 },
    );
  }
}
