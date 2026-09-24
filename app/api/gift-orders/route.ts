import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getGiftCatalog } from '@/lib/supabase/gift-catalog';
import { listShippingDetails } from '@/lib/supabase/employee-gift-shipping';
import {
  deleteGiftOrder,
  getGiftOrder,
  listGiftOrderLines,
  listGiftOrders,
  lockGiftOrder,
  reopenGiftOrder,
  type GiftOrderRefusal,
} from '@/lib/supabase/gift-orders';
import { buildInvoice, ORDER_PROBLEM_LABEL, resolveOrderLines } from '@/lib/gift-tracker/orders';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Gift Tracker → Orders. Governing doc: docs/features/gift-tracker-orders.md.
 *
 * GET  — every order (newest first) + the line keys a LIVE order holds.
 *        `migrated: false` while references/sql/create/2026-09-23_gift_orders.sql
 *        has not been applied, so the tab can say so instead of erroring.
 * POST { action: 'lock', submissionIds, variantChoices, names, expectedTotalCentavos }
 *        The browser names WHICH gifts; the server re-resolves every item, size
 *        and price from the database's own submissions and catalog. A total that
 *        disagrees with the screen (catalog edited meanwhile) is a 409, never a
 *        silent re-price.
 * POST { action: 'reopen', orderId, reason }
 *        Keeps the invoice, marks it reopened, frees its gifts back to Open.
 * POST { action: 'delete', orderId }
 *        Removes the invoice and its lines for good (Kane, 2026-09-23); a locked
 *        order's gifts go back to Open. The whole row is read FIRST and written
 *        to the audit entry, so it stays traceable after it is gone.
 *
 * Same gate as approval and the catalog: `hr / gift_tracker` (view to read, edit to write).
 */
export async function GET() {
  const authz = await requireFeatureAccess('hr', 'gift_tracker', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const result = await listGiftOrders();
  if (result.error) return NextResponse.json(result, { status: 500 });
  return NextResponse.json(result);
}

const REFUSAL_STATUS: Record<GiftOrderRefusal, { status: number; message: string }> = {
  empty: { status: 400, message: 'Pick at least one gift to lock.' },
  not_approved: { status: 409, message: 'One of these gifts is no longer approved. Refresh and try again.' },
  already_ordered: { status: 409, message: 'One of these gifts is already on a locked order. Refresh and try again.' },
  total_mismatch: { status: 409, message: 'The total did not add up. Refresh and try again.' },
  not_locked: { status: 409, message: 'That order is not locked (already reopened?). Refresh.' },
  not_found: { status: 404, message: 'That order no longer exists. Refresh.' },
  missing: { status: 503, message: 'Orders are not set up yet — the Gift Orders migration has not been applied.' },
};

interface LockBody {
  action: 'lock';
  submissionIds?: unknown;
  variantChoices?: unknown;
  names?: unknown;
  expectedTotalCentavos?: unknown;
}
interface DeleteBody {
  action: 'delete';
  orderId?: unknown;
}
interface ReopenBody {
  action: 'reopen';
  orderId?: unknown;
  reason?: unknown;
}

function stringRecord(v: unknown, max: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && k.length <= 300) out[k] = val.trim().slice(0, max);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('hr', 'gift_tracker');
  if (!authz.ok) return deniedResponse(authz);

  let body: LockBody | ReopenBody | DeleteBody;
  try {
    body = (await req.json()) as LockBody | ReopenBody | DeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'reopen') {
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
    if (!orderId) return NextResponse.json({ error: 'Missing orderId' }, { status: 400 });
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
    const { refusal, error } = await reopenGiftOrder({ orderId, reopenedBy: authz.sessionEmail, reason });
    if (refusal) return NextResponse.json({ error: REFUSAL_STATUS[refusal].message }, { status: REFUSAL_STATUS[refusal].status });
    if (error) return NextResponse.json({ error }, { status: 500 });
    void insertAuditLog({
      ...auditFrom(req, authz),
      action: 'gift.order_reopened',
      resource: 'gift_orders',
      resource_id: orderId,
      details: { reason },
    });
    return NextResponse.json({ error: null });
  }

  if (body.action === 'delete') {
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
    if (!orderId) return NextResponse.json({ error: 'Missing orderId' }, { status: 400 });
    // Read the whole thing BEFORE it is gone — the audit entry is the only
    // record of this invoice once the delete lands.
    const [{ order, error: readErr }, { lines, error: linesErr }] = await Promise.all([
      getGiftOrder(orderId),
      listGiftOrderLines(orderId),
    ]);
    if (readErr || linesErr) return NextResponse.json({ error: readErr ?? linesErr }, { status: 500 });
    if (!order) return NextResponse.json({ error: REFUSAL_STATUS.not_found.message }, { status: 404 });
    const { refusal, error } = await deleteGiftOrder(orderId);
    if (refusal) return NextResponse.json({ error: REFUSAL_STATUS[refusal].message }, { status: REFUSAL_STATUS[refusal].status });
    if (error) return NextResponse.json({ error }, { status: 500 });
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'gift.order_deleted',
      resource: 'gift_orders',
      resource_id: orderId,
      details: {
        order_no: order.order_no,
        status_at_delete: order.status,
        locked_at: order.locked_at,
        locked_by: order.locked_by,
        reopened_at: order.reopened_at,
        reopened_by: order.reopened_by,
        total_centavos: order.total_centavos,
        line_count: order.line_count,
        snapshot: order.snapshot,
        lines,
      },
    });
    return NextResponse.json({ error: null });
  }

  if (body.action !== 'lock') {
    return NextResponse.json({ error: "action must be 'lock', 'reopen' or 'delete'" }, { status: 400 });
  }

  const ids = Array.isArray(body.submissionIds)
    ? [...new Set(body.submissionIds.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];
  if (ids.length === 0) return NextResponse.json({ error: REFUSAL_STATUS.empty.message }, { status: 400 });
  if (ids.length > 2000) return NextResponse.json({ error: 'Too many gifts in one order.' }, { status: 400 });
  const expected = body.expectedTotalCentavos;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected <= 0) {
    return NextResponse.json({ error: 'expectedTotalCentavos must be a positive integer' }, { status: 400 });
  }
  const variantChoices = stringRecord(body.variantChoices, 100);
  const names = stringRecord(body.names, 200);

  // The server's own truth: approved submissions, the catalog, and live locks.
  const [subs, catalog, orders] = await Promise.all([
    listShippingDetails({ status: 'approved' }),
    getGiftCatalog(),
    listGiftOrders(),
  ]);
  if (subs.error) return NextResponse.json({ error: subs.error }, { status: 500 });
  if (catalog.error) return NextResponse.json({ error: catalog.error }, { status: 500 });
  if (!orders.migrated) return NextResponse.json({ error: REFUSAL_STATUS.missing.message }, { status: 503 });
  if (orders.error) return NextResponse.json({ error: orders.error }, { status: 500 });

  const wanted = new Set(ids);
  const lines = resolveOrderLines({
    submissions: subs.rows,
    catalog: catalog.catalog.items,
    tiers: catalog.catalog.anniversaries,
    lockedKeys: new Set(orders.liveKeys),
    variantChoices,
  }).filter((l) => wanted.has(l.submissionId));

  const found = new Set(lines.map((l) => l.submissionId));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `${missing.length} of these gifts are no longer open (not approved, or already on a locked order). Refresh and try again.`, missing },
      { status: 409 },
    );
  }
  const blocked = lines.filter((l) => l.problem !== null);
  if (blocked.length > 0) {
    return NextResponse.json(
      {
        error: `${blocked.length} line${blocked.length === 1 ? '' : 's'} cannot be priced yet: ${ORDER_PROBLEM_LABEL[blocked[0].problem!]} (${blocked[0].item}).`,
        blocked: blocked.map((l) => ({ key: l.key, problem: l.problem })),
      },
      { status: 400 },
    );
  }

  const { snapshot, lockLines } = buildInvoice(lines, (email) => names[email] || null);
  if (snapshot.totalCentavos !== expected) {
    return NextResponse.json(
      { error: 'Prices in Gift items changed since this screen loaded. Refresh to see the new total, then lock again.' },
      { status: 409 },
    );
  }

  const { order, refusal, error } = await lockGiftOrder({
    lockedBy: authz.sessionEmail,
    totalCentavos: snapshot.totalCentavos,
    snapshot,
    lines: lockLines,
  });
  if (refusal) return NextResponse.json({ error: REFUSAL_STATUS[refusal].message }, { status: REFUSAL_STATUS[refusal].status });
  if (error || !order) return NextResponse.json({ error: error ?? 'Lock failed' }, { status: 500 });

  void insertAuditLog({
    ...auditFrom(req, authz),
    action: 'gift.order_locked',
    resource: 'gift_orders',
    resource_id: order.id,
    details: {
      order_no: order.order_no,
      gifts: snapshot.giftCount,
      qty: snapshot.qtyTotal,
      total_centavos: snapshot.totalCentavos,
      submission_ids: ids,
    },
  });
  return NextResponse.json({ order, error: null });
}
