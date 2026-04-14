import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { work_email, password } = (await request.json()) as {
      work_email?: string;
      password?: string;
    };

    if (!work_email || !password) {
      return NextResponse.json({ error: 'Missing work_email or password' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const email = work_email.trim().toLowerCase();

    const { data, error } = await supabase.rpc('verify_employee_password', {
      p_email: email,
      p_password: password,
    });

    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const success = data === true;

    void insertAuditLog({
      user_name: email,
      user_role: 'Employee',
      action: success ? 'employee.login.success' : 'employee.login.failed',
      resource: 'employee_hourly_rates',
      resource_id: email,
      details: { work_email: email },
      ip_address: ip,
    });

    if (!success) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    return NextResponse.json({ success: true, work_email: email });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
