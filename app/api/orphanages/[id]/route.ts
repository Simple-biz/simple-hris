import { NextRequest, NextResponse } from 'next/server';
import {
  deleteOrphanage,
  updateOrphanage,
  type UpdateOrphanageInput,
} from '@/lib/supabase/orphanages';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

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

  const { row, error } = await updateOrphanage(id, body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status: 500 });
  }
  return NextResponse.json({ row, error: null });
}

/** DELETE /api/orphanages/{id} */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('orphanage', 'budget');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });

  const { ok, error } = await deleteOrphanage(id);
  if (!ok) return NextResponse.json({ ok: false, error: error ?? 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true, error: null });
}
