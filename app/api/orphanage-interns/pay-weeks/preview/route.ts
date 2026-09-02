import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { buildInternWeekPreview } from '@/lib/interns/intern-week-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/orphanage-interns/pay-weeks/preview?source_file=…
 *
 * The mini wizard's numbers: every intern row in the stored report, priced
 * server-side (caps × dated rate, intern PAB on the payout week, the split),
 * with refusals, readiness and the list of reasons Lock in is refused.
 * Readable by the Orphanage dashboard (interns view) and by Accounting
 * (payroll_wizard view) — same figures on both sides, from one pricer.
 */
export async function GET(req: NextRequest) {
  const orphanage = await requireFeatureAccess('orphanage', 'interns', 'view');
  if (!orphanage.ok) {
    const accounting = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
    if (!accounting.ok) return deniedResponse(orphanage);
  }
  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim();
  if (!sourceFile) return NextResponse.json({ error: 'source_file is required' }, { status: 400 });
  const { preview, error } = await buildInternWeekPreview(sourceFile);
  if (error || !preview) return NextResponse.json({ preview: null, error: error ?? 'Preview failed' }, { status: 404 });
  return NextResponse.json({ preview, error: null });
}
