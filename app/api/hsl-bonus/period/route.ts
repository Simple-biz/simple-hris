import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

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
 */
export async function DELETE(req: NextRequest) {
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
