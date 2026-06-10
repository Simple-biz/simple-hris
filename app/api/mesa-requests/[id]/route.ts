import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';

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
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as {
      status?: string;
      review_notes?: string | null;
    };

    const status = (body.status ?? '').trim();
    // 'pending' = revoke a prior decision (un-approve / un-deny).
    if (!['approved', 'denied', 'pending'].includes(status)) {
      return NextResponse.json({ error: 'status must be approved, denied, or pending' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    // A disbursement that's already been paid out via Payment Dispatch can't be
    // revoked — the money is gone. Block reverting it to pending.
    if (status === 'pending') {
      const { data: existing } = await supabase
        .from(TABLE)
        .select('dispatched_at')
        .eq('id', id)
        .single();
      if (existing?.dispatched_at) {
        return NextResponse.json(
          { error: 'This disbursement has already been paid out and cannot be revoked.' },
          { status: 409 },
        );
      }
    }

    const isRevoke = status === 'pending';
    const { error } = await supabase
      .from(TABLE)
      .update({
        status,
        review_notes: isRevoke ? null : (body.review_notes ?? null),
        reviewed_by: isRevoke ? null : authz.sessionEmail,
        reviewed_at: isRevoke ? null : new Date().toISOString(),
      })
      .eq('id', id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: isRevoke ? 'mesa.request.revoked' : `mesa.request.${status}`,
      resource: TABLE,
      resource_id: id,
      details: { status, review_notes: isRevoke ? null : (body.review_notes ?? null) },
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
    const authz = await requireElevatedSession();
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
