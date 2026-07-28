import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'urgent_payment_requests';

// DELETE /api/urgent-payments/requests/[id]
// Remove a pending one-off payment from Payment Dispatch → Urgent. Filed by
// mistake, superseded, or simply not to be paid.
//
// This CANCELS rather than hard-deletes: the table's status CHECK carries a
// 'cancelled' state for exactly this, and keeping the row preserves who filed
// the request and for how much (People-tab "Pay" is a money action, so the
// paper trail outlives the queue card). Either way the card leaves the queue,
// because the feed selects status='pending'.
//
// Gated on the same permission as sending from this queue
// (POST .../[id]/dispatch) — whoever can pay an item can decline to pay it.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    // Conditional update on status='pending' — the same claim pattern the dispatch
    // route uses. A row that was paid out in the meantime matches nothing here, so
    // a cancel can never erase an already-dispatched payment from the queue.
    const { data: cancelled, error } = await supabase
      .from(TABLE)
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id, work_email, full_name, amount_php, requested_by')
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (!cancelled) {
      const { data: exists } = await supabase
        .from(TABLE)
        .select('status')
        .eq('id', id)
        .maybeSingle();
      if (!exists) return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
      return NextResponse.json(
        { error: 'This payment has already been sent and cannot be removed.' },
        { status: 409 },
      );
    }

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'urgent_payment.cancelled',
      resource: TABLE,
      resource_id: id,
      details: {
        work_email: cancelled.work_email ?? null,
        full_name: cancelled.full_name ?? null,
        amount_php: cancelled.amount_php ?? null,
        requested_by: cancelled.requested_by ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
