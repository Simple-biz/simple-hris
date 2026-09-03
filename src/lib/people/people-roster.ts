import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import 'server-only';

import { normEmail } from '@/lib/email/norm-email';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { getEmployeeIds, type EmployeeIdRow } from '@/lib/supabase/employee-ids';
import {
  isPayoutComplete,
  resolveEffectivePayoutProcessor,
  resolvePreferredAccountNumber,
  type PayoutLegacyExtras,
} from '@/lib/employee/payout-completeness';
import { fetchLatestBankChangeAtByEmail } from '@/lib/supabase/bank-update-history';
// ONE masking rule for every export artifact — Kane's 2026-08-12 ruling that a
// payee row carries bank name + account LAST-4 only, shared with the Payment
// Dispatch cycle close-out report. Re-implementing it here is how two files end
// up disagreeing about what "masked" means.
import { maskAccountLast4 } from '@/lib/payroll/mask-account';
import { buildRailMix, buildRailMixByDepartment, type RailMix, type DeptRailAssignment } from './rail-mix';
import {
  getEmployeeHourlyRatesRows,
  type EmployeeHourlyRateRow,
} from '@/lib/supabase/employee-hourly-rates';
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
import { parseHoursToDecimal, mapHubstaffHoursRow } from '@/lib/supabase/hubstaff-hours';
import { parseDateRangeFromFilename, payWeekFromUploadStart, resolveCanonicalColumnsToIso } from '@/lib/hubstaff/calendar-column-dedupe';
import { projectOvertime } from './overtime-projection';
import { isHslFamilyLabel } from '@/lib/departments/hsl-subdept';
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
  /** Primary key of the underlying global_master_list row — targets identity
   *  edits from the People -> View Modal profile editor. */
  id: string | null;
  employee_id: string | null;
  name: string | null;
  work_email: string | null;
  /** Secondary contact email (from the master list). Directory / profile only. */
  personal_email: string | null;
  /** Extra gsuite aliases for the same human (non-empty, deduped). */
  alternate_work_emails: string[];
  department: string | null;
  /** Hire date (YYYY-MM-DD) — powers the tenure display in the profile. */
  start_date: string | null;
  /** Home location — city/province for the directory, full address in the profile. */
  street: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  full_address: string | null;
  /** Contact phone from the master list (distinct from the payout phone). */
  phone_number: string | null;
  /** Free-text "Location" column — the sheet's single address field. */
  location: string | null;
  rate: PeopleRate;
  hours: PeopleHours;
  /** The rail Payment Dispatch actually routes this person on — resolved with
   *  PD's precedence (bank_preferred → preferred_processor → legacy rates
   *  cell), NOT the raw Disbursement pick. */
  processor: string | null;
  hasBanking: boolean;
  /** Last 4 of the RECEIVING account Payment Dispatch would actually pay to,
   *  already masked ("···1234"). SLOT-AWARE via `resolvePreferredAccountNumber`,
   *  so it can never name an account PD would not use. Null when neither bank
   *  slot carries a number — every wallet rail, and anyone with no bank details.
   *  The FULL number never leaves the server on this route: only the reveal
   *  endpoint (which audit-logs the access) may return it. */
  accountLast4: string | null;
  /** When this person's payout details last changed (ISO), newest across every
   *  channel that writes `bank_update_history`. Null = no change on record. */
  bankUpdatedAt: string | null;
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
  /** How the SAME roster splits across send-from rails, and how many on each are
   *  payable there — powers the Bank changes KPI band. Folded from the very
   *  `processor` / `hasBanking` pair each row above carries, so the band can never
   *  disagree with the roster chips or the Missing-bank-info list. */
  railMix: RailMix;
  /** The same fold per department, keyed by the roster's own department label
   *  (people with none under `NO_DEPARTMENT`), so the Bank changes department
   *  filter re-scopes the band instead of leaving it on org-wide figures. */
  railMixByDept: Record<string, RailMix>;
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

/** Parse a "YYYY-MM-DD" string as a LOCAL calendar date (no UTC/TZ shift). */
function parseIsoLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Shared rate-resolution context — mirrors the live dispatch (current-pay.ts /
 *  disbursement-reports.ts) so the People tab shows the same rate payroll uses. */
export interface PeopleRateContext {
  fx: FxRates;
  catalogIndex: CatalogRateIndex;
  /** email → sheet rate (PHP) from employee_hourly_rates. */
  rateByEmail: Map<string, { reg: number | null; ot: number | null }>;
  /** email → current rates row — Payment Dispatch's legacy routing/details
   *  fallback ("Bank Preferred" cell, sheet-side wallet emails). Same deduped
   *  source PD's queue reads, so People resolves the SAME rail. */
  legacyByEmail: Map<string, EmployeeHourlyRateRow>;
}

export async function loadPeopleRateContext(): Promise<PeopleRateContext> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();

  const [fxRes, payStructuresRes, ratesRes, deptRegistry] = await Promise.all([
    supabase
      ? supabase.from('app_settings').select('key,value').in('key', ['usd_to_php_rate', 'usd_to_cop_rate'])
      : Promise.resolve({ data: null }),
    listPayStructures(),
    // The same loader Payment Dispatch's bulk rates API uses: the deduped
    // one-row-per-email current view, paginated past the PostgREST 1000-row
    // cap. The previous raw select('*') here was silently truncated at 1000 of
    // 22k+ history rows, so sheet rates AND legacy routing were incomplete.
    getEmployeeHourlyRatesRows(),
    // Renamed in-app departments resolve their base rate by alias slug.
    getDepartmentRegistry().catch(() => []),
  ]);

  const fxValues: Record<string, string | null> = {};
  for (const r of ((fxRes as { data: { key: string; value: string | null }[] | null }).data ?? [])) {
    fxValues[r.key] = r.value;
  }
  const fx = buildFxRates(fxValues);
  const catalogIndex = buildCatalogRateIndex(payStructuresRes.structures, deptRegistry);

  const rateByEmail = new Map<string, { reg: number | null; ot: number | null }>();
  const legacyByEmail = new Map<string, EmployeeHourlyRateRow>();
  for (const r of ratesRes.rows) {
    const we = normEmail(r.work_email);
    const pe = normEmail(r.personal_email);
    const entry = { reg: parseRate(r.regular_rate), ot: parseRate(r.ot_rate) };
    if (we) {
      rateByEmail.set(we, entry);
      legacyByEmail.set(we, r);
    }
    if (pe && !rateByEmail.has(pe)) rateByEmail.set(pe, entry);
    if (pe && !legacyByEmail.has(pe)) legacyByEmail.set(pe, r);
  }

  return { fx, catalogIndex, rateByEmail, legacyByEmail };
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
 * Distinct, chronological canonical payroll weeks from the Hubstaff uploads:
 * one {file, start, end} per real 6–8 day weekly report, with backfills /
 * time-activity / duplicate re-uploads dropped and identical date ranges deduped.
 * Shared by the weekly Statistics trend and the People roster's custom date range.
 */
function canonicalWeeksFromUploads(
  uploads: Awaited<ReturnType<typeof listHubstaffUploads>>,
): { file: string; start: Date; end: Date }[] {
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
  return weeks;
}

/** Hours + OT summed across every payroll week overlapping a custom date range. */
interface RangeHoursContext {
  /** email → { hours, ot } aggregated across the included weeks. */
  byEmail: Map<string, { hours: number; ot: number }>;
  /** How many canonical payroll weeks were aggregated. */
  weeks: number;
  /** Actual covered span (first included week's start → last week's end). */
  coveredStart: string | null;
  coveredEnd: string | null;
}

/**
 * Aggregate hours + overtime across every canonical payroll week that OVERLAPS
 * the [startIso, endIso] range. Each week's overtime is its own 40h-capped figure
 * (overtimeDecimal), so the per-person OT total is the sum of weekly OT — never a
 * single 40h cap across the whole multi-week span. The grand-total summary row
 * (see {@link MAX_PLAUSIBLE_WEEKLY_HOURS}) is dropped per week.
 */
async function loadRangeHoursContext(startIso: string, endIso: string): Promise<RangeHoursContext> {
  const start = parseIsoLocalDate(startIso);
  const end = parseIsoLocalDate(endIso);
  const empty: RangeHoursContext = { byEmail: new Map(), weeks: 0, coveredStart: null, coveredEnd: null };
  if (!start || !end || start.getTime() > end.getTime()) return empty;

  let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
  try {
    uploads = await listHubstaffUploads();
  } catch {
    return empty;
  }
  const sT = start.getTime();
  const eT = end.getTime();
  // A week is in scope if its [start, end] overlaps the requested range.
  const included = canonicalWeeksFromUploads(uploads).filter(
    (w) => w.start.getTime() <= eT && w.end.getTime() >= sT,
  );

  const byEmail = new Map<string, { hours: number; ot: number }>();
  await Promise.all(
    included.map(async (w) => {
      try {
        const { rows } = await fetchHubstaffRowsBySourceFile(w.file);
        // No awaits below, so each week's accumulation runs atomically — safe to
        // share `byEmail` across the parallel fetches.
        for (const pr of rowsToPayrollRows(rows)) {
          if (pr.hoursDecimal > MAX_PLAUSIBLE_WEEKLY_HOURS) continue;
          const em = normEmail(pr.email ?? '');
          if (!em) continue;
          const cur = byEmail.get(em) ?? { hours: 0, ot: 0 };
          cur.hours += pr.hoursDecimal;
          cur.ot += pr.overtimeDecimal;
          byEmail.set(em, cur);
        }
      } catch {
        /* skip this week's data */
      }
    }),
  );

  return {
    byEmail,
    weeks: included.length,
    coveredStart: included.length ? isoOf(included[0].start) : null,
    coveredEnd: included.length ? isoOf(included[included.length - 1].end) : null,
  };
}

/**
 * The full People roster: one row per active employee with rate, hours-this-week,
 * overtime projection, preferred processor, and a has-banking flag.
 *
 * Scope is EITHER a single payroll week (`sourceFile`, default = current week) OR
 * a custom `rangeStart`→`rangeEnd` window. In range mode each row's hours/OT are
 * summed across every payroll week overlapping the range, and the per-week OT
 * projection ("on track for") is omitted — it only applies to the live week.
 */
const EMPTY_SUMMARY: PeopleSummary = {
  otEmployees: 0,
  otHours: 0,
  otPayoutPhp: 0,
  otPayoutUsd: 0,
  // An empty roster genuinely has no rail mix — buildRailMix([]) is all zeros
  // rather than a hand-written blank, so the two can never drift apart.
  railMix: buildRailMix([]),
  railMixByDept: {},
};

export interface PeopleRosterScope {
  /** Single payroll week (Hubstaff source_file). Ignored when a range is given. */
  sourceFile?: string | null;
  /** Inclusive custom range start (YYYY-MM-DD). Both ends required for range mode. */
  rangeStart?: string | null;
  /** Inclusive custom range end (YYYY-MM-DD). */
  rangeEnd?: string | null;
}

/** Range coverage echoed back so the UI can show how many weeks were aggregated. */
export interface PeopleRangeCoverage {
  weeks: number;
  start: string | null;
  end: string | null;
}

export async function buildPeopleRoster(scope: PeopleRosterScope = {}): Promise<{
  rows: PeopleRosterRow[];
  sourceFile: string | null;
  summary: PeopleSummary;
  range: PeopleRangeCoverage | null;
  error: string | null;
}> {
  const rangeStart = (scope.rangeStart ?? '').trim();
  const rangeEnd = (scope.rangeEnd ?? '').trim();
  const rangeMode = !!(rangeStart && rangeEnd);

  const [{ employees, error }, rateCtx, hoursCtx, rangeCtx, idsRes, bankChangedRes] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
    rangeMode ? Promise.resolve(null) : loadHoursContext(scope.sourceFile),
    rangeMode ? loadRangeHoursContext(rangeStart, rangeEnd) : Promise.resolve(null),
    getEmployeeIds(),
    fetchLatestBankChangeAtByEmail(),
  ]);
  if (error) return { rows: [], sourceFile: null, summary: EMPTY_SUMMARY, range: null, error };

  // employee_ids rows keyed by every known email — same collision rules as
  // Payment Dispatch's buildIdsMap (useDispatchQueue.ts): work email last-wins,
  // personal email only fills a free slot. Processor + has-banking are resolved
  // per PERSON below so the legacy rates-row fallbacks can join in.
  const idByEmail = new Map<string, EmployeeIdRow>();
  for (const r of idsRes.rows) {
    const we = normEmail(r.work_email ?? '');
    const pe = normEmail(r.personal_email ?? '');
    if (we) idByEmail.set(we, r);
    if (pe && !idByEmail.has(pe)) idByEmail.set(pe, r);
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

  // One per roster row, pushed inside the map below — the KPI band's input,
  // tagged with the department so the band can follow the department filter.
  const railAssignments: DeptRailAssignment[] = [];

  const rows: PeopleRosterRow[] = uniqueEmployees.map((e) => {
    const aliases = [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map((a) => normEmail(a ?? ''))
      .filter(Boolean) as string[];

    // Family-aware — an `hsl:<sub>` label is still HSL (Mon–Sun weeks).
    const isHsl = isHslFamilyLabel(e.department);
    const rate = resolvePeopleRate(rateCtx, aliases, e.department ?? null);

    let hours: PeopleHours;
    if (rangeMode) {
      // Hours + OT summed across the range; no projection (historical aggregate).
      let agg = { hours: 0, ot: 0 };
      for (const em of aliases) {
        const h = rangeCtx!.byEmail.get(em);
        if (h) { agg = h; break; }
      }
      hours = {
        thisWeek: round1(agg.hours),
        ot: round1(agg.ot),
        weekStart: rangeCtx!.coveredStart,
        weekEnd: rangeCtx!.coveredEnd,
        inProgress: false,
        projectedHours: null,
        projectedOt: null,
      };
    } else {
      let hoursThisWeek = 0;
      for (const em of aliases) {
        const h = hoursCtx!.byEmail.get(em);
        if (h != null) { hoursThisWeek = h; break; }
      }
      const payWeek = isHsl ? hoursCtx!.payWeekHsl : hoursCtx!.payWeekNonHsl;
      const proj = projectOvertime(hoursThisWeek, payWeek?.start ?? null, payWeek?.end ?? null, today);
      hours = {
        thisWeek: proj.hoursSoFar,
        ot: proj.otSoFar,
        weekStart: isoOf(payWeek?.start ?? null),
        weekEnd: isoOf(payWeek?.end ?? null),
        inProgress: proj.inProgress,
        projectedHours: proj.projectedHours,
        projectedOt: proj.projectedOt,
      };
    }

    const idsRow = aliases.map((em) => idByEmail.get(em)).find(Boolean) ?? null;
    // Payment Dispatch parity: the displayed processor is the rail PD actually
    // routes on (bank_preferred → preferred_processor → legacy rates cell), and
    // "has banking" is judged with the SAME legacy rates-row fallbacks PD uses
    // to backfill wallet emails. Resolving with only preferred_processor (the
    // old behavior) showed no/along-the-wrong-rail chips for ~170 people whose
    // routing lives in bank_preferred or the sheet cell, and false-flagged
    // sheet-routed people as "Missing bank info".
    const legacyRow = aliases.map((em) => rateCtx.legacyByEmail.get(em)).find(Boolean) ?? null;
    const extras: PayoutLegacyExtras | undefined = legacyRow
      ? {
          bankPreferredRaw: legacyRow.bank_preferred,
          hurupayEmail: legacyRow.hurupay_email,
          higlobeEmail: legacyRow.higlobe_email,
          higlobeAccountName: legacyRow.higlobe_account_name,
        }
      : undefined;
    const idsRecord = idsRow as unknown as Record<string, unknown> | null;
    const effectiveProcessor = resolveEffectivePayoutProcessor(idsRecord, extras);
    const hasBanking = isPayoutComplete(idsRecord, extras);
    // Both halves of the Bank changes KPI band are folded from the values this
    // row already carries, so "which rail" and "can we pay them on it" can never
    // drift from the chip or the Missing-bank-info list. See rail-mix.ts.
    railAssignments.push({
      department: e.department ?? null,
      rail: effectiveProcessor,
      payable: hasBanking,
    });

    // Extra work-email aliases (deduped, non-empty) minus the primary — for the
    // profile "cabinet" view. All of these come from the employee record already
    // loaded above, so surfacing them costs no extra query.
    const primaryWork = normEmail(e.work_email ?? '');
    const altEmails = Array.from(
      new Set(
        [e.alternate_work_email, e.alternate_work_email_2]
          .map((a) => (a ?? '').trim())
          .filter(Boolean)
          .filter((a) => normEmail(a) !== primaryWork),
      ),
    );

    return {
      id: e.id ?? null,
      employee_id: e.employee_id ?? null,
      name: e.name ?? null,
      work_email: e.work_email ?? null,
      personal_email: e.personal_email ?? null,
      alternate_work_emails: altEmails,
      department: e.department ?? null,
      start_date: e.start_date ?? null,
      street: e.street ?? null,
      city: e.city ?? null,
      province: e.province ?? null,
      postal_code: e.postal_code ?? null,
      full_address: e.full_address ?? null,
      phone_number: e.phone_number ?? null,
      location: e.location ?? null,
      rate,
      hours,
      processor: effectiveProcessor,
      hasBanking,
      // Slot-aware, then masked — the export never sees a full account number.
      accountLast4: maskAccountLast4(resolvePreferredAccountNumber(idsRecord)),
      // Newest change across every alias: a person with two work addresses can
      // have saved under either one.
      bankUpdatedAt: aliases.reduce<string | null>((newest, em) => {
        const at = bankChangedRes.byEmail.get(em);
        return at && (!newest || at > newest) ? at : newest;
      }, null),
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
    railMix: buildRailMix(railAssignments),
    railMixByDept: buildRailMixByDepartment(railAssignments),
  };

  const range: PeopleRangeCoverage | null = rangeMode
    ? { weeks: rangeCtx!.weeks, start: rangeCtx!.coveredStart, end: rangeCtx!.coveredEnd }
    : null;

  // A bank-history read failure is NON-fatal (rows are still correct) but must
  // not pass silently: with an empty map every row's `bankUpdatedAt` is null,
  // which reads as "nobody ever changed their bank". The People tab renders this
  // string as a banner above a populated roster.
  const historyWarning = bankChangedRes.error
    ? `Bank change history unavailable — the "Bank Info Updated" column will read blank: ${bankChangedRes.error}`
    : null;

  return {
    rows,
    sourceFile: rangeMode ? null : hoursCtx!.sourceFile,
    summary,
    range,
    error: historyWarning,
  };
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

/* ──────────────────────────────────────────────────────────────────────────
 * Granular OT trend (daily / weekly / monthly)
 *
 * Overtime is a WEEKLY concept (hours over 40 per person per pay week), so a
 * daily view needs each week's OT attributed to specific days. We attribute it
 * to the day on which the person's running weekly total crosses 40 ("the day
 * that crosses 40h"): walking their days in order, the slice of each day's hours
 * that sits above the 40h line is that day's OT. By construction the per-day OT
 * sums back to the week's OT, so weekly/monthly rollups stay exact and the
 * existing weekly numbers are unchanged. Daily attribution is then scaled to the
 * authoritative Total-worked OT so a CSV whose day columns don't sum to the
 * weekly total still reconciles to the penny.
 * ────────────────────────────────────────────────────────────────────────── */

/** The three time granularities offered by the People → Statistics trend toggle. */
export type StatsGranularity = 'daily' | 'weekly' | 'monthly';

/** One atomic OT contribution: a person's overtime landing on a single calendar day. */
interface DailyOtRecord {
  iso: string;
  email: string;
  name: string | null;
  department: string;
  otHours: number;
  payoutPhp: number;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-day hours for one Hubstaff row. Canonical weekday columns (`monday`…) are
 * first resolved to the ISO dates of the file's week; ISO date columns pass
 * through. Returns `isoDate → hours` for the days the person actually logged.
 */
function extractDayHours(row: Record<string, unknown>, filename: string): Map<string, number> {
  const resolved = resolveCanonicalColumnsToIso(row, filename);
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(resolved)) {
    const k = key.trim();
    if (!ISO_DAY_RE.test(k)) continue;
    const h = parseHoursToDecimal(value);
    if (h > 0) out.set(k, h);
  }
  return out;
}

/**
 * Attribute a person's authoritative weekly OT (`weeklyOt`, from Total worked)
 * across their worked days using the "day that crosses 40h" rule, scaled so the
 * per-day amounts sum exactly to `weeklyOt`. Falls back to the last worked day
 * (or the week's end) when the row has no usable per-day columns.
 */
function attributeWeeklyOtToDays(
  dayHours: Map<string, number>,
  weeklyOt: number,
  weekEndIso: string,
): { iso: string; otHours: number }[] {
  if (weeklyOt <= 0) return [];
  const days = [...dayHours.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Raw crossing-40 attribution from the day columns.
  const raw: { iso: string; otHours: number }[] = [];
  let cum = 0;
  for (const [iso, h] of days) {
    const before = cum;
    cum += h;
    const ot = Math.max(0, cum - 40) - Math.max(0, before - 40);
    if (ot > 0) raw.push({ iso, otHours: ot });
  }
  const rawSum = raw.reduce((s, r) => s + r.otHours, 0);

  if (rawSum > 0) {
    const scale = weeklyOt / rawSum;
    return raw.map((r) => ({ iso: r.iso, otHours: r.otHours * scale }));
  }
  // No day columns (or days summed ≤ 40 despite a Total > 40): put it all on the
  // last worked day, else the week's end, so the daily series still reconciles.
  const fallbackIso = days.length ? days[days.length - 1][0] : weekEndIso;
  return [{ iso: fallbackIso, otHours: weeklyOt }];
}

/** Roll atomic daily-OT records into one trend point (distinct headcount, ranked leaders, dept rollup). */
function pointFromRecords(
  records: DailyOtRecord[],
  start: string,
  end: string,
  fxRate: number,
): PeopleStatsPoint {
  const byPerson = new Map<string, PeopleOtPerPerson>();
  let otHours = 0;
  let otPayoutPhp = 0;
  for (const r of records) {
    otHours += r.otHours;
    otPayoutPhp += r.payoutPhp;
    const key = r.email || (r.name ?? '').trim().toLowerCase();
    const cur = byPerson.get(key);
    if (cur) {
      cur.otHours += r.otHours;
      cur.payoutPhp += r.payoutPhp;
      if (!cur.name && r.name) cur.name = r.name;
    } else {
      byPerson.set(key, {
        name: r.name,
        email: r.email || null,
        department: r.department,
        otHours: r.otHours,
        payoutPhp: r.payoutPhp,
      });
    }
  }
  const perPerson = [...byPerson.values()];
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
  return {
    sourceFile: '',
    weekStart: start,
    weekEnd: end,
    otEmployees: perPerson.length,
    otHours: Math.round(otHours * 10) / 10,
    otPayoutPhp: Math.round(otPayoutPhp * 100) / 100,
    otPayoutUsd: fxRate > 0 ? Math.round((otPayoutPhp / fxRate) * 100) / 100 : null,
    leaders,
    depts: aggregateDepts(perPerson, fxRate),
  };
}

/** First / last calendar day of the month an ISO date belongs to (e.g. "2026-06-13" → 2026-06-01 / 2026-06-30). */
function monthBounds(iso: string): { key: string; start: string; end: string } {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const p2 = (x: number) => String(x).padStart(2, '0');
  const last = new Date(y, m, 0).getDate();
  return { key: `${iso.slice(0, 7)}`, start: `${y}-${p2(m)}-01`, end: `${y}-${p2(m)}-${p2(last)}` };
}

/**
 * OT trend at three granularities for the People → Statistics charts. One pass
 * over the recent canonical payroll weeks produces atomic per-day OT records
 * (see attribution note above); those are then bucketed by day, by pay week, and
 * by calendar month. The cross-week leaderboard aggregate is returned alongside,
 * unchanged, so the standings table keeps following its own period selector.
 */
export async function buildPeopleStatsSeries(maxWeeks = 26): Promise<{
  daily: PeopleStatsPoint[];
  weekly: PeopleStatsPoint[];
  monthly: PeopleStatsPoint[];
  otLeaders: PeopleStatsLeader[];
  otDepts: PeopleStatsDept[];
  error: string | null;
}> {
  const empty = { daily: [], weekly: [], monthly: [], otLeaders: [], otDepts: [] };
  const [{ employees, error }, rateCtx] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
  ]);
  if (error) return { ...empty, error };

  const otRateByEmail = buildOtRateByEmail(employees, rateCtx);
  const deptByEmail = buildDeptByEmail(employees);
  const fxRate = rateCtx.fx.usdToPhp;

  let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
  try {
    uploads = await listHubstaffUploads();
  } catch {
    uploads = [];
  }
  const recent = canonicalWeeksFromUploads(uploads).slice(-maxWeeks);

  // One bucket of atomic daily records per week, so weekly rollups can reuse the
  // exact week window while daily/monthly bucket purely by the records' dates.
  const perWeek = await Promise.all(
    recent.map(async (w) => {
      const weekEndIso = isoOf(w.end) ?? '';
      const records: DailyOtRecord[] = [];
      try {
        const { rows } = await fetchHubstaffRowsBySourceFile(w.file);
        for (const row of rows) {
          const mapped = mapHubstaffHoursRow(row);
          if (mapped.hoursDecimal > MAX_PLAUSIBLE_WEEKLY_HOURS) continue;
          const weeklyOt = mapped.overtimeDecimal;
          if (weeklyOt <= 0) continue;
          const em = normEmail(mapped.email ?? '') ?? '';
          const otPhpRate = otRateByEmail.get(em) ?? 0;
          const dept = deptByEmail.get(em) || (mapped.department ?? '').trim() || 'Unknown';
          const dayHours = extractDayHours(row, w.file);
          for (const part of attributeWeeklyOtToDays(dayHours, weeklyOt, weekEndIso)) {
            records.push({
              iso: part.iso,
              email: em,
              name: mapped.name ?? null,
              department: dept,
              otHours: part.otHours,
              payoutPhp: part.otHours * otPhpRate,
            });
          }
        }
      } catch {
        /* skip this week's data */
      }
      return { start: isoOf(w.start) ?? '', end: weekEndIso, records };
    }),
  );

  const allRecords = perWeek.flatMap((w) => w.records);

  // Weekly: one point per pay week, using the week's own window.
  const weekly = perWeek.map((w) => pointFromRecords(w.records, w.start, w.end, fxRate));

  // Daily: one point per calendar day that had OT.
  const byDay = new Map<string, DailyOtRecord[]>();
  for (const r of allRecords) {
    const bucket = byDay.get(r.iso);
    if (bucket) bucket.push(r);
    else byDay.set(r.iso, [r]);
  }
  const daily = [...byDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((iso) => pointFromRecords(byDay.get(iso)!, iso, iso, fxRate));

  // Monthly: one point per calendar month.
  const byMonth = new Map<string, { start: string; end: string; records: DailyOtRecord[] }>();
  for (const r of allRecords) {
    const mb = monthBounds(r.iso);
    const bucket = byMonth.get(mb.key);
    if (bucket) bucket.records.push(r);
    else byMonth.set(mb.key, { start: mb.start, end: mb.end, records: [r] });
  }
  const monthly = [...byMonth.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const m = byMonth.get(k)!;
      return pointFromRecords(m.records, m.start, m.end, fxRate);
    });

  // Cross-week leaderboard aggregate (unchanged from buildPeopleStats), so the
  // standings table on the right stays scoped by its own week selector.
  const leaderMap = new Map<string, PeopleStatsLeader>();
  for (const r of allRecords) {
    const key = r.email || (r.name ?? '').trim().toLowerCase();
    if (!key) continue;
    const existing = leaderMap.get(key);
    if (existing) {
      existing.otHours += r.otHours;
      existing.otPayoutPhp += r.payoutPhp;
      if (!existing.name && r.name) existing.name = r.name;
      if (!existing.email && r.email) existing.email = r.email;
    } else {
      leaderMap.set(key, {
        name: r.name,
        email: r.email || null,
        otHours: r.otHours,
        otPayoutPhp: r.payoutPhp,
        otPayoutUsd: null,
        weeks: 1,
      });
    }
  }
  const otLeaders = [...leaderMap.values()]
    .map((l) => ({
      ...l,
      otHours: Math.round(l.otHours * 10) / 10,
      otPayoutPhp: Math.round(l.otPayoutPhp * 100) / 100,
      otPayoutUsd: fxRate > 0 ? Math.round((l.otPayoutPhp / fxRate) * 100) / 100 : null,
    }))
    .sort((a, b) => b.otHours - a.otHours);

  const otDepts = aggregateDepts(allRecords, fxRate);

  return { daily, weekly, monthly, otLeaders, otDepts, error: null };
}
