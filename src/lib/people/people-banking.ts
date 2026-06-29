import 'server-only';

import { normEmail } from '@/lib/email/norm-email';
import { getEmployeeIdRowByEmail, type EmployeeIdRow } from '@/lib/supabase/employee-ids';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';

/** Normalized payout details for one person, returned masked or in full. */
export interface PeopleBanking {
  preferred_processor: string | null;
  preferred_bank_slot: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  swift_code: string | null;
  full_address: string | null;
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
  /** When the employee last self-updated these via the public /update-bank-info link (null = never / column absent). */
  bank_last_self_updated_at: string | null;
  /** True when the sensitive fields below are redacted (the default). */
  masked: boolean;
}

export interface PeoplePayrollRow {
  source_file: string | null;
  kind: 'cycle' | 'special';
  note: string | null;
  period_start: string | null;
  period_end: string | null;
  total_hours: number | null;
  regular_hours: number | null;
  ot_hours: number | null;
  amount_php: number | null;
  amount_usd: number | null;
  status: string | null;
  paid_amount_usd: number | null;
  paid_at: string | null;
}

/** Email shape excluding chars meaningful in a PostgREST or() filter. */
function isSafeEmail(s: string): boolean {
  return /^[^\s@,()"']+@[^\s@,()"']+\.[^\s@,()"']+$/.test(s);
}

/** Mask an account/number, leaving the last 4 chars visible. */
function maskNumber(v: string | null): string | null {
  if (!v) return v;
  const clean = v.replace(/[\s-]/g, '');
  if (clean.length <= 4) return '•'.repeat(clean.length);
  return '•'.repeat(Math.max(4, clean.length - 4)) + clean.slice(-4);
}

/** Mask an email's local part, keeping first char + domain (e.g. d•••@gmail.com). */
function maskEmail(v: string | null): string | null {
  if (!v || !v.includes('@')) return v ? maskNumber(v) : v;
  const [local, domain] = v.split('@');
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

function maskBanking(b: PeopleBanking): PeopleBanking {
  return {
    ...b,
    account_number: maskNumber(b.account_number),
    routing_number: maskNumber(b.routing_number),
    swift_code: maskNumber(b.swift_code),
    alt_account_number: maskNumber(b.alt_account_number),
    alt_routing_number: maskNumber(b.alt_routing_number),
    phone_number: maskNumber(b.phone_number),
    hurupay_email: maskEmail(b.hurupay_email),
    wepay_email: maskEmail(b.wepay_email),
    higlobe_email: maskEmail(b.higlobe_email),
    wise_email: maskEmail(b.wise_email),
    wise_tag: maskNumber(b.wise_tag),
    masked: true,
  };
}

function toBanking(row: EmployeeIdRow): PeopleBanking {
  return {
    preferred_processor: row.preferred_processor,
    preferred_bank_slot: row.preferred_bank_slot,
    bank_name: row.bank_name,
    account_holder_name: row.account_holder_name,
    account_number: row.account_number,
    routing_number: row.routing_number,
    swift_code: row.swift_code,
    full_address: row.full_address,
    alt_bank_name: row.alt_bank_name,
    alt_account_holder_name: row.alt_account_holder_name,
    alt_account_number: row.alt_account_number,
    alt_routing_number: row.alt_routing_number,
    hurupay_email: row.hurupay_email,
    wepay_email: row.wepay_email,
    higlobe_email: row.higlobe_email,
    higlobe_account_name: row.higlobe_account_name,
    wise_email: row.wise_email,
    wise_tag: row.wise_tag,
    phone_number: row.phone_number,
    bank_last_self_updated_at: null,
    masked: false,
  };
}

/**
 * Best-effort read of the external-link self-update timestamp. Kept separate
 * from the shared getEmployeeIdRowByEmail() select so a deployment whose DB
 * predates the bank_last_self_updated_at column still loads banking normally
 * (the column-missing error is swallowed and treated as "never").
 */
async function fetchBankSelfUpdatedAt(email: string): Promise<string | null> {
  const target = normEmail(email);
  if (!target) return null;
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('employee_ids')
      .select('bank_last_self_updated_at')
      .ilike('work_email', target)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { bank_last_self_updated_at?: string | null }).bank_last_self_updated_at ?? null;
  } catch {
    return null;
  }
}

/**
 * One person's payout details. `reveal=false` (default) redacts account numbers,
 * SWIFT codes, processor emails and phone — only the People reveal endpoint (which
 * audit-logs the access) should pass `reveal=true`.
 */
export async function getPeopleBanking(
  email: string,
  reveal: boolean,
): Promise<{ banking: PeopleBanking | null; error: string | null }> {
  const { row, error } = await getEmployeeIdRowByEmail(email);
  if (error) return { banking: null, error };
  if (!row) return { banking: null, error: null };
  const full = toBanking(row);
  full.bank_last_self_updated_at = await fetchBankSelfUpdatedAt(row.work_email ?? email);
  return { banking: reveal ? full : maskBanking(full), error: null };
}

/** Resolve every alias email for a person so payroll history matches whichever
 *  address the disbursement row was keyed on. */
async function aliasesFor(email: string): Promise<string[]> {
  const base = normEmail(email);
  const set = new Set<string>();
  if (base && isSafeEmail(base)) set.add(base);
  try {
    const { employee } = await getEmployeeMasterRecord(email);
    for (const a of [
      employee?.work_email,
      employee?.personal_email,
      employee?.alternate_work_email,
      employee?.alternate_work_email_2,
    ]) {
      const n = normEmail(a ?? '');
      if (n && isSafeEmail(n)) set.add(n);
    }
  } catch {
    /* fall back to the input email only */
  }
  return [...set];
}

/**
 * One person's payroll history from `disbursement_records` — regular weekly
 * cycles AND one-off special transfers, newest first. Mirrors the CEO assistant's
 * get_employee_pay query (alias-aware) but also returns kind/note/source_file so
 * the UI can flag special transfers.
 */
export async function getPeoplePayrollHistory(
  email: string,
  limit = 30,
): Promise<{ rows: PeoplePayrollRow[]; error: string | null }> {
  const aliases = await aliasesFor(email);
  if (aliases.length === 0) return { rows: [], error: null };

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { rows: [], error: 'Database is not reachable.' };

  const orFilter = aliases.map((a) => `recipient_email.ilike.${a}`).join(',');
  const { data, error } = await supabase
    .from('disbursement_records')
    .select(
      'source_file, kind, note, cycle_period_start, cycle_period_end, total_hours, regular_hours, ot_hours, amount_php, amount_usd, status, paid_amount_usd, paid_at',
    )
    .or(orFilter)
    .order('cycle_period_start', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };

  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };

  const rows: PeoplePayrollRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    source_file: (r.source_file as string | null) ?? null,
    kind: (r.kind as 'cycle' | 'special') ?? 'cycle',
    note: (r.note as string | null) ?? null,
    period_start: (r.cycle_period_start as string | null) ?? null,
    period_end: (r.cycle_period_end as string | null) ?? null,
    total_hours: num(r.total_hours),
    regular_hours: num(r.regular_hours),
    ot_hours: num(r.ot_hours),
    amount_php: num(r.amount_php),
    amount_usd: num(r.amount_usd),
    status: (r.status as string | null) ?? null,
    paid_amount_usd: num(r.paid_amount_usd),
    paid_at: (r.paid_at as string | null) ?? null,
  }));

  return { rows, error: null };
}
