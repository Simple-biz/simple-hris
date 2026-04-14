import { NextResponse } from 'next/server';
import { getAppSetting } from '@/lib/supabase/app-settings';
import {
  insertLeaveRequest,
  listAllLeaveRequests,
  listLeaveRequestsByEmployee,
  resolveManagerEmail,
} from '@/lib/supabase/leave-requests';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SYSTEM_USER = { name: 'HRIS', role: 'System' } as const;

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

/** GET ?employee_email=… | ?scope=all */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    if (scope === 'all') {
      const { rows, error } = await listAllLeaveRequests(300);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    const raw = searchParams.get('employee_email');
    const em = normEmail(raw ?? '') ?? raw?.trim().toLowerCase();
    if (!em) {
      return NextResponse.json({ error: 'Missing employee_email' }, { status: 400 });
    }
    const { rows, error } = await listLeaveRequestsByEmployee(em);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      employee_email?: string;
      employee_name?: string | null;
      department?: string | null;
      start_date?: string;
      end_date?: string;
      leave_type?: string;
      reason?: string | null;
    };

    const employee_email = normEmail(body.employee_email ?? '') ?? body.employee_email?.trim().toLowerCase();
    if (!employee_email) {
      return NextResponse.json({ error: 'employee_email is required' }, { status: 400 });
    }
    const start_date = body.start_date?.trim();
    const end_date = body.end_date?.trim();
    const leave_type = body.leave_type?.trim();
    if (!start_date || !end_date || !leave_type) {
      return NextResponse.json({ error: 'start_date, end_date, and leave_type are required' }, { status: 400 });
    }
    const sd = new Date(start_date);
    const ed = new Date(end_date);
    if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) {
      return NextResponse.json({ error: 'Invalid dates' }, { status: 400 });
    }
    if (ed < sd) {
      return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 });
    }

    const managersJson = await getAppSetting('leave_department_managers_json');
    const accountingNotify = await getAppSetting('leave_accounting_notify_emails');
    const dept = body.department?.trim() || null;
    const manager_email = resolveManagerEmail(dept, managersJson);

    const { id, error } = await insertLeaveRequest({
      employee_email,
      employee_name: body.employee_name?.trim() || null,
      department: dept,
      start_date: start_date.slice(0, 10),
      end_date: end_date.slice(0, 10),
      leave_type,
      reason: body.reason?.trim() || null,
      manager_email,
    });

    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: employee_email,
      user_role: 'Employee',
      action: 'leave.request',
      resource: 'leave_requests',
      resource_id: id ?? undefined,
      details: {
        leave_type,
        start_date: start_date.slice(0, 10),
        end_date: end_date.slice(0, 10),
        department: dept,
        manager_email,
        accounting_notify: accountingNotify
          ? accountingNotify.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, id, manager_email, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
