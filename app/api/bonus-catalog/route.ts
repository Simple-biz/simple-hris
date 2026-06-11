import { NextResponse } from 'next/server';
import {
  listBonusCatalog,
  upsertBonus,
  deleteBonus,
  addAssignment,
  removeAssignment,
} from '@/lib/supabase/bonus-catalog-db';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { validateBonus, type BonusDef, type BonusAssignment } from '@/lib/bonus-catalog/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET — list all bonuses + assignments. Read is allowed for any authenticated
 *  employee (middleware gates /api); the tab itself is permission-scoped. */
export async function GET() {
  try {
    const data = await listBonusCatalog();
    return NextResponse.json({ ...data, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ bonuses: [], assignments: [], error: msg }, { status: 500 });
  }
}

/** POST — create/update a bonus, or add an assignment. Writes require an
 *  elevated session; the actor's email is recorded as the creator. */
export async function POST(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: { type?: string; bonus?: BonusDef; assignment?: BonusAssignment };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.type === 'bonus') {
    const bonus = body.bonus;
    if (!bonus || !bonus.id || !bonus.name?.trim()) {
      return NextResponse.json({ error: 'Missing bonus id or name' }, { status: 400 });
    }
    const check = validateBonus(bonus);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    const { row, error } = await upsertBonus(bonus, actor);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ row, error: null });
  }

  if (body.type === 'assignment') {
    const a = body.assignment;
    if (!a || !a.id || !a.bonusId || !a.departmentKey) {
      return NextResponse.json({ error: 'Missing assignment fields' }, { status: 400 });
    }
    if (a.scope === 'employee' && !a.employeeEmail) {
      return NextResponse.json({ error: 'Employee assignment requires an email' }, { status: 400 });
    }
    const { row, error } = await addAssignment(a, actor);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ row, error: null });
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 });
}

/** DELETE — remove a bonus (?type=bonus&id=) or an assignment (?type=assignment&id=). */
export async function DELETE(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  if (type === 'bonus') {
    const { error } = await deleteBonus(id);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  }
  if (type === 'assignment') {
    const { error } = await removeAssignment(id);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  }
  return NextResponse.json({ error: 'Unknown type' }, { status: 400 });
}
