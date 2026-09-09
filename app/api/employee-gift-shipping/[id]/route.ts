import { NextRequest, NextResponse } from 'next/server';
import {
  deleteShippingDetail,
  editShippingDetailFields,
} from '@/lib/supabase/employee-gift-shipping';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface EditBody {
  /** Ignored for identity — the audit actor is the verified session. Kept only
   *  because the client still sends it; a body-supplied actor is a forged one. */
  edited_by?: string | null;
  preferred_delivery_location?: string;
  active_contact_number?: string;
  apparel_size?: string;
  notes?: string;
}

/** PATCH /api/employee-gift-shipping/[id] — orphanage edits the shipping fields. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('hr', 'gift_tracker');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });
  }
  let body: EditBody;
  try {
    body = (await req.json()) as EditBody;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { row, error } = await editShippingDetailFields({
    id,
    preferred_delivery_location: body.preferred_delivery_location,
    active_contact_number: body.active_contact_number,
    apparel_size: body.apparel_size,
    notes: body.notes,
  });
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status: 500 });
  }

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'employee_gift_shipping.edited',
    resource: 'employee_gift_shipping_details',
    resource_id: row.id,
    details: {
      personal_email: row.personal_email,
      milestone_index: row.milestone_index,
      fields_changed: Object.keys(body).filter((k) => k !== 'edited_by'),
      claimed_editor: body.edited_by ?? null,
    },
  });

  return NextResponse.json({ row, error: null });
}

interface DeleteBody {
  /** Ignored for identity — see EditBody.edited_by. */
  deleted_by?: string | null;
}

/** DELETE /api/employee-gift-shipping/[id] — orphanage removes a submission. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('hr', 'gift_tracker');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  let body: DeleteBody = {};
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    // Body is optional for DELETE — fine to swallow.
  }

  const { error } = await deleteShippingDetail(id);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'employee_gift_shipping.deleted',
    resource: 'employee_gift_shipping_details',
    resource_id: id,
    details: { claimed_deleter: body.deleted_by ?? null },
  });

  return NextResponse.json({ error: null });
}
