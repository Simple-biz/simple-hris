import { NextRequest, NextResponse } from 'next/server';
import { cronSessionElevated } from '@/lib/auth/cron-auth';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listScheduledDueTransfers } from '@/lib/supabase/department-transfer-requests';
import { applyApprovedTransfer, manilaTodayIso } from '@/lib/transfers/apply-transfer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SYSTEM_USER = { name: 'Transfer Scheduler', role: 'System' } as const;

/**
 * Authorization mirrors the sheet-sync crons: a `Bearer <CRON_SECRET>` header
 * (sent by Vercel Cron) OR an elevated in-app session (admin manual trigger).
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const got = req.headers.get('authorization') ?? '';
  return got === `Bearer ${expected}`;
}

/**
 * Applies released ("approved") department transfers whose effective date has
 * arrived: writes the new department to global_master_list + the master Google
 * Sheet, flips the row to `applied`, and notifies the receiving manager + the
 * employee. Runs daily; safe to run more often (each row is only picked up while
 * status='approved', then flips to 'applied').
 */
async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req) && !(await cronSessionElevated())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const today = manilaTodayIso();
  const { rows, error } = await listScheduledDueTransfers(today);
  if (error) return NextResponse.json({ success: false, error }, { status: 500 });

  let applied = 0;
  let failed = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const row of rows) {
    try {
      const res = await applyApprovedTransfer(row);
      if (res.applied) applied += 1;
      else {
        failed += 1;
        failures.push({ id: row.id, error: res.error ?? 'unknown' });
      }
    } catch (e) {
      failed += 1;
      failures.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  void insertAuditLog({
    user_name: SYSTEM_USER.name,
    user_role: SYSTEM_USER.role,
    action: 'department_transfer.scheduled_apply',
    resource: 'department_transfer_requests',
    details: { date: today, due: rows.length, applied, failed, failures: failures.slice(0, 20) },
  });

  return NextResponse.json({ success: true, date: today, due: rows.length, applied, failed, failures });
}

// Vercel Cron uses GET; admin manual trigger can POST. Both run the same code.
export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
