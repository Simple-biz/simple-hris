import { NextRequest, NextResponse } from 'next/server';
import { decideOrphanageBudgetRequest } from '@/lib/supabase/orphanage-budget-requests';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PatchBody {
  status: 'approved' | 'rejected';
  decided_by: string;
  decision_note?: string | null;
}

/**
 * PATCH /api/orphanage-budget-requests/{id}/decide
 *
 * Accounting endpoint — flips a pending request to approved or rejected,
 * stamps `decided_by` / `decided_at` / `decision_note`, and appends an audit
 * log entry. The History page reads the audit trail to render the timeline.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ row: null, error: 'Missing id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { row: null, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  if (body.status !== 'approved' && body.status !== 'rejected') {
    return NextResponse.json(
      { row: null, error: 'status must be approved or rejected' },
      { status: 400 },
    );
  }
  if (!body.decided_by || !String(body.decided_by).trim()) {
    return NextResponse.json(
      { row: null, error: 'decided_by is required' },
      { status: 400 },
    );
  }

  const { row, error } = await decideOrphanageBudgetRequest({
    id,
    status: body.status,
    decided_by: body.decided_by,
    decision_note: body.decision_note ?? null,
  });
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? 'Update failed' }, { status: 500 });
  }

  void insertAuditLog({
    user_name: body.decided_by,
    user_role: 'accounting',
    action:
      body.status === 'approved'
        ? 'orphanage_budget.approved'
        : 'orphanage_budget.rejected',
    resource: 'orphanage_budget_requests',
    resource_id: row.id,
    details: {
      decision_note: body.decision_note ?? null,
      final_amount: row.final_amount,
      visit_type: row.visit_type,
    },
  });

  return NextResponse.json({ row, error: null });
}
