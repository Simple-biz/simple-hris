import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { classifyColumnProbe } from '@/lib/db/probe-verdict';
import { isMesaRequestArchived, mesaArchiveRefusal } from '@/lib/mesa/request-archive';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_requests';

/** Shown when the archive columns are not there yet (migration PENDING). */
const ARCHIVE_NOT_SET_UP =
  'Archiving is not set up yet — run scripts/apply-mesa-request-archive-migration.mts --apply.';

// PATCH /api/mesa-requests/[id]
// Accounting-only: approve or deny a MESA request, correct an opt-out's
// effective date, or archive / unarchive a completed request.
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
      archived?: boolean;
    };

    // Two independent edits share this route: the decision (approve / deny /
    // revoke-to-pending) and — opt-out only — the effective date Accounting can
    // correct after the member picked it. Either alone is a valid call; sent
    // together, the date is fixed as part of the same decision.
    const status = (body.status ?? '').trim();
    const editsStatus = status !== '';
    const editsEffective = body.effective_date !== undefined;
    // Archive is its own edit: it changes where the row is shown, never what it
    // says, so it is not allowed to ride along with a decision or a date.
    const editsArchive = body.archived !== undefined;

    if (editsArchive && typeof body.archived !== 'boolean') {
      return NextResponse.json({ error: 'archived must be true or false' }, { status: 400 });
    }
    if (editsArchive && (editsStatus || editsEffective)) {
      return NextResponse.json(
        { error: 'archive on its own — not together with a decision or a date' },
        { status: 400 },
      );
    }
    if (!editsStatus && !editsEffective && !editsArchive) {
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

    // `*`, not a column list: `archived_at` does not exist until the archive
    // migration runs, and naming it would fail every PATCH before then.
    const { data: existingRow } = await supabase.from(TABLE).select('*').eq('id', id).single();
    if (!existingRow) return NextResponse.json({ error: 'request not found' }, { status: 404 });
    const existing = existingRow as {
      request_type: string;
      status: string;
      effective_date: string | null;
      dispatched_at: string | null;
      archived_at?: string | null;
    };

    if (editsArchive) {
      const archive = body.archived === true;
      if (!('archived_at' in existing)) {
        return NextResponse.json({ error: ARCHIVE_NOT_SET_UP }, { status: 503 });
      }
      const refusal = mesaArchiveRefusal(existing, archive);
      if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
      // Repeating the current state is a no-op, not a second audit row.
      if (archive === isMesaRequestArchived(existing)) {
        return NextResponse.json({ success: true, unchanged: true });
      }
      const archivePatch = archive
        ? { archived_at: new Date().toISOString(), archived_by: authz.sessionEmail }
        : { archived_at: null, archived_by: null };
      const { error: archiveErr } = await supabase.from(TABLE).update(archivePatch).eq('id', id);
      if (archiveErr) {
        if (classifyColumnProbe(archiveErr) === 'MISSING') {
          return NextResponse.json({ error: ARCHIVE_NOT_SET_UP }, { status: 503 });
        }
        return NextResponse.json({ error: archiveErr.message }, { status: 500 });
      }
      const archiveActor = await getSessionActor();
      void insertAuditLog({
        user_name: archiveActor.user_name,
        user_role: archiveActor.user_role,
        action: archive ? 'mesa.request.archived' : 'mesa.request.unarchived',
        resource: TABLE,
        resource_id: id,
        details: {
          request_type: existing.request_type,
          status: existing.status,
          dispatched: Boolean(existing.dispatched_at),
        },
      });
      return NextResponse.json({ success: true });
    }

    // An archived row is a closed record: it is unarchived before anything on it
    // changes. The database refuses a revoke on it too
    // (mesa_requests_archive_only_completed_chk); this says why in words.
    if (isMesaRequestArchived(existing)) {
      return NextResponse.json(
        { error: 'This request is archived. Unarchive it before changing it.' },
        { status: 409 },
      );
    }

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

    // `*` so `archived_at` is read when it exists and simply absent before the
    // archive migration runs.
    const { data: existingRow } = await supabase.from(TABLE).select('*').eq('id', id).single();
    const existing = existingRow as {
      request_type: string;
      status: string;
      dispatched_at: string | null;
      work_email: string;
      archived_at?: string | null;
    } | null;

    if (existing && isMesaRequestArchived(existing)) {
      return NextResponse.json(
        { error: 'This request is archived. Unarchive it before deleting it.' },
        { status: 409 },
      );
    }

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
