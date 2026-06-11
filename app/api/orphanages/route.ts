import { NextRequest, NextResponse } from 'next/server';
import {
  insertOrphanage,
  listOrphanages,
  type InsertOrphanageInput,
} from '@/lib/supabase/orphanages';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

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
  return NextResponse.json({ row, error: null });
}
