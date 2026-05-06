import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');
  const period_start = searchParams.get('period_start');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let query = supabase.from('hsl_bonus_entries').select('*').order('employee_name');
  if (dept) query = query.eq('department', dept);
  if (period_start) query = query.eq('period_start', period_start);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    entries: {
      department: string;
      period_type: string;
      period_start: string;
      period_end: string;
      employee_email: string;
      employee_name?: string;
      is_manager?: boolean;
      kpi_data?: Record<string, unknown>;
      calculated_bonus?: number;
      notes?: string;
      created_by?: string;
    }[];
  };

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return NextResponse.json({ error: 'entries array required' }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const rows = body.entries.map((e) => ({
    ...e,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('hsl_bonus_entries')
    .upsert(rows, { onConflict: 'department,period_start,employee_email' })
    .select('id, department, period_start, employee_email');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ saved: data?.length ?? 0 });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');
  const period_start = searchParams.get('period_start');
  const email = searchParams.get('email');

  if (!dept || !period_start || !email) {
    return NextResponse.json({ error: 'dept, period_start, email required' }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { error } = await supabase
    .from('hsl_bonus_entries')
    .delete()
    .eq('department', dept)
    .eq('period_start', period_start)
    .eq('employee_email', email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
