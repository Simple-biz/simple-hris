import 'server-only';

import { normEmail } from '@/lib/email/norm-email';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { getEmployeeIds } from '@/lib/supabase/employee-ids';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { buildFxRates, type FxRates } from '@/lib/fx/currency-fx';
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

async function loadHoursContext(): Promise<HoursContext> {
  let sourceFile: string | null = null;
  try {
    const uploads = await listHubstaffUploads();
    const current = uploads.find((u) => u.is_current) ?? uploads[0];
    sourceFile = current?.source_file ?? null;
  } catch {
    sourceFile = null;
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
export async function buildPeopleRoster(): Promise<{
  rows: PeopleRosterRow[];
  sourceFile: string | null;
  error: string | null;
}> {
  const [{ employees, error }, rateCtx, hoursCtx, idsRes] = await Promise.all([
    getEmployeesForAuthorizedServerRoute(),
    loadPeopleRateContext(),
    loadHoursContext(),
    getEmployeeIds(),
  ]);
  if (error) return { rows: [], sourceFile: null, error };

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

  return { rows, sourceFile: hoursCtx.sourceFile, error: null };
}
