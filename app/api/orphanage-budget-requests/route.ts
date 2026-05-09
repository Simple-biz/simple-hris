import { NextRequest, NextResponse } from 'next/server';
import {
  fetchOrphanageBudgetAuditTrail,
  insertOrphanageBudgetRequest,
  listOrphanageBudgetRequests,
  type InsertOrphanageBudgetRequestInput,
  type OrphanageBudgetRequestStatus,
} from '@/lib/supabase/orphanage-budget-requests';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/orphanage-budget-requests
 *   ?email=…         filter to one submitter (case-insensitive)
 *   ?status=…        pending|approved|rejected
 *   ?with_audit=1    include the audit_log timeline per row (slower)
 *   ?limit=…         optional cap
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const submitterEmail = searchParams.get('email')?.trim() || undefined;
  const statusRaw = searchParams.get('status');
  const status =
    statusRaw === 'pending' || statusRaw === 'approved' || statusRaw === 'rejected'
      ? (statusRaw as OrphanageBudgetRequestStatus)
      : undefined;
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const withAudit = searchParams.get('with_audit') === '1';

  const { rows, error } = await listOrphanageBudgetRequests({
    submitterEmail,
    status,
    limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
  });
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

  if (!withAudit) {
    return NextResponse.json({ rows, error: null });
  }

  // Fan-out audit trail per row. Modest N (history page caps).
  const audited = await Promise.all(
    rows.map(async (r) => {
      const { rows: trail } = await fetchOrphanageBudgetAuditTrail(r.id);
      return { ...r, audit_trail: trail };
    }),
  );
  return NextResponse.json({ rows: audited, error: null });
}

interface PostBody extends InsertOrphanageBudgetRequestInput {}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { row: null, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const required: (keyof PostBody)[] = [
    'submitter_email',
    'visit_type',
    'bank_account_name',
    'bank_account_number',
    'bank_name',
    'swift_code',
  ];
  for (const k of required) {
    if (!body[k] || (typeof body[k] === 'string' && !String(body[k]).trim())) {
      return NextResponse.json(
        { row: null, error: `Missing required field: ${String(k)}` },
        { status: 400 },
      );
    }
  }

  const { row, error } = await insertOrphanageBudgetRequest(body);
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Insert failed' }, { status: 500 });
  }

  void insertAuditLog({
    user_name: body.submitter_email,
    user_role: 'orphanage_submitter',
    action: 'orphanage_budget.created',
    resource: 'orphanage_budget_requests',
    resource_id: row.id,
    details: {
      visit_type: row.visit_type,
      mission_trip: row.mission_trip,
      subtotal: row.subtotal,
      leftover: row.leftover,
      final_amount: row.final_amount,
    },
  });

  return NextResponse.json({ row, error: null });
}
