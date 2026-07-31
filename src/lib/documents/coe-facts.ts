// Certificate of Engagement — the facts, resolved server-side.
//
// A COE is issued BY Simple, not supplied by the worker, so every value on it
// comes from here and nothing is accepted from the client. The same resolver
// backs the read-only preview an employee sees before requesting, the PDF
// rendered at request time, and the re-render at signing — so all three agree.
//
// Rates and bonuses go through computePersonComp (the shared Payment Catalog
// resolver) rather than a private code path: a certificate that quotes a rate
// the payroll engine disagrees with is worse than no certificate.
//
// REFUSALS are deliberate. A COE with a blank start date or a blank rate looks
// forged and is useless at a bank, so resolveCoeFacts returns a `blocked`
// reason instead of rendering placeholder dashes.

import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { listPayStructures } from '@/lib/supabase/pay-structures-db';
import { listSystemBonuses } from '@/lib/supabase/system-bonuses-db';
import { listBonusCatalog } from '@/lib/supabase/bonus-catalog-db';
import { getDepartmentRegistry } from '@/lib/departments/registry-db';
import { resolveSystemBonuses } from '@/lib/payment-catalog/system-bonus';
import {
  computePersonComp,
  parseRateText,
  winningRate,
  type PersonCompIndexes,
  type SheetRate,
} from '@/lib/payment-catalog/person-comp';
import {
  CURRENCY_SYMBOL,
  CURRENCY_LOCALE,
  defaultOtRate,
  type PayCurrency,
  type PayStructure,
} from '@/lib/payment-catalog/pay-structure';
import { flatAmount } from '@/lib/bonus-catalog/types';
import { mapEmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import { parseNameParts } from '@/lib/name/name-parts';
import { normEmail } from '@/lib/email/norm-email';

/** Identity columns on `employee_hourly_rates` — quoted and capitalised because
 *  the table is a sheet import. Verified against the live schema. */
const RATES_EMAIL_COLUMNS = ['Work Email', 'Personal Email'] as const;

/**
 * The worker's name in natural reading order, for the certificate's prose.
 *
 * `global_master_list."Name"` is stored surname-first with the go-by nickname in
 * quotes (`Zabala, Christian "Chris"`), which would read as
 * *"This is to certify that Zabala, Christian "Chris" has been contracted…"*.
 * parseNameParts unpicks that (compound surnames, middle-name markers,
 * generational suffixes) and we re-join as First Middle Last + suffix. The
 * nickname is dropped — a certificate states the legal name.
 *
 * Returns null when the composed name is still malformed, which happens for a
 * handful of master rows whose nickname leaked in FRONT of the surname
 * (`"Ro", Noquera, Rodelyn "Rodelyn"`) or that carry a doubled comma. Those need
 * a master-list fix; printing `, Jeannel Peduhan` on a legal document is worse
 * than declining to issue it.
 */
export function coeWorkerName(rawName: string | null | undefined): string | null {
  const raw = (rawName ?? '').trim();
  if (!raw) return null;
  const p = parseNameParts(raw);
  const core = [p.first, p.middle, p.last].filter(Boolean).join(' ').trim();
  const composed = (core && p.extension ? `${core} ${p.extension}` : core).replace(/\s+/g, ' ').trim();
  // A well-formed name never keeps a comma or a quote after composing.
  if (!composed || /[,"“”]/.test(composed)) return null;
  return composed;
}

/** Contracted hours per week, as the certificate template states them. */
export const COE_WEEKLY_HOURS = 40;

/** One money line on the certificate, pre-formatted in its own currency. */
export interface CoeBonusLine {
  label: string;
  /** Formatted amount ("₱5,000", "COP 320,000", "$35.00"), or null for a
   *  formula-based bonus whose value depends on performance. */
  amount: string | null;
  /** Parenthetical qualifier from the template, e.g. the Tech cadence. */
  qualifier?: string;
}

export interface CoeFacts {
  workerName: string;
  employeeEmail: string;
  employeeId: string | null;
  /** "March 4, 2024" — already formatted; the certificate prints prose. */
  startDateLabel: string;
  /** Raw ISO/date string as stored, for the audit trail. */
  startDateRaw: string;
  /** Department label as the master list spells it ("Sales Assistant"). */
  team: string;
  weeklyHours: number;
  hourlyRate: string;
  overtimeRate: string;
  currency: PayCurrency;
  /** Which layer paid the rate — recorded for audit, never printed. */
  rateSource: 'individual' | 'sheet' | 'department';
  /** Attendance + Technology lines, only those the worker's dept qualifies for. */
  standardBonuses: CoeBonusLine[];
  /** Performance bonuses reaching this person (personal + department-wide). */
  performanceBonuses: CoeBonusLine[];
}

/** Why a COE cannot be issued. Surfaced verbatim to the employee. */
export type CoeBlockedReason =
  | { code: 'no_master'; message: string }
  | { code: 'bad_name'; message: string }
  | { code: 'no_start_date'; message: string }
  | { code: 'no_department'; message: string }
  | { code: 'no_rate'; message: string };

export type CoeFactsResult =
  | { facts: CoeFacts; blocked: null; error: null }
  | { facts: null; blocked: CoeBlockedReason; error: null }
  | { facts: null; blocked: null; error: string };

/** COP's house symbol is "$COP", which carries the code — on a certificate read
 *  by a bank it needs a space ("$COP 320.000"), unlike a compact UI chip. */
function symbolAndGap(currency: PayCurrency): string {
  return currency === 'COP' ? `${CURRENCY_SYMBOL[currency]} ` : CURRENCY_SYMBOL[currency];
}

/** Money in its own currency: "₱5,000", "$COP 320.000", "$88". */
export function formatCoeMoney(amount: number, currency: PayCurrency): string {
  // COP is quoted in whole pesos by convention; PHP/USD keep cents only when the
  // amount actually has them (₱5,000 reads better than ₱5,000.00, while an
  // hourly ₱225.50 must not round).
  const fractionDigits = currency === 'COP' ? 0 : Number.isInteger(amount) ? 0 : 2;
  const n = amount.toLocaleString(CURRENCY_LOCALE[currency], {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${symbolAndGap(currency)}${n}`;
}

/** Hourly rates always show cents — a bank comparing ₱225 to ₱225.50 cares. */
function formatCoeRate(amount: number, currency: PayCurrency): string {
  const digits = currency === 'COP' ? 0 : 2;
  const n = amount.toLocaleString(CURRENCY_LOCALE[currency], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${symbolAndGap(currency)}${n}`;
}

/** "2024-03-04" / ISO timestamp → "March 4, 2024". Date-only strings must not
 *  be parsed as UTC midnight or they shift a day in Manila. */
export function formatCoeStartDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * The rates-sheet rows for one person only — a targeted query, so this never
 * meets the PostgREST 1000-row cap the full-table readers have to page around.
 *
 * `employee_hourly_rates` is a CSV/sheet import, so its columns are quoted and
 * capitalised — "Work Email", "Regular Rate" — NOT snake_case. Rather than name
 * them in a projection (where a rename silently 400s the whole certificate),
 * select * and normalise through mapEmployeeHourlyRateRow, the same mapper every
 * other rates reader uses; it already tolerates every column-name variant.
 */
async function fetchSheetRateFor(
  emails: string[],
): Promise<{ byEmail: Map<string, SheetRate>; error: string | null }> {
  const byEmail = new Map<string, SheetRate>();
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { byEmail, error: 'Supabase service-role client unavailable' };
  const table =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

  const list = emails.filter(Boolean);
  if (list.length === 0) return { byEmail, error: null };

  // One ilike per (column, email), exactly like fetchRowsByEmails in
  // employee-rate-profiles.ts — a PostgREST .or() filter cannot reference a
  // column whose name contains a space.
  const results = await Promise.all(
    RATES_EMAIL_COLUMNS.flatMap((column) =>
      list.map((email) => supabase.from(table).select('*').ilike(column, email).limit(50)),
    ),
  );

  for (const { data, error } of results) {
    if (error) return { byEmail, error: error.message };
    for (const raw of data ?? []) {
      const row = mapEmployeeHourlyRateRow(raw as Parameters<typeof mapEmployeeHourlyRateRow>[0]);
      const rate: SheetRate = {
        reg: parseRateText(row.regular_rate),
        ot: parseRateText(row.ot_rate),
      };
      // Work email first so it wins on a personal-email collision, matching the
      // engine's work-then-personal index order.
      for (const e of [normEmail(row.work_email), normEmail(row.personal_email)]) {
        if (e && !byEmail.has(e)) byEmail.set(e, rate);
      }
    }
  }
  return { byEmail, error: null };
}

/**
 * Resolve everything the Certificate of Engagement prints for one worker.
 * `email` is always the caller's own session email — never a query parameter.
 */
export async function resolveCoeFacts(email: string): Promise<CoeFactsResult> {
  const norm = normEmail(email) ?? email.trim().toLowerCase();
  if (!norm) return { facts: null, blocked: null, error: 'Missing employee email' };

  const { employee: master, error: masterErr } = await getEmployeeMasterRecord(norm);
  if (masterErr) return { facts: null, blocked: null, error: masterErr };
  if (!master) {
    return {
      facts: null,
      blocked: {
        code: 'no_master',
        message:
          'We could not find your record on the master list, so a Certificate of Engagement cannot be generated yet. Please contact Accounting.',
      },
      error: null,
    };
  }

  const workerName = coeWorkerName(master.name);
  const startDateRaw = master.start_date?.trim() || '';
  const startDateLabel = startDateRaw ? formatCoeStartDate(startDateRaw) : null;
  const team = master.department?.trim() || '';

  if (!workerName) {
    return {
      facts: null,
      blocked: {
        code: 'bad_name',
        message:
          'Your name is not recorded in a usable form on the master list, and the certificate has to state it exactly. Please ask Accounting to correct it, then request again.',
      },
      error: null,
    };
  }
  if (!startDateRaw || !startDateLabel) {
    return {
      facts: null,
      blocked: {
        code: 'no_start_date',
        message:
          'Your engagement start date is not on file yet, and a Certificate of Engagement has to state it. Please ask Accounting to add it, then request again.',
      },
      error: null,
    };
  }
  if (!team) {
    return {
      facts: null,
      blocked: {
        code: 'no_department',
        message:
          'Your team is not recorded on the master list yet, and the certificate has to name it. Please ask Accounting to set it, then request again.',
      },
      error: null,
    };
  }

  const aliases = Array.from(
    new Set(
      [
        norm,
        normEmail(master.work_email),
        normEmail(master.personal_email),
        normEmail(master.alternate_work_email),
        normEmail(master.alternate_work_email_2),
      ].filter((e): e is string => !!e),
    ),
  );

  const [structuresRes, systemRes, catalogRes, registry, sheetRes] = await Promise.all([
    listPayStructures(),
    listSystemBonuses(),
    listBonusCatalog(),
    getDepartmentRegistry(),
    fetchSheetRateFor(aliases),
  ]);
  if (structuresRes.error) return { facts: null, blocked: null, error: structuresRes.error };
  if (sheetRes.error) return { facts: null, blocked: null, error: sheetRes.error };

  // Same index shape the Payment Catalog builds, so precedence matches exactly:
  // later-one-wins on duplicate keys.
  const structByEmail = new Map<string, PayStructure>();
  const deptStructByKey = new Map<string, PayStructure>();
  for (const s of structuresRes.structures) {
    if (s.scope === 'employee') {
      const e = normEmail(s.employeeEmail);
      if (e) structByEmail.set(e, s);
    } else {
      deptStructByKey.set(s.departmentKey, s);
    }
  }

  const indexes: PersonCompIndexes = {
    structByEmail,
    deptStructByKey,
    sheetRateByEmail: sheetRes.byEmail,
    resolvedSystem: resolveSystemBonuses(systemRes.bonuses),
    systemBonuses: systemRes.bonuses,
    assignments: catalogRes.assignments,
    customDepartments: registry.map((d) => ({ key: d.key, name: d.name })),
  };

  const comp = computePersonComp({ email: norm, aliases, department: team }, indexes);
  const rate = winningRate(comp);
  // A zero rate is not a rate. US/externally-paid people carry a 0 (or blank)
  // rates-sheet row — business-logic.md calls this "paid externally" — and
  // computePersonComp faithfully mirrors the engine by treating 0 as present.
  // The certificate must not state "an hourly rate of ₱0.00", so the
  // certificate layer, not the shared resolver, applies the stricter rule.
  if (!rate || !(rate.regular > 0)) {
    return {
      facts: null,
      blocked: {
        code: 'no_rate',
        message:
          'Your hourly rate is not on file yet, and a Certificate of Engagement has to state it. If you are paid outside the Philippine payroll, Accounting will need to issue this certificate manually — otherwise ask them to set your rate in the Payment Catalog, then request again.',
      },
      error: null,
    };
  }

  // The template quotes an overtime rate; fall back to the standard 1.5x the
  // engine uses when no explicit OT rate is stored.
  const otRate = rate.ot ?? defaultOtRate(rate.regular);

  const standardBonuses: CoeBonusLine[] = comp.systemRows.map((row) => ({
    label: row.label,
    amount: formatCoeMoney(row.amount, row.currency),
    qualifier:
      row.code === 'pab' || row.code.startsWith('pab:')
        ? 'for meeting the required hours each week'
        : 'given every 3rd paycheck of each month for active workers',
  }));

  // Performance bonuses = personal assignments + department-wide ones this
  // person is not excluded from. Formula bonuses have no fixed amount, so the
  // certificate names them without quoting a figure.
  const bonusById = new Map(catalogRes.bonuses.map((b) => [b.id, b]));
  const performanceBonuses: CoeBonusLine[] = [];
  const seenBonus = new Set<string>();
  const pushBonus = (bonusId: string) => {
    if (seenBonus.has(bonusId)) return;
    const def = bonusById.get(bonusId);
    if (!def) return;
    seenBonus.add(bonusId);
    const flat = flatAmount(def);
    performanceBonuses.push({
      label: def.name,
      // A bonus carries its own currency (legacy rows omit it ⇒ PHP).
      amount: flat != null ? formatCoeMoney(flat, def.currency ?? 'PHP') : null,
    });
  };
  for (const a of comp.employeeAssignments) pushBonus(a.bonusId);
  for (const { assignment, excluded } of comp.commonAssignments) {
    if (!excluded) pushBonus(assignment.bonusId);
  }

  return {
    facts: {
      workerName,
      employeeEmail: norm,
      employeeId: master.employee_id?.trim() || null,
      startDateLabel,
      startDateRaw,
      team,
      weeklyHours: COE_WEEKLY_HOURS,
      hourlyRate: formatCoeRate(rate.regular, rate.currency),
      overtimeRate: formatCoeRate(otRate, rate.currency),
      currency: rate.currency,
      rateSource: rate.source as CoeFacts['rateSource'],
      standardBonuses,
      performanceBonuses,
    },
    blocked: null,
    error: null,
  };
}

/** Compact one-liner stored on the request row so the Accounting queue chip
 *  shows what was certified without opening the PDF. */
export function coeSummaryLabel(facts: CoeFacts): string {
  return `Engaged since ${facts.startDateLabel} · ${facts.hourlyRate}/hr`;
}
