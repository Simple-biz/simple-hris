import { NextRequest, NextResponse } from 'next/server';
import {
  createOrphanageVendor,
  listOrphanageVendors,
  type UpsertOrphanageVendorInput,
} from '@/lib/supabase/orphanage-vendors';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/orphanage-vendors -> { rows, error }. View-gated: rows carry vendor
 *  banking details, so this isn't an open read for any signed-in employee. */
export async function GET() {
  const authz = await requireFeatureAccess('orphanage', 'third_party_vendors', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await listOrphanageVendors();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/** POST /api/orphanage-vendors -> create a vendor. */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'third_party_vendors');
  if (!authz.ok) return deniedResponse(authz);

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

  const { row, error } = await createOrphanageVendor(body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Insert failed' }, { status: 500 });
  }

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.vendor.saved',
    resource: 'orphanage_vendors',
    resource_id: row.id,
    details: { business_name: row.business_name, created: true },
  });

  return NextResponse.json({ row, error: null });
}
