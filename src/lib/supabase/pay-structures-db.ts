import { createSupabaseServiceRoleClient } from './server';
import {
  PAY_CURRENCIES,
  SALARY_PERIODS,
  resolvePayStructureWriteTargetId,
  type PayStructure,
  type PayStructureSlot,
  type PayCurrency,
  type SalaryPeriod,
} from '@/lib/payment-catalog/pay-structure';

// Persistence for Payment Catalog pay structures
// (see references/create_payment_catalog_pay_structures.sql). One row per
// department- or employee-scoped structure, each carrying a creator +
// timestamps so the UI can show who set what and update live across users.

const TABLE = 'payment_catalog_pay_structures';

type PayRow = {
  id: string;
  scope: 'department' | 'employee';
  department_key: string;
  employee_email: string | null;
  employee_name: string | null;
  regular_rate: number | string;
  ot_rate: number | string | null;
  currency: string;
  /** Absent until references/sql/alter/2026-10-02_salary_pay_basis.sql is applied. */
  pay_basis?: string | null;
  salary_period?: string | null;
  salary_amount?: number | string | null;
  created_by: string | null;
  created_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

function mapSalary(r: PayRow): Pick<PayStructure, 'payBasis' | 'salaryPeriod' | 'salaryAmount'> {
  // Before the migration the column is absent: leave the basis undefined (reads as hourly).
  if (r.pay_basis === undefined) return {};
  if (r.pay_basis !== 'salary') return { payBasis: 'hourly' };
  const period = (SALARY_PERIODS as readonly string[]).includes(r.salary_period ?? '')
    ? (r.salary_period as SalaryPeriod)
    : undefined;
  const amount = r.salary_amount == null ? undefined : Number(r.salary_amount);
  // A salary row whose figures cannot be read keeps `payBasis: 'salary'` with them missing —
  // `structureBasisClaim` turns that into a claim no history row can match, so the engines
  // refuse to price it instead of reading it as hourly.
  return {
    payBasis: 'salary',
    salaryPeriod: period,
    salaryAmount: amount != null && Number.isFinite(amount) ? amount : undefined,
  };
}

function mapRow(r: PayRow): PayStructure {
  return {
    ...mapSalary(r),
    id: r.id,
    scope: r.scope,
    departmentKey: r.department_key,
    employeeEmail: r.employee_email ?? undefined,
    employeeName: r.employee_name ?? undefined,
    regularRate: Number(r.regular_rate),
    otRate: r.ot_rate == null ? undefined : Number(r.ot_rate),
    // Read every supported currency, not just USD/PHP: COP structures exist
    // (add_cop_currency.sql) and hardcoding the pair silently re-denominated a
    // Colombian rate as pesos — which a Certificate of Engagement would then
    // print as ₱18,500/hr instead of COP 18,500.
    currency: ((PAY_CURRENCIES as readonly string[]).includes(r.currency)
      ? r.currency
      : 'PHP') as PayCurrency,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function listPayStructures(): Promise<{ structures: PayStructure[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  // A missing client must be an ERROR, not an empty catalog: every consumer
  // treats "no structures" as "nobody has a catalog rate" and silently falls
  // back to sheet rates — the exact drift the catalog exists to prevent.
  if (!supabase) return { structures: [], error: 'Supabase service-role client unavailable' };
  // Page through everything: a single select is capped by PostgREST max-rows
  // (commonly 1000), and with ascending order the NEWEST structures — the most
  // recently set rates — would be the ones silently dropped at the cap.
  const rows: PayRow[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) return { structures: [], error: error.message };
    rows.push(...((data ?? []) as PayRow[]));
    if (!data || data.length < SIZE) break;
  }
  return { structures: rows.map(mapRow), error: null };
}

/**
 * Every structure already sharing this one's DEPARTMENT, reduced to the fields
 * that identify a natural-key slot. Scoped to the department (an indexed column
 * — `payment_catalog_pay_structures_dept_idx`) because that's the leading column
 * of both unique indexes, so it's the smallest set that can possibly contain a
 * collision.
 *
 * Emails are compared in JS rather than with `.ilike()` on purpose: `_` and `%`
 * are LIKE wildcards, so an address like `a_b@x.com` would match `aXb@x.com` and
 * we could overwrite the WRONG person's pay rate. Paged because PostgREST caps
 * every read at 1000 rows (a big department could reach it).
 */
async function loadDeptSlots(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  departmentKey: string,
): Promise<{ slots: PayStructureSlot[]; error: string | null }> {
  const slots: PayStructureSlot[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, scope, department_key, employee_email')
      .eq('department_key', departmentKey)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) return { slots: [], error: error.message };
    const rows = (data ?? []) as Pick<PayRow, 'id' | 'scope' | 'department_key' | 'employee_email'>[];
    for (const r of rows) {
      slots.push({
        id: r.id,
        scope: r.scope,
        departmentKey: r.department_key,
        employeeEmail: r.employee_email ?? undefined,
      });
    }
    if (rows.length < SIZE) break;
  }
  return { slots, error: null };
}

/** True when the error is Postgres/PostgREST saying a column does not exist. */
export function isMissingColumnError(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /column .* does not exist|could not find the .* column/i.test(error.message ?? '')
  );
}

// Once the salary columns are seen they stay (a migration is never rolled back by the app), so
// only a POSITIVE answer is cached. A negative one is re-probed after a minute, so applying the
// migration needs no redeploy.
let salaryColumnsSeen = false;
let salaryProbeAt = 0;
let salaryProbeAnswer: boolean | null = null;

/**
 * Whether `payment_catalog_pay_structures` carries the salary columns yet
 * (references/sql/alter/2026-10-02_salary_pay_basis.sql). `null` = the probe itself failed —
 * callers then refuse a salary save and send an hourly one without the columns.
 */
export async function payStructuresSupportSalary(): Promise<boolean | null> {
  if (salaryColumnsSeen) return true;
  if (salaryProbeAnswer === false && Date.now() - salaryProbeAt < 60_000) return false;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const { error } = await supabase.from(TABLE).select('pay_basis').limit(1);
  salaryProbeAt = Date.now();
  if (!error) {
    salaryColumnsSeen = true;
    salaryProbeAnswer = true;
    return true;
  }
  if (isMissingColumnError(error)) {
    salaryProbeAnswer = false;
    return false;
  }
  return null;
}

export async function upsertPayStructure(
  s: PayStructure,
  actor: string,
): Promise<{ row: PayStructure | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase client unavailable' };

  // The salary columns go on the row only once the migration has landed: sending them before
  // then would fail EVERY save, hourly ones included. A salary save without them is refused.
  const salaryColumns = await payStructuresSupportSalary();
  const isSalary = s.payBasis === 'salary';
  if (isSalary && salaryColumns !== true) {
    return {
      row: null,
      error:
        salaryColumns === false
          ? 'Salaries are not set up yet — the salary migration has not been applied.'
          : 'Could not confirm salaries are set up. Try again.',
    };
  }

  // `id` is only a surrogate — the DB's real uniqueness is the natural key
  // (one department-scoped structure per department; one per department+email).
  // Callers without the structures list mint a fresh id every save (the Payroll
  // Wizard's "Set rate" fixer does), which made this "upsert" a plain INSERT and
  // raised a raw duplicate-key error for anyone who already had a structure.
  // Resolve the slot's current occupant first so the write UPDATES it instead.
  const { slots, error: slotErr } = await loadDeptSlots(supabase, s.departmentKey);
  // A failed lookup must NOT silently fall through to an insert that trips the
  // unique index with an unreadable Postgres message — report it plainly.
  if (slotErr) return { row: null, error: `Could not check existing pay structures: ${slotErr}` };
  const targetId = resolvePayStructureWriteTargetId(s, slots);

  // created_by/created_at are preserved on UPDATE by the touch trigger, so it's
  // safe to send `actor` as both creator and updater here.
  const payload = {
    id: targetId,
    scope: s.scope,
    department_key: s.departmentKey,
    employee_email: s.scope === 'employee' ? (s.employeeEmail ?? null) : null,
    employee_name: s.scope === 'employee' ? (s.employeeName ?? null) : null,
    // A salary row stores NO hourly rate: 0 and null, whatever the caller sent, so a reader that
    // never learned the salary basis prices ₱0 rather than a believable hourly figure.
    regular_rate: isSalary ? 0 : Number.isFinite(s.regularRate) ? s.regularRate : 0,
    ot_rate: isSalary ? null : s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : null,
    currency: s.currency === 'USD' ? 'USD' : 'PHP',
    // Once the columns exist they are ALWAYS written, so saving an hourly rate over a salary
    // row really clears the salary (the CHECK refuses an hourly row carrying salary figures).
    ...(salaryColumns === true
      ? {
          pay_basis: isSalary ? 'salary' : 'hourly',
          salary_period: isSalary ? (s.salaryPeriod ?? null) : null,
          salary_amount: isSalary && s.salaryAmount != null && Number.isFinite(s.salaryAmount) ? s.salaryAmount : null,
        }
      : {}),
    created_by: actor,
    updated_by: actor,
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'id' })
    .select('*')
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ? mapRow(data as PayRow) : null, error: null };
}

/** One structure by its surrogate id (null when it does not exist). */
export async function getPayStructureById(
  id: string,
): Promise<{ structure: PayStructure | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { structure: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) return { structure: null, error: error.message };
  return { structure: data ? mapRow(data as PayRow) : null, error: null };
}

export async function deletePayStructure(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return { error: error ? error.message : null };
}

/**
 * Every EMPLOYEE-scope structure a person holds, in ANY department — the input
 * to the fixer's complete override (`shadowEmployeeStructures`). Reads the
 * employee-scope rows paged and compares emails in JS after normalisation: a
 * `.ilike()` would treat `_` and `%` as wildcards on a write path
 * (bonus-catalog.md §5.6 rule 2).
 */
export async function listEmployeeStructuresForEmail(
  email: string,
): Promise<{ structures: PayStructure[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { structures: [], error: 'Supabase client unavailable' };
  const want = email.trim().toLowerCase();
  if (!want) return { structures: [], error: null };
  const rows: PayRow[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('scope', 'employee')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) return { structures: [], error: error.message };
    const page = (data ?? []) as PayRow[];
    for (const r of page) {
      if ((r.employee_email ?? '').trim().toLowerCase() === want) rows.push(r);
    }
    if (page.length < SIZE) break;
  }
  return { structures: rows.map(mapRow), error: null };
}

/** Delete several structures by id in one statement. No-op on an empty list. */
export async function deletePayStructures(ids: readonly string[]): Promise<{ error: string | null }> {
  if (ids.length === 0) return { error: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase.from(TABLE).delete().in('id', [...ids]);
  return { error: error ? error.message : null };
}
