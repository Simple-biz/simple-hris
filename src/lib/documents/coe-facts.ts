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
import { getSkillSet } from '@/lib/supabase/employee-skill-sets';
import { listEmployeePayStubs } from '@/lib/payroll/employee-paystubs';
import { formatWeekHuman } from '@/lib/payroll/paystub-view';
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

/**
 * The worker's self-declared role, as the certificate prints it — or null when
 * they have not set one.
 *
 * The source is `employee_skill_sets.role_title`, the "Role / Title" field on
 * the employee's own Profile → Skill Sets card (a department-specific pick list
 * with a free-typed "Custom title…" escape, 80 chars). It is employee-authored
 * and HR does not review it, so the certificate treats it as OPTIONAL: blank ⇒
 * the clause is omitted entirely, never a dash and never a refusal. The human
 * check is the one every other fact already gets — Accounting sees the role on
 * the facts card and on the real certificate before signing.
 */
export function coeRoleTitle(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/** Contracted hours per week, as the certificate template states them. */
export const COE_WEEKLY_HOURS = 40;

/** How many completed pay cycles the "bonuses earned" line sums (Kane, 2026-09-10). */
export const COE_RECENT_BONUS_CYCLES = 4;

/** How far back the statements are read to find those cycles. Twelve weeks
 *  gives a person who missed a few weeks room to still show four, while keeping
 *  the read to a dozen files instead of the whole archive. */
export const COE_RECENT_BONUS_LOOKBACK_DAYS = 84;

/**
 * The bonus money a worker's recent pay statements itemise, summed over their
 * most recent completed pay cycles. Every figure is PHP because the statements
 * are — a USD- or COP-rate person is still paid these lines in pesos.
 */
export interface CoeRecentBonuses {
  /** How many completed cycles were summed — at most COE_RECENT_BONUS_CYCLES,
   *  fewer when the person has fewer statements in the lookback window. */
  cycles: number;
  /** "Aug 9 – Sep 5, 2026" — oldest week's start to newest week's end. */
  windowLabel: string;
  /** ISO bounds of that window, for the audit trail. */
  windowStart: string | null;
  windowEnd: string | null;
  /** "₱12,850" — the three lines summed, formatted for the certificate. */
  total: string;
  totalPhp: number;
  attendancePhp: number;
  technologyPhp: number;
  performancePhp: number;
  /** "Attendance ₱10,000 · Technology ₱1,850 · Performance ₱1,000" — only the
   *  non-zero lines; null when every line was zero. */
  breakdown: string | null;
}

/** The statement fields the summary reads — a structural subset of PayStubView. */
export interface CoeStatementLike {
  weekStart: string | null;
  weekEnd: string | null;
  attendanceBonus: number;
  techBonus: number;
  performanceBonus: number;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/**
 * Sum the bonus lines of the `cycles` most recent COMPLETED statements.
 *
 * "Completed" = the week ended before `todayIso` (a Manila calendar date). The
 * in-progress week is excluded on purpose: its wizard snapshot is still moving
 * while Accounting works the week, and a certificate must not quote a figure
 * that can change an hour later. A completed week that is locked but not yet
 * dispatched IS counted — the line says "earned", not "paid".
 *
 * What counts as a bonus is exactly what the statement itemises as one:
 * Attendance (PAB), Technology and Performance. NOT the Adjustment (a
 * correction, possibly negative), NOT Orphanage pay, NOT a MESA disbursement
 * (the member's own savings coming back).
 *
 * Returns null when there is no completed statement at all — a brand-new hire —
 * so the certificate omits the line rather than printing "₱0 over 0 cycles".
 * Four completed cycles with no bonus money return a real ₱0, which is the truth.
 */
export function summarizeRecentBonuses(
  statements: ReadonlyArray<CoeStatementLike>,
  todayIso: string,
  cycles: number = COE_RECENT_BONUS_CYCLES,
): CoeRecentBonuses | null {
  const completed = statements
    .filter((s): s is CoeStatementLike & { weekEnd: string } => !!s.weekEnd && s.weekEnd < todayIso)
    .sort((a, b) => b.weekEnd.localeCompare(a.weekEnd))
    .slice(0, Math.max(0, cycles));
  if (completed.length === 0) return null;

  const attendancePhp = round2(completed.reduce((acc, s) => acc + (Number(s.attendanceBonus) || 0), 0));
  const technologyPhp = round2(completed.reduce((acc, s) => acc + (Number(s.techBonus) || 0), 0));
  const performancePhp = round2(completed.reduce((acc, s) => acc + (Number(s.performanceBonus) || 0), 0));
  const totalPhp = round2(attendancePhp + technologyPhp + performancePhp);

  const newest = completed[0];
  const oldest = completed[completed.length - 1];
  const windowStart = oldest.weekStart ?? oldest.weekEnd;
  const windowEnd = newest.weekEnd;

  const parts: string[] = [];
  if (attendancePhp !== 0) parts.push(`Attendance ${formatCoeMoney(attendancePhp, 'PHP')}`);
  if (technologyPhp !== 0) parts.push(`Technology ${formatCoeMoney(technologyPhp, 'PHP')}`);
  if (performancePhp !== 0) parts.push(`Performance ${formatCoeMoney(performancePhp, 'PHP')}`);

  return {
    cycles: completed.length,
    windowLabel: formatWeekHuman(windowStart, windowEnd),
    windowStart,
    windowEnd,
    total: formatCoeMoney(totalPhp, 'PHP'),
    totalPhp,
    attendancePhp,
    technologyPhp,
    performancePhp,
    breakdown: parts.length > 0 ? parts.join(' · ') : null,
  };
}

/** Today's calendar date in Manila (YYYY-MM-DD) — the timezone payroll runs on. */
function manilaTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `days` calendar days before a YYYY-MM-DD date, as YYYY-MM-DD (no TZ drift). */
function isoDaysBefore(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The master list's start date as a YYYY-MM-DD day, or null when unparseable.
 *  A date-only string is taken verbatim (never through UTC midnight); anything
 *  else goes through Date and is read as a local calendar day. */
function startDateIsoDay(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The earliest week END the recent-bonus read considers: the lookback cutoff,
 * but never earlier than the worker's engagement start.
 *
 * Measured on live data (2026-09-10): a July hire's 12-week window reached five
 * archive weeks they were never in, and every one of those ran the ~6 s
 * whole-company engine (no snapshot names a person who was not there yet) —
 * 45 s for a facts card. A week that ended before the person started cannot
 * carry their statement, so it is not a candidate. Statements are read by week
 * END, so a mid-week start still keeps its first (partial) week.
 */
export function recentBonusWindowStart(todayIso: string, startDateRaw: string): string {
  const cutoff = isoDaysBefore(todayIso, COE_RECENT_BONUS_LOOKBACK_DAYS);
  const start = startDateIsoDay(startDateRaw);
  return start && start > cutoff ? start : cutoff;
}

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
  /** The role the worker set on their own profile, or null ⇒ clause omitted. */
  roleTitle: string | null;
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
  /** Bonus money their last completed pay cycles actually itemised; null ⇒ no
   *  completed statement yet (or the caller opted out) ⇒ line omitted. */
  recentBonuses: CoeRecentBonuses | null;
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
 * The bonus money the worker's recent statements itemise — read through the
 * SAME assembly the Pay Stubs tab and its export use (`listEmployeePayStubs`),
 * never a private re-derivation, so the certificate and the statements it
 * summarises cannot disagree. Bounded to the lookback window so a certificate
 * does not pay for the whole archive.
 */
async function fetchRecentBonuses(
  email: string,
  startDateRaw: string,
): Promise<{ recent: CoeRecentBonuses | null; error: string | null }> {
  const today = manilaTodayIso();
  try {
    const { stubs } = await listEmployeePayStubs(email, {
      sinceWeekEnd: recentBonusWindowStart(today, startDateRaw),
    });
    return { recent: summarizeRecentBonuses(stubs.map((s) => s.view), today), error: null };
  } catch (e) {
    // A failed read is an error, never a silently missing money line.
    return {
      recent: null,
      error: `Could not read the recent pay statements: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Resolve everything the Certificate of Engagement prints for one worker.
 * `email` is always the caller's own session email — never a query parameter.
 *
 * `opts.recentBonuses` (default true) reads the worker's recent statements for
 * the "bonuses earned" line. A caller that only needs the standing terms — the
 * Penny profile tool — passes `false` and gets `recentBonuses: null` without
 * paying for the statement read.
 */
export async function resolveCoeFacts(
  email: string,
  opts: { recentBonuses?: boolean } = {},
): Promise<CoeFactsResult> {
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

  // The profile's Skill Sets card is keyed by the WORK email (the row the
  // employee edits is upserted under it), so read it by that, not the session
  // alias the caller happened to sign in with.
  const skillEmail = normEmail(master.work_email) ?? norm;
  const includeRecent = opts.recentBonuses !== false;

  const [structuresRes, systemRes, catalogRes, registry, sheetRes, skillRes, recentRes] =
    await Promise.all([
      listPayStructures(),
      listSystemBonuses(),
      listBonusCatalog(),
      getDepartmentRegistry(),
      fetchSheetRateFor(aliases),
      getSkillSet(skillEmail),
      includeRecent
        ? fetchRecentBonuses(norm, startDateRaw)
        : Promise.resolve({ recent: null, error: null } as Awaited<ReturnType<typeof fetchRecentBonuses>>),
    ]);
  if (structuresRes.error) return { facts: null, blocked: null, error: structuresRes.error };
  if (sheetRes.error) return { facts: null, blocked: null, error: sheetRes.error };
  if (skillRes.error) {
    return { facts: null, blocked: null, error: `Could not read the profile role: ${skillRes.error}` };
  }
  if (recentRes.error) return { facts: null, blocked: null, error: recentRes.error };

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
      roleTitle: coeRoleTitle(skillRes.row.role_title),
      weeklyHours: COE_WEEKLY_HOURS,
      hourlyRate: formatCoeRate(rate.regular, rate.currency),
      overtimeRate: formatCoeRate(otRate, rate.currency),
      currency: rate.currency,
      rateSource: rate.source as CoeFacts['rateSource'],
      standardBonuses,
      performanceBonuses,
      recentBonuses: recentRes.recent,
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
