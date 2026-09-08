import { NextResponse } from 'next/server';
import {
  listBonusCatalog,
  upsertBonus,
  deleteBonus,
  addAssignment,
  removeAssignment,
} from '@/lib/supabase/bonus-catalog-db';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { validateBonus, type BonusDef, type BonusAssignment } from '@/lib/bonus-catalog/types';
import { parseEffectiveDate } from '@/lib/bonus-catalog/history';

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
 *  elevated session; the actor's email is recorded as the creator.
 *
 *  `effectiveDate` (YYYY-MM-DD, optional ⇒ today) is the day the change takes
 *  effect. It is recorded on the version / event row for display + audit; the
 *  KPI Calculator keeps paying the live definition. A malformed date is a 400,
 *  never coerced. A save whose history row could not be written still returns
 *  the saved row, with `historyError` set, so the client can say so. */
export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: { type?: string; bonus?: BonusDef; assignment?: BonusAssignment; effectiveDate?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const eff = parseEffectiveDate(body.effectiveDate);
  if (!eff.ok) return NextResponse.json({ error: eff.error }, { status: 400 });

  if (body.type === 'bonus') {
    const bonus = body.bonus;
    if (!bonus || !bonus.id || !bonus.name?.trim()) {
      return NextResponse.json({ error: 'Missing bonus id or name' }, { status: 400 });
    }
    const check = validateBonus(bonus);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    const { row, error, historyError } = await upsertBonus(bonus, actor, eff.iso);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ row, error: null, historyError });
  }

  if (body.type === 'assignment') {
    const a = body.assignment;
    if (!a || !a.id || !a.bonusId || !a.departmentKey) {
      return NextResponse.json({ error: 'Missing assignment fields' }, { status: 400 });
    }
    if (a.scope === 'employee' && !a.employeeEmail) {
      return NextResponse.json({ error: 'Employee assignment requires an email' }, { status: 400 });
    }
    const { row, error, historyError } = await addAssignment(a, actor, eff.iso);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ row, error: null, historyError });
  }

  return NextResponse.json({ error: 'Unknown type' }, { status: 400 });
}

/** DELETE — remove a bonus (?type=bonus&id=) or an assignment
 *  (?type=assignment&id=&effectiveDate=). Deleting a bonus cascades to its
 *  assignments AND its history; removing an assignment records a `removed` event. */
export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

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
    const eff = parseEffectiveDate(searchParams.get('effectiveDate'));
    if (!eff.ok) return NextResponse.json({ error: eff.error }, { status: 400 });
    const { error, historyError } = await removeAssignment(id, actor, eff.iso);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null, historyError });
  }
  return NextResponse.json({ error: 'Unknown type' }, { status: 400 });
}
