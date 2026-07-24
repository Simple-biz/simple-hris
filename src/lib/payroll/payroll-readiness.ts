import 'server-only';

/**
 * Payroll Readiness — the server-side composition behind the Payroll Wizard's
 * "Readiness" checklist tab (the FAB modal). It answers one question for
 * Accounting: *are we payroll ready for the week we're about to run?*
 *
 * It unions four independent signal families for the CURRENT payroll week:
 *
 *   1. KPI submission     — per department (manager-KPI + every HSL sub-dept):
 *                           has the manager marked their week ready/locked, and
 *                           how much is still left (scored vs expected).
 *   2. Missing rates      — current-week Hubstaff workers with NO resolvable pay
 *                           rate (individual catalog → sheet → dept base all
 *                           absent) — they literally can't be paid yet. USEE/US
 *                           Employees are excluded (paid off-channel, so a
 *                           missing hourly rate isn't a blocker for them).
 *   3. Missing bank info  — active employees whose employee_ids row isn't payable
 *                           (isPayoutComplete === false), USEE/US Employees aside.
 *   4. Exceptions         — HR onboarding-pipeline hires who naturally won't be
 *                           paid this week (still onboarding, no-show, or started
 *                           this week so their first period hasn't closed).
 *
 * Everything is derived from the same primitives payroll itself uses, so the
 * checklist stays honest:
 *   - week key: the live Hubstaff upload's Monday (matches what managers submit
 *     against and what the wizard pays), via pickCurrentSourceFile + isoWeekStart.
 *   - rates: loadPeopleRateContext + resolvePeopleRate (People roster's chain).
 *   - banking: isPayoutComplete (the single "payable" definition).
 *   - KPI status: hsl_bonus_period_status ⨝ (hsl_bonus_entries | bonus_catalog_applied).
 *
 * The heavy identity/redaction hazards (recycled work emails, rate redaction)
 * stay on the server; the client receives one flat, typed { ... } payload.
 */

import { normEmail } from '@/lib/email/norm-email';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import {
  getEmployeeHourlyRatesRows,
  indexHourlyRatesByEmail,
} from '@/lib/supabase/employee-hourly-rates';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { loadPeopleRateContext, resolvePeopleRate } from '@/lib/people/people-roster';
import {
  fetchHubstaffRowsOrdered,
  fetchHubstaffRowsBySourceFile,
  listHubstaffUploads,
  rowsToPayrollRows,
} from '@/lib/supabase/hubstaff-hours-db';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import { pickCurrentSourceFile } from '@/lib/hubstaff/current-upload';
import { summarizeApplied } from '@/lib/supabase/bonus-catalog-applied-db';
import { listHrPendingEmployees } from '@/lib/supabase/hr-pending-employees';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { DEPARTMENTS, MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { listBonusCatalog } from '@/lib/supabase/bonus-catalog-db';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import { HSL_DEPTS, HSL_DEPT_KEYS, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import { weekRangeLabel } from '@/lib/payroll/manila-week';
import {
  computeReadinessScore,
  type ReadinessScore,
  type ReadinessScoreComponent,
} from '@/lib/payroll/readiness-score';

// Re-export the score types so existing importers of this module keep working
// (the scorer itself lives in the framework-free readiness-score.ts).
export type { ReadinessScore, ReadinessScoreComponent };
export { computeReadinessScore };

// ── Types (the client payload) ────────────────────────────────────────────────

/** How submitted a department's KPI is for the week. `n/a` = a monthly HSL dept
 *  that isn't due this (non-final) week — not expected, so it never counts against
 *  readiness. `no_bonus` = a general dept with NO Payment Catalog bonus the
 *  manager could apply this week (the calculator is catalog-driven, so an empty
 *  catalog renders "No bonuses assigned" — there is nothing to submit), so it
 *  auto-reads Ready. */
export type KpiDeptStatus = 'ready' | 'locked' | 'draft' | 'na' | 'no_bonus';

export interface ReadinessKpiDept {
  key: string;
  name: string;
  /** 'general' = manager-KPI (bonus_catalog_applied); 'hsl' = an HSL sub-dept;
   *  'custom' = an in-app department (Payment Catalog -> Department registry) —
   *  listed for visibility, no KPI calculator of its own. */
  source: 'general' | 'hsl' | 'custom';
  cadence: 'weekly' | 'monthly';
  status: KpiDeptStatus;
  /** People with a scored (>0) entry this week. */
  scoredCount: number;
  /** People touched for the dept-week (entries or applied rows). */
  employeeCount: number;
  /** Sum of the dept-week's bonus amounts (PHP). */
  totalBonus: number;
  /** Last touch on the dept-week's status / entries. */
  updatedAt: string | null;
  /** Who marked it (locked_by), when known. */
  lockedBy: string | null;
}

export interface ReadinessMissingRate {
  name: string;
  email: string | null;
  department: string | null;
}

export interface ReadinessMissingBank {
  name: string;
  email: string | null;
  department: string | null;
  /** The processor picked but left incomplete, if any (helps triage). */
  processor: string | null;
  /** Identity split for the in-tab "Set bank" editor: which email column the
   *  employee_ids write should key on. `email` above stays the display value. */
  workEmail: string | null;
  personalEmail: string | null;
}

/** Why a person is expected NOT to be paid this week (an onboarding exception). */
export type ExceptionKind =
  | 'onboarding' // still mid-onboarding (not yet promoted)
  | 'awaiting_orientation' // ready but manager hasn't confirmed orientation
  | 'no_show' // marked no-show — will not be paid
  | 'started_this_week'; // promoted, but started in the current pay week

export interface ReadinessException {
  name: string;
  email: string | null;
  department: string | null;
  kind: ExceptionKind;
  /** Human sub-label, e.g. a start date. */
  detail: string | null;
}

export interface PayrollReadiness {
  /** Monday ISO of the payroll week this snapshot describes. */
  weekStart: string;
  /** "Jul 14 – Jul 20" label for the week. */
  weekLabel: string;
  /** True on the month's final payroll week (monthly KPI depts are due). */
  isMonthlyPayWeek: boolean;
  /** The live Hubstaff source file the week resolved from (null when none). */
  sourceFile: string | null;
  kpi: ReadinessKpiDept[];
  missingRates: ReadinessMissingRate[];
  missingBank: ReadinessMissingBank[];
  exceptions: ReadinessException[];
  /** Count of current-week Hubstaff workers considered for the rate check. */
  workerCount: number;
  /** Count of active on-channel employees considered for the bank check. */
  bankEligibleCount: number;
  /** The blocker-weighted readiness score (0–100) + its breakdown. */
  score: ReadinessScore;
}

// ── Week resolution ─────────────────────────────────────────────────────────

/** Format a local date as `YYYY-MM-DD` (no timezone shift). */
function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The payroll `period_start` key for a Hubstaff upload: the filename's date-range
 * START, verbatim. This is the SAME key the Payroll Wizard (`hubstaffWeekStart`)
 * and the manager KPI calculators (`DeptBonusCalculator` / `HslBonusCalculator`,
 * which seed `weekStart` from `toIso(range.start)`) write against — so readiness
 * queries `hsl_bonus_period_status` on the exact row the managers submitted.
 *
 * IMPORTANT: do NOT Monday-anchor this. The report weeks start on a SUNDAY
 * (e.g. `..._2026-07-12_to_2026-07-18.csv`), and an ISO/Monday `weekStart` would
 * pull that Sunday back a full week to the prior Monday (2026-07-06), querying an
 * empty period — which made every dept read "Pending" even after managers marked
 * them ready/locked. Keying on `range.start` directly keeps us in lock-step.
 */
function weekKeyFromSourceFile(sourceFile: string): string | null {
  const range = parseDateRangeFromFilename(sourceFile);
  if (range?.start && !Number.isNaN(range.start.getTime())) {
    return toIsoDate(range.start);
  }
  return null;
}

/** Monday (ISO) of the week containing a local date. Used ONLY for the
 *  pre-upload calendar fallback (no filename to key on yet). */
function isoWeekStartOf(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = day.getDay(); // 0=Sun … 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  day.setDate(day.getDate() - daysBack);
  return toIsoDate(day);
}

function parseLocalIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Resolve the payroll week key. When the Payroll Wizard hands us the exact file
 * it's currently on (`preferredSourceFile` — possibly a replayed past week), we
 * honor it so readiness always describes the SAME week the accountant is looking
 * at. Otherwise we fall back to the live (`is_current`) Hubstaff upload, then to
 * today's calendar week (so the tab still renders pre-upload).
 *
 * The week key is the upload's filename date-range START (see
 * `weekKeyFromSourceFile`), matching the wizard + manager calculators exactly.
 */
async function resolveCurrentWeek(
  preferredSourceFile?: string | null,
): Promise<{ weekStart: string; sourceFile: string | null }> {
  let sourceFile: string | null = (preferredSourceFile ?? '').trim() || null;
  if (!sourceFile) {
    try {
      const uploads = await listHubstaffUploads();
      sourceFile = pickCurrentSourceFile(
        uploads.map((u) => ({ source_file: u.source_file, is_current: u.is_current })),
        undefined,
      );
    } catch {
      sourceFile = null;
    }
  }
  if (sourceFile) {
    const weekStart = weekKeyFromSourceFile(sourceFile);
    if (weekStart) return { weekStart, sourceFile };
  }
  // No usable upload filename → fall back to the current calendar week's Monday
  // so the tab still renders before any upload exists.
  return { weekStart: isoWeekStartOf(new Date()), sourceFile };
}

// ── Department enumeration ────────────────────────────────────────────────────

const DEPT_NAME_BY_KEY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const d of DEPARTMENTS) m[d.key] = d.name;
  for (const k of HSL_DEPT_KEYS) m[k] = HSL_DEPTS[k].name;
  return m;
})();

// ── Status table row ─────────────────────────────────────────────────────────

interface StatusRow {
  department: string;
  period_start: string;
  status: 'draft' | 'ready' | 'locked';
  updated_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
}

interface HslEntryAgg {
  employeeCount: number;
  scoredCount: number;
  totalBonus: number;
}

// ── KPI readiness ─────────────────────────────────────────────────────────────

async function buildKpiReadiness(weekStart: string, isMonthly: boolean): Promise<ReadinessKpiDept[]> {
  const supabase = createSupabaseServiceRoleClient();

  // Status for every dept-week (implicit draft when absent). The GET-all shape.
  const statusByDept = new Map<string, StatusRow>();
  if (supabase) {
    const { data } = await supabase
      .from('hsl_bonus_period_status')
      .select('department, period_start, status, updated_at, locked_by, locked_at')
      .eq('period_start', weekStart);
    for (const s of (data ?? []) as StatusRow[]) statusByDept.set(s.department, s);
  }

  // HSL entry aggregates for the week (scored/expected counts + total).
  const hslAggByDept = new Map<string, HslEntryAgg>();
  if (supabase) {
    const { data } = await supabase
      .from('hsl_bonus_entries')
      .select('department, calculated_bonus')
      .eq('period_start', weekStart);
    for (const r of (data ?? []) as { department: string; calculated_bonus: number | string | null }[]) {
      const agg = hslAggByDept.get(r.department) ?? { employeeCount: 0, scoredCount: 0, totalBonus: 0 };
      agg.employeeCount += 1;
      const b = Number(r.calculated_bonus ?? 0);
      agg.totalBonus += Number.isFinite(b) ? b : 0;
      if (b > 0) agg.scoredCount += 1;
      hslAggByDept.set(r.department, agg);
    }
  }

  // In-app departments (Payment Catalog -> Department registry) join the KPI
  // list for visibility. Best-effort: a registry read failure must not take
  // down readiness for the built-in departments.
  let customDepts: { key: string; name: string }[] = [];
  try {
    const builtin = new Set<string>([...MANAGER_BONUS_DEPT_KEYS, ...HSL_DEPT_KEYS]);
    customDepts = (await getDepartmentRegistry())
      .filter((e) => !builtin.has(e.key))
      .map((e) => ({ key: e.key, name: e.name }));
  } catch {
    customDepts = [];
  }

  // General (catalog) dept aggregates for the week. Scoped to this week's
  // period_start at the DB so we don't pull the entire applied-bonus history
  // just to keep one week (this was the readiness snapshot's slowest query).
  const appliedRows: Awaited<ReturnType<typeof summarizeApplied>> = await summarizeApplied(
    [...MANAGER_BONUS_DEPT_KEYS, ...customDepts.map((d) => d.key)],
    weekStart,
  ).catch(() => []);
  const appliedByDept = new Map(appliedRows.map((r) => [r.department, r]));

  // Departments with at least one Payment Catalog bonus the manager could apply
  // THIS week (department- or employee-scoped), resolved the same way the
  // manager calculator (DeptBonusCalculator) does: dept key normalized,
  // assignments whose bonus was deleted ignored, monthly-cadence bonuses only
  // counted on the month's final payroll week. A general dept with no such
  // bonus has nothing for its manager to submit — the catalog-driven calculator
  // literally renders "No bonuses assigned to this department yet" — so it
  // auto-reads Ready ('no_bonus') instead of sitting on "Pending" forever.
  // Best-effort: if the catalog can't load we assume every dept has bonuses
  // (never auto-Ready on a read failure).
  let catalogDeptKeys: Set<string> | null = null;
  try {
    const { bonuses, assignments } = await listBonusCatalog();
    const bonusById = new Map(bonuses.map((b) => [b.id, b]));
    catalogDeptKeys = new Set<string>();
    for (const a of assignments) {
      const bonus = bonusById.get(a.bonusId);
      if (!bonus) continue;
      if (bonus.cadence === 'monthly' && !isMonthly) continue;
      catalogDeptKeys.add(normalizeDeptToKey(a.departmentKey) ?? a.departmentKey);
    }
  } catch {
    catalogDeptKeys = null;
  }

  const out: ReadinessKpiDept[] = [];

  // General manager-KPI departments.
  for (const key of MANAGER_BONUS_DEPT_KEYS) {
    const status = statusByDept.get(key);
    const applied = appliedByDept.get(key);
    const hasCatalogBonus = catalogDeptKeys === null || catalogDeptKeys.has(key);
    let deptStatus = (status?.status ?? 'draft') as KpiDeptStatus;
    // Only an untouched dept auto-flips: a manager's explicit ready/locked (or
    // any applied bonus rows this week) always wins over the no-bonus shortcut.
    if (deptStatus === 'draft' && !hasCatalogBonus && (applied?.employee_count ?? 0) === 0) {
      deptStatus = 'no_bonus';
    }
    out.push({
      key,
      name: DEPT_NAME_BY_KEY[key] ?? key,
      source: 'general',
      cadence: 'weekly',
      status: deptStatus,
      scoredCount: applied?.employee_count ?? 0,
      employeeCount: applied?.employee_count ?? 0,
      totalBonus: Math.round(applied?.total_bonus ?? 0),
      updatedAt: status?.updated_at ?? applied?.applied_at ?? null,
      lockedBy: status?.locked_by ?? applied?.applied_by ?? null,
    });
  }

  // In-app departments — same auto-Ready rule as general depts: nothing in the
  // catalog for its manager to submit means there is nothing pending. A custom
  // dept that DOES get catalog assignments (keyed on its slug) follows the
  // normal draft/applied logic.
  for (const { key, name } of customDepts) {
    const status = statusByDept.get(key);
    const applied = appliedByDept.get(key);
    const hasCatalogBonus = catalogDeptKeys === null || catalogDeptKeys.has(key);
    let deptStatus = (status?.status ?? 'draft') as KpiDeptStatus;
    if (deptStatus === 'draft' && !hasCatalogBonus && (applied?.employee_count ?? 0) === 0) {
      deptStatus = 'no_bonus';
    }
    out.push({
      key,
      name,
      source: 'custom',
      cadence: 'weekly',
      status: deptStatus,
      scoredCount: applied?.employee_count ?? 0,
      employeeCount: applied?.employee_count ?? 0,
      totalBonus: Math.round(applied?.total_bonus ?? 0),
      updatedAt: status?.updated_at ?? applied?.applied_at ?? null,
      lockedBy: status?.locked_by ?? applied?.applied_by ?? null,
    });
  }

  // HSL sub-departments (monthly ones are only "due" on the month's final week).
  for (const key of HSL_DEPT_KEYS as readonly HslDeptKey[]) {
    const cfg = HSL_DEPTS[key];
    const monthly = cfg.cadence === 'monthly';
    const due = !monthly || isMonthly;
    const status = statusByDept.get(key);
    const agg = hslAggByDept.get(key);
    out.push({
      key,
      name: cfg.name,
      source: 'hsl',
      cadence: cfg.cadence,
      status: !due ? 'na' : ((status?.status ?? 'draft') as KpiDeptStatus),
      scoredCount: agg?.scoredCount ?? 0,
      employeeCount: agg?.employeeCount ?? 0,
      totalBonus: Math.round(agg?.totalBonus ?? 0),
      updatedAt: status?.updated_at ?? null,
      lockedBy: status?.locked_by ?? null,
    });
  }

  // Sort: not-ready first (draft before ready before locked before n/a), then
  // by name — so what still needs attention floats to the top.
  const rank: Record<KpiDeptStatus, number> = { draft: 0, ready: 1, locked: 2, no_bonus: 3, na: 4 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  return out;
}

// ── Missing rates (current-week Hubstaff workers, USEE excluded) ──────────────

async function buildMissingRates(
  sourceFile: string | null,
  excludeIdentities: Set<string>,
): Promise<{ rows: ReadinessMissingRate[]; workerCount: number }> {
  // The workers considered are exactly the week-in-view's Hubstaff roster: the
  // named file when the wizard is on a specific (possibly replayed) week, else
  // the live `is_current` upload.
  let hubstaffRows: Awaited<ReturnType<typeof fetchHubstaffRowsOrdered>>['rows'] = [];
  try {
    ({ rows: hubstaffRows } = sourceFile
      ? await fetchHubstaffRowsBySourceFile(sourceFile)
      : await fetchHubstaffRowsOrdered());
  } catch {
    return { rows: [], workerCount: 0 };
  }

  const rateCtx = await loadPeopleRateContext();
  // Master roster: work→personal alias sets + department, so a Hubstaff row
  // keyed on the work email resolves via every alias the person owns (the
  // People roster's exact behaviour).
  const { employees } = await getEmployeesForAuthorizedServerRoute();
  const aliasesByEmail = new Map<string, string[]>();
  const deptByEmail = new Map<string, string | null>();
  for (const e of employees) {
    const aliases = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map((a) => normEmail(a ?? ''))
      .filter(Boolean) as string[];
    for (const a of aliases) {
      if (!aliasesByEmail.has(a)) aliasesByEmail.set(a, aliases);
      if (!deptByEmail.has(a)) deptByEmail.set(a, e.department ?? null);
    }
  }

  const workers = rowsToPayrollRows(hubstaffRows);
  const seen = new Set<string>();
  const missing: ReadinessMissingRate[] = [];
  let workerCount = 0;
  for (const w of workers) {
    const email = normEmail(w.email ?? '');
    const name = (w.name ?? '').trim() || email || '';
    const key = email || name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // The rate chain runs over every alias this person owns; department is the
    // master-list dept (falls back to the Hubstaff row's own dept label).
    const aliases = (email && aliasesByEmail.get(email)) || (email ? [email] : []);
    const dept = (email && deptByEmail.get(email)) ?? w.department ?? null;

    // USEE / US Employees are paid off-channel, so a missing hourly rate isn't a
    // payroll blocker for them — skip them from BOTH the list and the considered
    // count (mirrors the missing-bank list's off-channel exclusion) so the stat
    // stays honest.
    if (isOffChannelDept(dept)) continue;

    // Onboarding-exception people (still onboarding / no-show / started this week)
    // are expected NOT to be paid, so a missing rate for them must never cost
    // readiness points. Drop them from BOTH the list and the worker denominator.
    // Matched on any alias this person owns (from the master roster) OR the
    // Hubstaff row's own email/name, so it catches them regardless of key.
    if (
      excludeByIdentity(excludeIdentities, email, null, name) ||
      aliases.some((a) => excludeIdentities.has(a))
    ) {
      continue;
    }
    workerCount += 1;

    const rate = resolvePeopleRate(rateCtx, aliases, dept);
    if (rate.source === null) {
      missing.push({ name, email: email || null, department: dept });
    }
  }
  missing.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: missing, workerCount };
}

// ── Missing bank info (active roster, USEE excluded) ──────────────────────────

/** Departments paid off-channel — never flagged for missing bank info. Mirrors
 *  the People tab's `department !== 'USEE'` guard (US Employees are paid via a
 *  separate channel). */
function isOffChannelDept(dept: string | null | undefined): boolean {
  const d = (dept ?? '').trim().toLowerCase();
  return d === 'usee' || d === 'us employees' || d === 'us employee';
}

/** The identity keys a person can be matched on across the readiness lists: every
 *  normalized email they own (so a rate/bank row keyed on the work OR the personal
 *  alias both match) plus a `name:`-prefixed normalized-name fallback for rows
 *  that carry no email. The name is prefixed so it can never collide with an
 *  email key. */
function identityKeys(
  workEmail: string | null | undefined,
  personalEmail: string | null | undefined,
  name: string | null | undefined,
): string[] {
  const keys: string[] = [];
  for (const e of [workEmail, personalEmail]) {
    const em = normEmail(e ?? '');
    if (em) keys.push(em);
  }
  const n = (name ?? '').trim().toLowerCase();
  if (n) keys.push(`name:${n}`);
  return keys;
}

/** True when any of a row's identity keys is in the exclusion set — used to drop
 *  onboarding-exception people out of the rate/bank populations so they never
 *  cost readiness points (they're expected non-payments this week). */
function excludeByIdentity(
  exclude: Set<string>,
  workEmail: string | null | undefined,
  personalEmail: string | null | undefined,
  name: string | null | undefined,
): boolean {
  if (exclude.size === 0) return false;
  return identityKeys(workEmail, personalEmail, name).some((k) => exclude.has(k));
}

async function buildMissingBank(
  excludeIdentities: Set<string>,
): Promise<{ rows: ReadinessMissingBank[]; eligibleCount: number }> {
  const [{ employees }, idsRes, ratesRes] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    getEmployeeIds(),
    // The legacy rates-sheet row is Payment Dispatch's fallback for both the
    // processor (the free-text `bank_preferred` cell) and the hurupay/higlobe
    // emails — completeness must judge with the same fallbacks or this list
    // flags people the dispatch queue pays fine. Best-effort: on error we
    // just judge without the extras.
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [], error: null })),
  ]);

  // employee_ids row keyed by every email it carries (the row itself — payable
  // is judged per person below, with that person's legacy extras).
  const idRowByEmail = new Map<string, Record<string, unknown>>();
  for (const r of idsRes.rows) {
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) idRowByEmail.set(em, r as unknown as Record<string, unknown>);
    }
  }
  const ratesByEmail = indexHourlyRatesByEmail(ratesRes.rows);

  // One row per active person (dedupe on identity, first wins), skipping
  // off-channel (USEE) departments. `eligibleCount` is every distinct on-channel
  // person considered (the score's bank-coverage denominator), whether payable
  // or not; `out` is only the ones missing payout details.
  const seen = new Set<string>();
  const out: ReadinessMissingBank[] = [];
  let eligibleCount = 0;
  for (const e of employees) {
    if (isOffChannelDept(e.department)) continue;
    // Onboarding-exception people (e.g. a `started_this_week` hire already
    // promoted onto the active roster) are expected NOT to be paid this week, so
    // an incomplete employee_ids row for them must never cost readiness points.
    // Drop them from BOTH the missing list and the eligible denominator.
    if (excludeByIdentity(excludeIdentities, e.work_email, e.personal_email, e.name)) continue;
    const w = normEmail(e.work_email ?? '');
    const p = normEmail(e.personal_email ?? '');
    const n = (e.name ?? '').trim().toLowerCase();
    const base = w || p || n;
    if (!base) continue;
    const idKey = `${base}|${n}`;
    if (seen.has(idKey)) continue;
    seen.add(idKey);
    eligibleCount += 1;

    const idRow = (w && idRowByEmail.get(w)) || (p && idRowByEmail.get(p)) || null;
    const rates = (w && ratesByEmail.get(w)) || (p && ratesByEmail.get(p)) || null;
    const extras: PayoutLegacyExtras | undefined = rates
      ? {
          bankPreferredRaw: rates.bank_preferred,
          hurupayEmail: rates.hurupay_email,
          higlobeEmail: rates.higlobe_email,
          higlobeAccountName: rates.higlobe_account_name,
        }
      : undefined;
    if (isPayoutComplete(idRow, extras)) continue;
    out.push({
      name: e.name ?? w ?? p ?? '—',
      email: e.work_email ?? e.personal_email ?? null,
      department: e.department ?? null,
      // The processor PD would route on (bank_preferred → disbursement →
      // legacy cell) — what the "wires · incomplete" pill should actually say.
      processor: resolveEffectivePayoutProcessor(idRow, extras),
      workEmail: e.work_email ?? null,
      personalEmail: e.personal_email ?? null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: out, eligibleCount };
}

// ── Onboarding exceptions ─────────────────────────────────────────────────────

/** The exception list PLUS the identity keys of everyone on it, so the rate and
 *  bank checks can subtract these expected non-payments out before scoring (an
 *  onboarding exception must never cost points on any dimension — see
 *  `excludeByIdentity`). `identities` holds every normalized email a hire owns
 *  (work AND personal, so it matches whichever alias the rate/bank list keyed on)
 *  and a normalized-name fallback for rows with no email. */
async function buildExceptions(
  weekStart: string,
): Promise<{ rows: ReadinessException[]; identities: Set<string> }> {
  let rows: Awaited<ReturnType<typeof listHrPendingEmployees>>['rows'] = [];
  try {
    ({ rows } = await listHrPendingEmployees());
  } catch {
    return { rows: [], identities: new Set() };
  }

  const weekEnd = (() => {
    const d = parseLocalIso(weekStart);
    if (!d) return null;
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
    return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
  })();

  const out: ReadinessException[] = [];
  const identities = new Set<string>();
  // Record every identity key an exception hire owns (both email aliases + a
  // normalized-name fallback) so the rate/bank lists can exclude them regardless
  // of which alias they were keyed on.
  const remember = (r: (typeof rows)[number]) => {
    for (const key of identityKeys(r.work_email, r.personal_email, r.name)) {
      identities.add(key);
    }
  };

  for (const r of rows) {
    const name = r.display_name || r.name || r.work_email || r.personal_email || '—';
    const email = r.work_email || r.personal_email || null;
    const department = r.department ?? null;

    if (r.status === 'no_show') {
      out.push({ name, email, department, kind: 'no_show', detail: 'Marked no-show — not paid' });
      remember(r);
      continue;
    }
    if (r.status === 'pending_work_email' || r.status === 'ready' || r.status === 'failed_to_promote') {
      const awaiting = !r.orientation_attended_at;
      out.push({
        name,
        email,
        department,
        kind: awaiting ? 'awaiting_orientation' : 'onboarding',
        detail: awaiting ? 'Awaiting orientation confirmation' : 'Still onboarding — not on payroll yet',
      });
      remember(r);
      continue;
    }
    if (r.status === 'promoted') {
      // Started this week ⇒ first pay period hasn't closed. The real start date
      // is the orientation date (promote stamps master Start Date from it);
      // fall back to the staged start_date / promoted_at.
      const startIso =
        (r.orientation_attended_at ? r.orientation_attended_at.slice(0, 10) : null) ??
        r.start_date ??
        (r.promoted_at ? r.promoted_at.slice(0, 10) : null);
      if (startIso && startIso >= weekStart && (!weekEnd || startIso <= weekEnd)) {
        out.push({
          name,
          email,
          department,
          kind: 'started_this_week',
          detail: `Started ${startIso} — first pay period not closed`,
        });
        remember(r);
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: out, identities };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Compose the full readiness snapshot for the payroll week in view.
 *
 * @param sourceFile Optional Hubstaff upload the caller (the Payroll Wizard) is
 *   currently on — including a replayed past week. When omitted, resolves the
 *   live `is_current` upload. Either way the snapshot describes exactly that
 *   week, so it never drifts from what the wizard shows.
 */
export async function getPayrollReadiness(
  sourceFile?: string | null,
): Promise<PayrollReadiness> {
  const { weekStart, sourceFile: resolvedFile } = await resolveCurrentWeek(sourceFile);
  const isMonthlyPayWeek = isFinalPayrollWeekOfMonth(weekStart);

  // Exceptions resolve first: their identity set feeds the rate/bank checks so an
  // expected non-payment (onboarding / no-show / started-this-week) never costs
  // points on ANY score dimension. KPI is per-department, so it needs no
  // per-person exclusion and still runs alongside.
  const [exceptionsRes, kpi] = await Promise.all([
    buildExceptions(weekStart),
    buildKpiReadiness(weekStart, isMonthlyPayWeek),
  ]);
  const { rows: exceptions, identities: exceptionIdentities } = exceptionsRes;

  const [ratesRes, bankRes] = await Promise.all([
    buildMissingRates(resolvedFile, exceptionIdentities),
    buildMissingBank(exceptionIdentities),
  ]);

  // KPI due/submitted for the score: monthly depts not due this week ('na') are
  // excluded from the denominator; everything else is due, and "submitted" means
  // the manager marked it ready/locked — or there is no bonus configured for the
  // dept at all ('no_bonus'), which is Ready by definition.
  const kpiDue = kpi.filter((d) => d.status !== 'na').length;
  const kpiSubmitted = kpi.filter(
    (d) => d.status === 'ready' || d.status === 'locked' || d.status === 'no_bonus',
  ).length;

  const score = computeReadinessScore({
    workerCount: ratesRes.workerCount,
    missingRates: ratesRes.rows.length,
    kpiDue,
    kpiSubmitted,
    bankEligibleCount: bankRes.eligibleCount,
    missingBank: bankRes.rows.length,
  });

  return {
    weekStart,
    weekLabel: weekRangeLabel(weekStart),
    isMonthlyPayWeek,
    sourceFile: resolvedFile,
    kpi,
    missingRates: ratesRes.rows,
    missingBank: bankRes.rows,
    exceptions,
    workerCount: ratesRes.workerCount,
    bankEligibleCount: bankRes.eligibleCount,
    score,
  };
}
