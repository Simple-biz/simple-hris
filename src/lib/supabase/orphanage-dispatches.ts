import { createSupabaseServiceRoleClient } from './server';
import type { OrphanageBudgetRequestRow } from './orphanage-budget-requests';
import type { EmployeeGiftShippingRow } from './employee-gift-shipping';

export type OrphanageDispatchStatus = 'pending' | 'paid' | 'problem';
export type OrphanageDispatchType = 'budget_request' | 'gift_shipping';

export interface OrphanageDispatchRow {
  id: string;
  dispatch_type: OrphanageDispatchType;
  budget_request_id: string | null;
  gift_shipping_id: string | null;
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
}

const SELECT_COLS =
  'id, dispatch_type, budget_request_id, gift_shipping_id, label, submitter_email, bank_name, bank_account_name, bank_account_number, swift_code, amount_php, status, transaction_id, bank_used, sent_date, note, created_by, paid_by, paid_at, created_at, updated_at';

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

  // IDs that already have a dispatch record
  const { data: dispatched, error: dErr } = await supabase
    .from('orphanage_dispatches')
    .select('budget_request_id, gift_shipping_id');
  if (dErr) return { items: [], defaultBank: null, error: dErr.message };

  const dispatchedBudgetIds = (dispatched ?? [])
    .map((d: { budget_request_id: string | null }) => d.budget_request_id)
    .filter(Boolean) as string[];
  const dispatchedGiftIds = (dispatched ?? [])
    .map((d: { gift_shipping_id: string | null }) => d.gift_shipping_id)
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

  // Approved gift shippings not yet dispatched
  let gsQuery = supabase
    .from('employee_gift_shipping_details')
    .select('*')
    .eq('status', 'approved')
    .order('decided_at', { ascending: false });
  if (dispatchedGiftIds.length > 0) {
    gsQuery = gsQuery.not('id', 'in', `(${dispatchedGiftIds.join(',')})`);
  }
  const { data: gsData, error: gsErr } = await gsQuery;
  if (gsErr) return { items: [], defaultBank: null, error: gsErr.message };

  const budgetRows = (brData ?? []) as OrphanageBudgetRequestRow[];
  const giftRows = (gsData ?? []) as EmployeeGiftShippingRow[];

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
    ...giftRows.map((r) => ({
      sourceType: 'gift_shipping' as const,
      sourceId: r.id,
      label: `Gift · ${r.milestone_index * 6}-month milestone${r.gift_name ? ` · ${r.gift_name}` : ''}`,
      submitterEmail: r.personal_email,
      bankName: defaultBank?.bank_name ?? '',
      bankAccountName: defaultBank?.bank_account_name ?? '',
      bankAccountNumber: defaultBank?.bank_account_number ?? '',
      swiftCode: defaultBank?.swift_code ?? '',
      amountPhp: r.gift_price_php ?? 0,
      giftShipping: r,
    })),
  ];

  return { items, defaultBank, error: null };
}

/** Create a dispatch record (i.e. Lenny has sent the payment). */
export async function createOrphanageDispatch(input: {
  dispatch_type: OrphanageDispatchType;
  budget_request_id?: string | null;
  gift_shipping_id?: string | null;
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
