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
 * MUST paginate: PostgREST caps un-ranged selects at 1000 rows and the table
 * passed 9,000 rows in Jul 2026 — an un-paged read silently dropped every old
 * baseline row (the 1970-dated backfills), so the wizard prorated against a
 * truncated history while believing it had it all.
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ rows: [], error: null });

  const PAGE = 1000;
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('employee_rate_history')
      .select('employee_email, regular_rate, ot_rate, effective_from')
      .order('effective_from', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return NextResponse.json({ rows, error: null });
}
