import { NextResponse } from 'next/server';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/employee-master-record?email=...
 *
 * Returns the latest row from `public.global_master_list` matching the given email,
 * regardless of whether it's currently active in `active_employees`. Used as the
 * Profile page's identity fallback for people like internal devs/founders who aren't
 * part of the rolling CSV roster.
 *
 * Auth: self-or-elevated (same as `/api/employees`).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('email');
  const em = normEmail(raw ?? '') ?? raw?.trim().toLowerCase();
  if (!em) {
    return NextResponse.json({ employee: null, error: 'Missing email' }, { status: 400 });
  }
  const authz = await authorizeEmailAccess(em);
  if (!authz.ok) return deniedResponse(authz);

  const { employee, error } = await getEmployeeMasterRecord(authz.effectiveEmail);
  if (error) return NextResponse.json({ employee: null, error }, { status: 500 });
  return NextResponse.json({ employee, error: null });
}
