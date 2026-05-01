import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/departments
 * Returns the distinct, non-empty `Department` values from `active_employees`,
 * sorted A→Z. Auth: any elevated session (admin/HR/payroll) — used by the
 * Roles & permissions admin tab to populate the dept multi-select.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { departments: [], error: 'Supabase not configured' },
      { status: 500 },
    );
  }

  const { data, error } = await supabase
    .from('active_employees')
    .select('"Department"')
    .range(0, 9999);
  if (error) return NextResponse.json({ departments: [], error: error.message }, { status: 500 });

  const set = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const d = String(row['Department'] ?? '').trim();
    if (d) set.add(d);
  }
  const departments = Array.from(set).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return NextResponse.json({ departments, error: null });
}
