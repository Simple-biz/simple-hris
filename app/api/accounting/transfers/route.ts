import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { buildAccountingTransfers } from '@/lib/transfers/accounting-transfers';
import { getTransferRequestById, setTransferSheetSync } from '@/lib/supabase/department-transfer-requests';
import { updateMasterSheetDepartment } from '@/lib/google-sheets/update-master-sheet-department';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

/**
 * GET /api/accounting/transfers — read-only transfer history joined to the
 * pay-rate change each move triggered. Pay-bearing → gated to RATE_VISIBLE_ROLES
 * (admin / accounting / ceo).
 */
export async function GET() {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { rows, error } = await buildAccountingTransfers();
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

/**
 * POST /api/accounting/transfers — retry the Google Sheet write-back for an
 * applied transfer whose Sheet update previously failed. Body: { id, action: 'retry_sheet' }.
 */
export async function POST(request: Request) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await request.json()) as { id?: string; action?: string };
    if (body.action !== 'retry_sheet' || !body.id) {
      return NextResponse.json({ error: "action must be 'retry_sheet' with an id" }, { status: 400 });
    }

    const { row, error: fetchErr } = await getTransferRequestById(body.id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    if (row.status !== 'applied') {
      return NextResponse.json({ error: 'Only an applied transfer can be re-synced' }, { status: 409 });
    }

    let synced = false;
    let syncError: string | null = null;
    try {
      const res = await updateMasterSheetDepartment({
        personalEmail: row.employee_personal_email,
        workEmail: row.employee_work_email,
        fromDepartment: row.from_department,
        toDepartment: row.to_department,
      });
      synced = res.updated > 0;
      if (!synced) syncError = res.reason ?? 'no matching sheet row updated';
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e);
    }

    await setTransferSheetSync({ id: row.id, sheet_synced: synced, sheet_sync_error: syncError });

    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: 'Accounting',
      action: 'department_transfer.sheet_retry',
      resource: 'department_transfer_requests',
      resource_id: row.id,
      details: { synced, sync_error: syncError, from_department: row.from_department, to_department: row.to_department },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, sheet_synced: synced, sheet_sync_error: syncError, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
