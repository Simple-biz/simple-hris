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
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from '@/lib/supabase/employees';
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
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';
import { isFinalPayrollWeekOfMonth } from '@/lib/payroll/bonus-cadence';
import { DEPARTMENTS, MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { listBonusCatalog } from '@/lib/supabase/bonus-catalog-db';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import {
  resolveDeptKeyWithRegistry,
  slugifyDeptKey,
  type DepartmentRegistryEntry,
} from '@/lib/departments/registry';
import { getAppSetting } from '@/lib/supabase/app-settings';
import {
  deptPayPausedSettingKey,
  parsePausedDeptKeys,
} from '@/lib/payroll/dept-pay-config';
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
 *  auto-reads Ready. `excluded` = the department is switched out of this week's
 *  pay in the Payroll Wizard's step-1 Configuration tab — still listed for
 *  visibility, but it neither owes a submission nor counts toward the score
 *  until it's switched back on. */
export type KpiDeptStatus = 'ready' | 'locked' | 'draft' | 'na' | 'no_bonus' | 'excluded';

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
  /** Master-list "Start Date", normalized to `YYYY-MM-DD`. Null when the column
   *  is blank or unparseable (it's free text on the sheet). */
  startDate: string | null;
  /** True when the start date lands in the pay week in view OR the week before
   *  it: a brand-new hire who already logged hours (that's why they're on this
   *  week's Hubstaff file at all) but has no rate in the Payment Catalog yet.
   *  Triage signal only — a new hire's missing rate blocks pay exactly like
   *  anyone else's, so it still scores the same. */
  recentlyOnboarded: boolean;
  /** Set when the department/start date came from an OFF-BOARDED master row: the
   *  person worked part of the week and then left. They still need a rate if
   *  those final hours are being paid, so the row stays — this just explains it.
   *  `YYYY-MM-DD` of the off-board, or null for anyone still active. */
  offBoardedAt: string | null;
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
  /** True when this person has hours in the week-in-view's Hubstaff upload —
   *  they are being PAID this week with no payout rail, which makes them a
   *  hard blocker (pins the score's bank dimension, like a missing rate). */
  onPayroll: boolean;
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
  /** Count of active on-channel employees considered for the bank check (the
   *  full roster-hygiene LIST's denominator — the score uses the on-payroll
   *  slice below instead). */
  bankEligibleCount: number;
  /** Of `bankEligibleCount`, how many have hours in this week's Hubstaff file —
   *  the people actually being PAID this week, and the denominator the score's
   *  bank dimension is judged over. */
  bankOnPayrollCount: number;
  /** How many of `missingBank` are on this week's payroll (hard blockers). */
  missingBankOnPayroll: number;
  /** Data sources that could NOT be read this load, in human-readable form.
   *  Non-empty means one or more dimensions were judged on partial data — the
   *  UI shows these as a warning, and the grade can never read 'ready' (a
   *  broken read must never paint the dashboard green). Empty on a clean load. */
  degraded: string[];
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
): Promise<{ weekStart: string; sourceFile: string | null; degraded: string[] }> {
  let sourceFile: string | null = (preferredSourceFile ?? '').trim() || null;
  const degraded: string[] = [];
  if (!sourceFile) {
    try {
      const uploads = await listHubstaffUploads();
      sourceFile = pickCurrentSourceFile(
        uploads.map((u) => ({ source_file: u.source_file, is_current: u.is_current })),
        undefined,
      );
    } catch {
      // MUST be reported. Losing the upload list doesn't just blank a field — it
      // drops us on the calendar-week fallback below, where the rate check runs
      // over EVERY Hubstaff row ever loaded instead of this week's file. That
      // reads as hundreds of phantom no-rate workers (people long gone) and a
      // wrecked score, with nothing on screen to say the data was bad.
      sourceFile = null;
      degraded.push(
        'The Hubstaff upload list couldn’t be read — the pay week fell back to the calendar week, so the pay-rate check may cover the wrong hours.',
      );
    }
  }
  if (sourceFile) {
    const weekStart = weekKeyFromSourceFile(sourceFile);
    if (weekStart) return { weekStart, sourceFile, degraded };
  }
  // No usable upload filename → fall back to the current calendar week's Monday
  // so the tab still renders before any upload exists.
  return { weekStart: isoWeekStartOf(new Date()), sourceFile, degraded };
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

async function buildKpiReadiness(
  weekStart: string,
  isMonthly: boolean,
  registry: DepartmentRegistryEntry[],
  /** Departments excluded from this week's pay (wizard Configuration tab) —
   *  still LISTED (status 'excluded') but owing nothing. */
  paused: Set<string>,
  /** Distinct raw Department labels on the active master roster. Labels that
   *  don't resolve to an already-enumerated dept (built-in / HSL / registry)
   *  join the list as derived rows — so a master-list-only department like
   *  "Orphan Ministry" is VISIBLE here exactly like the Payroll Wizard shows
   *  it: 'excluded' when switched off in Configuration, auto-Ready
   *  ('no_bonus') when it has nothing to submit. Before this, such depts
   *  simply never appeared, which read as "missing" rather than "nothing
   *  owed". */
  masterDeptLabels: string[],
): Promise<ReadinessKpiDept[]> {
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
  // list for visibility. The registry is loaded (best-effort) by the caller so
  // the pay-paused predicate and this list share one read.
  const builtin = new Set<string>([...MANAGER_BONUS_DEPT_KEYS, ...HSL_DEPT_KEYS]);
  const customDepts: { key: string; name: string }[] = registry
    .filter((e) => !builtin.has(e.key))
    .map((e) => ({ key: e.key, name: e.name }));

  // Master-list-derived departments: any roster Department label that doesn't
  // resolve to a dept already enumerated above. HSL-ish labels ("HSL",
  // "hsl:intake_specialist", anything Hogan) are skipped — HSL is represented
  // by its per-sub-dept rows, and a derived catch-all "HSL" row would wrongly
  // read no-bonus/Ready next to them.
  const enumerated = new Set<string>([...builtin, ...customDepts.map((d) => d.key)]);
  const masterDepts: { key: string; name: string }[] = [];
  for (const raw of masterDeptLabels) {
    const label = (raw ?? '').trim();
    if (!label) continue;
    const l = label.toLowerCase();
    if (l.startsWith('hsl') || l.includes('hogan')) continue;
    const key = resolveDeptKeyWithRegistry(label, registry) ?? slugifyDeptKey(label);
    if (!key || enumerated.has(key)) continue;
    enumerated.add(key);
    masterDepts.push({ key, name: label });
  }

  // General (catalog) dept aggregates for the week. Scoped to this week's
  // period_start at the DB so we don't pull the entire applied-bonus history
  // just to keep one week (this was the readiness snapshot's slowest query).
  // Derived master-list depts are included so an applied bonus keyed on one of
  // their slugs still reads as activity rather than silently vanishing.
  const appliedRows: Awaited<ReturnType<typeof summarizeApplied>> = await summarizeApplied(
    [...MANAGER_BONUS_DEPT_KEYS, ...customDepts.map((d) => d.key), ...masterDepts.map((d) => d.key)],
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

  // General manager-KPI departments. Pay-excluded ones (wizard Configuration
  // tab) stay LISTED but read 'excluded' — visible, owing nothing.
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
    if (paused.has(key)) deptStatus = 'excluded';
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
  // normal draft/applied logic. Master-list-derived depts (e.g. "Orphan
  // Ministry") ride the exact same rules and render as 'custom' (informational
  // row, "In-app" chip, no calculator to open).
  for (const { key, name } of [...customDepts, ...masterDepts]) {
    const status = statusByDept.get(key);
    const applied = appliedByDept.get(key);
    const hasCatalogBonus = catalogDeptKeys === null || catalogDeptKeys.has(key);
    let deptStatus = (status?.status ?? 'draft') as KpiDeptStatus;
    if (deptStatus === 'draft' && !hasCatalogBonus && (applied?.employee_count ?? 0) === 0) {
      deptStatus = 'no_bonus';
    }
    if (paused.has(key)) deptStatus = 'excluded';
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
  // Pausing the Hogan Smith Law payroll department pauses every sub-dept with it —
  // they stay listed but read 'excluded'.
  for (const key of HSL_DEPT_KEYS as readonly HslDeptKey[]) {
    const hslExcluded = paused.has('hogan_smith_law') || paused.has(key);
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
      status: hslExcluded ? 'excluded' : !due ? 'na' : ((status?.status ?? 'draft') as KpiDeptStatus),
      scoredCount: agg?.scoredCount ?? 0,
      employeeCount: agg?.employeeCount ?? 0,
      totalBonus: Math.round(agg?.totalBonus ?? 0),
      updatedAt: status?.updated_at ?? null,
      lockedBy: status?.locked_by ?? null,
    });
  }

  // Sort: not-ready first (draft before ready before locked before n/a), then
  // by name — so what still needs attention floats to the top. Excluded
  // departments sink to the bottom: nothing to do there until re-enabled.
  const rank: Record<KpiDeptStatus, number> = { draft: 0, ready: 1, locked: 2, no_bonus: 3, na: 4, excluded: 5 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  return out;
}

// ── Missing rates (current-week Hubstaff workers, USEE excluded) ──────────────

/**
 * Normalize a master-list "Start Date" cell to a `YYYY-MM-DD` calendar date, so
 * it can be compared against the week key and rendered without a timezone shift.
 * The column is free text (it comes off the sheet), so three shapes are handled;
 * anything else returns null rather than a guess.
 */
function normalizeStartDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Already a date (or a timestamp) — take the calendar-date prefix verbatim.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Sheet exports write M/D/YYYY. Native Date parsing of that is locale-dependent
  // on Node ("5/4/2026" can read as April 5), so parse the parts explicitly.
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const year = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // Spelled-out forms ("July 20, 2026") parse to LOCAL midnight, so local getters
  // read back the same calendar date that was written.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toIsoDate(d);
}

/** Name → comparable token set: lowercased words, with the master list's
 *  surname-first commas, quoted nicknames and curly quotes stripped. So
 *  `Zambas, Alehzandra "Alexa"` → {zambas, alehzandra, alexa}, which a Hubstaff
 *  "Alexa Zambas" is a subset of. */
function nameTokens(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .toLowerCase()
      .replace(/["“”'’,.]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Fill in department / start date for missing-rate rows the ACTIVE roster
 * couldn't resolve, reading `global_master_list` directly.
 *
 * The roster snapshot readiness scores against is `active_employees`, which by
 * design drops anyone off-boarded or missed by the last sheet sync — and those
 * are exactly the people who pile up on this list (they have hours but no rate
 * precisely because nothing links them to a department any more). Verified
 * against the Jul 5–11 week, where all five no-rate rows were invisible to the
 * active view: four off-boarded mid-week, one (alehzandra@ vs alehzandraz@) whose
 * Hubstaff address never matched her master row at all.
 *
 * Two passes, most-trustworthy first: every email alias on the master row, then
 * — only for a row still unresolved — a name-token match that must land on
 * exactly ONE person. This is display-only enrichment (it never moves a number
 * or the score), so on a read failure the columns just stay blank.
 */
async function enrichMissingRatesFromMaster(missing: ReadinessMissingRate[]): Promise<void> {
  const unresolved = missing.filter((m) => !m.department || !m.startDate);
  if (unresolved.length === 0) return;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;

  const FULL =
    'Department,Name,"Start Date","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2",off_boarded_at,last_seen_upload_id';
  const BASE = 'Department,Name,"Start Date","Work Email","Personal Email",off_boarded_at';
  type MasterRow = Record<string, unknown>;

  const readAll = async (sel: string): Promise<MasterRow[] | null> => {
    const PAGE = 1000;
    const out: MasterRow[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('global_master_list')
        .select(sel)
        .range(from, from + PAGE - 1);
      if (error) return null;
      const page = (data ?? []) as unknown as MasterRow[];
      out.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    return out;
  };

  // The alternate-email + last_seen_upload_id columns post-date the original
  // table, so fall back to the base projection rather than losing the whole read.
  const rows = (await readAll(FULL)) ?? (await readAll(BASE));
  if (!rows || rows.length === 0) return;

  const str = (v: unknown): string | null => {
    const s = v == null ? '' : String(v).trim();
    return s ? s : null;
  };

  interface Candidate {
    department: string | null;
    startDate: string | null;
    offBoardedAt: string | null;
    tokens: Set<string>;
    /** Sort key for picking between duplicate rows for the same person. */
    seenId: number;
  }
  // Prefer a row that is still active, then the one seen in the latest upload:
  // the master list carries duplicate person rows (and recycled work emails),
  // and a live row describes the person better than a historical one. Active
  // beats off-boarded OUTRIGHT — never let a stale row win on `seenId`.
  const better = (a: Candidate, b: Candidate): boolean => {
    const aLive = a.offBoardedAt === null;
    const bLive = b.offBoardedAt === null;
    if (aLive !== bLive) return aLive;
    return a.seenId > b.seenId;
  };

  const byEmail = new Map<string, Candidate>();
  const candidates: Candidate[] = [];
  for (const rawRow of rows) {
    // Effective department (Sales/Sales-Assistant email split) so exception
    // rows label and pause-filter on the person's real department.
    const r = applyDeptOverrideToRawRow(rawRow);
    const seen = Number(r['last_seen_upload_id'] ?? 0);
    const c: Candidate = {
      department: str(r['Department']),
      startDate: normalizeStartDate(str(r['Start Date'])),
      offBoardedAt: normalizeStartDate(str(r['off_boarded_at'])),
      tokens: nameTokens(str(r['Name'])),
      seenId: Number.isFinite(seen) ? seen : 0,
    };
    candidates.push(c);
    for (const col of [
      'Work Email',
      'Personal Email',
      'Alternate Work Email',
      'Alternate Work Email 2',
    ]) {
      const em = normEmail(str(r[col]) ?? '');
      if (!em) continue;
      const cur = byEmail.get(em);
      if (!cur || better(c, cur)) byEmail.set(em, c);
    }
  }

  for (const m of unresolved) {
    let hit = m.email ? byEmail.get(normEmail(m.email) ?? '') ?? null : null;
    if (!hit) {
      // Last resort: the Hubstaff display name. Only accepted when exactly one
      // person matches — a near-miss must leave the columns blank rather than
      // attribute someone else's department to this row.
      const want = nameTokens(m.name);
      if (want.size >= 2) {
        const matches = candidates.filter((c) => [...want].every((t) => c.tokens.has(t)));
        const distinct = new Map<string, Candidate>();
        for (const c of matches) {
          // Same person, duplicated across master rows → collapse on the name
          // token set so the uniqueness test below counts PEOPLE, not rows.
          const key = [...c.tokens].sort().join(' ');
          const cur = distinct.get(key);
          if (!cur || better(c, cur)) distinct.set(key, c);
        }
        if (distinct.size === 1) hit = [...distinct.values()][0];
      }
    }
    if (!hit) continue;
    m.department = m.department ?? hit.department;
    m.startDate = m.startDate ?? hit.startDate;
    m.offBoardedAt = hit.offBoardedAt;
  }
}

async function buildMissingRates(
  sourceFile: string | null,
  /** The active master roster, fetched ONCE by getPayrollReadiness and shared
   *  with the bank check — one snapshot, no double read, no drift. */
  employees: EmployeeRow[],
  excludeIdentities: Set<string>,
  /** True when a raw department label belongs to a pay-paused department —
   *  its workers leave both the missing list AND the denominator, so the
   *  score re-curves over the people actually being paid. */
  isPausedDept: (dept: string | null | undefined) => boolean,
  /** The pay week in view (see `weekKeyFromSourceFile`). Only used to label a
   *  missing-rate row as recently onboarded. */
  weekStart: string,
): Promise<{
  rows: ReadinessMissingRate[];
  workerCount: number;
  /** Every normalized email (all master-roster aliases) of everyone with hours
   *  in the week's Hubstaff upload — the "being paid this week" identity set
   *  the bank check uses to split hard blockers from roster hygiene. Built
   *  from ALL distinct workers on the file (before the rate-denominator
   *  exclusions): an off-channel/paused/excepted person is never in the bank
   *  list anyway, so the extra keys can't mislabel anyone. */
  payrollEmails: Set<string>;
  /** Human-readable notes for reads that failed (see PayrollReadiness.degraded). */
  degraded: string[];
}> {
  // The workers considered are exactly the week-in-view's Hubstaff roster: the
  // named file when the wizard is on a specific (possibly replayed) week, else
  // the live `is_current` upload.
  let hubstaffRows: Awaited<ReturnType<typeof fetchHubstaffRowsOrdered>>['rows'] = [];
  try {
    ({ rows: hubstaffRows } = sourceFile
      ? await fetchHubstaffRowsBySourceFile(sourceFile)
      : await fetchHubstaffRowsOrdered());
  } catch {
    // MUST be reported, never swallowed: with no Hubstaff roster the rate
    // check reads clear (0 of 0) and the bank check loses its payday-blocker
    // signal — both make the score LOOK BETTER exactly when the data broke.
    return {
      rows: [],
      workerCount: 0,
      payrollEmails: new Set(),
      degraded: [
        "Hubstaff hours couldn't be read — the pay-rate check and this week's payday-blocker detection were skipped.",
      ],
    };
  }

  const rateCtx = await loadPeopleRateContext();
  // Master roster: work→personal alias sets + department, so a Hubstaff row
  // keyed on the work email resolves via every alias the person owns (the
  // People roster's exact behaviour).
  const aliasesByEmail = new Map<string, string[]>();
  const deptByEmail = new Map<string, string | null>();
  const startDateByEmail = new Map<string, string | null>();
  for (const e of employees) {
    const aliases = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map((a) => normEmail(a ?? ''))
      .filter(Boolean) as string[];
    for (const a of aliases) {
      if (!aliasesByEmail.has(a)) aliasesByEmail.set(a, aliases);
      if (!deptByEmail.has(a)) deptByEmail.set(a, e.department ?? null);
      // First-wins, like the department above: the master list carries duplicate
      // person rows, and the first one is the same row the dept came from.
      if (!startDateByEmail.has(a)) startDateByEmail.set(a, normalizeStartDate(e.start_date));
    }
  }

  // "Recently onboarded" = started no earlier than the week BEFORE the week in
  // view. Anyone who started IN the week in view and is still in the onboarding
  // pipeline is already an exception (`started_this_week`) and never reaches this
  // list; what's left is the hire whose first full week is being paid right now
  // and whose Payment Catalog rate was never set. No upper bound — a start date
  // past this week is even more clearly a brand-new row.
  const recentStartCutoff = (() => {
    const d = parseLocalIso(weekStart);
    if (!d) return null;
    return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7));
  })();

  const workers = rowsToPayrollRows(hubstaffRows);
  const seen = new Set<string>();
  const missing: ReadinessMissingRate[] = [];
  const payrollEmails = new Set<string>();
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

    // "Being paid this week" identity set — every alias, recorded BEFORE the
    // exclusions below (see the return-type note on why that's safe).
    if (email) payrollEmails.add(email);
    for (const a of aliases) payrollEmails.add(a);

    // USEE / US Employees are paid off-channel, so a missing hourly rate isn't a
    // payroll blocker for them — skip them from BOTH the list and the considered
    // count (mirrors the missing-bank list's off-channel exclusion) so the stat
    // stays honest.
    if (isOffChannelDept(dept)) continue;

    // Departments excluded from this week's pay (wizard Configuration tab)
    // aren't being paid, so their people can't block readiness either.
    if (isPausedDept(dept)) continue;

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
      missing.push({
        name,
        email: email || null,
        department: dept,
        startDate: (email && startDateByEmail.get(email)) ?? null,
        // Both stamped below, once the master-list fallback has had its say.
        recentlyOnboarded: false,
        offBoardedAt: null,
      });
    }
  }

  // Backfill department / start date for the rows the active roster couldn't
  // resolve, THEN decide who's a new hire — the enriched date is usually the
  // only one there is (a brand-new or just-left worker is exactly who the active
  // view misses).
  await enrichMissingRatesFromMaster(missing);
  for (const m of missing) {
    m.recentlyOnboarded = Boolean(
      m.startDate && recentStartCutoff && m.startDate >= recentStartCutoff,
    );
  }
  missing.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: missing, workerCount, payrollEmails, degraded: [] };
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
  /** See {@link buildMissingRates} — the shared roster snapshot. */
  employees: EmployeeRow[],
  excludeIdentities: Set<string>,
  /** See {@link buildMissingRates} — pay-paused departments leave the bank
   *  list and its denominator alike. */
  isPausedDept: (dept: string | null | undefined) => boolean,
): Promise<{
  rows: ReadinessMissingBank[];
  eligibleCount: number;
  /** Per eligible person, their normalized emails — so the composer can count
   *  how many of them are on this week's payroll (the score's bank denominator)
   *  by intersecting with the Hubstaff identity set. */
  eligibleEmails: string[][];
  degraded: string[];
}> {
  const [idsRes, ratesRes] = await Promise.all([
    getEmployeeIds().catch(() => ({ rows: [], error: 'unreachable' })),
    // The legacy rates-sheet row is Payment Dispatch's fallback for both the
    // processor (the free-text `bank_preferred` cell) and the hurupay/higlobe
    // emails — completeness must judge with the same fallbacks or this list
    // flags people the dispatch queue pays fine. On error we still judge
    // without the extras (fail toward over-flagging, the safe direction) but
    // the outage is REPORTED so an over-flagged list is never mistaken for a
    // real regression.
    getEmployeeHourlyRatesRows().catch(() => ({ rows: [], error: 'unreachable' })),
  ]);

  const degraded: string[] = [];
  if (idsRes.error) {
    degraded.push(
      'Payout records (employee_ids) couldn’t be read — everyone reads as missing bank info until it recovers.',
    );
  }
  if (ratesRes.error) {
    degraded.push(
      'The legacy rates sheet couldn’t be read — bank completeness was judged without its fallbacks and may over-flag.',
    );
  }

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
  const eligibleEmails: string[][] = [];
  let eligibleCount = 0;
  for (const e of employees) {
    if (isOffChannelDept(e.department)) continue;
    if (isPausedDept(e.department)) continue;
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
    eligibleEmails.push([w, p].filter((e): e is string => Boolean(e)));

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
      // Stamped for real by getPayrollReadiness once the week's Hubstaff
      // identity set is in hand — this fn only knows the roster.
      onPayroll: false,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { rows: out, eligibleCount, eligibleEmails, degraded };
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
): Promise<{ rows: ReadinessException[]; identities: Set<string>; degraded: string[] }> {
  let rows: Awaited<ReturnType<typeof listHrPendingEmployees>>['rows'] = [];
  try {
    ({ rows } = await listHrPendingEmployees());
  } catch {
    // Reported: with no exception identities, expected non-payments (onboarding
    // hires) leak back into the rate/bank checks and cost points they shouldn't.
    return {
      rows: [],
      identities: new Set(),
      degraded: [
        'Onboarding records couldn’t be read — expected non-payments may be counted against readiness.',
      ],
    };
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
  return { rows: out, identities, degraded: [] };
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
  const {
    weekStart,
    sourceFile: resolvedFile,
    degraded: weekDegraded,
  } = await resolveCurrentWeek(sourceFile);
  const isMonthlyPayWeek = isFinalPayrollWeekOfMonth(weekStart);

  // Departments excluded from THIS pay week (the wizard's step-1 Configuration
  // tab — keyed per Hubstaff source file, so the exclusion never outlives its
  // week). They leave every readiness dimension — numerators AND denominators —
  // so the score describes only the departments actually being paid, and a new
  // week's upload snaps everything back automatically. Best-effort reads: a
  // settings/registry failure must never take readiness down, it just skips
  // the exclusion (and is REPORTED via `degraded`).
  //
  // The active master roster is fetched ONCE here and shared by the KPI
  // (department universe), rate (aliases), and bank (population) checks — one
  // consistent snapshot instead of three racing reads.
  const [pausedRaw, registry, rosterRes, exceptionsRes] = await Promise.all([
    resolvedFile
      ? getAppSetting(deptPayPausedSettingKey(resolvedFile)).catch(() => undefined)
      : Promise.resolve(null),
    getDepartmentRegistry().catch(() => null),
    getEmployeesForAuthorizedServerRoute().catch(() => ({
      employees: [] as EmployeeRow[],
      error: 'unreachable',
    })),
    buildExceptions(weekStart),
  ]);

  const degraded: string[] = [...weekDegraded, ...exceptionsRes.degraded];
  if (pausedRaw === undefined) {
    degraded.push(
      'The pay-week Configuration (excluded departments) couldn’t be read — exclusions were not applied this load.',
    );
  }
  if (registry === null) {
    degraded.push('The department registry couldn’t be read — in-app departments may be missing from the KPI list.');
  }
  if (rosterRes.error && rosterRes.employees.length === 0) {
    degraded.push(
      'The employee roster couldn’t be read — bank-info coverage and department visibility are incomplete.',
    );
  }
  const employees = rosterRes.employees;
  const registrySafe = registry ?? ([] as DepartmentRegistryEntry[]);

  const pausedDeptKeys = parsePausedDeptKeys(pausedRaw ?? null);
  const isPausedDept = (dept: string | null | undefined): boolean => {
    if (pausedDeptKeys.size === 0) return false;
    // Same key derivation as the KPI dept list: master-list-only labels
    // ("Manager") have no built-in/registry key, so they pause by their
    // derived slug — otherwise their people stay on the rate/bank lists
    // even though the whole department is excluded from this pay week.
    const key = resolveDeptKeyWithRegistry(dept, registrySafe) ?? (dept?.trim() ? slugifyDeptKey(dept) : null);
    return !!key && pausedDeptKeys.has(key);
  };

  // The department universe the KPI list must cover = every distinct label on
  // the master roster (matches the Payroll Wizard, which tabs every dept).
  const masterDeptLabels = [
    ...new Set(employees.map((e) => (e.department ?? '').trim()).filter(Boolean)),
  ];

  // The exceptions' identity set feeds the rate/bank checks so an expected
  // non-payment (onboarding / no-show / started-this-week) never costs points
  // on ANY score dimension. KPI is per-department, so it needs no per-person
  // exclusion.
  const { identities: exceptionIdentities } = exceptionsRes;
  // Pay-paused departments' hires are expected non-payments of a different
  // kind — the whole department is off — so they don't clutter the list.
  const exceptions = exceptionsRes.rows.filter((r) => !isPausedDept(r.department));

  const [kpi, ratesRes, bankRes] = await Promise.all([
    buildKpiReadiness(weekStart, isMonthlyPayWeek, registrySafe, pausedDeptKeys, masterDeptLabels),
    buildMissingRates(resolvedFile, employees, exceptionIdentities, isPausedDept, weekStart),
    buildMissingBank(employees, exceptionIdentities, isPausedDept),
  ]);
  degraded.push(...ratesRes.degraded, ...bankRes.degraded);

  // Split the missing-bank list by severity: someone with hours in THIS WEEK's
  // upload is about to not get paid (hard blocker — pins the score's bank
  // dimension); the rest is roster hygiene. Matched on either email — the
  // payroll set carries every master-roster alias, so an alt-work-email
  // Hubstaff row still connects to the person's work/personal identity here.
  const onWeekPayroll = (r: ReadinessMissingBank): boolean =>
    [r.workEmail, r.personalEmail].some((e) => {
      const em = normEmail(e);
      return !!em && ratesRes.payrollEmails.has(em);
    });
  const missingBank = bankRes.rows
    .map((r) => ({ ...r, onPayroll: onWeekPayroll(r) }))
    // Blockers surface first so the list starts with the people whose payday
    // is actually at stake this week; names stay alphabetical within groups.
    .sort((a, b) => Number(b.onPayroll) - Number(a.onPayroll) || a.name.localeCompare(b.name));
  const missingBankOnPayroll = missingBank.reduce((n, r) => n + (r.onPayroll ? 1 : 0), 0);

  // The score's bank denominator: eligible roster people who are actually being
  // PAID this week (any alias with hours in the week's Hubstaff file). The full
  // `eligibleCount` stays on the payload for the roster-hygiene list's "X of Y"
  // framing, but it must not shape the score — someone we aren't paying this
  // week can't block this week's payroll.
  const bankOnPayrollCount = bankRes.eligibleEmails.reduce(
    (n, aliases) => n + (aliases.some((e) => ratesRes.payrollEmails.has(e)) ? 1 : 0),
    0,
  );

  // KPI due/submitted for the score: monthly depts not due this week ('na') and
  // departments switched out of this week's pay ('excluded') are dropped from
  // the denominator; everything else is due, and "submitted" means the manager
  // marked it ready/locked — or there is no bonus configured for the dept at
  // all ('no_bonus'), which is Ready by definition.
  const kpiDue = kpi.filter((d) => d.status !== 'na' && d.status !== 'excluded').length;
  const kpiSubmitted = kpi.filter(
    (d) => d.status === 'ready' || d.status === 'locked' || d.status === 'no_bonus',
  ).length;

  // The score judges ONLY the people we need to pay THIS WEEK. Rates and KPI
  // are already payroll-scoped (this week's Hubstaff workers; due departments).
  // Bank joins them here: the numerator is the missing-bank people ON this
  // week's payroll, over the on-payroll denominator — the roster-hygiene rows
  // (missing bank but not being paid this week) stay VISIBLE in the list but
  // never move the score, exactly like excluded departments and onboarding
  // exceptions.
  let score = computeReadinessScore({
    workerCount: ratesRes.workerCount,
    missingRates: ratesRes.rows.length,
    kpiDue,
    kpiSubmitted,
    bankEligibleCount: bankOnPayrollCount,
    missingBank: missingBankOnPayroll,
    missingBankOnPayroll,
  });
  // A partial load must never paint the dashboard green: dimensions judged on
  // missing data read BETTER, not worse (an unreadable Hubstaff file zeroes the
  // rate check; an unreadable roster empties the bank list). The pure scorer
  // stays honest about the numbers it was given — this cap is the composer
  // saying "the numbers themselves are suspect".
  if (degraded.length > 0 && score.grade === 'ready') {
    score = { ...score, grade: 'at_risk' };
  }

  return {
    weekStart,
    weekLabel: weekRangeLabel(weekStart),
    isMonthlyPayWeek,
    sourceFile: resolvedFile,
    kpi,
    missingRates: ratesRes.rows,
    missingBank,
    exceptions,
    workerCount: ratesRes.workerCount,
    bankEligibleCount: bankRes.eligibleCount,
    bankOnPayrollCount,
    missingBankOnPayroll,
    degraded,
    score,
  };
}
