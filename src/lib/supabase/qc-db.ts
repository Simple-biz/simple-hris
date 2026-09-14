import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from './employees';
import { listDepartmentsForManager } from './department-managers';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { QC_DEPT_KEYS, isQcDeptKey, type QcDeptKey } from '@/lib/qc/constants';
import {
  officersFromRoster,
  freezeOfficers,
  currentDeptByEmail,
  classifySlot,
} from '@/lib/qc/officers';
import { dealDeptSlots, leastLoadedOfficer } from '@/lib/qc/deal';
import { qcSlotsAsOfWeek, type AsOfWeekCandidate, type AsOfWeekTransfer } from '@/lib/qc/roster-as-of-week';
import { sanitizeOffboardDay } from '@/lib/roster/offboard-date-sanity';
import { fetchDepartmentTransferRows } from '@/lib/payroll/hsl-transfer-effective';
import type { AppliedBonusRow } from './bonus-catalog-applied-db';

/** A candidate plus the start date the caller gates on (the pure module
 *  deliberately does not know about employment start). */
type QcWeekCandidate = AsOfWeekCandidate & { startDate: string | null };

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

/** The last day (Saturday) of the Sunday-anchored pay week starting `periodStart`. */
function weekEndDate(periodStart: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(periodStart);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 6);
}

/** The week's last day as `YYYY-MM-DD` (Saturday), or null. */
function weekEndDay(periodStart: string): string | null {
  const d = weekEndDate(periodStart);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * People who left on or after `weekStart` — invisible to the active roster, and
 * exactly the ones Carla has been adding by hand ("same as if they were
 * offboarded, we just have to add them externally", 2026-09-14).
 *
 * Bounded at the query: only stamps from the scored week onward are read, so
 * the long-departed are never a candidate in the first place. The stamp is then
 * put through `sanitizeOffboardDay`, because `off >= weekStart` is precisely the
 * comparison a future-dated typo defeats — franm@'s `2027-04-20` rode every
 * window in the pipeline for months on exactly this shape of test.
 *
 * Returns `null` on a read failure, never `[]`: an empty list is indistinguishable
 * from "nobody left", and silently dealing without the leavers is the bug this
 * exists to fix.
 */
async function listOffboardedSince(weekStart: string): Promise<QcWeekCandidate[] | null> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('global_master_list')
      .select('"Name","Work Email","Personal Email","Department","Start Date","Alternate Work Email","Alternate Work Email 2",off_boarded_at')
      .not('off_boarded_at', 'is', null)
      .gte('off_boarded_at', weekStart)
      .range(from, from + 999);
    if (error) return null;
    const page = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const out: QcWeekCandidate[] = [];
  for (const r of rows) {
    const str = (k: string) => {
      const v = r[k];
      return typeof v === 'string' ? v : null;
    };
    const off = sanitizeOffboardDay(str('off_boarded_at'));
    if (!off) continue; // no usable stamp — no evidence they were here that week
    const personal = norm(str('Personal Email'));
    const work = norm(str('Work Email'));
    const email = personal || work;
    if (!email) continue;
    out.push({
      email,
      identityEmails: [personal, work, norm(str('Alternate Work Email')), norm(str('Alternate Work Email 2'))].filter(Boolean),
      name: str('Name'),
      departmentKey: normalizeDeptToKey(str('Department')),
      offBoardedAt: off,
      startDate: str('Start Date'),
    });
  }
  return out;
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
  /** The officer's full name from the master list, when resolvable from their
   *  work/personal email; null when no roster row matches. The rail shows the
   *  first name (falling back to "QC Officer N" when null). */
  name: string | null;
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

/**
 * Active QC officers — **the people in the QC department**, not holders of an admin
 * grant.
 *
 * Changed 2026-09-14 (Kane: *"I dont want the admin provisions to be the source of the
 * QC Pickers I just want the people under the QC Department to assist the LEADGEN
 * manager in scoring their KPI's"*). The old source was `employee_roles.role='qc'`, and
 * it had drifted: measured that day the grant held 10 people while the QC department
 * held 9, the extra being `jeromer@`, who had moved to Callback Team and was still being
 * dealt 34 Lead Gen slots a week. A roster-derived list cannot drift, because the roster
 * is the thing that defines the department.
 *
 * The `qc` role rows are deliberately left in place, unused by the deal — removing
 * provisions is a separate, audited decision.
 *
 * Derivation and ordering live in `src/lib/qc/officers.ts`, pure and unit-tested. Order
 * is deterministic because the deal is SEEDED: an unstable officer order would make a
 * reproducible seed produce a different split on every read.
 */
export async function listActiveQcOfficers(): Promise<string[]> {
  const { employees } = await getEmployeesForAuthorizedServerRoute();
  return officersFromRoster(employees);
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
 * QC-scored rosters (`QC_DEPT_KEYS` — Lead Gen only since 2026-09-10; Discovery
 * left 2026-06-26 and Callback left with it, both retained-but-invisible) across
 * the active QC officers for a week. A "slot" is one (member, department) pair — so a person who holds master
 * rows in two QC departments (e.g. mid-transfer) produces two slots and can be
 * scored in both.
 *
 * STICKY SNAPSHOT: once a slot exists for a week it is NEVER deleted — if the
 * member later leaves that department (transfer) or the master list (offboard),
 * the row is kept and flagged (`roster_status` = transferred/removed,
 * `current_department` = where they are now). This is the "memory" so their
 * Leadgen score & bonus for the week stand even after they move.
 *
 * Split: each department's live slots are dealt across officers in a SEEDED-RANDOM
 * order (counts still differ by at most 1 per dept) — see `src/lib/qc/deal.ts`.
 * Seeded on (period_start, department) so a week is reproducible on re-read but
 * every week deals differently; an unseeded shuffle would re-split the same week
 * on every dashboard load. On the first build or when the officer SET changes, the
 * whole week is re-split; otherwise existing officer attributions are kept and only
 * new slots are balance-assigned. Writes ONLY the diff (and never deletes), so a
 * no-op read doesn't churn Realtime.
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

  // Reassigned below once the week's freeze is applied.
  let officers = await listActiveQcOfficers();

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
  // The FULL active roster, read once. Narrowing to the scored departments BEFORE
  // this point is exactly what made `roster_status='transferred'` unreachable: a person
  // who moved out of Lead Gen vanished from the only roster the deal could see, so there
  // was nowhere to read "where are they now" from, and every departure fell through to
  // `removed` — the same value as quitting. Measured 2026-09-14: 0 of 8,537 rows had
  // ever been written as `transferred`.
  const { employees: allEmployees } = await getEmployeesForAuthorizedServerRoute();
  const currentDepts = currentDeptByEmail(allEmployees);

  // The slots are the department's roster AS OF THE SCORED WEEK, not as of
  // today. Drawing from the live roster was right only while the week being
  // scored was the week you were standing in; with 50–75 people offboarded a
  // week, anyone who left or moved between the week ending and an officer
  // opening the dashboard simply vanished. Carla, 2026-09-14: *"Every time
  // someone gets transferred, we have to just add it externally. Same as if
  // they were offboarded."* Rules and their proofs: src/lib/qc/roster-as-of-week.ts.
  const [offboardedDuringWeek, transferRows] = await Promise.all([
    listOffboardedSince(periodStart),
    fetchDepartmentTransferRows().catch(() => null),
  ]);

  const rosterCandidates: QcWeekCandidate[] = allEmployees.map((e) => ({
    email: memberEmail(e),
    identityEmails: [norm(e.personal_email), norm(e.work_email)].filter(Boolean),
    name: e.name ?? null,
    departmentKey: normalizeDeptToKey(e.department),
    offBoardedAt: null,
    startDate: e.start_date ?? null,
  }));

  // A read failure is NOT an empty list. Falling back to the live roster keeps
  // the deal working exactly as it did before this change — never better, never
  // silently worse — rather than dealing a week that is missing its leavers.
  const transfers: AsOfWeekTransfer[] = (transferRows ?? []).map((t) => ({
    identityEmails: [norm(t.employee_email), norm(t.employee_work_email)].filter(Boolean),
    fromKey: normalizeDeptToKey(t.from_department),
    toKey: normalizeDeptToKey(t.to_department),
    effectiveDate: t.effective_date ?? null,
  }));

  const periodEnd = weekEndDate(periodStart);
  const weekEnd = weekEndDay(periodStart);
  /** Employment start gates separately: someone who had not joined yet cannot be
   *  scored, and an unknown/unparseable start date is KEPT ("we can't prove they
   *  hadn't started") — the house fail-toward-keeping rule, unchanged. */
  const hadStarted = (c: QcWeekCandidate) => {
    if (!periodEnd) return true;
    const sd = parseStartDate(c.startDate);
    return !sd || sd.getTime() <= periodEnd.getTime();
  };

  const asOfWeek = qcSlotsAsOfWeek({
    roster: rosterCandidates.filter(hadStarted),
    offboarded: (offboardedDuringWeek ?? []).filter(hadStarted),
    transfers,
    weekStart: periodStart,
    weekEnd: weekEnd ?? '',
    isScoredDept: isQcDeptKey,
  });

  const liveSlots: Array<{ email: string; dept: string; name: string | null }> = [];
  const liveSlotSet = new Set<string>();
  const nameBySlot = new Map<string, string | null>();
  for (const s of asOfWeek) {
    const key = slotKey(s.email, s.dept);
    if (liveSlotSet.has(key)) continue;
    liveSlotSet.add(key);
    liveSlots.push({ email: s.email, dept: s.dept, name: s.name });
    nameBySlot.set(key, s.name);
  }

  // A DEALT WEEK IS FROZEN to the officers already on its slots.
  //
  // This is the guard that makes a roster-derived officer list safe. Under the old admin
  // grant the officer set only moved when somebody clicked; derived from the roster, an
  // ordinary department transfer, an offboard, or a master-sheet clobber (a documented
  // live risk — `hris-is-dept-source-of-truth`) changes it, and an officer-set change
  // used to re-deal the current week. Without the freeze, routine roster churn would
  // reshuffle every officer's slice underneath people already scoring.
  //
  // Kane chose this for the Jerome case on 2026-09-14: he finishes the week he is in and
  // is not dealt the next one. New officers likewise join on the NEXT week's deal; a
  // slot appearing mid-week is still balance-filled among the frozen set.
  const { officers: periodOfficers } = freezeOfficers(
    existing.map((r) => norm(r.qc_officer_email)),
    officers,
  );
  officers = periodOfficers;
  const activeOfficerSet = new Set(officers);
  const regen = existing.length === 0;

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
    if (regen) {
      // RANDOMIZED, not alphabetical. Until 2026-09-10 this sorted by email and
      // dealt `i % officers.length`, so officer #1 held the alphabetically-first
      // slice of Lead Gen every week — the buddy risk Carla ratified randomization
      // to close (see src/lib/qc/deal.ts for why the shuffle is SEEDED and not
      // `Math.random()`). Evenness is unchanged: dealing positions round-robin over
      // a permutation still differs by at most one per officer.
      for (const { slot, officer } of dealDeptSlots(slots, officers, periodStart, dept)) {
        officerForSlot.set(slotKey(slot.email, dept), officer);
      }
    } else {
      // A slot that appeared mid-week. The sticky rule keeps every prior
      // attribution, so this can only balance-fill against the load already on the
      // board — never re-shuffle the week out from under an officer mid-scoring.
      const load = new Map<string, number>(officers.map((o) => [o, 0]));
      for (const [k, o] of officerForSlot) if (k.endsWith(`|${dept}`)) load.set(o, (load.get(o) ?? 0) + 1);
      // Deterministic order for the fill itself, so two concurrent reads of the same
      // week agree on where a new slot lands.
      const sorted = [...slots].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
      for (const s of sorted) {
        const key = slotKey(s.email, dept);
        if (officerForSlot.has(key)) continue;
        const best = leastLoadedOfficer(officers, load);
        if (!best) continue;
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
    // `transferred` = still employed, in a different department (carries where).
    // `removed`     = not on the active roster at all: they left.
    // NEITHER means "stop scoring" — Kane, 2026-09-14: "we still need to score people
    // who quit by the way like offboarded people". Status labels a person; the officer's
    // slot list carries every status and must never gain a status filter.
    const { status, currentDepartment: current } = classifySlot(
      isLive,
      dept,
      currentDepts.get(email) ?? null,
    );
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

/**
 * Officer summary (1-based index + slot count) for a week.
 *
 * Counts EVERY slot the officer must score, whatever its `roster_status`. It used to
 * count only `active` ones, on the reasoning that a departed person "no longer inflates
 * the officer's current workload" — but a transferred or offboarded person is still
 * scored (Kane, 2026-09-14: *"we still need to score people who quit"*), so excluding
 * them made the headline disagree with the list underneath it: 34 shown against 36 to
 * do. The count is the half that was wrong; the list was always right.
 */
export function summarizeOfficers(
  officers: string[],
  rows: QcAssignmentRow[],
  nameByEmail?: Map<string, string>,
): QcOfficer[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const o = norm(r.qc_officer_email);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  return officers.map((email, i) => ({
    email,
    index: i + 1,
    memberCount: counts.get(email) ?? 0,
    name: nameByEmail?.get(norm(email)) ?? null,
  }));
}

/**
 * Resolve QC officers' full names from the master list. Officers are keyed by
 * `work_email` (in `employee_roles`), but a roster row may match on the work,
 * personal, or either alternate work email — so we index every email a row
 * exposes. Returns a Map keyed by lower-cased email → full name. Used to label
 * the QC first-pass rail with each officer's name instead of "QC Officer N".
 */
export async function getQcOfficerNameMap(emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = new Set(emails.map(norm).filter(Boolean));
  if (want.size === 0) return out;
  const { employees } = await getEmployeesForAuthorizedServerRoute();
  for (const e of employees) {
    const name = (e.name ?? '').trim();
    if (!name) continue;
    for (const addr of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
      const key = norm(addr);
      if (key && want.has(key) && !out.has(key)) out.set(key, name);
    }
  }
  return out;
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
