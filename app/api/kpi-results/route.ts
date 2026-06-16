import { NextRequest, NextResponse } from 'next/server';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import { getEmployeeKpiResults } from '@/lib/supabase/employee-kpi-results';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/kpi-results?email=<employee>
 *
 * An employee's own published KPI bonus results (ready/locked periods only).
 * Self-or-elevated: a normal employee may only read their own results; the
 * requested ?email= is resolved against the session and never trusted raw.
 *
 * Managers apply KPI bonuses under whichever roster email they have (work OR
 * personal), so we gather both aliases before querying.
 */
export async function GET(req: NextRequest) {
  try {
    const requested = req.nextUrl.searchParams.get('email')?.trim() ?? '';
    const authz = await authorizeEmailAccess(requested);
    if (!authz.ok) return deniedResponse(authz);

    const primary = authz.effectiveEmail;
    const aliases = new Set<string>();
    const add = (e: string | null | undefined) => {
      const n = normEmail(e ?? '');
      if (n) aliases.add(n);
    };
    add(primary);

    // Resolve work/personal aliases so a bonus applied under the other address
    // still surfaces. Both lookups are best-effort — failures just narrow the set.
    const [master, idRes] = await Promise.all([
      getEmployeeMasterRecord(primary).catch(() => ({ employee: null })),
      getEmployeeIdRowByEmail(primary).catch(() => ({ row: null })),
    ]);
    add(master.employee?.work_email);
    add(master.employee?.personal_email);
    add(idRes.row?.work_email);
    add(idRes.row?.personal_email);

    const { periods, error } = await getEmployeeKpiResults([...aliases]);
    return NextResponse.json({ periods, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ periods: [], error: msg }, { status: 500 });
  }
}
