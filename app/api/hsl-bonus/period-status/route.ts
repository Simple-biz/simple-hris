import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');
  const period_start = searchParams.get('period_start');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let query = supabase.from('hsl_bonus_period_status').select('*');
  if (dept) query = query.eq('department', dept);
  if (period_start) query = query.eq('period_start', period_start);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    department: string;
    period_type: string;
    period_start: string;
    period_end: string;
    status: 'draft' | 'ready' | 'locked';
    locked_by?: string;
  };

  if (!body.department || !body.period_start || !body.status) {
    return NextResponse.json({ error: 'department, period_start, status required' }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const row = {
    department: body.department,
    period_type: body.period_type,
    period_start: body.period_start,
    period_end: body.period_end,
    status: body.status,
    locked_by: body.status === 'locked' ? (body.locked_by ?? null) : null,
    locked_at: body.status === 'locked' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('hsl_bonus_period_status')
    .upsert(row, { onConflict: 'department,period_start' })
    .select('id, department, period_start, status')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ row: data });
}
