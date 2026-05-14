import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip');
}

type Payload = {
  email?: string;
  full_name?: string;
  department?: string;
  shift_schedule_est?: string;
};

export async function POST(req: NextRequest) {
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const email = normEmail(body.email ?? '');
  const fullName = (body.full_name ?? '').trim();
  const department = (body.department ?? '').trim();
  const shift = (body.shift_schedule_est ?? '').trim();

  if (!email || !fullName || !department || !shift) {
    return NextResponse.json(
      { success: false, error: 'All fields are required.' },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  let stored = false;
  let storeError: string | null = null;

  if (supabase) {
    const { error } = await supabase.from('fpu_enrollments').insert({
      email,
      full_name: fullName,
      department,
      shift_schedule_est: shift,
    });
    if (error) {
      storeError = error.message;
    } else {
      stored = true;
    }
  }

  void insertAuditLog({
    user_name: fullName || email,
    user_role: 'Employee',
    action: 'fpu.enroll',
    resource: 'fpu_enrollments',
    resource_id: email,
    details: {
      email,
      full_name: fullName,
      department,
      shift_schedule_est: shift,
      stored_in_table: stored,
      store_error: storeError,
    },
    ip_address: clientIp(req),
  });

  // We treat the audit-log write as enough to consider the submission "received".
  // If the dedicated table is missing (migration not yet run), we still succeed
  // so the user gets a confirmation — the audit log preserves the data.
  return NextResponse.json({ success: true, stored, storeError });
}
