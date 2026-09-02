import { createSupabaseServiceRoleClient } from './server';
import type { OrphanageBudgetRequestRow } from './orphanage-budget-requests';
import type { EmployeeGiftShippingRow } from './employee-gift-shipping';
import {
  workerTypeLabel,
  type OrphanageWorkerPaymentRow,
} from '../orphanage/worker-payment';
import type { OrphanageInternPayRow } from '@/lib/interns/intern-types';
import { mapInternPay } from './orphanage-intern-pay-db';

export type OrphanageDispatchStatus = 'pending' | 'paid' | 'problem';
/**
 * `intern_pay` / `intern_orphanage_share` (2026-09-02): an ACCEPTED intern week
 * row (`orphanage_intern_pay`) is the source. Under `system_split` it yields two
 * payees — the intern's share and the orphanage's share; under `intern_remits`
 * one item for the gross. Both reference `intern_pay_id`.
 */
export type OrphanageDispatchType = 'budget_request' | 'gift_shipping' | 'worker_payment' | 'intern_pay' | 'intern_orphanage_share';

export interface OrphanageDispatchRow {
  id: string;
  dispatch_type: OrphanageDispatchType;
  budget_request_id: string | null;
  gift_shipping_id: string | null;
  /** Set when dispatch_type === 'worker_payment' — the source worker row. */
  worker_payment_id: string | null;
  /** Set for intern_pay / intern_orphanage_share — the accepted intern week row. */
  intern_pay_id: string | null;
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
  /** Extra context for intern items — the accepted week row this item pays. */
  internPay?: OrphanageInternPayRow;
  /** For intern items: whose share this is. Bank is READ-ONLY at pay time —
   *  intern bank changes on the Orphanage dashboard, orphanage bank in its directory. */
  internPayee?: 'intern' | 'orphanage';
}

const SELECT_COLS =
  'id, dispatch_type, budget_request_id, gift_shipping_id, worker_payment_id, intern_pay_id, recipient_name, worker_type, label, submitter_email, bank_name, bank_account_name, bank_account_number, swift_code, amount_php, status, transaction_id, bank_used, sent_date, note, created_by, paid_by, paid_at, created_at, updated_at';

/**
 * Accepted intern weeks with no dispatch yet → pending items. Best-effort like
 * the worker branch: if the intern tables are absent (migration not run), the
 * rest of the queue still loads.
 */
async function listPendingInternItems(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
): Promise<OrphanagePendingItem[]> {
  const { data: dispatched, error: dErr } = await supabase
    .from('orphanage_dispatches')
    .select('intern_pay_id, dispatch_type')
    .not('intern_pay_id', 'is', null);
  if (dErr) {
    console.warn('[orphanage-dispatches] intern dispatch dedup unavailable (run the 2026-09-02 interns migration?):', dErr.message);
    return [];
  }
  const done = new Set(
    (dispatched ?? []).map((d: { intern_pay_id: string | null; dispatch_type: string }) => `${d.intern_pay_id}:${d.dispatch_type}`),
  );

  const { data: payData, error: payErr } = await supabase
    .from('orphanage_intern_pay')
    .select('*')
    .eq('status', 'accepted')
    .order('week_start', { ascending: false })
    .order('intern_name');
  if (payErr) {
    console.warn('[orphanage-dispatches] intern pay unavailable (run the 2026-09-02 interns migration?):', payErr.message);
    return [];
  }
  const payRows = ((payData ?? []) as Record<string, unknown>[]).map(mapInternPay);
  if (payRows.length === 0) return [];

  const internIds = [...new Set(payRows.map((r) => r.intern_id))];
  const { data: internData } = await supabase
    .from('orphanage_interns')
    .select('id, full_name, orphanage_id, bank_name, bank_account_name, bank_account_number, swift_code')
    .in('id', internIds);
  const interns = new Map(
    ((internData ?? []) as Array<{ id: string; full_name: string; orphanage_id: string | null; bank_name: string; bank_account_name: string; bank_account_number: string; swift_code: string }>).map((i) => [i.id, i]),
  );
  const orphIds = [...new Set([...interns.values()].map((i) => i.orphanage_id).filter((x): x is string => !!x))];
  const { data: orphData } = orphIds.length
    ? await supabase.from('orphanages').select('id, name, bank_name, bank_account_name, bank_account_number, swift_code').in('id', orphIds)
    : { data: [] as unknown[] };
  const orphanages = new Map(
    ((orphData ?? []) as Array<{ id: string; name: string; bank_name?: string; bank_account_name?: string; bank_account_number?: string; swift_code?: string }>).map((o) => [o.id, o]),
  );

  const weekLabel = (r: OrphanageInternPayRow) => {
    const f = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    return `${f(r.week_start)}–${f(r.week_end)}`;
  };

  const items: OrphanagePendingItem[] = [];
  for (const r of payRows) {
    const intern = interns.get(r.intern_id);
    const internAmount = r.share_mode === 'system_split' ? r.intern_share_php : r.gross_php;
    if (!done.has(`${r.id}:intern_pay`) && internAmount > 0) {
      items.push({
        sourceType: 'intern_pay',
        sourceId: r.id,
        label: `${r.intern_name} · Intern · ${weekLabel(r)}${r.pab_php > 0 ? ' · incl. PAB' : ''}`,
        submitterEmail: r.intern_email,
        bankName: intern?.bank_name ?? '',
        bankAccountName: intern?.bank_account_name ?? '',
        bankAccountNumber: intern?.bank_account_number ?? '',
        swiftCode: intern?.swift_code ?? '',
        amountPhp: internAmount,
        internPay: r,
        internPayee: 'intern',
      });
    }
    if (r.share_mode === 'system_split' && r.orphanage_share_php > 0 && !done.has(`${r.id}:intern_orphanage_share`)) {
      const orph = intern?.orphanage_id ? orphanages.get(intern.orphanage_id) : undefined;
      items.push({
        sourceType: 'intern_orphanage_share',
        sourceId: r.id,
        label: `${orph?.name ?? 'Orphanage'} · ${r.orphanage_share_pct}% share of ${r.intern_name} · ${weekLabel(r)}`,
        submitterEmail: r.intern_email,
        bankName: orph?.bank_name ?? '',
        bankAccountName: orph?.bank_account_name ?? '',
        bankAccountNumber: orph?.bank_account_number ?? '',
        swiftCode: orph?.swift_code ?? '',
        amountPhp: r.orphanage_share_php,
        internPay: r,
        internPayee: 'orphanage',
      });
    }
  }
  return items;
}

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
    ...(await listPendingInternItems(supabase)),
  ];

  return { items, defaultBank, error: null };
}

/** Create a dispatch record (i.e. Lenny has sent the payment). */
export async function createOrphanageDispatch(input: {
  dispatch_type: OrphanageDispatchType;
  budget_request_id?: string | null;
  gift_shipping_id?: string | null;
  worker_payment_id?: string | null;
  intern_pay_id?: string | null;
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
      intern_pay_id: input.intern_pay_id ?? null,
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
