import { createSupabaseServiceRoleClient } from './server';

// Persistence for locked-in orphanage pay (see references/create_orphanage_pay.sql).
// One row per (source_file, employee_email): the per-employee orphanage hours and
// pay the Payroll Wizard's Orphanage paste tool locked in for a pay period. This is
// the first-class record; the live working value also lives in the app_settings
// `payroll.wizard.additions.<source_file>` blob (orphanageAmounts).

const TABLE = 'orphanage_pay';

/** A single locked-in orphanage-pay row as exchanged with the client (camelCase). */
export interface OrphanagePayRow {
  /** The wizard row's email key — lower-cased on write for consistent lookups. */
  employeeEmail: string;
  employeeName?: string | null;
  payWeek?: string | null;
  hours: number;
  regHours: number;
  otHours: number;
  regularRatePhp: number | null;
  otRatePhp: number | null;
  amountPhp: number;
}

const finiteOrNull = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? n : null;
const finiteOrZero = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

/**
 * Upsert the locked-in orphanage rows for a pay period. ACCUMULATES — a person not
 * in this batch keeps their existing row; re-pasting a person overwrites theirs
 * (latest lock-in wins), matching how `orphanageAmounts` behaves in the wizard.
 */
export async function saveOrphanagePay(params: {
  sourceFile: string;
  rows: OrphanagePayRow[];
  actor: string | null;
}): Promise<{ saved: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { saved: 0, error: 'Supabase client unavailable' };
  if (params.rows.length === 0) return { saved: 0, error: null };

  const lockedAt = new Date().toISOString();
  const payload = params.rows.map((r) => ({
    source_file: params.sourceFile,
    employee_email: r.employeeEmail.trim().toLowerCase(),
    employee_name: r.employeeName ?? null,
    pay_week: r.payWeek ?? null,
    hours: finiteOrZero(r.hours),
    reg_hours: finiteOrZero(r.regHours),
    ot_hours: finiteOrZero(r.otHours),
    regular_rate_php: finiteOrNull(r.regularRatePhp),
    ot_rate_php: finiteOrNull(r.otRatePhp),
    amount_php: finiteOrZero(r.amountPhp),
    locked_by: params.actor,
    locked_at: lockedAt,
  }));

  const { error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'source_file,employee_email' });
  if (error) return { saved: 0, error: error.message };
  return { saved: payload.length, error: null };
}

/** Remove one locked-in orphanage row (when its amount is cleared in the wizard). */
export async function deleteOrphanagePay(
  sourceFile: string,
  employeeEmail: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('source_file', sourceFile)
    .eq('employee_email', employeeEmail.trim().toLowerCase());
  return { error: error ? error.message : null };
}

/** All locked-in orphanage rows for a pay period (raw snake_case DB rows). */
export async function listOrphanagePay(sourceFile: string): Promise<Record<string, unknown>[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase || !sourceFile) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('source_file', sourceFile)
    .order('employee_name', { ascending: true });
  if (error || !data) return [];
  return data as Record<string, unknown>[];
}
