/**
 * Gift Tracker → Orders persistence. Server-only (service role).
 * Tables + functions: references/sql/create/2026-09-23_gift_orders.sql.
 * Governing doc: docs/features/gift-tracker-orders.md.
 */
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import type { InvoiceSnapshot, LockLine } from '@/lib/gift-tracker/orders';
import { orderLineKey } from '@/lib/gift-tracker/orders';
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';

export interface GiftOrderRow {
  id: string;
  order_no: number;
  status: 'locked' | 'reopened';
  locked_at: string;
  locked_by: string;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
  total_centavos: number;
  line_count: number;
  snapshot: InvoiceSnapshot;
}

interface LiveLineRow {
  submission_id: string;
  item: string;
  order_id: string;
}

const ORDER_COLS =
  'id, order_no, status, locked_at, locked_by, reopened_at, reopened_by, reopen_reason, total_centavos, line_count, snapshot';

export type GiftOrdersList =
  | { migrated: false; orders: []; liveKeys: []; error: null }
  | { migrated: true; orders: GiftOrderRow[]; liveKeys: string[]; error: string | null };

/** Every order (newest first) + the line keys a LIVE order holds. Both paged. */
export async function listGiftOrders(): Promise<GiftOrdersList> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { migrated: true, orders: [], liveKeys: [], error: 'Supabase client unavailable' };

  const orders = await selectAllPaged<GiftOrderRow>((from, to) =>
    supabase.from('gift_orders').select(ORDER_COLS).order('locked_at', { ascending: false }).order('id').range(from, to),
  );
  if (orders.error) {
    if (classifyTableProbe({ message: orders.error }) === 'MISSING') {
      return { migrated: false, orders: [], liveKeys: [], error: null };
    }
    return { migrated: true, orders: [], liveKeys: [], error: orders.error };
  }

  const lines = await selectAllPaged<LiveLineRow>((from, to) =>
    supabase
      .from('gift_order_lines')
      .select('submission_id, item, order_id')
      .is('released_at', null)
      .order('id')
      .range(from, to),
  );
  if (lines.error) return { migrated: true, orders: [], liveKeys: [], error: lines.error };
  return {
    migrated: true,
    orders: orders.rows.map((o) => ({ ...o, total_centavos: Number(o.total_centavos), order_no: Number(o.order_no) })),
    liveKeys: lines.rows.map((l) => orderLineKey(l.submission_id, l.item)),
    error: null,
  };
}

/** The distinct refusals the lock/reopen functions raise, mapped to HTTP. */
export type GiftOrderRefusal =
  | 'empty'
  | 'not_approved'
  | 'already_ordered'
  | 'total_mismatch'
  | 'not_locked'
  | 'not_found'
  | 'missing';

function refusalOf(err: { code?: string; message: string }): GiftOrderRefusal | null {
  const m = err.message;
  if (err.code === '23505' || /gift_order_lines_one_live_order/.test(m)) return 'already_ordered';
  if (/gift_order_not_approved/.test(m)) return 'not_approved';
  if (/gift_order_empty/.test(m)) return 'empty';
  if (/gift_order_total_mismatch/.test(m)) return 'total_mismatch';
  if (/gift_order_not_locked/.test(m)) return 'not_locked';
  if (/gift_order_not_found/.test(m)) return 'not_found';
  if (classifyTableProbe(err) === 'MISSING' || err.code === 'PGRST202') return 'missing';
  return null;
}

export async function lockGiftOrder(args: {
  lockedBy: string;
  totalCentavos: number;
  snapshot: InvoiceSnapshot;
  lines: LockLine[];
}): Promise<{ order: GiftOrderRow | null; refusal: GiftOrderRefusal | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { order: null, refusal: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.rpc('gift_order_lock', {
    p_locked_by: args.lockedBy,
    p_total_centavos: args.totalCentavos,
    p_snapshot: args.snapshot,
    p_lines: args.lines,
  });
  if (error) return { order: null, refusal: refusalOf(error), error: error.message };
  const id = (Array.isArray(data) ? data[0] : data)?.id as string | undefined;
  if (!id) return { order: null, refusal: null, error: 'Lock returned no order' };
  const { data: row, error: readErr } = await supabase.from('gift_orders').select(ORDER_COLS).eq('id', id).maybeSingle();
  if (readErr || !row) return { order: null, refusal: null, error: readErr?.message ?? 'Locked order not found' };
  const o = row as GiftOrderRow;
  return { order: { ...o, total_centavos: Number(o.total_centavos), order_no: Number(o.order_no) }, refusal: null, error: null };
}

export async function reopenGiftOrder(args: {
  orderId: string;
  reopenedBy: string;
  reason: string | null;
}): Promise<{ refusal: GiftOrderRefusal | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { refusal: null, error: 'Supabase client unavailable' };
  const { error } = await supabase.rpc('gift_order_reopen', {
    p_order_id: args.orderId,
    p_reopened_by: args.reopenedBy,
    p_reason: args.reason,
  });
  if (error) return { refusal: refusalOf(error), error: error.message };
  return { refusal: null, error: null };
}

/** One order, whole — read before a delete so the audit entry can carry it. */
export async function getGiftOrder(orderId: string): Promise<{ order: GiftOrderRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { order: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.from('gift_orders').select(ORDER_COLS).eq('id', orderId).maybeSingle();
  if (error) return { order: null, error: error.message };
  if (!data) return { order: null, error: null };
  const o = data as GiftOrderRow;
  return { order: { ...o, total_centavos: Number(o.total_centavos), order_no: Number(o.order_no) }, error: null };
}

/** Every line of one order (released or not) — for the delete's audit record. */
export async function listGiftOrderLines(
  orderId: string,
): Promise<{ lines: Record<string, unknown>[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { lines: [], error: 'Supabase client unavailable' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from('gift_order_lines')
      .select('submission_id, personal_email, milestone_index, item, size, unit_centavos, qty, released_at')
      .eq('order_id', orderId)
      .order('id')
      .range(from, to),
  );
  return { lines: rows, error };
}

/** Hard delete (Kane, 2026-09-23). Atomic: the order and all its lines, or nothing. */
export async function deleteGiftOrder(
  orderId: string,
): Promise<{ refusal: GiftOrderRefusal | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { refusal: null, error: 'Supabase client unavailable' };
  const { error } = await supabase.rpc('gift_order_delete', { p_order_id: orderId });
  if (error) return { refusal: refusalOf(error), error: error.message };
  return { refusal: null, error: null };
}

/**
 * The live order holding this submission, if any. Used by the edit/delete
 * routes: a locked invoice's gift is frozen until the order is reopened.
 * A missing table means nothing can be locked, so nothing is held.
 */
export async function liveOrderForSubmission(
  submissionId: string,
): Promise<{ orderNo: number | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { orderNo: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase
    .from('gift_order_lines')
    .select('order_id, gift_orders!inner(order_no)')
    .eq('submission_id', submissionId)
    .is('released_at', null)
    .limit(1);
  if (error) {
    if (classifyTableProbe(error) === 'MISSING') return { orderNo: null, error: null };
    return { orderNo: null, error: error.message };
  }
  const first = (data ?? [])[0] as { gift_orders?: { order_no: number } | { order_no: number }[] } | undefined;
  if (!first) return { orderNo: null, error: null };
  const go = Array.isArray(first.gift_orders) ? first.gift_orders[0] : first.gift_orders;
  return { orderNo: go ? Number(go.order_no) : -1, error: null };
}
