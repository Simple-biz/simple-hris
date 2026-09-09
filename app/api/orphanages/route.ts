import { NextRequest, NextResponse } from 'next/server';
import {
  insertOrphanage,
  listOrphanages,
  type InsertOrphanageInput,
} from '@/lib/supabase/orphanages';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';
import { orphanageAuditSnapshot } from '@/lib/audit/orphanage-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/orphanages -> { rows, error } */
export async function GET() {
  const { rows, error } = await listOrphanages();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, error: null });
}

/** POST /api/orphanages -> create a new orphanage. */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'budget');
  if (!authz.ok) return deniedResponse(authz);
  let body: InsertOrphanageInput;
  try {
    body = (await req.json()) as InsertOrphanageInput;
  } catch {
    return NextResponse.json({ row: null, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.name || !String(body.name).trim()) {
    return NextResponse.json(
      { row: null, error: 'Missing required field: name' },
      { status: 400 },
    );
  }

  const { row, error } = await insertOrphanage(body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Insert failed' }, { status: 500 });
  }

  // The registry row carries the receiving bank for the interns' orphanage
  // share, so creating one is a routing decision and belongs in the trail.
  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'orphanage_registry.created',
    resource: 'orphanages',
    resource_id: row.id,
    details: orphanageAuditSnapshot(row),
  });

  return NextResponse.json({ row, error: null });
}
