import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Employee submits work_email + start_date in MMDDYY format to prove identity.
// Request is recorded in audit_log for the accounting team to action.
export async function POST(request: Request) {
  try {
    const { work_email, start_mmddyy, note } = (await request.json()) as {
      work_email?: string;
      start_mmddyy?: string;
      note?: string;
    };

    if (!work_email || !start_mmddyy) {
      return NextResponse.json({ error: 'Missing work_email or start_mmddyy' }, { status: 400 });
    }

    if (!/^\d{6}$/.test(start_mmddyy)) {
      return NextResponse.json({ error: 'Start date must be 6 digits (MMDDYY)' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const email = work_email.trim().toLowerCase();

    const { data, error } = await supabase.rpc('verify_employee_identity', {
      p_email: email,
      p_start_mmddyy: start_mmddyy,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const verified = data === true;

    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip');

    void insertAuditLog({
      user_name: email,
      user_role: 'Employee',
      action: verified ? 'employee.password_reset.requested' : 'employee.password_reset.identity_failed',
      resource: 'employee_hourly_rates',
      resource_id: email,
      details: {
        work_email: email,
        start_mmddyy_provided: start_mmddyy,
        note: note?.trim() || null,
        verified,
      },
      ip_address: ip,
    });

    if (!verified) {
      return NextResponse.json(
        { error: 'Work email and start date do not match our records.' },
        { status: 401 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Your request has been sent to the accounting team. They will contact you shortly.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
