import { createSupabaseServiceRoleClient } from './server';
import { insertAuditLog } from './audit-log';

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

/** Who is doing a destructive delete, for the audit snapshot. */
export type OrphanagePayActor = { email: string | null; role: string };

/**
 * Remove one locked-in orphanage row (when its amount is cleared in the wizard).
 * The row is snapshotted into `audit_log` BEFORE it goes — once deleted, that
 * entry is the only place the hours evidence survives (the same reason
 * `pab_dispute.admin_deleted` snapshots what it destroys). Fails CLOSED: if the
 * snapshot read errors, nothing is deleted.
 */
export async function deleteOrphanagePay(
  sourceFile: string,
  employeeEmail: string,
  actor?: OrphanagePayActor,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase client unavailable' };
  const email = employeeEmail.trim().toLowerCase();
  const { data: snapshot, error: readErr } = await supabase
    .from(TABLE)
    .select('*')
    .eq('source_file', sourceFile)
    .eq('employee_email', email)
    .maybeSingle();
  if (readErr) return { error: `Could not snapshot the row before deleting: ${readErr.message}` };
  if (!snapshot) return { error: null }; // nothing on file — the delete would be a no-op
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('source_file', sourceFile)
    .eq('employee_email', email);
  if (error) return { error: error.message };
  void insertAuditLog({
    user_name: actor?.email ?? 'system',
    user_role: actor?.role ?? 'accounting',
    action: 'orphanage_pay.record_deleted',
    resource: TABLE,
    resource_id: `${sourceFile}:${email}`,
    details: { source_file: sourceFile, row: snapshot },
  });
  return { error: null };
}

/**
 * Remove EVERY locked-in orphanage row for one pay period — the Payroll Wizard's
 * "Remove all", so a bad paste can be wiped and re-entered fresh instead of
 * leaving records behind to haunt the red panel and PAB coverage. Scoped
 * strictly to the given `source_file`; other weeks' rows are never touched.
 * The deleted rows are snapshotted into ONE `audit_log` entry BEFORE the
 * delete (paged read — never trust a single 1000-row page), and the read
 * failing REFUSES the delete: destroying rows we could not snapshot would
 * leave the hours unrecoverable.
 */
export async function deleteAllOrphanagePay(
  sourceFile: string,
  actor: OrphanagePayActor,
): Promise<{ deleted: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: 0, error: 'Supabase client unavailable' };
  if (!sourceFile) return { deleted: 0, error: 'source_file required' };

  const PAGE = 1000;
  const snapshot: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('source_file', sourceFile)
      // Stable order (the composite PK's second column) so pagination never
      // drops or duplicates a row in the audit snapshot.
      .order('employee_email', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { deleted: 0, error: `Could not snapshot rows before deleting: ${error.message}` };
    if (!data) break;
    snapshot.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (snapshot.length === 0) return { deleted: 0, error: null };

  const { error } = await supabase.from(TABLE).delete().eq('source_file', sourceFile);
  if (error) return { deleted: 0, error: error.message };

  void insertAuditLog({
    user_name: actor.email ?? 'system',
    user_role: actor.role,
    action: 'orphanage_pay.period_cleared',
    resource: TABLE,
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      deleted_count: snapshot.length,
      total_amount_php: snapshot.reduce((s, r) => s + Number(r.amount_php ?? 0), 0),
      rows: snapshot,
    },
  });
  return { deleted: snapshot.length, error: null };
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

/** A locked-in orphanage row reduced to what PAB-coverage mapping needs. */
export interface OrphanagePayHoursRow {
  source_file: string | null;
  employee_email: string;
  hours: number;
}

/**
 * Every locked-in orphanage row across ALL pay weeks — just the columns the
 * TEMPORARY orphanage → PAB coverage rule needs (source_file for the week +
 * email + hours). Used by the server eligibility paths (current-pay,
 * member-monthly-pay) to top up orphanage-excused days. Optionally scoped to a
 * set of emails (already lower-cased) for the per-employee dashboard path.
 * Paginated — orphanage_pay accumulates across every period.
 */
export async function listAllOrphanagePayHours(
  emails?: Iterable<string>,
): Promise<OrphanagePayHoursRow[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const emailFilter = emails ? Array.from(new Set([...emails].map((e) => e.trim().toLowerCase()).filter(Boolean))) : null;
  if (emailFilter && emailFilter.length === 0) return [];
  const PAGE = 1000;
  const out: OrphanagePayHoursRow[] = [];
  let from = 0;
  while (true) {
    let query = supabase
      .from(TABLE)
      .select('source_file, employee_email, hours')
      // Deterministic order across pages (the composite PK) so OFFSET pagination
      // never drops or duplicates a row once the table exceeds one page — a dropped
      // row would silently remove that person/week's orphanage hours from coverage.
      .order('source_file', { ascending: true })
      .order('employee_email', { ascending: true })
      .range(from, from + PAGE - 1);
    if (emailFilter) query = query.in('employee_email', emailFilter);
    const { data, error } = await query;
    if (error || !data) break;
    for (const r of data as Array<Record<string, unknown>>) {
      out.push({
        source_file: typeof r.source_file === 'string' ? r.source_file : null,
        employee_email: String(r.employee_email ?? ''),
        hours: Number(r.hours ?? 0),
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
