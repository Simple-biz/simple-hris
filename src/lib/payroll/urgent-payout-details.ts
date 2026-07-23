import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';

// Shared payout pre-fill for the Urgent queue's pending sources (MESA
// disbursements + People-tab one-off payments). Both need the recipient's saved
// preferred processor + banking so Mark Paid pre-fills for whichever processor
// the clerk picks. Extracted from app/api/urgent-payments/route.ts so the
// one-off requests feed (app/api/urgent-payments/requests/route.ts) reuses it
// verbatim rather than duplicating the logic.

const KNOWN_PROCESSORS = new Set<ProcessorId>(['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires']);

export function isKnownProcessor(v: string): v is ProcessorId {
  return (KNOWN_PROCESSORS as Set<string>).has(v);
}

function pickFirst(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

// Minimal shape of the employee_ids columns we read for payout pre-fill.
export type IdsRow = {
  work_email: string | null;
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  alt_bank_name: string | null;
  alt_account_holder_name: string | null;
  alt_account_number: string | null;
  alt_routing_number: string | null;
  hurupay_email: string | null;
  wepay_email: string | null;
  higlobe_email: string | null;
  higlobe_account_name: string | null;
  wise_email: string | null;
  wise_tag: string | null;
  phone_number: string | null;
  swift_code: string | null;
  full_address: string | null;
};

const IDS_COLUMNS =
  'work_email, preferred_processor, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address';

export function buildPayoutDetails(ids: IdsRow | undefined, workEmail: string): QueueRow['details'] {
  const slot = ids?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';
  const bankName = slot === 'alternative'
    ? pickFirst(ids?.alt_bank_name, ids?.bank_name)
    : pickFirst(ids?.bank_name, ids?.alt_bank_name);
  const accountHolder = slot === 'alternative'
    ? pickFirst(ids?.alt_account_holder_name, ids?.account_holder_name)
    : pickFirst(ids?.account_holder_name, ids?.alt_account_holder_name);
  const accountNumber = slot === 'alternative'
    ? pickFirst(ids?.alt_account_number, ids?.account_number)
    : pickFirst(ids?.account_number, ids?.alt_account_number);
  const swiftCode = slot === 'alternative'
    ? pickFirst(ids?.alt_routing_number, ids?.swift_code, ids?.routing_number)
    : pickFirst(ids?.swift_code, ids?.routing_number, ids?.alt_routing_number);
  return {
    email: workEmail,
    hurupay_email: pickFirst(ids?.hurupay_email),
    wepay_email: pickFirst(ids?.wepay_email),
    higlobe_email: pickFirst(ids?.higlobe_email),
    higlobe_account_name: pickFirst(ids?.higlobe_account_name),
    wise_email: pickFirst(ids?.wise_email),
    wise_tag: pickFirst(ids?.wise_tag),
    phone_number: pickFirst(ids?.phone_number),
    full_address: pickFirst(ids?.full_address),
    bank_name: bankName,
    account_holder_name: accountHolder,
    account_number: accountNumber,
    swift_code: swiftCode,
  };
}

/** The recipient's saved preferred processor, defaulting to 'wise' when unset. */
export function preferredProcessor(ids: IdsRow | undefined): ProcessorId {
  const chose = (ids?.preferred_processor ?? '').trim().toLowerCase();
  return isKnownProcessor(chose) ? chose : 'wise';
}

/**
 * Batch-fetch employee_ids for a set of work emails, keyed by lowercased email.
 * Returns an empty map when there are no emails or the query fails (payout
 * pre-fill is best-effort — the clerk can still fill Mark Paid by hand).
 */
export async function fetchPayoutIdsByEmail(
  supabase: SupabaseClient,
  workEmails: string[],
): Promise<Record<string, IdsRow>> {
  const emails = [...new Set(workEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const byEmail: Record<string, IdsRow> = {};
  if (emails.length === 0) return byEmail;

  const { data } = await supabase
    .from('employee_ids')
    .select(IDS_COLUMNS)
    .in('work_email', emails);

  for (const row of (data ?? []) as IdsRow[]) {
    const e = row.work_email?.trim().toLowerCase();
    if (e) byEmail[e] = row;
  }
  return byEmail;
}
