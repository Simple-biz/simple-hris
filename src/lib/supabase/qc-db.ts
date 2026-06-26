import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from './employees';
import { listDepartmentsForManager } from './department-managers';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { QC_DEPT_KEYS, type QcDeptKey } from '@/lib/qc/constants';
import type { AppliedBonusRow } from './bonus-catalog-applied-db';

export { QC_DEPT_KEYS };
export type { QcDeptKey };

/**
 * QC (Quality Control) data layer.
 *
 * QC officers do a FIRST-PASS KPI scoring of Leadgen / Callback / Discovery in
 * the same calculator the manager uses, then lock it in for the department's
 * real manager to review + finalize. QC scores are STAGED in `qc_kpi_submissions`
 * — the Payroll Wizard never reads them; the manager promotes reviewed values
 * into `bonus_catalog_applied` through the existing flow (no double-count).
 *
 * The combined Leadgen+Callback+Discovery roster is auto-split evenly across the
 * active QC officers (one member → one officer per week). See
 * {@link ensureQcAssignmentsForPeriod}.
 */

const QC_DEPT_SET = new Set<string>(QC_DEPT_KEYS);

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Canonical member identity — personal-first, mirroring the calculator's
 *  `rowEmail` so assignments, submissions, and the manager prefill all key off
 *  the same email. */
function memberEmail(r: EmployeeRow): string {
  return norm(r.personal_email) || norm(r.work_email);
}

/** Parse a master-list start date — handles `YYYY-MM-DD`, US `M/D/YY[YY]`, and a
 *  loose `Date` fallback. Local midnight, date-only. Null when missing/unparseable. */
function parseStartDate(s: string | null | undefined): Date | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(y, Number(m[1]) - 1, Number(m[2]));
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The Sunday (period_start Monday + 6 days) of a `YYYY-MM-DD` pay-week start. */
function weekEndDate(periodStart: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(periodStart);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 6);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type QcRosterStatus = 'active' | 'transferred' | 'removed';

export interface QcAssignmentRow {
  qc_officer_email: string;
  member_email: string;
  member_name: string | null;
  department: string;
  /** 'active' = still in this dept; 'transferred' = moved to current_department;
   *  'removed' = gone from the master list. Kept either way (sticky snapshot). */
  roster_status: QcRosterStatus;
  current_department: string | null;
}

interface QcAssignmentDbRow extends QcAssignmentRow {
  id: string;
  period_start: string;
  generated: boolean;
  assigned_at: string;
}

export interface QcOfficer {
  email: string;
  index: number; // 1-based "QC Officer N", stable by assignment order
  memberCount: number;
}

/** Per-department roster size + the equal per-officer share, for the QC Overview. */
export interface QcDeptTotal {
  department: string;
  total: number;       // active members in this dept this week
  perOfficer: number;  // ceil(total / officerCount)
}

export interface QcOfficerLockRow {
  qc_officer_email: string;
  status: 'draft' | 'locked';
  member_count: number;
  locked_at: string | null;
  locked_by: string | null;
}

export type QcSubmissionDbRow = {
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
  scored_by: string | null;
};

export interface QcReviewStatusRow {
  period_start: string;
  department: string;
  status: 'pending' | 'accepted' | 'returned';
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
}

// ── Officers + roster ───────────────────────────────────────────────────────

/** Active QC-role holders, ordered by assignment date → the "Officer 1, 2, …"
 *  order. Lowercased + de-duplicated. */
export async function listActiveQcOfficers(): Promise<string[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('employee_roles')
    .select('work_email, assigned_at')
    .eq('role', 'qc')
    .is('revoked_at', null)
    .order('assigned_at', { ascending: true });
  if (error || !data) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of data as Array<{ work_email: string }>) {
    const e = norm(r.work_email);
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/** The QC dept keys (lead_gen/callback/discovery) a manager is assigned to —
 *  used to scope what a manager may read/review. Empty = manages none of them. */
export async function listManagedQcDepts(email: string | null | undefined): Promise<string[]> {
  const { rows } = await listDepartmentsForManager(email);
  const keys = new Set<string>();
  for (const r of rows) {
    const k = normalizeDeptToKey(r.department);
    if (k && QC_DEPT_SET.has(k)) keys.add(k);
  }
  return [...keys];
}

/** Active employees in the three QC departments, full EmployeeRow shape. */
export async function getQcRosterMembers(): Promise<EmployeeRow[]> {
  const { employees } = await getEmployeesForAuthorizedServerRoute();
  return employees.filter((e) => {
    const k = normalizeDeptToKey(e.department);
    return !!k && QC_DEPT_SET.has(k);
  });
}

// ── Equal-split assignment (auto, reconciled) ─────────────────────────────────

function toAssignmentRow(r: QcAssignmentDbRow): QcAssignmentRow {
  return {
    qc_officer_email: r.qc_officer_email,
    member_email: r.member_email,
    member_name: r.member_name,
    department: r.department,
    roster_status: (r.roster_status ?? 'active') as QcRosterStatus,
    current_department: r.current_department ?? null,
  };
}

function slotKey(email: string, dept: string): string {
  return `${email}|${dept}`;
}

/**
 * Ensure `qc_score_assignments` reflects a PER-DEPARTMENT equal split of the
 * Leadgen / Callback / Discovery rosters across the active QC officers for a
 * week. A "slot" is one (member, department) pair — so a person who holds master
 * rows in two QC departments (e.g. mid-transfer) produces two slots and can be
 * scored in both.
 *
 * STICKY SNAPSHOT: once a slot exists for a week it is NEVER deleted — if the
 * member later leaves that department (transfer) or the master list (offboard),
 * the row is kept and flagged (`roster_status` = transferred/removed,
 * `current_department` = where they are now). This is the "memory" so their
 * Leadgen score & bonus for the week stand even after they move.
 *
 * Split: each department's live slots are round-robin'd across officers (counts
 * differ by at most 1 per dept). On the first build or when the officer SET
 * changes, the whole week is re-split; otherwise existing officer attributions
 * are kept and only new slots are balance-assigned. Writes ONLY the diff (and
 * never deletes), so a no-op read doesn't churn Realtime.
 *
 * ⚠️ REQUIRES migration #89 (references/sql/migrate/2026-06-26_qc_transfer_memory.sql):
 * the upsert writes `roster_status` / `current_department` and conflicts on
 * (period_start, member_email, department). Until #89 runs (after #88) this
 * throws "column does not exist" / "no unique constraint", surfaced as a 500 by
 * /api/qc/assignments. Run #88 then #89 before the QC dashboard is used.
 */
export async function ensureQcAssignmentsForPeriod(periodStart: string): Promise<{
  officers: string[];
  rows: QcAssignmentRow[];
  error: string | null;
}> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { officers: [], rows: [], error: 'Supabase not configured' };

  const officers = await listActiveQcOfficers();

  const { data: existingData, error: readErr } = await sb
    .from('qc_score_assignments')
    .select('*')
    .eq('period_start', periodStart);
  if (readErr) return { officers, rows: [], error: readErr.message };
  const existing = (existingData ?? []) as QcAssignmentDbRow[];

  // No officers → nothing to (re)assign. Surface whatever exists (possibly stale).
  if (officers.length === 0) {
    return { officers, rows: existing.map(toAssignmentRow), error: null };
  }

  // Live slots: one per (member, QC-dept) from the master list. A person with
  // rows in two QC depts appears twice (two slots). Anyone whose employment
  // START DATE is after this scoring week is excluded — they hadn't joined yet,
  // so scoring them for this period makes no sense. Unknown/unparseable start
  // dates are kept (we can't prove they hadn't started).
  const roster = await getQcRosterMembers();
  const periodEnd = weekEndDate(periodStart);
  const eligibleRoster = periodEnd
    ? roster.filter((r) => {
        const sd = parseStartDate(r.start_date);
        return !sd || sd.getTime() <= periodEnd.getTime();
      })
    : roster;
  const liveSlots: Array<{ email: string; dept: string; name: string | null }> = [];
  const liveSlotSet = new Set<string>();
  const liveDeptsByEmail = new Map<string, string[]>();
  const nameBySlot = new Map<string, string | null>();
  for (const r of eligibleRoster) {
    const email = memberEmail(r);
    const dept = normalizeDeptToKey(r.department);
    if (!email || !dept || !QC_DEPT_SET.has(dept)) continue;
    const key = slotKey(email, dept);
    if (liveSlotSet.has(key)) continue;
    liveSlotSet.add(key);
    liveSlots.push({ email, dept, name: r.name ?? null });
    nameBySlot.set(key, r.name ?? null);
    const arr = liveDeptsByEmail.get(email) ?? [];
    arr.push(dept);
    liveDeptsByEmail.set(email, arr);
  }

  const activeOfficerSet = new Set(officers);
  const existingOfficerSet = new Set(existing.map((r) => norm(r.qc_officer_email)));
  const officerSetChanged =
    existing.length > 0 &&
    (existingOfficerSet.size !== activeOfficerSet.size ||
      [...activeOfficerSet].some((o) => !existingOfficerSet.has(o)) ||
      [...existingOfficerSet].some((o) => !activeOfficerSet.has(o)));
  const regen = existing.length === 0 || officerSetChanged;

  // officerForSlot: slotKey -> officer. Seed from existing (keep attribution)
  // unless we're regenerating the whole week.
  const officerForSlot = new Map<string, string>();
  if (!regen) {
    for (const r of existing) {
      const o = norm(r.qc_officer_email);
      if (activeOfficerSet.has(o)) officerForSlot.set(slotKey(norm(r.member_email), r.department), o);
    }
  }

  // PER-DEPARTMENT equal split of the live slots.
  const slotsByDept = new Map<string, Array<{ email: string; dept: string }>>();
  for (const s of liveSlots) {
    const a = slotsByDept.get(s.dept) ?? [];
    a.push({ email: s.email, dept: s.dept });
    slotsByDept.set(s.dept, a);
  }
  for (const [dept, slots] of slotsByDept) {
    const sorted = [...slots].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    if (regen) {
      sorted.forEach((s, i) => officerForSlot.set(slotKey(s.email, dept), officers[i % officers.length]!));
    } else {
      // balance new slots within this dept against the kept attributions
      const load = new Map<string, number>(officers.map((o) => [o, 0]));
      for (const [k, o] of officerForSlot) if (k.endsWith(`|${dept}`)) load.set(o, (load.get(o) ?? 0) + 1);
      for (const s of sorted) {
        const key = slotKey(s.email, dept);
        if (officerForSlot.has(key)) continue;
        let best = officers[0]!;
        for (const o of officers) if ((load.get(o) ?? 0) < (load.get(best) ?? 0)) best = o;
        officerForSlot.set(key, best);
        load.set(best, (load.get(best) ?? 0) + 1);
      }
    }
  }

  // Departed existing slots (no longer live) — keep them (sticky). Make sure
  // they're owned by an active officer so nothing is orphaned.
  for (const r of existing) {
    const key = slotKey(norm(r.member_email), r.department);
    if (liveSlotSet.has(key)) continue;
    let officer = norm(r.qc_officer_email);
    if (regen || !activeOfficerSet.has(officer)) {
      // Balance WITHIN this slot's department (matches the live-slot split),
      // not across all departments, so a dept stays evenly distributed.
      const load = new Map<string, number>(officers.map((o) => [o, 0]));
      for (const [k, o] of officerForSlot) if (k.endsWith(`|${r.department}`)) load.set(o, (load.get(o) ?? 0) + 1);
      let best = officers[0]!;
      for (const o of officers) if ((load.get(o) ?? 0) < (load.get(best) ?? 0)) best = o;
      officer = best;
    }
    officerForSlot.set(key, officer);
  }

  // Build desired rows for every slot, with lifecycle status.
  const existingByKey = new Map(existing.map((r) => [slotKey(norm(r.member_email), r.department), r]));
  const desiredRows = [...officerForSlot.entries()].map(([key, officer]) => {
    const sep = key.lastIndexOf('|');
    const email = key.slice(0, sep);
    const dept = key.slice(sep + 1);
    const isLive = liveSlotSet.has(key);
    let status: QcRosterStatus = 'active';
    let current: string | null = dept;
    if (!isLive) {
      const liveDepts = liveDeptsByEmail.get(email) ?? [];
      if (liveDepts.length > 0) {
        status = 'transferred';
        current = liveDepts[0]!;
      } else {
        status = 'removed';
        current = null;
      }
    }
    const name = nameBySlot.get(key) ?? existingByKey.get(key)?.member_name ?? email;
    return { key, officer, email, dept, name, status, current };
  });

  // Upsert new/changed rows only. NEVER delete (sticky memory).
  const toUpsert: Array<Record<string, unknown>> = [];
  for (const d of desiredRows) {
    const ex = existingByKey.get(d.key);
    const changed =
      !ex ||
      norm(ex.qc_officer_email) !== d.officer ||
      (ex.roster_status ?? 'active') !== d.status ||
      (ex.current_department ?? null) !== d.current ||
      (ex.member_name ?? null) !== (d.name ?? null);
    if (!changed) continue;
    toUpsert.push({
      period_start: periodStart,
      qc_officer_email: d.officer,
      member_email: d.email,
      member_name: d.name,
      department: d.dept,
      roster_status: d.status,
      current_department: d.current,
      generated: true,
    });
  }
  if (toUpsert.length > 0) {
    const { error } = await sb
      .from('qc_score_assignments')
      .upsert(toUpsert, { onConflict: 'period_start,member_email,department' });
    if (error) return { officers, rows: [], error: error.message };
  }

  const rows: QcAssignmentRow[] = desiredRows.map((d) => ({
    qc_officer_email: d.officer,
    member_email: d.email,
    member_name: d.name,
    department: d.dept,
    roster_status: d.status,
    current_department: d.current,
  }));
  return { officers, rows, error: null };
}

/** Per-department totals + equal per-officer share, for the QC Overview. Counts
 *  only `active` slots (current members of each dept this week). */
export function computeDeptTotals(rows: QcAssignmentRow[], officerCount: number): QcDeptTotal[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.roster_status !== 'active') continue;
    totals.set(r.department, (totals.get(r.department) ?? 0) + 1);
  }
  return QC_DEPT_KEYS.map((dept) => {
    const total = totals.get(dept) ?? 0;
    return { department: dept, total, perOfficer: officerCount > 0 ? Math.ceil(total / officerCount) : 0 };
  });
}

/** Plain read of assignments for a week (no compute). */
export async function listQcAssignments(periodStart: string): Promise<QcAssignmentRow[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data } = await sb.from('qc_score_assignments').select('*').eq('period_start', periodStart);
  return ((data ?? []) as QcAssignmentDbRow[]).map(toAssignmentRow);
}

/** Officer summary (1-based index + active member/slot count) for a week.
 *  Counts only `active` slots so a transferred/removed person no longer inflates
 *  the officer's current workload. */
export function summarizeOfficers(officers: string[], rows: QcAssignmentRow[]): QcOfficer[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.roster_status !== 'active') continue;
    const o = norm(r.qc_officer_email);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  return officers.map((email, i) => ({ email, index: i + 1, memberCount: counts.get(email) ?? 0 }));
}

// ── Submissions (staged scores) ───────────────────────────────────────────────

const SUBMISSIONS = 'qc_kpi_submissions';

export async function listQcSubmissions(opts: {
  dept?: string;
  depts?: string[];
  periodStart?: string;
  scoredBy?: string;
}): Promise<QcSubmissionDbRow[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  let q = sb.from(SUBMISSIONS).select('*').order('employee_name', { ascending: true });
  if (opts.dept) q = q.eq('department', opts.dept);
  if (opts.depts && opts.depts.length > 0) q = q.in('department', opts.depts);
  if (opts.periodStart) q = q.eq('period_start', opts.periodStart);
  if (opts.scoredBy) q = q.ilike('scored_by', norm(opts.scoredBy));
  const { data, error } = await q;
  if (error || !data) return [];
  return data as QcSubmissionDbRow[];
}

/**
 * Replace a QC officer's OWN staged rows for a (department, period). Upserts the
 * provided rows, then deletes only this officer's leftover rows for that
 * dept-week (scoped by `scored_by`) so un-applying a bonus removes it — WITHOUT
 * touching another officer's members in the same department.
 */
export async function saveQcSubmissions(params: {
  department: string;
  periodStart: string;
  periodEnd: string;
  rows: AppliedBonusRow[];
  scoredBy: string;
}): Promise<{ saved: number; error: string | null }> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { saved: 0, error: 'Supabase not configured' };
  const scoredBy = norm(params.scoredBy);

  const payload = params.rows.map((r) => ({
    id: r.id,
    period_start: params.periodStart,
    period_end: params.periodEnd,
    department: params.department,
    employee_email: norm(r.employeeEmail),
    employee_name: r.employeeName ?? null,
    bonus_id: r.bonusId,
    bonus_name: r.bonusName,
    kind: r.kind,
    vars: r.vars ?? null,
    amount: Number.isFinite(r.amount) ? r.amount : 0,
    scored_by: scoredBy,
  }));

  if (payload.length > 0) {
    const { error } = await sb
      .from(SUBMISSIONS)
      .upsert(payload, { onConflict: 'period_start,department,employee_email,bonus_id' });
    if (error) return { saved: 0, error: error.message };
  }

  // Remove this officer's leftover rows for the dept-week (bonuses they
  // un-applied) without touching another officer's members. Fetch the officer's
  // existing ids and delete the ones not in the keep-set via a parameterized
  // .in() — no string-built NOT IN, so no injection surface from row ids.
  const keep = new Set(payload.map((p) => p.id));
  const { data: existing } = await sb
    .from(SUBMISSIONS)
    .select('id')
    .eq('department', params.department)
    .eq('period_start', params.periodStart)
    .ilike('scored_by', scoredBy);
  const toDelete = ((existing ?? []) as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id) => !keep.has(id));
  if (toDelete.length > 0) {
    const { error: delErr } = await sb.from(SUBMISSIONS).delete().in('id', toDelete);
    if (delErr) return { saved: payload.length, error: delErr.message };
  }

  return { saved: payload.length, error: null };
}

// ── Officer locks ─────────────────────────────────────────────────────────────

export async function listQcOfficerLocks(periodStart: string): Promise<QcOfficerLockRow[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('qc_officer_locks')
    .select('qc_officer_email, status, member_count, locked_at, locked_by')
    .eq('period_start', periodStart);
  if (error || !data) return [];
  return data as QcOfficerLockRow[];
}

export async function setQcOfficerLock(params: {
  periodStart: string;
  officerEmail: string;
  status: 'draft' | 'locked';
  memberCount: number;
}): Promise<{ error: string | null }> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { error: 'Supabase not configured' };
  const officer = norm(params.officerEmail);
  const row = {
    period_start: params.periodStart,
    qc_officer_email: officer,
    status: params.status,
    member_count: params.memberCount,
    locked_at: params.status === 'locked' ? new Date().toISOString() : null,
    locked_by: params.status === 'locked' ? officer : null,
  };
  const { error } = await sb
    .from('qc_officer_locks')
    .upsert(row, { onConflict: 'period_start,qc_officer_email' });
  return { error: error?.message ?? null };
}

// ── Manager review status ─────────────────────────────────────────────────────

export async function listQcReviewStatus(periodStart: string): Promise<QcReviewStatusRow[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('qc_review_status')
    .select('period_start, department, status, reviewed_by, reviewed_at, note')
    .eq('period_start', periodStart);
  if (error || !data) return [];
  return data as QcReviewStatusRow[];
}

export async function setQcReviewStatus(params: {
  periodStart: string;
  department: string;
  status: 'pending' | 'accepted' | 'returned';
  reviewedBy: string | null;
  note?: string | null;
}): Promise<{ error: string | null }> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { error: 'Supabase not configured' };
  const row = {
    period_start: params.periodStart,
    department: params.department,
    status: params.status,
    reviewed_by: params.reviewedBy,
    reviewed_at: params.status === 'pending' ? null : new Date().toISOString(),
    note: params.note ?? null,
  };
  const { error } = await sb
    .from('qc_review_status')
    .upsert(row, { onConflict: 'period_start,department' });
  return { error: error?.message ?? null };
}
