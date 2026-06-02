import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';

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
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  account_holder_name: string | null;
  phone_number: string | null;
}

// GET /api/urgent-payments
// Returns approved, not-yet-dispatched MESA disbursement requests.
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

    // Batch-fetch employee_ids for Wise account pre-fill
    const emails = [...new Set(rows.map((r) => r.work_email.trim().toLowerCase()))];
    let idsByEmail: Record<string, { wise_email?: string | null; wise_tag?: string | null; account_holder_name?: string | null; phone_number?: string | null }> = {};

    if (emails.length > 0) {
      const { data: idsData } = await supabase
        .from('employee_ids')
        .select('work_email, wise_email, wise_tag, account_holder_name, phone_number')
        .in('work_email', emails);

      for (const row of idsData ?? []) {
        const e = (row.work_email as string | null)?.trim().toLowerCase();
        if (e) idsByEmail[e] = row as typeof idsByEmail[string];
      }
    }

    const result: UrgentPaymentRow[] = rows.map((r) => {
      const emp = idsByEmail[r.work_email.trim().toLowerCase()] ?? {};
      return {
        ...r,
        wise_email: emp.wise_email ?? null,
        wise_tag: emp.wise_tag ?? null,
        account_holder_name: emp.account_holder_name ?? null,
        phone_number: emp.phone_number ?? null,
      };
    });

    return NextResponse.json({ rows: result });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
