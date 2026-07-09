import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/payroll/rate-history-bulk — every `employee_rate_history` row
 * (email, reg/ot rate, effective_from), newest-first. The Payroll Wizard uses
 * this to prorate mid-week rate changes per employee for the selected period,
 * matching the server dispatch compute (current-pay.ts). Pay data → gated to
 * rate-visible roles (admin / accounting / ceo).
 *
 * The table is small (≈one row per rate change + a baseline per employee), so
 * it returns unpaginated.
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ rows: [], error: null });

  const { data, error } = await supabase
    .from('employee_rate_history')
    .select('employee_email, regular_rate, ot_rate, effective_from')
    .order('effective_from', { ascending: false });

  if (error) return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [], error: null });
}
