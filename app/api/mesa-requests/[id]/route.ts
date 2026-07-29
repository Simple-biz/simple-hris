import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_requests';

// PATCH /api/mesa-requests/[id]
// Accounting-only: approve or deny a MESA request.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEditAnyView('mesa');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as {
      status?: string;
      review_notes?: string | null;
      effective_date?: string | null;
    };

    // Two independent edits share this route: the decision (approve / deny /
    // revoke-to-pending) and — opt-out only — the effective date Accounting can
    // correct after the member picked it. Either alone is a valid call; sent
    // together, the date is fixed as part of the same decision.
    const status = (body.status ?? '').trim();
    const editsStatus = status !== '';
    const editsEffective = body.effective_date !== undefined;

    if (!editsStatus && !editsEffective) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
    }
    // 'pending' = revoke a prior decision (un-approve / un-deny).
    if (editsStatus && !['approved', 'denied', 'pending'].includes(status)) {
      return NextResponse.json({ error: 'status must be approved, denied, or pending' }, { status: 400 });
    }
    const effective_date = (body.effective_date ?? '').trim();
    if (editsEffective && !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
      return NextResponse.json({ error: 'effective_date must be YYYY-MM-DD' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data: existing } = await supabase
      .from(TABLE)
      .select('request_type, effective_date, dispatched_at')
      .eq('id', id)
      .single();
    if (!existing) return NextResponse.json({ error: 'request not found' }, { status: 404 });

    // The column is single-purpose; nothing else carries an effective date.
    if (editsEffective && existing.request_type !== 'opt_out') {
      return NextResponse.json(
        { error: 'effective_date only applies to an opt-out request' },
        { status: 400 },
      );
    }
    // A disbursement that's already been paid out via Payment Dispatch can't be
    // revoked — the money is gone. Block reverting it to pending.
    if (status === 'pending' && existing.dispatched_at) {
      return NextResponse.json(
        { error: 'This disbursement has already been paid out and cannot be revoked.' },
        { status: 409 },
      );
    }

    const isRevoke = status === 'pending';
    const patch: Record<string, unknown> = {};
    if (editsStatus) {
      patch.status = status;
      patch.review_notes = isRevoke ? null : (body.review_notes ?? null);
      patch.reviewed_by = isRevoke ? null : authz.sessionEmail;
      patch.reviewed_at = isRevoke ? null : new Date().toISOString();
    }
    if (editsEffective) patch.effective_date = effective_date;

    const { error } = await supabase.from(TABLE).update(patch).eq('id', id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: editsStatus
        ? isRevoke
          ? 'mesa.request.revoked'
          : `mesa.request.${status}`
        : 'mesa.request.effective_date_updated',
      resource: TABLE,
      resource_id: id,
      details: {
        ...(editsStatus ? { status, review_notes: isRevoke ? null : (body.review_notes ?? null) } : {}),
        // Both sides of the date change — an audit line that only says "changed"
        // can't answer "what was it before?".
        ...(editsEffective
          ? { effective_date_from: existing.effective_date ?? null, effective_date_to: effective_date }
          : {}),
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/mesa-requests/[id]
// Accounting-only: permanently remove a MESA request. A disbursement that's
// already been paid out via Payment Dispatch is blocked — its record must stay.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEditAnyView('mesa');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data: existing } = await supabase
      .from(TABLE)
      .select('request_type, status, dispatched_at, work_email')
      .eq('id', id)
      .single();

    if (existing?.dispatched_at) {
      return NextResponse.json(
        { error: 'This disbursement has already been paid out and cannot be deleted.' },
        { status: 409 },
      );
    }

    const { error } = await supabase.from(TABLE).delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'mesa.request.deleted',
      resource: TABLE,
      resource_id: id,
      details: {
        request_type: existing?.request_type ?? null,
        status: existing?.status ?? null,
        work_email: existing?.work_email ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
