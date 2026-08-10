import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';
import { effectiveUsdToPhpRateFromStored } from '@/lib/fx/usd-php';
import { resolveEffectivePayoutProcessor } from '@/lib/employee/payout-completeness';

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
  /** Send-from rail — wins Payment Dispatch's routing precedence over
   *  preferred_processor. Must be selected, or the rail resolves wrong. */
  bank_preferred: string | null;
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
  'work_email, bank_preferred, preferred_processor, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address';

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

/**
 * The rail Payment Dispatch would actually pay this person on — resolved with
 * PD's full precedence (`bank_preferred` → `preferred_processor` → the legacy
 * rates-sheet cell), NOT the Disbursement pick alone.
 *
 * Returns `null` when nothing resolves. That matters: this value pre-selects
 * the rail on an Urgent payment card whose Send button records a real dispatch,
 * so a wrong guess sends money down a rail the payee isn't set up on. The old
 * behavior defaulted to `'wise'` — a retired processor — for anyone routed via
 * `bank_preferred` or the sheet, silently disagreeing with every other surface.
 * Callers should treat null as "make the clerk choose", the same way PD holds
 * an unroutable person in Excluded as `no_bank`.
 */
export function preferredProcessor(
  ids: IdsRow | undefined,
  legacyBankPreferred?: string | null,
): ProcessorId | null {
  return resolveEffectivePayoutProcessor(
    (ids ?? null) as unknown as Record<string, unknown> | null,
    { bankPreferredRaw: legacyBankPreferred ?? null },
  );
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

/**
 * Batch-fetch the legacy rates-sheet "Bank Preferred" cell — the LAST tier of
 * Payment Dispatch's routing precedence, and the only routing many people have
 * (they never picked a processor in-app). Without it an Urgent card would show
 * no rail for someone payroll pays every week. Best-effort: a failure just
 * leaves those people unresolved rather than mis-routed.
 */
export async function fetchLegacyBankPreferredByEmail(
  supabase: SupabaseClient,
  workEmails: string[],
): Promise<Record<string, string | null>> {
  const emails = [...new Set(workEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const byEmail: Record<string, string | null> = {};
  if (emails.length === 0) return byEmail;
  // Prefer the deduped current view (what PD reads); fall back to the base table.
  for (const source of ['employee_hourly_rates_current', 'employee_hourly_rates']) {
    const { data, error } = await supabase
      .from(source)
      .select('"Work Email", "Personal Email", "Bank Preferred"')
      .or(emails.map((e) => `"Work Email".ilike.${e},"Personal Email".ilike.${e}`).join(','));
    if (error) continue;
    for (const row of (data ?? []) as Record<string, string | null>[]) {
      const cell = row['Bank Preferred'] ?? null;
      for (const key of ['Work Email', 'Personal Email']) {
        const e = (row[key] ?? '').trim().toLowerCase();
        if (e && byEmail[e] == null) byEmail[e] = cell;
      }
    }
    return byEmail;
  }
  return byEmail;
}

/**
 * The active USD→PHP rate (PHP per $1) from `app_settings`, falling back to the
 * official rate when unset/invalid. Urgent payments are filed in PHP, so this is
 * what turns them into the USD figure the dispatch queue and weekly report
 * headline in.
 */
export async function fetchUsdToPhpRate(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'usd_to_php_rate')
    .maybeSingle();
  return effectiveUsdToPhpRateFromStored((data as { value?: string | null } | null)?.value);
}

/**
 * USD equivalent of a PHP-denominated urgent amount, rounded to cents. Mirrors
 * the conversion the dispatch routes persist onto `payment_dispatches.amount_usd`,
 * so the figure the clerk sees on the card is the figure that lands in the
 * weekly report. Null in → null out (amount not yet set).
 */
export function usdFromPhp(amountPhp: number | null | undefined, usdToPhp: number): number | null {
  if (amountPhp == null || !Number.isFinite(Number(amountPhp))) return null;
  if (!(usdToPhp > 0)) return null;
  return Math.round((Number(amountPhp) / usdToPhp) * 100) / 100;
}
