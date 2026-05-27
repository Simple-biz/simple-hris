import { createSupabaseServiceRoleClient } from './server';
import { listManagersByDepartment } from './department-managers';

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type LeaveRequestRow = {
  id: string;
  employee_email: string;
  employee_name: string | null;
  department: string | null;
  start_date: string;
  end_date: string;
  leave_type: string;
  reason: string | null;
  status: LeaveRequestStatus;
  manager_email: string | null;
  created_at: string;
  updated_at: string;
  approver_email: string | null;
  approver_note: string | null;
};

function tableName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_LEAVE_REQUESTS_TABLE?.trim() || 'leave_requests';
}

export async function insertLeaveRequest(row: {
  employee_email: string;
  employee_name: string | null;
  department: string | null;
  start_date: string;
  end_date: string;
  leave_type: string;
  reason: string | null;
  manager_email: string | null;
}): Promise<{ id: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { id: null, error: 'Supabase not configured' };

  const email = row.employee_email.trim().toLowerCase();
  const { data, error } = await supabase
    .from(tableName())
    .insert({
      employee_email: email,
      employee_name: row.employee_name,
      department: row.department,
      start_date: row.start_date,
      end_date: row.end_date,
      leave_type: row.leave_type,
      reason: row.reason,
      manager_email: row.manager_email?.trim() || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

export async function listLeaveRequestsByEmployee(
  emailNorm: string,
): Promise<{ rows: LeaveRequestRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(tableName())
    .select('*')
    .ilike('employee_email', emailNorm)
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as LeaveRequestRow[];
  await enrichRowsWithMissingNames(rows);
  return { rows, error: error?.message ?? null };
}

export async function listAllLeaveRequests(limit = 200): Promise<{
  rows: LeaveRequestRow[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(tableName())
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as LeaveRequestRow[];
  await enrichRowsWithMissingNames(rows);
  return { rows, error: error?.message ?? null };
}

/**
 * Backfills `employee_name` (and `department` when missing) from `active_employees`
 * for any rows the client didn't resolve at submit time. Mutates `rows` in place;
 * single bulk lookup so a long pending queue doesn't fan out N round-trips.
 */
async function enrichRowsWithMissingNames(rows: LeaveRequestRow[]): Promise<void> {
  const missing = rows.filter((r) => !r.employee_name?.trim() || !r.department?.trim());
  if (missing.length === 0) return;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  const { data, error } = await supabase
    .from('active_employees')
    .select('"Name","Work Email","Personal Email","Department"')
    .range(0, 9999);
  if (error) return;
  const byEmail = new Map<string, { name: string | null; department: string | null }>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const we = String(row['Work Email'] ?? '').trim().toLowerCase();
    const pe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    const entry = {
      name: String(row['Name'] ?? '').trim() || null,
      department: String(row['Department'] ?? '').trim() || null,
    };
    if (we) byEmail.set(we, entry);
    if (pe && !byEmail.has(pe)) byEmail.set(pe, entry);
  }
  for (const r of missing) {
    const hit = byEmail.get(r.employee_email.trim().toLowerCase());
    if (!hit) continue;
    if (!r.employee_name?.trim() && hit.name) r.employee_name = hit.name;
    if (!r.department?.trim() && hit.department) r.department = hit.department;
  }
}

export async function updateLeaveRequestStatus(params: {
  id: string;
  status: LeaveRequestStatus;
  approver_email: string | null;
  approver_note: string | null;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase
    .from(tableName())
    .update({
      status: params.status,
      approver_email: params.approver_email,
      approver_note: params.approver_note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id);

  return { error: error?.message ?? null };
}

export async function cancelLeaveRequestIfOwned(params: {
  id: string;
  employee_email: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase
    .from(tableName())
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .ilike('employee_email', params.employee_email.trim().toLowerCase())
    .eq('status', 'pending');

  return { error: error?.message ?? null };
}

/**
 * Owner-initiated hard delete. Lets an employee permanently remove one of their OWN
 * leave requests once it is in a terminal, non-approved state (cancelled or rejected) so
 * they can tidy up their list. Pending requests must be cancelled first (PATCH cancel);
 * approved requests are left intact to preserve the manager's decision trail.
 *
 * Ownership + status are enforced in the query itself (matched id + email + status), so a
 * mismatched owner or a still-pending/approved row deletes nothing. Returns the row
 * snapshot when a row was actually removed so the API can audit-log it.
 */
export async function deleteLeaveRequestIfOwned(params: {
  id: string;
  employee_email: string;
}): Promise<{ row: LeaveRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from(tableName())
    .delete()
    .eq('id', params.id)
    .ilike('employee_email', params.employee_email.trim().toLowerCase())
    .in('status', ['cancelled', 'rejected'])
    .select('*')
    .maybeSingle();

  if (error) return { row: null, error: error.message };
  return { row: (data as LeaveRequestRow) ?? null, error: null };
}

/**
 * Roles allowed to PERMANENTLY DELETE a leave request (any status, regardless of who filed it).
 *
 *  - `admin` / `payroll_manager` — unrestricted, can delete any request in any department.
 *  - `manager` — scoped: can only delete requests for departments they actively manage
 *    (verified via `isAuthorizedLeaveApprover`, same mechanism used for approve/reject).
 *
 * The role list controls which users see the trash button in the UI; the API enforces
 * the per-row authorization.
 */
export const LEAVE_DELETE_ROLES: readonly string[] = [
  'payroll_manager',
  'admin',
  'manager',
];

/** Roles whose delete authority is unrestricted (no per-department check). */
export const LEAVE_DELETE_UNRESTRICTED_ROLES: readonly string[] = [
  'payroll_manager',
  'admin',
];

/**
 * Returns true if `actorEmail` is allowed to action (approve/reject/delete) the given
 * leave request based on per-department manager assignments. Mirrors the authorization
 * chain used by the PATCH approve/reject route:
 *   1. Listed in the row's stored `manager_email` (comma-joined).
 *   2. Currently active manager for the row's department (via department_managers).
 *   3. Listed in the legacy `leave_department_managers_json` map for the department.
 *   4. In `leave_accounting_notify_emails` or `leave_approver_emails` settings.
 *
 * Note: callers fetching app_settings should pass them in to avoid duplicate reads when
 * a route already has them. Each lookup short-circuits as soon as a match is found.
 */
export async function isAuthorizedLeaveApprover(params: {
  actorEmail: string;
  row: LeaveRequestRow;
  managersJson?: string | null;
  accountingNotify?: string | null;
  approverAllow?: string | null;
}): Promise<boolean> {
  const { row, managersJson, accountingNotify, approverAllow } = params;
  const a = (params.actorEmail ?? '').trim().toLowerCase();
  if (!a) return false;
  const dept = row.department?.trim() || null;

  // 1. Stored manager_email on the row
  const storedManagers = splitManagerEmails(row.manager_email);
  if (storedManagers.includes(a)) return true;

  // 2. Live department manager
  const liveManagers = await listManagersForDepartment(dept);
  if (liveManagers.includes(a)) return true;

  // 3. Legacy json map
  if (managersJson != null) {
    const jsonManagers = resolveManagerEmailsFromJson(dept, managersJson);
    if (jsonManagers.includes(a)) return true;
  }

  // 4. Accounting notify list
  if (accountingNotify) {
    const extra = accountingNotify
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (extra.includes(a)) return true;
  }

  // 5. Global approver allow list
  if (approverAllow) {
    const globalAllow = approverAllow
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (globalAllow.includes(a)) return true;
  }

  return false;
}

/**
 * Admin/payroll-manager-only hard delete. Works on any status. Caller is responsible
 * for verifying the session holds a role in LEAVE_DELETE_ROLES — this function does NOT
 * re-check authorization. Returns the deleted row's snapshot in `error: null` cases so
 * the API layer can include it in the audit log.
 */
export async function adminDeleteLeaveRequest(
  id: string,
): Promise<{ row: LeaveRequestRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { row, error: fetchErr } = await getLeaveRequestById(id);
  if (fetchErr) return { row: null, error: fetchErr };
  if (!row) return { row: null, error: 'Leave request not found' };

  const { error } = await supabase.from(tableName()).delete().eq('id', id);
  if (error) return { row: null, error: error.message };

  return { row, error: null };
}

export async function getLeaveRequestById(id: string): Promise<{
  row: LeaveRequestRow | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { row: null, error: 'Supabase not configured' };

  const { data, error } = await supabase.from(tableName()).select('*').eq('id', id).maybeSingle();

  return { row: (data as LeaveRequestRow) ?? null, error: error?.message ?? null };
}

/**
 * Legacy fallback: `leave_department_managers_json` in app_settings, e.g.
 * `{"Accounting":"mgr@co.com"}` or `{"Accounting":["a@co.com","b@co.com"]}`.
 * Returns every email that maps to a department whose key matches (case-insensitively or
 * via substring); de-duplicated.
 */
export function resolveManagerEmailsFromJson(
  department: string | null | undefined,
  managersJson: string | null | undefined,
): string[] {
  if (!department?.trim() || !managersJson?.trim()) return [];
  try {
    const map = JSON.parse(managersJson) as Record<string, string | string[]>;
    if (!map || typeof map !== 'object') return [];
    const d = department.trim().toLowerCase();
    const exact: string[] = [];
    const fuzzy: string[] = [];
    for (const [k, v] of Object.entries(map)) {
      const key = k.trim().toLowerCase();
      const list = Array.isArray(v) ? v : [v];
      const emails = list
        .map((s) => String(s ?? '').trim())
        .filter((s) => s.length > 0);
      if (!emails.length) continue;
      if (key === d) exact.push(...emails);
      else if (d.includes(key) || key.includes(d)) fuzzy.push(...emails);
    }
    const out = exact.length ? exact : fuzzy;
    return Array.from(new Set(out.map((s) => s.toLowerCase())));
  } catch {
    return [];
  }
}

/** Back-compat single-email helper. Returns the first match. */
export function resolveManagerEmail(
  department: string | null | undefined,
  managersJson: string | null | undefined,
): string | null {
  return resolveManagerEmailsFromJson(department, managersJson)[0] ?? null;
}

/**
 * Returns every email authorized to approve leave for `department`.
 *
 * Resolution order:
 *  1. Explicit assignments in `department_managers` — admins pick managers per department
 *     in the Roles & permissions tab. Honours multiple managers per dept.
 *  2. Fallback: employees with the `manager` role whose own department in
 *     `active_employees` matches. Keeps things working before any explicit assignment.
 */
export async function listManagersForDepartment(
  department: string | null | undefined,
): Promise<string[]> {
  const dept = department?.trim().toLowerCase();
  if (!dept) return [];

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];

  // Active manager-role emails — used as a gate for both explicit and fallback paths so
  // a revoked role can't keep approval power via a stale department assignment.
  const rolesRes = await supabase
    .from('employee_roles')
    .select('work_email')
    .eq('role', 'manager')
    .is('revoked_at', null);
  const activeManagerEmails = new Set(
    (rolesRes.data ?? [])
      .map((r) => String((r as { work_email?: string }).work_email ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  const explicit = await listManagersByDepartment(department);
  const explicitGated = explicit.filter((e) => activeManagerEmails.has(e));
  if (explicitGated.length > 0) return explicitGated;

  const empsRes = await supabase
    .from('active_employees')
    .select('"Work Email","Personal Email","Department"')
    .range(0, 9999);
  if (rolesRes.error || empsRes.error) return [];

  const out = new Set<string>();
  for (const row of (empsRes.data ?? []) as Array<Record<string, unknown>>) {
    const rowDept = String(row['Department'] ?? '').trim().toLowerCase();
    if (!rowDept || rowDept !== dept) continue;
    const we = String(row['Work Email'] ?? '').trim().toLowerCase();
    const pe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    if (we && activeManagerEmails.has(we)) out.add(we);
    if (pe && activeManagerEmails.has(pe)) out.add(pe);
  }
  return Array.from(out);
}

/**
 * Looks up an employee's display name + department in `active_employees` by either
 * Work Email or Personal Email (case-insensitive). Returns nulls when nothing matches.
 * Used by the leave-request route to backfill `employee_name` when the client didn't
 * resolve it (e.g. master-list lookup raced submit, or email-drift between login and
 * the master list).
 */
export async function lookupEmployeeNameAndDepartment(
  email: string | null | undefined,
): Promise<{ name: string | null; department: string | null }> {
  const target = email?.trim().toLowerCase();
  if (!target) return { name: null, department: null };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { name: null, department: null };

  const { data, error } = await supabase
    .from('active_employees')
    .select('"Name","Work Email","Personal Email","Department"')
    .range(0, 9999);
  if (error) return { name: null, department: null };

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const we = String(row['Work Email'] ?? '').trim().toLowerCase();
    const pe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    if (we === target || pe === target) {
      const name = String(row['Name'] ?? '').trim() || null;
      const department = String(row['Department'] ?? '').trim() || null;
      return { name, department };
    }
  }
  return { name: null, department: null };
}

/** Splits a comma-/semicolon-separated list of emails to a normalized lowercase array. */
export function splitManagerEmails(value: string | null | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/[,;\n]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}
