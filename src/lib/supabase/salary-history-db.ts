import { createSupabaseServiceRoleClient } from './server';
import type { PayCurrency, SalaryPeriod } from '@/lib/payment-catalog/pay-structure';
import type { SalaryHistoryState } from '@/lib/payroll/salary-basis';

// Persistence for `employee_salary_history` (references/sql/alter/2026-10-02_salary_pay_basis.sql):
// the dated, person-keyed pay-basis timeline both pay engines resolve a salaried week from
// (docs/features/salaried-pay-basis.md). Server-only: the table is service-role only.

const TABLE = 'employee_salary_history';
const COLUMNS = 'employee_email, effective_from, pay_basis, salary_period, salary_amount, currency, created_at';

export type RawSalaryHistoryRow = {
  employee_email: string;
  effective_from: string;
  pay_basis: string;
  salary_period: string | null;
  salary_amount: number | string | null;
  currency: string;
  created_at: string | null;
};

/** True when PostgREST/Postgres says the table does not exist (migration not applied). */
function isMissingTableError(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /relation .* does not exist|could not find the table/i.test(error.message ?? '')
  );
}

/**
 * Every history row, paged (PostgREST caps a read at 1000 rows even with `.range()` — never a
 * single select). `state` is never guessed: a missing table is `not_configured` (nobody can be
 * salaried yet), any other failure is `unavailable` (the engines then HOLD every salaried
 * person rather than price them hourly).
 */
export async function listAllSalaryHistory(): Promise<{
  rows: RawSalaryHistoryRow[];
  state: SalaryHistoryState;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], state: 'unavailable', error: 'Supabase service-role client unavailable' };
  const rows: RawSalaryHistoryRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .order('effective_from', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTableError(error)) return { rows: [], state: 'not_configured', error: null };
      return { rows: [], state: 'unavailable', error: error.message };
    }
    const page = (data ?? []) as RawSalaryHistoryRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, state: 'loaded', error: null };
}

/** One person's rows, newest first — exact match on the stored (lower-cased) email; never
 *  `.ilike()`, whose `_`/`%` wildcards could read another person's salary on a write path. */
export async function listSalaryHistoryForEmail(email: string): Promise<{
  rows: RawSalaryHistoryRow[];
  state: SalaryHistoryState;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], state: 'unavailable', error: 'Supabase service-role client unavailable' };
  const want = email.trim().toLowerCase();
  if (!want) return { rows: [], state: 'loaded', error: null };
  const rows: RawSalaryHistoryRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('employee_email', want)
      .order('effective_from', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTableError(error)) return { rows: [], state: 'not_configured', error: null };
      return { rows: [], state: 'unavailable', error: error.message };
    }
    const page = (data ?? []) as RawSalaryHistoryRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, state: 'loaded', error: null };
}

/** What a save decides to write — before the structure id and actor are known. */
export type SalaryHistoryWriteFields = {
  email: string;
  /** YYYY-MM-DD; the route only ever sends a pay-week Sunday. */
  effectiveIso: string;
  /** "today" in the same local calendar the route uses, for the supersede clause. */
  todayIso: string;
  note: string;
} & (
  | { basis: 'hourly' }
  | { basis: 'salary'; period: SalaryPeriod; amount: number; currency: PayCurrency }
);

export type SalaryHistoryWrite = SalaryHistoryWriteFields & {
  structureId: string | null;
  actor: string;
};

/**
 * Supersede, then insert — the same clause `syncRateHistory` uses for a Payment Catalog save:
 * clear the person's still-pending future rows (`effective_from >= today`) and any row on the
 * SAME effective date, so a re-save replaces instead of stacking. Both steps report their
 * error; the caller awaits this, because a salary saved to the catalog with no dated row is a
 * week the engines will refuse to price.
 */
export async function writeSalaryHistoryRow(w: SalaryHistoryWrite): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const email = w.email.trim().toLowerCase();
  if (!email) return { error: 'No email to file the salary under' };
  const { error: delErr } = await supabase
    .from(TABLE)
    .delete()
    .eq('employee_email', email)
    .or(`effective_from.gte.${w.todayIso},effective_from.eq.${w.effectiveIso}`);
  if (delErr) return { error: `Could not supersede the salary history: ${delErr.message}` };
  const { error } = await supabase.from(TABLE).insert({
    employee_email: email,
    effective_from: w.effectiveIso,
    pay_basis: w.basis,
    salary_period: w.basis === 'salary' ? w.period : null,
    salary_amount: w.basis === 'salary' ? w.amount : null,
    currency: w.basis === 'salary' ? w.currency : 'PHP',
    structure_id: w.structureId,
    note: w.note,
    created_by: w.actor,
  });
  if (error) return { error: `Could not write the salary history row: ${error.message}` };
  return { error: null };
}
