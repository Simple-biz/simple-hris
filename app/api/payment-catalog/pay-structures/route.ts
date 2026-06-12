import { NextResponse } from 'next/server';
import {
  listPayStructures,
  upsertPayStructure,
  deletePayStructure,
} from '@/lib/supabase/pay-structures-db';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { validatePayStructure, type PayStructure } from '@/lib/payment-catalog/pay-structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET -- list all pay structures. Read is allowed for any authenticated
 *  employee (middleware gates /api); the tab itself is permission-scoped. */
export async function GET() {
  const { structures, error } = await listPayStructures();
  if (error) return NextResponse.json({ structures: [], error }, { status: 500 });
  return NextResponse.json({ structures, error: null });
}

/** POST -- create/update a pay structure. Writes require an elevated session;
 *  the actor's email is recorded as the creator. */
export async function POST(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: { structure?: PayStructure };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const s = body.structure;
  if (!s || !s.id || !s.departmentKey) {
    return NextResponse.json({ error: 'Missing pay structure id or department' }, { status: 400 });
  }
  const check = validatePayStructure(s);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const { row, error } = await upsertPayStructure(s, actor);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row, error: null });
}

/** DELETE -- remove a pay structure (?id=). */
export async function DELETE(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await deletePayStructure(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
