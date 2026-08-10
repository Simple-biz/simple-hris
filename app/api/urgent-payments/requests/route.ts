import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import type { ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';
import {
  buildPayoutDetails,
  fetchLegacyBankPreferredByEmail,
  fetchPayoutIdsByEmail,
  fetchUsdToPhpRate,
  preferredProcessor,
  usdFromPhp,
} from '@/lib/payroll/urgent-payout-details';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface UrgentOneOffRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string | null;
  amount_php: number | null;
  /** USD equivalent of `amount_php` at the active FX rate — the same figure the
   *  dispatch route will persist, so the queue can headline in dollars. */
  amount_usd: number | null;
  note: string | null;
  requested_by: string | null;
  requested_at: string;
  /** The rail Payment Dispatch would pay this person on (bank_preferred →
   *  disbursement pick → legacy rates cell); `null` when none resolves. */
  processor: ProcessorId | null;
  /** Per-processor payout detail so Mark Paid pre-fills for the chosen processor. */
  details: QueueRow['details'];
}

// GET /api/urgent-payments/requests
// Pending one-off payments filed from the People tab "Pay" action, enriched with
// the recipient's preferred processor + payout detail (same pre-fill as the MESA
// urgent feed). Accounting / payroll-clerk only.
export async function GET() {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data, error } = await supabase
      .from('urgent_payment_requests')
      .select('id, work_email, full_name, department, amount_php, note, requested_by, requested_at')
      .eq('status', 'pending')
      .order('requested_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as Array<{
      id: string;
      work_email: string;
      full_name: string;
      department: string | null;
      amount_php: number | null;
      note: string | null;
      requested_by: string | null;
      requested_at: string;
    }>;

    const [idsByEmail, legacyByEmail, usdToPhp] = await Promise.all([
      fetchPayoutIdsByEmail(supabase, rows.map((r) => r.work_email)),
      fetchLegacyBankPreferredByEmail(supabase, rows.map((r) => r.work_email)),
      fetchUsdToPhpRate(supabase),
    ]);

    const result: UrgentOneOffRow[] = rows.map((r) => {
      const key = r.work_email.trim().toLowerCase();
      const ids = idsByEmail[key];
      return {
        ...r,
        amount_usd: usdFromPhp(r.amount_php, usdToPhp),
        processor: preferredProcessor(ids, legacyByEmail[key]),
        details: buildPayoutDetails(ids, r.work_email),
      };
    });

    return NextResponse.json({ rows: result });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
