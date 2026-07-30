import { NextResponse } from 'next/server';
import {
  deleteSystemBonus,
  listSystemBonuses,
  upsertSystemBonus,
} from '@/lib/supabase/system-bonuses-db';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import {
  isCustomSystemBonusCode,
  validateSystemBonus,
  type SystemBonus,
} from '@/lib/payment-catalog/system-bonus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Payment Catalog -- System Bonuses (PAB + Technology Bonus + custom currency
// variants with `pab:*` / `tech:*` codes).
// GET is open to any authenticated employee (the amounts/allowlist are not
// sensitive and drive the employee dashboards); the editor POST/DELETE are
// gated to accounting feature-edit. DELETE only removes custom variants --
// the two built-ins are permanent (disable them instead).

export async function GET() {
  const { bonuses, error } = await listSystemBonuses();
  if (error) return NextResponse.json({ bonuses: [], error }, { status: 500 });
  return NextResponse.json({ bonuses, error: null });
}

export async function POST(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);
  const actor = authz.sessionEmail;

  let body: { bonus?: SystemBonus };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const b = body.bonus;
  if (!b || !b.code) {
    return NextResponse.json({ error: 'Missing system bonus code' }, { status: 400 });
  }
  const check = validateSystemBonus(b);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const { row, error } = await upsertSystemBonus(b, actor);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row, error: null });
}

export async function DELETE(request: Request) {
  const authz = await requireFeatureEdit('accounting', 'bonus_catalog');
  if (!authz.ok) return deniedResponse(authz);

  const code = new URL(request.url).searchParams.get('code') ?? '';
  if (!isCustomSystemBonusCode(code)) {
    return NextResponse.json(
      { error: 'Only custom system bonuses can be deleted.' },
      { status: 400 },
    );
  }
  const { error } = await deleteSystemBonus(code);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ error: null });
}
