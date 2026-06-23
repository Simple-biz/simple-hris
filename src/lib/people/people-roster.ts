import 'server-only';

import { normEmail } from '@/lib/email/norm-email';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { buildFxRates, phpPerUnit, type FxRates } from '@/lib/fx/currency-fx';
import { listPayStructures } from '@/lib/supabase/pay-structures-db';
import {
  buildCatalogRateIndex,
  resolveEmployeeCatalogRate,
  resolveDeptCatalogRate,
  type CatalogRateIndex,
} from '@/lib/payroll/resolve-rate';
import { listHubstaffUploads, fetchHubstaffRowsBySourceFile, rowsToPayrollRows } from '@/lib/supabase/hubstaff-hours-db';
import { parseDateRangeFromFilename, payWeekFromUploadStart } from '@/lib/hubstaff/calendar-column-dedupe';
import { projectOvertime } from './overtime-projection';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';

/** Pay rate resolved for one person, shown in their NATIVE currency. */
export interface PeopleRate {
  regular: number | null;
  ot: number | null;
  currency: PayCurrency;
  /** Which layer the rate came from (catalog individual → sheet → department base). */
  source: 'employee' | 'sheet' | 'department' | null;
}

/** Hours worked this pay week + overtime monitoring. */
export interface PeopleHours {
  thisWeek: number;
  ot: number;
  weekStart: string | null;
  weekEnd: string | null;
  inProgress: boolean;
  projectedHours: number | null;
  projectedOt: number | null;
}

export interface PeopleRosterRow {
  employee_id: string | null;
  name: string | null;
  work_email: string | null;
  department: string | null;
  rate: PeopleRate;
  hours: PeopleHours;
  processor: string | null;
  hasBanking: boolean;
}

/** Week-level KPI rollups for the People tab cards (scoped to the resolved week). */
export interface PeopleSummary {
  /** Active employees with any overtime (>40h) this week. */
  otEmployees: number;
  /** Total overtime hours across everyone this week. */
  otHours: number;
  /** Estimated OT payout this week, PHP-equivalent (regular+OT engine parity not
   *  applied — this is OT hours × resolved OT rate, summed). */
  otPayoutPhp: number;
  /** Same payout converted to USD at the current FX rate (null if FX missing). */
  otPayoutUsd: number | null;
}

function parseRate(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isoOf(d: Date | null): string | null {
  if (!d) return null;
  const p2 = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Shared rate-resolution context — mirrors the live dispatch (current-pay.ts /
 *  disbursement-reports.ts) so the People tab shows the same rate payroll uses. */
export interface PeopleRateContext {
  fx: FxRates;
  catalogIndex: CatalogRateIndex;
  /** email → sheet rate (PHP) from employee_hourly_rates. */
  rateByEmail: Map<string, { reg: number | null; ot: number | null }>;
}

export async function loadPeopleRateContext(): Promise<PeopleRateContext> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();

  const [fxRes, payStructuresRes, ratesRes] = await Promise.all([
    supabase
      ? supabase.from('app_settings').select('key,value').in('key', ['usd_to_php_rate', 'usd_to_cop_rate'])
      : Promise.resolve({ data: null }),
    listPayStructures(),
    supabase ? supabase.from('employee_hourly_rates').select('*') : Promise.resolve({ data: null }),
  ]);

  const fxValues: Record<string, string | null> = {};
  for (const r of ((fxRes as { data: { key: string; value: string | null }[] | null }).data ?? [])) {
    fxValues[r.key] = r.value;
  }
  const fx = buildFxRates(fxValues);
  const catalogIndex = buildCatalogRateIndex(payStructuresRes.structures);

  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  for (const r of (((ratesRes as { data: Record<string, unknown>[] | null }).data) ?? [])) {
    const we = normEmail(r['Work Email'] as string | null);
    const pe = normEmail(r['Personal Email'] as string | null);
    const entry = { reg: parseRate(r['Regular Rate'] as string | number | null), ot: parseRate(r['OT Rate'] as string | number | null) };
    if (we) rateByEmail.set(we, entry);
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
  }

  return { fx, catalogIndex, rateByEmail };
}

/**
 * Resolve one person's effective NATIVE pay rate using the same priority as the
 * payroll engine: individual catalog → sheet → department base. The catalog
 * carries its own currency; the sheet/department-PHP path is PHP.
 */
export function resolvePeopleRate(
  ctx: PeopleRateContext,
  emails: string[],
  department: string | null,
): PeopleRate {
  const empCat = resolveEmployeeCatalogRate(ctx.catalogIndex, emails, ctx.fx);
  if (empCat) {
    return { regular: empCat.regNative, ot: empCat.otNative, currency: empCat.currency, source: 'employee' };
  }
  for (const e of emails) {
    const em = normEmail(e);
    const sheet = em ? ctx.rateByEmail.get(em) : undefined;
    if (sheet && (sheet.reg != null || sheet.ot != null)) {
      return { regular: sheet.reg, ot: sheet.ot, currency: 'PHP', source: 'sheet' };
    }
  }
  const deptCat = resolveDeptCatalogRate(ctx.catalogIndex, department, ctx.fx);
  if (deptCat) {
    return { regular: deptCat.regNative, ot: deptCat.otNative, currency: deptCat.currency, source: 'department' };
  }
  return { regular: null, ot: null, currency: 'PHP', source: null };
}

/** Hours-this-week map keyed by every alias email, plus the resolved pay-week windows. */
interface HoursContext {
  sourceFile: string | null;
  byEmail: Map<string, number>;
  payWeekHsl: { start: Date; end: Date } | null;
  payWeekNonHsl: { start: Date; end: Date } | null;
}

async function loadHoursContext(requestedSourceFile?: string | null): Promise<HoursContext> {
  let sourceFile: string | null = null;
  const requested = (requestedSourceFile ?? '').trim();
  if (requested) {
    // Explicit week chosen via the CSV period selector.
    sourceFile = requested;
  } else {
    try {
      const uploads = await listHubstaffUploads();
      const current = uploads.find((u) => u.is_current) ?? uploads[0];
      sourceFile = current?.source_file ?? null;
    } catch {
      sourceFile = null;
    }
  }
  if (!sourceFile) return { sourceFile: null, byEmail: new Map(), payWeekHsl: null, payWeekNonHsl: null };

  const range = parseDateRangeFromFilename(sourceFile);
  const payWeekHsl = range ? payWeekFromUploadStart(range.start, true) : null;
  const payWeekNonHsl = range ? payWeekFromUploadStart(range.start, false) : null;

  const byEmail = new Map<string, number>();
  try {
    const { rows } = await fetchHubstaffRowsBySourceFile(sourceFile);
    for (const pr of rowsToPayrollRows(rows)) {
      const em = normEmail(pr.email ?? '');
      if (em) byEmail.set(em, pr.hoursDecimal);
    }
  } catch {
    /* no rows — everyone shows 0 hours */
  }
  return { sourceFile, byEmail, payWeekHsl, payWeekNonHsl };
}

/**
 * The full People roster: one row per active employee with rate, hours-this-week,
 * overtime projection, preferred processor, and a has-banking flag.
 */
const EMPTY_SUMMARY: PeopleSummary = { otEmployees: 0, otHours: 0, otPayoutPhp: 0, otPayoutUsd: 0 };

export async function buildPeopleRoster(sourceFile?: string | null): Promise<{
  rows: PeopleRosterRow[];
  sourceFile: string | null;
  summary: PeopleSummary;
  error: string | null;
}> {
  const [{ employees, error }, rateCtx, hoursCtx, idsRes] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
    loadHoursContext(sourceFile),
    getEmployeeIds(),
  ]);
  if (error) return { rows: [], sourceFile: null, summary: EMPTY_SUMMARY, error };

  // employee_ids → processor + has-banking, keyed by every known email.
  const idByEmail = new Map<string, { processor: string | null; hasBanking: boolean }>();
  for (const r of idsRes.rows) {
    const hasBanking = !!(
      r.account_number || r.alt_account_number || r.hurupay_email || r.wepay_email ||
      r.higlobe_email || r.wise_email || r.wise_tag || r.phone_number
    );
    const info = { processor: r.preferred_processor ?? null, hasBanking };
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) idByEmail.set(em, info);
    }
  }

  const today = new Date();

  // Collapse multiple global_master_list rows for the SAME person (e.g. someone
  // listed under two departments because an old dept row was never removed) into
  // ONE roster row. Identity key mirrors the Rates & Profiles card
  // (`personCardKey`): work email, falling back to personal email then name, and
  // qualified by name so a RECYCLED work email inherited by a different person
  // stays a separate row. First occurrence wins. Without this, two rows share a
  // work email and React throws a duplicate-key warning in the People table.
  const seenPerson = new Set<string>();
  const uniqueEmployees = employees.filter((e) => {
    const w = normEmail(e.work_email ?? '');
    const p = normEmail(e.personal_email ?? '');
    const n = (e.name ?? '').trim().toLowerCase();
    const base = w || p || n;
    if (!base) return true; // no identity at all — keep (can't dedupe safely)
    const key = `${base}|${n}`;
    if (seenPerson.has(key)) return false;
    seenPerson.add(key);
    return true;
  });

  const rows: PeopleRosterRow[] = uniqueEmployees.map((e) => {
    const aliases = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map((a) => normEmail(a ?? ''))
      .filter(Boolean) as string[];

    const isHsl = (e.department ?? '').trim().toLowerCase() === 'hsl';
    const rate = resolvePeopleRate(rateCtx, aliases, e.department ?? null);

    let hoursThisWeek = 0;
    for (const em of aliases) {
      const h = hoursCtx.byEmail.get(em);
      if (h != null) { hoursThisWeek = h; break; }
    }
    const payWeek = isHsl ? hoursCtx.payWeekHsl : hoursCtx.payWeekNonHsl;
    const proj = projectOvertime(hoursThisWeek, payWeek?.start ?? null, payWeek?.end ?? null, today);

    const idInfo = aliases.map((em) => idByEmail.get(em)).find(Boolean) ?? null;

    return {
      employee_id: e.employee_id ?? null,
      name: e.name ?? null,
      work_email: e.work_email ?? null,
      department: e.department ?? null,
      rate,
      hours: {
        thisWeek: proj.hoursSoFar,
        ot: proj.otSoFar,
        weekStart: isoOf(payWeek?.start ?? null),
        weekEnd: isoOf(payWeek?.end ?? null),
        inProgress: proj.inProgress,
        projectedHours: proj.projectedHours,
        projectedOt: proj.projectedOt,
      },
      processor: idInfo?.processor ?? null,
      hasBanking: idInfo?.hasBanking ?? false,
    };
  });

  // Stable, scannable order: by name.
  rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  // Week-level OT KPIs. Payout = OT hours × the resolved OT rate (converted to
  // PHP-equivalent), summed — an estimate that mirrors the per-row rate display.
  let otEmployees = 0;
  let otHours = 0;
  let otPayoutPhp = 0;
  for (const r of rows) {
    if (r.hours.ot > 0) {
      otEmployees += 1;
      otHours += r.hours.ot;
      if (r.rate.ot != null) {
        otPayoutPhp += r.hours.ot * r.rate.ot * phpPerUnit(r.rate.currency, rateCtx.fx);
      }
    }
  }
  const fxRate = rateCtx.fx.usdToPhp;
  const summary: PeopleSummary = {
    otEmployees,
    otHours: Math.round(otHours * 10) / 10,
    otPayoutPhp: Math.round(otPayoutPhp * 100) / 100,
    otPayoutUsd: fxRate > 0 ? Math.round((otPayoutPhp / fxRate) * 100) / 100 : null,
  };

  return { rows, sourceFile: hoursCtx.sourceFile, summary, error: null };
}

/**
 * One person's OT — powers the Statistics-tab leaderboard, which can be ranked
 * by OT hours or OT pay. Used both for a SINGLE week's ranked list (carried on
 * each {@link PeopleStatsPoint}) and for the cross-week aggregate. Only people
 * who rendered OT appear, so the table is "OT only" by construction.
 */
export interface PeopleStatsLeader {
  name: string | null;
  email: string | null;
  /** OT hours (this week, or summed across the period for the aggregate). */
  otHours: number;
  /** OT pay, PHP-equivalent of the resolved OT rate. */
  otPayoutPhp: number;
  /** Same value normalised to USD at the current FX (null if no FX). */
  otPayoutUsd: number | null;
  /** Weeks on OT — 1 for a single-week row, the count for the aggregate. */
  weeks: number;
}

/** One week's point in the Statistics line graph. */
export interface PeopleStatsPoint {
  sourceFile: string;
  weekStart: string;
  weekEnd: string;
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  /** Every OT renderer this week, most OT hours first (top 5 feed the tooltip). */
  leaders: PeopleStatsLeader[];
  /** Per-department OT for this week — powers the department trend line graph. */
  depts: PeopleStatsDept[];
}

/**
 * One department's OT — powers the Statistics-tab "OT by department" breakdown,
 * which surfaces who's paid the most OT and who logs the most OT hours. Used for
 * both a single week and the cross-week aggregate.
 */
export interface PeopleStatsDept {
  department: string;
  otHours: number;
  otPayoutPhp: number;
  otPayoutUsd: number | null;
  /** Distinct people on OT in this department. */
  people: number;
}

/**
 * A single person cannot log more hours than physically exist in a payroll week
 * (a ≤8-day window has at most 8 × 24 = 192). Hubstaff exports append a
 * grand-total summary row that sums every member's hours; parsed as a person it
 * shows tens of thousands of OT hours and tops the "Top OT renderers" list (and
 * inflates the OT-hours total / on-OT headcount). Any row above this ceiling is
 * a data artifact, never a real week, so it is dropped from the stats.
 */
const MAX_PLAUSIBLE_WEEKLY_HOURS = 192;

type PeopleOtPerPerson = {
  name: string | null;
  email: string | null;
  department: string;
  otHours: number;
  payoutPhp: number;
};

/** email → OT rate (PHP-equivalent), resolved once and reused for every week. */
function buildOtRateByEmail(
  employees: Awaited<ReturnType<typeof getEmployeesForAuthorizedServerRoute>>['employees'],
  rateCtx: Awaited<ReturnType<typeof loadPeopleRateContext>>,
): Map<string, number> {
  const otRateByEmail = new Map<string, number>();
  for (const e of employees) {
    const aliases = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map((a) => normEmail(a ?? ''))
      .filter(Boolean) as string[];
    const rate = resolvePeopleRate(rateCtx, aliases, e.department ?? null);
    const otPhp = rate.ot != null ? rate.ot * phpPerUnit(rate.currency, rateCtx.fx) : 0;
    for (const em of aliases) if (!otRateByEmail.has(em)) otRateByEmail.set(em, otPhp);
  }
  return otRateByEmail;
}

/** email → HRIS department, so OT can be grouped by the same departments the roster uses. */
function buildDeptByEmail(
  employees: Awaited<ReturnType<typeof getEmployeesForAuthorizedServerRoute>>['employees'],
): Map<string, string> {
  const deptByEmail = new Map<string, string>();
  for (const e of employees) {
    const dept = (e.department ?? '').trim();
    if (!dept) continue;
    for (const a of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
      const em = normEmail(a ?? '');
      if (em && !deptByEmail.has(em)) deptByEmail.set(em, dept);
    }
  }
  return deptByEmail;
}

/** Roll a flat list of OT people up into per-department totals (distinct headcount). */
function aggregateDepts(people: PeopleOtPerPerson[], fxRate: number): PeopleStatsDept[] {
  const map = new Map<string, { otHours: number; payoutPhp: number; ids: Set<string> }>();
  for (const p of people) {
    const dept = (p.department || 'Unknown').trim() || 'Unknown';
    const cur = map.get(dept) ?? { otHours: 0, payoutPhp: 0, ids: new Set<string>() };
    cur.otHours += p.otHours;
    cur.payoutPhp += p.payoutPhp;
    cur.ids.add(normEmail(p.email ?? '') || (p.name ?? '').trim().toLowerCase());
    map.set(dept, cur);
  }
  return Array.from(map.entries())
    .map(([department, v]) => ({
      department,
      otHours: Math.round(v.otHours * 10) / 10,
      otPayoutPhp: Math.round(v.payoutPhp * 100) / 100,
      otPayoutUsd: fxRate > 0 ? Math.round((v.payoutPhp / fxRate) * 100) / 100 : null,
      people: v.ids.size,
    }))
    .sort((a, b) => (b.otPayoutUsd ?? b.otPayoutPhp ?? 0) - (a.otPayoutUsd ?? a.otPayoutPhp ?? 0));
}

/**
 * Reduce one week's raw Hubstaff rows to its OT totals, the ranked renderer list
 * (most OT hours first), and the per-department breakdown. Drops the grand-total
 * summary row and any other physically-impossible outlier (see
 * {@link MAX_PLAUSIBLE_WEEKLY_HOURS}).
 */
function computeWeekOt(
  rows: Record<string, unknown>[],
  otRateByEmail: Map<string, number>,
  deptByEmail: Map<string, string>,
  fxRate: number,
): {
  otEmployees: number;
  otHours: number;
  otPayoutPhp: number;
  perPerson: PeopleOtPerPerson[];
  leaders: PeopleStatsLeader[];
  depts: PeopleStatsDept[];
} {
  let otEmployees = 0;
  let otHours = 0;
  let otPayoutPhp = 0;
  const perPerson: PeopleOtPerPerson[] = [];
  for (const pr of rowsToPayrollRows(rows)) {
    if (pr.hoursDecimal > MAX_PLAUSIBLE_WEEKLY_HOURS) continue;
    const ot = pr.overtimeDecimal;
    if (ot > 0) {
      otEmployees += 1;
      otHours += ot;
      const em = normEmail(pr.email ?? '') ?? '';
      const payoutPhp = ot * (otRateByEmail.get(em) ?? 0);
      otPayoutPhp += payoutPhp;
      perPerson.push({
        name: pr.name ?? null,
        email: pr.email ?? null,
        department: deptByEmail.get(em) || (pr.department ?? '').trim() || 'Unknown',
        otHours: ot,
        payoutPhp,
      });
    }
  }
  const leaders: PeopleStatsLeader[] = perPerson
    .slice()
    .sort((a, b) => b.otHours - a.otHours)
    .map((p) => ({
      name: p.name,
      email: p.email,
      otHours: Math.round(p.otHours * 10) / 10,
      otPayoutPhp: Math.round(p.payoutPhp * 100) / 100,
      otPayoutUsd: fxRate > 0 ? Math.round((p.payoutPhp / fxRate) * 100) / 100 : null,
      weeks: 1,
    }));
  return { otEmployees, otHours, otPayoutPhp, perPerson, leaders, depts: aggregateDepts(perPerson, fxRate) };
}

/**
 * OT renderers for ONE Hubstaff source file, ranked most OT hours first. Powers
 * the Statistics-tab OT-leaders table when a specific CSV period is selected, so
 * the table is authoritatively scoped to whatever week the selector names —
 * including weeks/files outside the recent-trend window.
 */
export async function buildOtLeadersForFile(
  sourceFile: string,
): Promise<{ leaders: PeopleStatsLeader[]; depts: PeopleStatsDept[]; error: string | null }> {
  const file = (sourceFile ?? '').trim();
  if (!file) return { leaders: [], depts: [], error: null };
  const [{ employees, error }, rateCtx] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
  ]);
  if (error) return { leaders: [], depts: [], error };
  const otRateByEmail = buildOtRateByEmail(employees, rateCtx);
  const deptByEmail = buildDeptByEmail(employees);
  try {
    const { rows } = await fetchHubstaffRowsBySourceFile(file);
    const { leaders, depts } = computeWeekOt(rows, otRateByEmail, deptByEmail, rateCtx.fx.usdToPhp);
    return { leaders, depts, error: null };
  } catch (e) {
    return { leaders: [], depts: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Weekly progression for the Statistics tab: OT payout + headcount-on-OT across
 * the recent canonical payroll weeks (the same weeks the CSV period selector
 * lists). Rate context is loaded once and the CURRENT resolved OT rate is used
 * for every week (matching the roster's "current rate" model), so only each
 * week's hours are fetched. Backfills / time-activity / duplicate uploads are
 * excluded so the trend line uses one point per real week.
 */
export async function buildPeopleStats(maxWeeks = 16): Promise<{
  points: PeopleStatsPoint[];
  otLeaders: PeopleStatsLeader[];
  otDepts: PeopleStatsDept[];
  error: string | null;
}> {
  const [{ employees, error }, rateCtx] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
  ]);
  if (error) return { points: [], otLeaders: [], otDepts: [], error };

  // email → OT rate (PHP-equivalent) and email → department, resolved once.
  const otRateByEmail = buildOtRateByEmail(employees, rateCtx);
  const deptByEmail = buildDeptByEmail(employees);

  // Canonical weekly uploads only, chronological, deduped by date range.
  let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
  try {
    uploads = await listHubstaffUploads();
  } catch {
    uploads = [];
  }
  const weeks: { file: string; start: Date; end: Date }[] = [];
  const seenRange = new Set<string>();
  for (const u of uploads) {
    const file = (u.source_file ?? '').trim();
    if (!file || /backfill|time-activity|\(\d+\)|copy/i.test(file)) continue;
    const range = parseDateRangeFromFilename(file);
    if (!range) continue;
    const days = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1;
    if (days < 6 || days > 8) continue;
    const key = `${isoOf(range.start)}_${isoOf(range.end)}`;
    if (seenRange.has(key)) continue;
    seenRange.add(key);
    weeks.push({ file, start: range.start, end: range.end });
  }
  weeks.sort((a, b) => a.start.getTime() - b.start.getTime());
  const recent = weeks.slice(-maxWeeks);

  const fxRate = rateCtx.fx.usdToPhp;
  const weekResults = await Promise.all(
    recent.map(async (w) => {
      let week = {
        otEmployees: 0,
        otHours: 0,
        otPayoutPhp: 0,
        perPerson: [] as PeopleOtPerPerson[],
        leaders: [] as PeopleStatsLeader[],
        depts: [] as PeopleStatsDept[],
      };
      try {
        const { rows } = await fetchHubstaffRowsBySourceFile(w.file);
        week = computeWeekOt(rows, otRateByEmail, deptByEmail, fxRate);
      } catch {
        /* skip this week's data */
      }
      const point: PeopleStatsPoint = {
        sourceFile: w.file,
        weekStart: isoOf(w.start) ?? '',
        weekEnd: isoOf(w.end) ?? '',
        otEmployees: week.otEmployees,
        otHours: Math.round(week.otHours * 10) / 10,
        otPayoutPhp: Math.round(week.otPayoutPhp * 100) / 100,
        otPayoutUsd: fxRate > 0 ? Math.round((week.otPayoutPhp / fxRate) * 100) / 100 : null,
        leaders: week.leaders,
        depts: week.depts,
      };
      return { point, perPerson: week.perPerson };
    }),
  );

  const points = weekResults.map((r) => r.point);

  // Aggregate every person's OT across the recent weeks into one leaderboard
  // row, keyed on a stable identity (work/personal email, falling back to name).
  const leaderMap = new Map<string, PeopleStatsLeader>();
  for (const { perPerson } of weekResults) {
    for (const p of perPerson) {
      const key = normEmail(p.email ?? '') || (p.name ?? '').trim().toLowerCase();
      if (!key) continue;
      const existing = leaderMap.get(key);
      if (existing) {
        existing.otHours += p.otHours;
        existing.otPayoutPhp += p.payoutPhp;
        existing.weeks += 1;
        if (!existing.name && p.name) existing.name = p.name;
        if (!existing.email && p.email) existing.email = p.email;
      } else {
        leaderMap.set(key, {
          name: p.name ?? null,
          email: p.email ?? null,
          otHours: p.otHours,
          otPayoutPhp: p.payoutPhp,
          otPayoutUsd: null, // filled below once the PHP total is final
          weeks: 1,
        });
      }
    }
  }
  const otLeaders: PeopleStatsLeader[] = Array.from(leaderMap.values())
    .map((l) => ({
      ...l,
      otHours: Math.round(l.otHours * 10) / 10,
      otPayoutPhp: Math.round(l.otPayoutPhp * 100) / 100,
      otPayoutUsd: fxRate > 0 ? Math.round((l.otPayoutPhp / fxRate) * 100) / 100 : null,
    }))
    .sort((a, b) => b.otHours - a.otHours);

  // Cross-week department rollup (distinct headcount via aggregateDepts' id set).
  const otDepts = aggregateDepts(weekResults.flatMap((r) => r.perPerson), fxRate);

  return { points, otLeaders, otDepts, error: null };
}
