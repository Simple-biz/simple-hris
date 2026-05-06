import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/hsl-bonus/team-members              -> all rows (admin/elevated)
// GET /api/hsl-bonus/team-members?dept=KEY     -> filtered by dept_key
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  let query = supabase
    .from('hsl_team_members')
    .select('email, full_name, hsl_name, role_raw, dept_key, sub_team, is_manager, hourly_rate, ot_rate')
    .order('full_name');

  if (dept) query = query.eq('dept_key', dept);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
