import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse, requireRateVisibilitySession } from '@/lib/auth/authorize-email';
import { sendUrgentPaymentAlert } from '@/lib/people/urgent-payment-notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/people/pay
// CEO / Accounting file a one-off payment to an employee from the People tab.
// Creates a PENDING urgent_payment_requests row — it surfaces in Payment
// Dispatch → Urgent → One-off Payments, where a clerk actually sends it. No
// money moves here; this is only the request. Gated by rate visibility
// (admin / accounting / ceo) so the CEO — who is otherwise read-only on People —
// can still file a payment.
export async function POST(request: Request) {
  try {
    const authz = await requireRateVisibilitySession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      work_email?: string;
      full_name?: string;
      department?: string | null;
      amount_php?: number | string | null;
      note?: string | null;
    };

    const work_email = (body.work_email ?? '').trim().toLowerCase();
    if (!work_email) {
      return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    }

    const full_name = (body.full_name ?? '').trim();
    if (!full_name) {
      return NextResponse.json({ error: 'full_name is required' }, { status: 400 });
    }

    // Amount: accept number or numeric string, must be a positive PHP value
    // within the numeric(12,2) column's range (ceiling ₱1B — far above any real
    // one-off payment; rejects overflow with a clean 400 instead of a DB 500).
    const MAX_AMOUNT = 1_000_000_000; // ₱1B
    const amount =
      typeof body.amount_php === 'string' ? parseFloat(body.amount_php) : body.amount_php;
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'amount_php must be a positive number' }, { status: 400 });
    }
    if (amount > MAX_AMOUNT) {
      return NextResponse.json({ error: 'amount_php is too large' }, { status: 400 });
    }
    // Round to 2dp to match the numeric(12,2) column.
    const amount_php = Math.round(amount * 100) / 100;

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const actor = await getSessionActor();
    const requestedBy = actor.user_name !== 'anonymous' ? actor.user_name : null;

    const { data, error } = await supabase
      .from('urgent_payment_requests')
      .insert({
        work_email,
        full_name,
        department: (body.department ?? '').trim() || null,
        amount_php,
        note: (body.note ?? '').trim() || null,
        status: 'pending',
        requested_by: requestedBy,
      })
      .select('id')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Best-effort email alert to Accounting (n8n owns recipients + copy) —
    // fire-and-forget so a webhook hiccup never fails the payment request.
    void sendUrgentPaymentAlert({
      full_name,
      work_email,
      department: (body.department ?? '').trim() || null,
      amount_php,
      note: (body.note ?? '').trim() || null,
      requested_by: requestedBy,
    });

    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'urgent_payment.requested',
      resource: 'urgent_payment_requests',
      resource_id: data?.id ?? null,
      details: { work_email, full_name, amount_php, note: (body.note ?? '').trim() || null },
    });

    return NextResponse.json({ success: true, id: data?.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
