import { NextRequest, NextResponse } from 'next/server';
import {
  listPendingOrphanageItems,
  createOrphanageDispatch,
  listOrphanageDispatches,
  type OrphanageDispatchStatus,
  type OrphanageDispatchType,
} from '@/lib/supabase/orphanage-dispatches';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

/** GET /api/orphanage-dispatches
 *  ?pending=1  → pending items queue (budget requests, gift shippings, and worker
 *                payments — carpenters/handymen/musicians — awaiting payment)
 *  ?paid=1     → paid dispatch records (for Reports tab)
 *  (no param)  → all dispatch records
 *
 *  View-gated: the response carries recipient bank details (budget/gift/worker
 *  account numbers + holder names), so it isn't an open read for any signed-in
 *  employee — only the Payment Dispatch audience (Lenny + accounting).
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'payment_dispatch', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { searchParams } = req.nextUrl;
  const wantPending = searchParams.get('pending') === '1';
  const wantPaid = searchParams.get('paid') === '1';

  if (wantPending) {
    const { items, defaultBank, error } = await listPendingOrphanageItems();
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ items, defaultBank });
  }

  const status: OrphanageDispatchStatus | undefined = wantPaid ? 'paid' : undefined;
  const { rows, error } = await listOrphanageDispatches({ status });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ rows });
}

/** POST /api/orphanage-dispatches — Lenny logs a payment. */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sourceType = body.source_type as OrphanageDispatchType | undefined;
  const sourceId = body.source_id as string | undefined;

  if (!sourceType || !['budget_request', 'gift_shipping', 'worker_payment'].includes(sourceType)) {
    return NextResponse.json({ error: 'source_type must be budget_request, gift_shipping, or worker_payment' }, { status: 400 });
  }
  if (!sourceId) {
    return NextResponse.json({ error: 'source_id is required' }, { status: 400 });
  }
  if (typeof body.amount_php !== 'number' || body.amount_php <= 0) {
    return NextResponse.json({ error: 'amount_php must be a positive number' }, { status: 400 });
  }
  if (!body.status || !['paid', 'problem'].includes(body.status as string)) {
    return NextResponse.json({ error: 'status must be paid or problem' }, { status: 400 });
  }

  const { row, error } = await createOrphanageDispatch({
    dispatch_type: sourceType,
    budget_request_id: sourceType === 'budget_request' ? sourceId : null,
    gift_shipping_id: sourceType === 'gift_shipping' ? sourceId : null,
    worker_payment_id: sourceType === 'worker_payment' ? sourceId : null,
    recipient_name: (body.recipient_name as string | null) ?? null,
    worker_type: (body.worker_type as string | null) ?? null,
    label: String(body.label ?? ''),
    submitter_email: String(body.submitter_email ?? ''),
    bank_name: String(body.bank_name ?? ''),
    bank_account_name: String(body.bank_account_name ?? ''),
    bank_account_number: String(body.bank_account_number ?? ''),
    swift_code: String(body.swift_code ?? ''),
    amount_php: body.amount_php as number,
    status: body.status as OrphanageDispatchStatus,
    transaction_id: (body.transaction_id as string | null) ?? null,
    bank_used: (body.bank_used as string | null) ?? null,
    sent_date: (body.sent_date as string | null) ?? null,
    note: (body.note as string | null) ?? null,
    created_by: (body.paid_by as string | null) ?? null,
    paid_by: (body.paid_by as string | null) ?? null,
  });

  if (error) return NextResponse.json({ error }, { status: 500 });

  if (row) {
    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: row.paid_by || row.created_by || actor.user_name,
      user_role: actor.user_role,
      action: 'orphanage.dispatched',
      resource: 'orphanage_dispatches',
      resource_id: row.id,
      details: {
        dispatch_type: row.dispatch_type,
        budget_request_id: row.budget_request_id,
        gift_shipping_id: row.gift_shipping_id,
        worker_payment_id: row.worker_payment_id,
        recipient_name: row.recipient_name,
        worker_type: row.worker_type,
        label: row.label,
        submitter_email: row.submitter_email,
        amount_php: row.amount_php,
        status: row.status,
        transaction_id: row.transaction_id,
        bank_used: row.bank_used,
        sent_date: row.sent_date,
      },
    });
  }

  return NextResponse.json({ row }, { status: 201 });
}
