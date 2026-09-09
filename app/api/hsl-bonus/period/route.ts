import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { auditFrom } from '@/lib/audit/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/hsl-bonus/period?dept=KEY&period_start=YYYY-MM-DD
 *
 * Hard-deletes both the entries and the period_status row for a given week.
 * Used by the manager Bonus History tab when the manager wants to remove a
 * past KPI submission entirely (e.g., it was sent in error).
 *
 * Returns the counts of rows removed from each table.
 *
 * This is the most destructive action on the HSL surface: it erases a whole
 * department-week of scored bonuses and the status row that says the week was
 * ever submitted. `docs/features/delete-authorization.md` requires audit
 * "proportional to the destructiveness", with the snapshot in the event "so
 * deletions remain traceable after the row is gone" — so the entries are read
 * and the `hsl_bonus.period_deleted` event is written BEFORE anything is
 * deleted, and a trail write failure abandons the delete.
 */
export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');
  const period_start = searchParams.get('period_start');

  if (!dept || !period_start) {
    return NextResponse.json(
      { error: 'dept and period_start are required' },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  // Read what is about to go, and record it, while it still exists.
  const { data: doomedEntries, error: readError } = await supabase
    .from('hsl_bonus_entries')
    .select('id, employee_email, employee_name, calculated_bonus, is_manager')
    .eq('department', dept)
    .eq('period_start', period_start);
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const { data: doomedStatus } = await supabase
    .from('hsl_bonus_period_status')
    .select('*')
    .eq('department', dept)
    .eq('period_start', period_start);

  const entries = doomedEntries ?? [];
  const total = entries.reduce(
    (sum, e) => sum + (Number((e as { calculated_bonus?: number }).calculated_bonus) || 0),
    0,
  );

  const { error: auditError } = await insertAuditLog({
    ...auditFrom(req, authz),
    action: 'hsl_bonus.period_deleted',
    resource: 'hsl_bonus_entries',
    resource_id: `${dept}::${period_start}`,
    details: {
      department: dept,
      period_start,
      entries_deleted: entries.length,
      total_bonus_deleted: total,
      status_rows_deleted: doomedStatus?.length ?? 0,
      status_rows: doomedStatus ?? null,
      deleted_entries: entries,
    },
  });
  if (auditError) {
    return NextResponse.json(
      { error: `Delete abandoned — the audit event could not be written: ${auditError}` },
      { status: 500 },
    );
  }

  const [entriesRes, statusRes] = await Promise.all([
    supabase
      .from('hsl_bonus_entries')
      .delete()
      .eq('department', dept)
      .eq('period_start', period_start)
      .select('id'),
    supabase
      .from('hsl_bonus_period_status')
      .delete()
      .eq('department', dept)
      .eq('period_start', period_start)
      .select('id'),
  ]);

  if (entriesRes.error) {
    return NextResponse.json({ error: entriesRes.error.message }, { status: 500 });
  }
  if (statusRes.error) {
    return NextResponse.json({ error: statusRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    entries_deleted: entriesRes.data?.length ?? 0,
    status_deleted: statusRes.data?.length ?? 0,
  });
}
