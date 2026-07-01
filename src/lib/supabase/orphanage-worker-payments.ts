import { createSupabaseServiceRoleClient } from './server';
import type {
  OrphanageWorkerPaymentRow,
  UpsertOrphanageWorkerPaymentInput,
} from '../orphanage/worker-payment';

// TEMPORARY store for orphanage staff who have no Hubstaff record / employee
// identity — carpenters/handymen and musicians. Accounting adds them + sets
// their pay in the Payment Dispatch → Orphanage tab; a row here is the SOURCE
// that surfaces as a pending item until it's paid (an orphanage_dispatches row
// references it). See references/sql/create/create_orphanage_worker_payments.sql.
//
// The types + `workerTypeLabel` helper live in the client-safe pure module
// `src/lib/orphanage/worker-payment.ts` (re-exported here for server callers).
export type {
  OrphanageWorkerType,
  OrphanageWorkerPaymentRow,
  UpsertOrphanageWorkerPaymentInput,
} from '../orphanage/worker-payment';
export { workerTypeLabel } from '../orphanage/worker-payment';

const SELECT_COLS =
  'id, recipient_name, worker_type, type_label, pay_week, amount_php, bank_name, bank_account_name, bank_account_number, swift_code, note, created_by, created_at, updated_at';

/** All worker payments (raw rows), newest first. */
export async function listOrphanageWorkerPayments(): Promise<{
  rows: OrphanageWorkerPaymentRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_worker_payments')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OrphanageWorkerPaymentRow[], error: null };
}

/** Add a new worker payment (a pending item until it's paid). */
export async function createOrphanageWorkerPayment(
  input: UpsertOrphanageWorkerPaymentInput,
): Promise<{ row: OrphanageWorkerPaymentRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_worker_payments')
    .insert({
      recipient_name: input.recipient_name.trim(),
      worker_type: input.worker_type,
      type_label: input.worker_type === 'other' ? (input.type_label?.trim() || null) : null,
      pay_week: input.pay_week?.trim() || null,
      amount_php: input.amount_php,
      bank_name: input.bank_name?.trim() ?? '',
      bank_account_name: input.bank_account_name?.trim() ?? '',
      bank_account_number: input.bank_account_number?.trim() ?? '',
      swift_code: input.swift_code?.trim() ?? '',
      note: input.note?.trim() || null,
      created_by: input.created_by ?? null,
    })
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageWorkerPaymentRow, error: null };
}

/** Edit a pending worker payment (name / type / amount / bank / note). */
export async function updateOrphanageWorkerPayment(
  id: string,
  input: UpsertOrphanageWorkerPaymentInput,
): Promise<{ row: OrphanageWorkerPaymentRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_worker_payments')
    .update({
      recipient_name: input.recipient_name.trim(),
      worker_type: input.worker_type,
      type_label: input.worker_type === 'other' ? (input.type_label?.trim() || null) : null,
      pay_week: input.pay_week?.trim() || null,
      amount_php: input.amount_php,
      bank_name: input.bank_name?.trim() ?? '',
      bank_account_name: input.bank_account_name?.trim() ?? '',
      bank_account_number: input.bank_account_number?.trim() ?? '',
      swift_code: input.swift_code?.trim() ?? '',
      note: input.note?.trim() || null,
    })
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageWorkerPaymentRow, error: null };
}

/** Remove a worker payment (only meaningful before it's been paid). */
export async function deleteOrphanageWorkerPayment(
  id: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.from('orphanage_worker_payments').delete().eq('id', id);
  return { error: error ? error.message : null };
}
