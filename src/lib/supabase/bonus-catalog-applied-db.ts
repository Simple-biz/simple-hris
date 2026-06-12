import { createSupabaseServiceRoleClient } from './server';

// Persistence for APPLIED catalog bonuses (see references/create_bonus_catalog_applied.sql).
// One row per (period_start, department, employee_email, bonus_id): a catalog
// bonus a manager applied to one employee for one pay-week. The Payroll Wizard
// sums `amount` per employee for the week; Bonus History reads the breakdown.

const TABLE = 'bonus_catalog_applied';

/** A single applied-bonus row as exchanged with the client. */
export interface AppliedBonusRow {
  id: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  department: string;
  employeeEmail: string;
  employeeName?: string | null;
  bonusId: string;
  bonusName: string;
  kind: 'flat' | 'formula';
  vars?: Record<string, number> | null;
  amount: number;
  appliedBy?: string | null;
}

type DbRow = {
  id: string;
  period_start: string;
  period_end: string;
  department: string;
  employee_email: string;
  employee_name: string | null;
  bonus_id: string;
  bonus_name: string;
  kind: 'flat' | 'formula';
  vars: Record<string, number> | null;
  amount: number | string | null;
  applied_by: string | null;
};

function mapRow(r: DbRow): AppliedBonusRow {
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    department: r.department,
    employeeEmail: r.employee_email,
    employeeName: r.employee_name,
    bonusId: r.bonus_id,
    bonusName: r.bonus_name,
    kind: r.kind,
    vars: r.vars ?? null,
    amount: r.amount == null ? 0 : Number(r.amount),
    appliedBy: r.applied_by,
  };
}

/** List applied rows, filtered by a single dept or a set of depts, for a period. */
export async function listApplied(opts: {
  dept?: string;
  depts?: string[];
  periodStart?: string;
}): Promise<AppliedBonusRow[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  let query = supabase.from(TABLE).select('*').order('employee_name', { ascending: true });
  if (opts.dept) query = query.eq('department', opts.dept);
  if (opts.depts && opts.depts.length > 0) query = query.in('department', opts.depts);
  if (opts.periodStart) query = query.eq('period_start', opts.periodStart);
  const { data, error } = await query;
  if (error || !data) return [];
  return data.map((r) => mapRow(r as DbRow));
}

/**
 * Replace the full set of applied rows for one (department, periodStart):
 * upsert the provided rows, then delete any rows for that dept+period that are
 * no longer present (so un-applying a bonus removes it). Returns the saved count.
 */
export async function saveDeptPeriodApplied(params: {
  department: string;
  periodStart: string;
  periodEnd: string;
  rows: AppliedBonusRow[];
  actor: string | null;
}): Promise<{ saved: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { saved: 0, error: 'Supabase client unavailable' };

  const payload = params.rows.map((r) => ({
    id: r.id,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    department: params.department,
    employee_email: r.employeeEmail,
    employee_name: r.employeeName ?? null,
    bonus_id: r.bonusId,
    bonus_name: r.bonusName,
    kind: r.kind,
    vars: r.vars ?? null,
    amount: Number.isFinite(r.amount) ? r.amount : 0,
    applied_by: params.actor,
  }));

  if (payload.length > 0) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'period_start,department,employee_email,bonus_id' });
    if (error) return { saved: 0, error: error.message };
  }

  // Delete rows for this dept+period that are not in the new keep-set.
  const keepIds = payload.map((p) => p.id);
  let del = supabase
    .from(TABLE)
    .delete()
    .eq('department', params.department)
    .eq('period_start', params.periodStart);
  if (keepIds.length > 0) {
    del = del.not('id', 'in', `(${keepIds.map((id) => `"${id}"`).join(',')})`);
  }
  const { error: delError } = await del;
  if (delError) return { saved: payload.length, error: delError.message };

  return { saved: payload.length, error: null };
}

/** Per-(department, period_start) rollup for Bonus History. */
export interface AppliedSummaryRow {
  department: string;
  period_start: string;
  period_end: string;
  employee_count: number;
  total_bonus: number;
}

export async function summarizeApplied(depts: string[]): Promise<AppliedSummaryRow[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase || depts.length === 0) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('department, period_start, period_end, employee_email, amount')
    .in('department', depts);
  if (error || !data) return [];

  // Aggregate in-process: group by (department, period_start).
  const map = new Map<
    string,
    { department: string; period_start: string; period_end: string; emails: Set<string>; total: number }
  >();
  for (const r of data as Array<{
    department: string;
    period_start: string;
    period_end: string;
    employee_email: string;
    amount: number | string | null;
  }>) {
    const key = `${r.department}::${r.period_start}`;
    let g = map.get(key);
    if (!g) {
      g = {
        department: r.department,
        period_start: r.period_start,
        period_end: r.period_end,
        emails: new Set(),
        total: 0,
      };
      map.set(key, g);
    }
    if (r.employee_email) g.emails.add(r.employee_email);
    g.total += r.amount == null ? 0 : Number(r.amount);
  }
  return Array.from(map.values())
    .map((g) => ({
      department: g.department,
      period_start: g.period_start,
      period_end: g.period_end,
      employee_count: g.emails.size,
      total_bonus: g.total,
    }))
    .sort((a, b) => (a.period_start < b.period_start ? 1 : a.period_start > b.period_start ? -1 : 0));
}

/** Remove a whole dept-week (Bonus History delete). */
export async function deleteAppliedPeriod(
  department: string,
  periodStart: string,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('department', department)
    .eq('period_start', periodStart);
  return { error: error ? error.message : null };
}
