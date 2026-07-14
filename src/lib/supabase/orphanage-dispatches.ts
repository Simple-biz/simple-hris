import { createSupabaseServiceRoleClient } from './server';
import type { OrphanageBudgetRequestRow } from './orphanage-budget-requests';
import type { EmployeeGiftShippingRow } from './employee-gift-shipping';
import {
  workerTypeLabel,
  type OrphanageWorkerPaymentRow,
} from '../orphanage/worker-payment';

export type OrphanageDispatchStatus = 'pending' | 'paid' | 'problem';
export type OrphanageDispatchType = 'budget_request' | 'gift_shipping' | 'worker_payment';

export interface OrphanageDispatchRow {
  id: string;
  dispatch_type: OrphanageDispatchType;
  budget_request_id: string | null;
  gift_shipping_id: string | null;
  /** Set when dispatch_type === 'worker_payment' — the source worker row. */
  worker_payment_id: string | null;
  /** Self-contained name snapshot for worker payments (no employee to join to). */
  recipient_name: string | null;
  /** 'handyman' | 'musician' | 'other' for worker payments; null otherwise. */
  worker_type: string | null;
  label: string;
  submitter_email: string;
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  swift_code: string;
  amount_php: number;
  status: OrphanageDispatchStatus;
  transaction_id: string | null;
  bank_used: string | null;
  sent_date: string | null;
  note: string | null;
  created_by: string | null;
  paid_by: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Pending item returned to the Orphanage tab queue in PayrollDispatch. */
export interface OrphanagePendingItem {
  sourceType: OrphanageDispatchType;
  sourceId: string;
  label: string;
  submitterEmail: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  swiftCode: string;
  amountPhp: number;
  /** Extra context for budget requests */
  budgetRequest?: OrphanageBudgetRequestRow;
  /** Extra context for gift shippings */
  giftShipping?: EmployeeGiftShippingRow;
  /** Extra context for worker payments (handymen / musicians / other). */
  workerPayment?: OrphanageWorkerPaymentRow;
}

const SELECT_COLS =
  'id, dispatch_type, budget_request_id, gift_shipping_id, worker_payment_id, recipient_name, worker_type, label, submitter_email, bank_name, bank_account_name, bank_account_number, swift_code, amount_php, status, transaction_id, bank_used, sent_date, note, created_by, paid_by, paid_at, created_at, updated_at';

/**
 * Returns all approved orphanage budget requests and approved gift shippings
 * that don't yet have an orphanage_dispatches row (i.e. still need payment).
 * Also returns the latest approved budget request bank info as a default for gift items.
 */
export async function listPendingOrphanageItems(): Promise<{
  items: OrphanagePendingItem[];
  defaultBank: { bank_name: string; bank_account_name: string; bank_account_number: string; swift_code: string } | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { items: [], defaultBank: null, error: 'Supabase not configured' };

  // IDs that already have a dispatch record. Kept to the two long-standing
  // columns so this core query never breaks if the worker-payment migration
  // (#95) hasn't run yet — worker dedup is fetched separately + best-effort.
  const { data: dispatched, error: dErr } = await supabase
    .from('orphanage_dispatches')
    .select('budget_request_id, gift_shipping_id');
  if (dErr) return { items: [], defaultBank: null, error: dErr.message };

  const dispatchedBudgetIds = (dispatched ?? [])
    .map((d: { budget_request_id: string | null }) => d.budget_request_id)
    .filter(Boolean) as string[];
  // Worker-payment ids that already have a dispatch. Best-effort: if the
  // worker_payment_id column doesn't exist yet (pre-migration), skip dedup
  // rather than failing the whole (budget + gift) queue.
  const { data: dispatchedWorkers } = await supabase
    .from('orphanage_dispatches')
    .select('worker_payment_id')
    .not('worker_payment_id', 'is', null);
  const dispatchedWorkerIds = (dispatchedWorkers ?? [])
    .map((d: { worker_payment_id: string | null }) => d.worker_payment_id)
    .filter(Boolean) as string[];

  // Approved budget requests not yet dispatched
  let brQuery = supabase
    .from('orphanage_budget_requests')
    .select('*')
    .eq('status', 'approved')
    .order('decided_at', { ascending: false });
  if (dispatchedBudgetIds.length > 0) {
    brQuery = brQuery.not('id', 'in', `(${dispatchedBudgetIds.join(',')})`);
  }
  const { data: brData, error: brErr } = await brQuery;
  if (brErr) return { items: [], defaultBank: null, error: brErr.message };

  // Tenure gifts are informational only (no payment / no price) so they never
  // enter the dispatch queue — the queue carries budget requests and worker
  // payments. (Historical gift dispatches, if any, still show in Reports.)

  // Worker payments not yet dispatched (handymen / musicians / other staff the
  // clerk added by hand in the Orphanage tab). These are pending the moment
  // they're created — there's no approval gate — so they show until paid.
  // Best-effort: if the table doesn't exist yet (pre-migration #95), fall back
  // to no worker items rather than breaking the whole (budget + gift) queue.
  let wpQuery = supabase
    .from('orphanage_worker_payments')
    .select('*')
    .order('created_at', { ascending: false });
  if (dispatchedWorkerIds.length > 0) {
    wpQuery = wpQuery.not('id', 'in', `(${dispatchedWorkerIds.join(',')})`);
  }
  const { data: wpData, error: wpErr } = await wpQuery;
  if (wpErr) {
    console.warn('[orphanage-dispatches] worker payments unavailable (run migration #95?):', wpErr.message);
  }

  const budgetRows = (brData ?? []) as OrphanageBudgetRequestRow[];
  const workerRows = (wpData ?? []) as OrphanageWorkerPaymentRow[];

  // The most recent approved budget request provides the default orphanage bank
  const latestBudget = budgetRows[0] ?? null;
  const defaultBank = latestBudget
    ? {
        bank_name: latestBudget.bank_name,
        bank_account_name: latestBudget.bank_account_name,
        bank_account_number: latestBudget.bank_account_number,
        swift_code: latestBudget.swift_code,
      }
    : null;

  const items: OrphanagePendingItem[] = [
    ...budgetRows.map((r) => ({
      sourceType: 'budget_request' as const,
      sourceId: r.id,
      label: `${r.visit_type.charAt(0).toUpperCase() + r.visit_type.slice(1)} visit budget${r.mission_trip ? ' · Mission Trip' : ''}`,
      submitterEmail: r.submitter_email,
      bankName: r.bank_name,
      bankAccountName: r.bank_account_name,
      bankAccountNumber: r.bank_account_number,
      swiftCode: r.swift_code,
      amountPhp: r.final_amount,
      budgetRequest: r,
    })),
    ...workerRows.map((r) => ({
      sourceType: 'worker_payment' as const,
      sourceId: r.id,
      label: `${r.recipient_name} · ${workerTypeLabel(r)}${r.pay_week ? ` · ${r.pay_week}` : ''}`,
      submitterEmail: '',
      bankName: r.bank_name,
      bankAccountName: r.bank_account_name,
      bankAccountNumber: r.bank_account_number,
      swiftCode: r.swift_code,
      amountPhp: r.amount_php,
      workerPayment: r,
    })),
  ];

  return { items, defaultBank, error: null };
}

/** Create a dispatch record (i.e. Lenny has sent the payment). */
export async function createOrphanageDispatch(input: {
  dispatch_type: OrphanageDispatchType;
  budget_request_id?: string | null;
  gift_shipping_id?: string | null;
  worker_payment_id?: string | null;
  recipient_name?: string | null;
  worker_type?: string | null;
  label: string;
  submitter_email: string;
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  swift_code: string;
  amount_php: number;
  status: OrphanageDispatchStatus;
  transaction_id?: string | null;
  bank_used?: string | null;
  sent_date?: string | null;
  note?: string | null;
  created_by?: string | null;
  paid_by?: string | null;
}): Promise<{ row: OrphanageDispatchRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('orphanage_dispatches')
    .insert({
      dispatch_type: input.dispatch_type,
      budget_request_id: input.budget_request_id ?? null,
      gift_shipping_id: input.gift_shipping_id ?? null,
      worker_payment_id: input.worker_payment_id ?? null,
      recipient_name: input.recipient_name ?? null,
      worker_type: input.worker_type ?? null,
      label: input.label,
      submitter_email: input.submitter_email,
      bank_name: input.bank_name,
      bank_account_name: input.bank_account_name,
      bank_account_number: input.bank_account_number,
      swift_code: input.swift_code,
      amount_php: input.amount_php,
      status: input.status,
      transaction_id: input.transaction_id ?? null,
      bank_used: input.bank_used ?? null,
      sent_date: input.sent_date ?? null,
      note: input.note ?? null,
      created_by: input.created_by ?? null,
      paid_by: input.paid_by ?? null,
      paid_at: input.status === 'paid' ? new Date().toISOString() : null,
    })
    .select(SELECT_COLS)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as OrphanageDispatchRow, error: null };
}

/** List all paid/problem orphanage dispatches (used by the Reports tab). */
export async function listOrphanageDispatches(opts: {
  status?: OrphanageDispatchStatus;
} = {}): Promise<{ rows: OrphanageDispatchRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  let q = supabase
    .from('orphanage_dispatches')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (opts.status) q = q.eq('status', opts.status);

  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as OrphanageDispatchRow[], error: null };
}
