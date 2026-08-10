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

interface UrgentPaymentRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  /** USD equivalent of `amount_needed` at the active FX rate — the same figure
   *  the dispatch route will persist, so the queue can headline in dollars. */
  amount_usd: number | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** The rail Payment Dispatch would pay this person on (bank_preferred →
   *  disbursement pick → legacy rates cell). `null` when none resolves — the
   *  clerk must then choose, rather than the card guessing a rail the payee
   *  isn't set up on. */
  processor: ProcessorId | null;
  /** Per-processor payout detail so Mark Paid pre-fills for whichever processor the clerk picks. */
  details: QueueRow['details'];
}

// GET /api/urgent-payments
// Returns approved, not-yet-dispatched MESA disbursement requests, each carrying
// the recipient's preferred payment processor + payout details so the Urgent
// queue can default + pre-fill the Mark Paid dialog per recipient.
// Accounting / payroll-clerk only.
export async function GET() {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data, error } = await supabase
      .from('mesa_requests')
      .select('id, work_email, full_name, department, disbursement_reason, explanation, amount_needed, created_at, reviewed_by, reviewed_at')
      .eq('request_type', 'disbursement')
      .eq('status', 'approved')
      .is('dispatched_at', null)
      .order('reviewed_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as Array<{
      id: string;
      work_email: string;
      full_name: string;
      department: string;
      disbursement_reason: string | null;
      explanation: string | null;
      amount_needed: number | null;
      created_at: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
    }>;

    // Batch-fetch employee_ids for processor preference + payout pre-fill, and
    // the FX rate for the USD equivalent (one query each, not per row).
    const [idsByEmail, legacyByEmail, usdToPhp] = await Promise.all([
      fetchPayoutIdsByEmail(supabase, rows.map((r) => r.work_email)),
      fetchLegacyBankPreferredByEmail(supabase, rows.map((r) => r.work_email)),
      fetchUsdToPhpRate(supabase),
    ]);

    const result: UrgentPaymentRow[] = rows.map((r) => {
      const key = r.work_email.trim().toLowerCase();
      const ids = idsByEmail[key];
      return {
        ...r,
        amount_usd: usdFromPhp(r.amount_needed, usdToPhp),
        processor: preferredProcessor(ids, legacyByEmail[key]),
        details: buildPayoutDetails(ids, r.work_email),
      };
    });

    return NextResponse.json({ rows: result });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
