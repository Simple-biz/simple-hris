import 'server-only';

import { randomUUID } from 'crypto';
import { normEmail } from '@/lib/email/norm-email';
import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { insertPaymentDispatch, type PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { buildFxRates } from '@/lib/fx/currency-fx';

export interface SpecialTransferInput {
  recipientEmail: string;
  amountPhp: number;
  sentDate: string; // YYYY-MM-DD
  reason: string;
  processor?: string | null;
  bankUsed?: string | null;
  transactionId?: string | null;
  createdBy?: string | null;
}

export interface SpecialTransferResult {
  ok: boolean;
  error: string | null;
  sourceFile?: string;
  recipientName?: string | null;
  amountPhp?: number;
  amountUsd?: number | null;
  sentDate?: string;
  dispatch?: PaymentDispatchRow | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Record a one-off "special transfer" to an employee. Writes BOTH:
 *   1. a `disbursement_records` row (kind='special') so it lands in the person's
 *      payroll history — the payment_dispatches sync trigger only UPDATEs an
 *      existing (source_file, recipient_email) row, so for a brand-new synthetic
 *      source_file we must insert this row ourselves; then
 *   2. a `payment_dispatches` row (status='paid'), which the trigger writes
 *      through to the disbursement row above (flips it to paid + links dispatch_id).
 *
 * The result shows up in the People detail history, the Payment Dispatch Reports
 * tab (under its synthetic cycle), and the employee's own portal.
 */
export async function recordSpecialTransfer(input: SpecialTransferInput): Promise<SpecialTransferResult> {
  const email = normEmail(input.recipientEmail);
  if (!email) return { ok: false, error: 'Missing or invalid recipient email.' };

  const amountPhp = Number(input.amountPhp);
  if (!Number.isFinite(amountPhp) || amountPhp <= 0) {
    return { ok: false, error: 'Amount must be a positive number (PHP).' };
  }

  const sentDate = (input.sentDate ?? '').trim();
  if (!ISO_DATE.test(sentDate)) return { ok: false, error: 'sentDate must be YYYY-MM-DD.' };

  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'A reason for the special transfer is required.' };

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { ok: false, error: 'Database is not reachable.' };

  // FX (PHP per $1) for the USD-equivalent column.
  const { data: fxRows } = await supabase
    .from('app_settings')
    .select('key,value')
    .in('key', ['usd_to_php_rate', 'usd_to_cop_rate']);
  const fxValues: Record<string, string | null> = {};
  for (const r of (fxRows ?? []) as { key: string; value: string | null }[]) fxValues[r.key] = r.value;
  const fx = buildFxRates(fxValues);
  const fxRate = fx.usdToPhp;
  const amountUsd = fxRate > 0 ? Math.round((amountPhp / fxRate) * 100) / 100 : null;

  // Recipient identity + banking snapshot (best-effort).
  const { row: idRow } = await getEmployeeIdRowByEmail(email);
  let recipientName: string | null = idRow?.name ?? null;
  if (!recipientName) {
    try {
      const { employee } = await getEmployeeMasterRecord(email);
      recipientName = employee?.name ?? null;
    } catch { /* ignore */ }
  }

  const processor = (input.processor ?? idRow?.preferred_processor ?? 'wires') || 'wires';
  const bankUsed = (input.bankUsed ?? idRow?.bank_name ?? 'Special transfer') || 'Special transfer';
  const transactionId = (input.transactionId ?? '').trim() || `SPECIAL-${randomUUID().slice(0, 8).toUpperCase()}`;

  const sourceFile = `special_${sentDate}_${randomUUID().slice(0, 6)}`;

  // 1) Write the disbursement_records row first (pending). The dispatch trigger
  //    below flips it to paid; doing it in this order means the trigger finds a
  //    row to update.
  const { error: drErr } = await supabase.from('disbursement_records').insert({
    source_file: sourceFile,
    recipient_email: email,
    recipient_name: recipientName,
    kind: 'special',
    note: reason,
    cycle_period_start: sentDate,
    cycle_period_end: sentDate,
    total_hours: 0,
    regular_hours: 0,
    ot_hours: 0,
    amount_php: amountPhp,
    amount_usd: amountUsd,
    fx_rate: fxRate || null,
    status: 'pending',
  });
  if (drErr) return { ok: false, error: `Could not record disbursement: ${drErr.message}` };

  // 2) Write the dispatch (paid). Trigger syncs the row above.
  const { row: dispatch, error: pdErr } = await insertPaymentDispatch({
    cycle_source_file: sourceFile,
    cycle_period_start: sentDate,
    cycle_period_end: sentDate,
    recipient_email: email,
    recipient_name: recipientName,
    processor,
    recipient_preferred_bank: idRow?.bank_name ?? null,
    recipient_account_number: idRow?.account_number ?? null,
    recipient_account_holder: idRow?.account_holder_name ?? null,
    recipient_swift_code: idRow?.swift_code ?? null,
    amount_php: amountPhp,
    amount_usd: amountUsd,
    transaction_id: transactionId,
    bank_used: bankUsed,
    sent_date: sentDate,
    status: 'paid',
    note: `Special transfer — ${reason}`,
    created_by: input.createdBy ?? null,
  });
  if (pdErr) {
    // Roll back the orphaned disbursement row so we don't leave a stuck "pending".
    await supabase.from('disbursement_records').delete().eq('source_file', sourceFile);
    return { ok: false, error: `Could not record payment: ${pdErr}` };
  }

  return {
    ok: true,
    error: null,
    sourceFile,
    recipientName,
    amountPhp,
    amountUsd,
    sentDate,
    dispatch,
  };
}
