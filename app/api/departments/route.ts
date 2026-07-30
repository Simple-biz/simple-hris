import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/departments
 * Returns the distinct, non-empty `Department` values from `active_employees`,
 * UNIONED with the in-app departments created from Payment Catalog → Department
 * (the registry) so a department is selectable everywhere — HR onboarding,
 * Roles & permissions, transfer targets — even before any roster row carries
 * its label. Sorted A→Z. Auth: any elevated session (admin/HR/payroll).
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

  // Emails ride along so the Sales/Sales-Assistant email override can compute
  // each row's EFFECTIVE department — with it, both "Sales" (US) and
  // "Sales Assistant" (PH override cohort) surface as selectable labels even
  // though the sheet labels every one of those rows "Sales".
  // Paged: the roster passed 1,000 people and PostgREST silently caps even an
  // explicit .range(0, 9999) at 1,000 — a department whose only members sort
  // past the cap would vanish from the pickers.
  const { rows: data, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from('active_employees')
      .select('"Department", "Work Email", "Personal Email"')
      .order('Work Email', { ascending: true })
      .range(from, to),
  );
  if (error) return NextResponse.json({ departments: [], error }, { status: 500 });

  const set = new Set<string>();
  const seen = new Set<string>(); // case-insensitive dedupe key
  const add = (raw: string) => {
    const d = raw.trim();
    if (!d) return;
    const k = d.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    set.add(d);
  };
  for (const row of data) {
    add(String(applyDeptOverrideToRawRow(row)['Department'] ?? ''));
  }
  // In-app departments (best-effort: a registry read failure must not take
  // down the roster-derived list).
  try {
    for (const entry of await getDepartmentRegistry()) add(entry.name);
  } catch {
    /* roster-derived departments only */
  }
  const departments = Array.from(set).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  return NextResponse.json({ departments, error: null });
}
