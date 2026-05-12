import { NextRequest, NextResponse } from 'next/server';
import {
  listPendingOrphanageItems,
  createOrphanageDispatch,
  listOrphanageDispatches,
  type OrphanageDispatchStatus,
  type OrphanageDispatchType,
} from '@/lib/supabase/orphanage-dispatches';

/** GET /api/orphanage-dispatches
 *  ?pending=1  → pending items queue (budget requests + gift shippings awaiting payment)
 *  ?paid=1     → paid dispatch records (for Reports tab)
 *  (no param)  → all dispatch records
 */
export async function GET(req: NextRequest) {
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sourceType = body.source_type as OrphanageDispatchType | undefined;
  const sourceId = body.source_id as string | undefined;

  if (!sourceType || !['budget_request', 'gift_shipping'].includes(sourceType)) {
    return NextResponse.json({ error: 'source_type must be budget_request or gift_shipping' }, { status: 400 });
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
  return NextResponse.json({ row }, { status: 201 });
}
