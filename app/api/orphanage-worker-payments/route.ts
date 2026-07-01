import { NextRequest, NextResponse } from 'next/server';
import {
  listOrphanageWorkerPayments,
  createOrphanageWorkerPayment,
  updateOrphanageWorkerPayment,
  deleteOrphanageWorkerPayment,
  type OrphanageWorkerType,
  type UpsertOrphanageWorkerPaymentInput,
} from '@/lib/supabase/orphanage-worker-payments';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKER_TYPES: OrphanageWorkerType[] = ['handyman', 'musician', 'other'];

/** Parse + validate the shared add/edit body. Returns the input or an error string. */
function parseBody(
  body: Record<string, unknown>,
): { input: UpsertOrphanageWorkerPaymentInput } | { error: string } {
  const recipient_name = String(body.recipient_name ?? '').trim();
  if (!recipient_name) return { error: 'recipient_name is required' };

  const worker_type = body.worker_type as OrphanageWorkerType;
  if (!WORKER_TYPES.includes(worker_type)) {
    return { error: "worker_type must be 'handyman', 'musician', or 'other'" };
  }

  const amount_php = Number(body.amount_php);
  if (!Number.isFinite(amount_php) || amount_php <= 0) {
    return { error: 'amount_php must be a positive number' };
  }

  return {
    input: {
      recipient_name,
      worker_type,
      type_label: (body.type_label as string | null) ?? null,
      pay_week: (body.pay_week as string | null) ?? null,
      amount_php,
      bank_name: (body.bank_name as string | null) ?? null,
      bank_account_name: (body.bank_account_name as string | null) ?? null,
      bank_account_number: (body.bank_account_number as string | null) ?? null,
      swift_code: (body.swift_code as string | null) ?? null,
      note: (body.note as string | null) ?? null,
    },
  };
}

/** GET /api/orphanage-worker-payments — all worker payments (newest first). */
export async function GET() {
  const authz = await requireFeatureAccess('accounting', 'payment_dispatch', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const { rows, error } = await listOrphanageWorkerPayments();
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ rows });
}

/** POST /api/orphanage-worker-payments — add a worker payment. */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const actor = await getSessionActor();
  const { row, error } = await createOrphanageWorkerPayment({
    ...parsed.input,
    created_by: actor.user_name !== 'anonymous' ? actor.user_name : null,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  if (row) {
    void insertAuditLog({
      user_name: row.created_by || actor.user_name,
      user_role: actor.user_role,
      action: 'orphanage.worker_payment.added',
      resource: 'orphanage_worker_payments',
      resource_id: row.id,
      details: {
        recipient_name: row.recipient_name,
        worker_type: row.worker_type,
        type_label: row.type_label,
        amount_php: row.amount_php,
        pay_week: row.pay_week,
      },
    });
  }

  return NextResponse.json({ row }, { status: 201 });
}

/** PATCH /api/orphanage-worker-payments?id=<uuid> — edit a worker payment. */
export async function PATCH(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { row, error } = await updateOrphanageWorkerPayment(id, parsed.input);
  if (error) return NextResponse.json({ error }, { status: 500 });

  if (row) {
    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'orphanage.worker_payment.edited',
      resource: 'orphanage_worker_payments',
      resource_id: row.id,
      details: {
        recipient_name: row.recipient_name,
        worker_type: row.worker_type,
        amount_php: row.amount_php,
      },
    });
  }

  return NextResponse.json({ row });
}

/** DELETE /api/orphanage-worker-payments?id=<uuid> — remove a worker payment. */
export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { error } = await deleteOrphanageWorkerPayment(id);
  if (error) return NextResponse.json({ error }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage.worker_payment.deleted',
    resource: 'orphanage_worker_payments',
    resource_id: id,
    details: {},
  });

  return NextResponse.json({ ok: true });
}
