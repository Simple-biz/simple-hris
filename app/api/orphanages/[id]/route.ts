import { NextRequest, NextResponse } from 'next/server';
import {
  deleteOrphanage,
  getOrphanage,
  updateOrphanage,
  type UpdateOrphanageInput,
} from '@/lib/supabase/orphanages';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';
import {
  orphanageAuditDiff,
  orphanageAuditSnapshot,
} from '@/lib/audit/orphanage-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/orphanages/{id} -> update one or more fields. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'budget');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });

  let body: UpdateOrphanageInput;
  try {
    body = (await req.json()) as UpdateOrphanageInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Read the row BEFORE the write so the event can name what actually changed
  // — a patch body alone cannot tell an edit from a no-op retype, and the bank
  // fields on this row decide where the orphanage share is sent.
  const { row: before } = await getOrphanage(id);

  const { row, error } = await updateOrphanage(id, body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status: 500 });
  }

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'orphanage_registry.updated',
    resource: 'orphanages',
    resource_id: row.id,
    details: {
      name: row.name,
      // `null` when the pre-read failed: an unknown BEFORE is stated, never
      // implied by an empty change list.
      changes: before ? orphanageAuditDiff(before, row) : null,
      fields_submitted: Object.keys(body),
    },
  });

  return NextResponse.json({ row, error: null });
}

/** DELETE /api/orphanages/{id} */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'budget');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

  // AUDIT FIRST, then delete. `delete-authorization.md` requires the event to
  // carry the prior row "so deletions remain traceable after the row is gone";
  // that is only achievable if the snapshot is taken and written while the row
  // still exists. If the trail cannot record it, nothing is deleted.
  const { row: before, error: readError } = await getOrphanage(id);
  if (readError) {
    return NextResponse.json({ ok: false, error: readError }, { status: 500 });
  }
  if (!before) {
    return NextResponse.json({ ok: false, error: 'Orphanage not found' }, { status: 404 });
  }

  const { error: auditError } = await insertAuditLog({
    ...auditFrom(req, authz),
    action: 'orphanage_registry.deleted',
    resource: 'orphanages',
    resource_id: id,
    details: { deleted_row: orphanageAuditSnapshot(before) },
  });
  if (auditError) {
    return NextResponse.json(
      { ok: false, error: `Delete abandoned — the audit event could not be written: ${auditError}` },
      { status: 500 },
    );
  }

  const { ok, error } = await deleteOrphanage(id);
  if (!ok) return NextResponse.json({ ok: false, error: error ?? 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true, error: null });
}
