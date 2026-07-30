import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { fetchHslTransferEffectiveByEmail } from '@/lib/payroll/hsl-transfer-effective';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/hsl-transfers-bulk — effective dates of department transfers
 * INTO HSL, keyed by employee email (`{ effectiveByEmail: { email: 'YYYY-MM-DD' } }`).
 * The Payroll Wizard uses this to day-scope the HSL Weekend Hours treatment in
 * a transfer week (`resolveHslWeekScope`), matching the server dispatch compute
 * (current-pay.ts) exactly. Same gate as rate-history-bulk: the wizard is a
 * rate-visible surface (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  try {
    const map = await fetchHslTransferEffectiveByEmail();
    return NextResponse.json({ effectiveByEmail: Object.fromEntries(map), error: null });
  } catch (e) {
    return NextResponse.json(
      { effectiveByEmail: {}, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
