import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { fetchLastSyncTimestamps } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Last successful Google-Sheet sync timestamps for the Payroll Wizard's
 * Initialize step — one per source (master roster / payroll rates / Hogan Smith
 * pay plan). Read from the audit trail each sync route already writes, so both
 * cron-triggered and manual button syncs are reflected. Rate-visible only
 * (admin / accounting / ceo), matching the wizard's own gate.
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { master, rates, hsl, error } = await fetchLastSyncTimestamps();
  if (error) return NextResponse.json({ master, rates, hsl, error }, { status: 500 });
  return NextResponse.json({ master, rates, hsl, error: null });
}
