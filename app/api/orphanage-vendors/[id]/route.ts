import { NextRequest, NextResponse } from 'next/server';
import {
  deleteOrphanageVendor,
  updateOrphanageVendor,
  type UpsertOrphanageVendorInput,
} from '@/lib/supabase/orphanage-vendors';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/orphanage-vendors/{id} -> update a vendor. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });

  let body: UpsertOrphanageVendorInput;
  try {
    body = (await req.json()) as UpsertOrphanageVendorInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.business_name || !String(body.business_name).trim()) {
    return NextResponse.json(
      { row: null, error: 'Missing required field: business_name' },
      { status: 400 },
    );
  }

  const { row, error } = await updateOrphanageVendor(id, body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status: 500 });
  }

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor.saved',
    resource: 'orphanage_vendors',
    resource_id: row.id,
    details: { business_name: row.business_name, created: false },
  });

  return NextResponse.json({ row, error: null });
}

/** DELETE /api/orphanage-vendors/{id} */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

  const { ok, error } = await deleteOrphanageVendor(id);
  if (!ok) return NextResponse.json({ ok: false, error: error ?? 'Delete failed' }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor.deleted',
    resource: 'orphanage_vendors',
    resource_id: id,
    details: null,
  });

  return NextResponse.json({ ok: true, error: null });
}
