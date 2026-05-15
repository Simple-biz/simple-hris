/**
 * POST /api/admin/backfill-employee-ids
 *
 * One-shot backfill that stamps `employee_id` onto every `global_master_list`
 * row where it's currently NULL. Mirrors the in-memory ID assignment the UI
 * has always shown (`generateEmployeeIds` in src/lib/supabase/employees.ts) so
 * persisted IDs match what users already see.
 *
 * Requires the column-add migration first:
 *   references/add_employee_id_to_global_master_list.sql
 *
 * Idempotent — re-running only fills nulls, never renumbers a row that already
 * has an ID. Service role required.
 *
 * Returns: `{ assigned, skipped, error }`.
 */

import { NextResponse } from 'next/server';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { backfillEmployeeIds } from '@/lib/supabase/backfill-employee-ids';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { assigned: 0, skipped: 0, error: 'SUPABASE_SERVICE_ROLE_KEY missing' },
      { status: 500 },
    );
  }

  const result = await backfillEmployeeIds(supabase);
  const status = result.error ? 500 : 200;
  return NextResponse.json(result, { status });
}
