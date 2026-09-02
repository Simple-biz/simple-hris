import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { maskAccountLast4 } from '@/lib/payroll/mask-account';
import {
  countInternPayRows,
  deleteIntern,
  getInternById,
  updateIntern,
  validateInternProfile,
  type InternProfileInput,
} from '@/lib/supabase/orphanage-interns-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 *  GET    /api/orphanage-interns/{id}  → profile + rate history. FULL account
 *                                        number only with `edit`; `view` gets last 4.
 *  PATCH  /api/orphanage-interns/{id}  → update personal / bank / caps / status
 *  DELETE /api/orphanage-interns/{id}  → refused while any locked week exists
 *                                        (End internship instead — paid history stays)
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const view = await requireFeatureAccess('orphanage', 'interns', 'view');
  if (!view.ok) return deniedResponse(view);
  const { id } = await params;
  const { intern, rates, error } = await getInternById(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!intern) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const edit = await requireFeatureAccess('orphanage', 'interns', 'edit');
  const canEdit = edit.ok;
  const safe = canEdit
    ? intern
    : { ...intern, bank_account_number: maskAccountLast4(intern.bank_account_number) ?? '' };
  return NextResponse.json({ intern: safe, rates, canEdit, error: null });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await params;

  let body: Partial<InternProfileInput>;
  try {
    body = (await req.json()) as Partial<InternProfileInput>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const invalid = validateInternProfile(body, false);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const { intern, error } = await updateIntern(id, body);
  if (error || !intern) {
    const dup = /duplicate key|unique/i.test(error ?? '');
    return NextResponse.json({ error: dup ? 'An intern with this email already exists.' : error ?? 'Update failed' }, { status: dup ? 409 : 500 });
  }

  const actor = await getSessionActor();
  const changed = Object.keys(body);
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern.saved',
    resource: 'orphanage_interns',
    resource_id: intern.id,
    // Field NAMES only for bank fields — the values never go to the audit log.
    details: { created: false, email: intern.email, full_name: intern.full_name, status: intern.status, changed_fields: changed },
  });
  return NextResponse.json({ intern, error: null });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await params;

  const { intern, error: getErr } = await getInternById(id);
  if (getErr) return NextResponse.json({ error: getErr }, { status: 500 });
  if (!intern) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { count, error: cErr } = await countInternPayRows(id);
  if (cErr) return NextResponse.json({ error: cErr }, { status: 500 });
  if (count > 0) {
    return NextResponse.json(
      { error: `${intern.full_name} has ${count} locked week${count === 1 ? '' : 's'} on record. Use "End internship" instead so the paid history stays.` },
      { status: 409 },
    );
  }

  const { error } = await deleteIntern(id);
  if (error) return NextResponse.json({ error }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern.deleted',
    resource: 'orphanage_interns',
    resource_id: id,
    details: { email: intern.email, full_name: intern.full_name },
  });
  return NextResponse.json({ ok: true });
}
