/**
 * Salaried pay basis — the PURE resolver both pay engines (the Payroll Wizard's client calc and
 * the server's `computeCurrentPay`) call, so they can never disagree about who is salaried in a
 * given pay week or what the week pays. Client-safe: no DB, no server-only imports.
 *
 * THE RULING (docs/features/salaried-pay-basis.md §2): a salary is a DATED FACT ABOUT A PERSON,
 * never a property of a department. The basis is read from `employee_salary_history` (email +
 * effective date, mirroring `employee_rate_history`) as of the person's pay-week start — never
 * from a department label, which is the most-clobbered field in the system and fails toward
 * HOURLY, not toward zero (§3.1–3.2).
 *
 * THE CONTRACT (§4.1): `resolveSalaryBasis` returns `hourly`, `salary`, or `unknown` — NEVER null.
 * A degraded read must not be able to `if (salary)` its way into the hourly chain. `unknown` means
 * REFUSE TO PRICE: the row is unpaid and flagged exactly like a "No rate" row, so Accounting sees
 * it, instead of a plausible hourly number on a plausible paystub (§6).
 *
 * THE MONEY (Kane, 2026-10-02): "instead of the regular hourly and ot hourly … a flat rate
 * everytime no matter their hubstaff hours". A salaried week pays the flat amount — no OT, no
 * HSL weekend premium, and time adjustments move nothing. Bonuses, Adj., MESA and Orphanage stay
 * on top, unchanged. Only a WEEKLY salary prices today; day and month wait on Kane's ruling.
 */
import {
  PRICEABLE_SALARY_PERIODS,
  SALARY_CURRENCIES,
  type PayCurrency,
  type PayStructure,
  type SalaryPeriod,
} from '@/lib/payment-catalog/pay-structure';
import { phpPerUnit, type FxRates } from '@/lib/fx/currency-fx';
import { normEmail } from '@/lib/email/norm-email';

/** One `employee_salary_history` row, parsed. `unreadable` = a row the app cannot interpret
 *  (impossible under the DB CHECKs; kept so a hand edit fails closed instead of reading hourly). */
export type SalaryHistoryRow = {
  email: string;
  /** Local-midnight date the basis takes effect (same construction as rate history). */
  effectiveFrom: Date;
  effectiveIso: string;
  /** Tie-break for rows on one date under two aliases of one person. */
  createdAtMs: number;
} & (
  | { basis: 'hourly' }
  | { basis: 'salary'; period: SalaryPeriod; amount: number; currency: PayCurrency }
  | { basis: 'unreadable'; raw: string }
);

/** Map<lower-cased email, rows sorted NEWEST effective date first>. */
export type SalaryHistoryByEmail = Map<string, SalaryHistoryRow[]>;

/** Whether the history could be read at all. `not_configured` = the table does not exist yet
 *  (migration not applied) — then no structure can be salaried either. */
export type SalaryHistoryState = 'loaded' | 'unavailable' | 'not_configured';

/** What the person's winning employee-scope Pay Structure says (the editor's current state). */
export type StructureBasisClaim =
  | { kind: 'none' }
  | { kind: 'hourly' }
  | { kind: 'salary'; period: SalaryPeriod; amount: number; currency: PayCurrency }
  /** The catalog itself failed to load — the cross-check cannot run. */
  | { kind: 'unavailable' };

export type SalaryUnknownReason =
  | 'history_unavailable'
  | 'structure_mismatch'
  | 'changed_mid_week'
  | 'partial_week'
  | 'period_not_priced'
  | 'currency_not_priced'
  | 'unreadable_row'
  | 'fx_unavailable'
  /** The engine could not place the person's pay week, so the basis cannot be dated. */
  | 'week_unknown'
  /** The offboarded list could not be read, so a mid-week last day cannot be ruled out. */
  | 'leavers_unavailable';

export type SalaryBasis =
  | { kind: 'hourly' }
  | {
      kind: 'salary';
      period: SalaryPeriod;
      amount: number;
      currency: PayCurrency;
      /** YYYY-MM-DD the salary in force took effect. */
      effectiveFrom: string;
    }
  | { kind: 'unknown'; reason: SalaryUnknownReason; detail: string };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD…' → local-midnight Date, or null. */
export function parseIsoDay(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local midnight of `d` (drops any time of day). */
function day(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Is `iso` a SUNDAY — the first day of every pay week the engines run today (non-HSL Sun→Sat,
 * and HSL Sun→Sat since the 2026-05-31 cutover)? A salary change is only accepted on one: a
 * change inside a week would be a partial week, and the partial-week divisor is Kane's ruling
 * (salaried-pay-basis.md, NEEDS 3).
 */
export function isPayWeekSunday(iso: string | null | undefined): boolean {
  const d = parseIsoDay(iso ?? '');
  return d != null && d.getDay() === 0 && isoOf(d) === (iso ?? '').trim().slice(0, 10);
}

/** The next Sunday strictly after `from` (the default effective date for a salary change). */
export function nextSundayIso(from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + (7 - d.getDay()));
  return isoOf(d);
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the per-email index from raw `employee_salary_history` rows (as returned by the API).
 * Every row lands somewhere — an uninterpretable one becomes `unreadable`, never dropped, so a
 * bad row can only make a week REFUSE to price, never quietly fall back to hourly.
 */
export function buildSalaryHistoryByEmail(
  raw: ReadonlyArray<{
    employee_email?: unknown;
    effective_from?: unknown;
    pay_basis?: unknown;
    salary_period?: unknown;
    salary_amount?: unknown;
    currency?: unknown;
    created_at?: unknown;
  }>,
): SalaryHistoryByEmail {
  const out: SalaryHistoryByEmail = new Map();
  for (const r of raw) {
    const email = normEmail(String(r.employee_email ?? ''));
    const eff = parseIsoDay(r.effective_from);
    if (!email || !eff) continue;
    const createdAtMs = typeof r.created_at === 'string' ? Date.parse(r.created_at) || 0 : 0;
    const base = { email, effectiveFrom: eff, effectiveIso: isoOf(eff), createdAtMs };
    const basis = String(r.pay_basis ?? '');
    const period = String(r.salary_period ?? '') as SalaryPeriod;
    const amount = num(r.salary_amount);
    const currency = String(r.currency ?? 'PHP') as PayCurrency;
    let row: SalaryHistoryRow;
    if (basis === 'hourly' && r.salary_period == null && r.salary_amount == null) {
      row = { ...base, basis: 'hourly' };
    } else if (
      basis === 'salary' &&
      (['day', 'week', 'month'] as const).includes(period as 'day') &&
      amount != null &&
      amount >= 0 &&
      (['PHP', 'USD', 'COP'] as const).includes(currency as 'PHP')
    ) {
      row = { ...base, basis: 'salary', period, amount, currency };
    } else {
      row = { ...base, basis: 'unreadable', raw: JSON.stringify(r) };
    }
    const list = out.get(email);
    if (list) list.push(row);
    else out.set(email, [row]);
  }
  for (const list of out.values()) sortNewestFirst(list);
  return out;
}

function sortNewestFirst(list: SalaryHistoryRow[]): void {
  list.sort(
    (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAtMs - a.createdAtMs,
  );
}

/** Every history row filed under ANY of the person's aliases, newest first. A row is filed under
 *  the address the structure was saved with, which may be the personal or an alternate one. */
export function salaryRowsForEmails(
  history: SalaryHistoryByEmail,
  emails: Iterable<string>,
): SalaryHistoryRow[] {
  const seen = new Set<string>();
  const rows: SalaryHistoryRow[] = [];
  for (const e of emails) {
    const em = normEmail(e);
    if (!em || seen.has(em)) continue;
    seen.add(em);
    const list = history.get(em);
    if (list) rows.push(...list);
  }
  sortNewestFirst(rows);
  return rows;
}

/** The structure's claim, from the catalog's winning employee-scope structure (or none). */
export function structureBasisClaim(s: PayStructure | null | undefined): StructureBasisClaim {
  if (!s) return { kind: 'none' };
  if (s.payBasis === 'salary') {
    if (s.salaryPeriod == null || s.salaryAmount == null) {
      // A salary flag with no figures cannot price; claim a salary nobody can match so the
      // resolver fails closed on structure_mismatch rather than reading hourly.
      return { kind: 'salary', period: s.salaryPeriod ?? 'week', amount: Number.NaN, currency: s.currency };
    }
    return { kind: 'salary', period: s.salaryPeriod, amount: s.salaryAmount, currency: s.currency };
  }
  return { kind: 'hourly' };
}

const AMOUNT_EPSILON = 0.005;

function sameSalary(
  a: { period: SalaryPeriod; amount: number; currency: PayCurrency },
  b: { period: SalaryPeriod; amount: number; currency: PayCurrency },
): boolean {
  return a.period === b.period && a.currency === b.currency && Math.abs(a.amount - b.amount) <= AMOUNT_EPSILON;
}

/** Do two history rows state the same basis (and, for a salary, the same figures)? */
function sameBasis(a: SalaryHistoryRow, b: SalaryHistoryRow): boolean {
  if (a.basis === 'unreadable' || b.basis === 'unreadable') return false;
  if (a.basis === 'hourly' || b.basis === 'hourly') return a.basis === b.basis;
  return sameSalary(a, b);
}

function fmtDay(d: Date): string {
  return isoOf(d);
}

export interface ResolveSalaryBasisInput {
  /** The person's rows across every alias, NEWEST first (`salaryRowsForEmails`). */
  rows: readonly SalaryHistoryRow[];
  historyState: SalaryHistoryState;
  /** The winning employee-scope structure's claim (`structureBasisClaim`), or `unavailable`. */
  structure: StructureBasisClaim;
  /** The person's pay week, inclusive, local dates. */
  weekStart: Date;
  weekEnd: Date;
  /** Master-list start date, when known. */
  startDate?: Date | null;
  /** Last day of employment (offboard date). `'unknown'` = the person is offboarded but no
   *  date is recorded (they fell off the sheet) — a salaried week then cannot be judged whole. */
  lastDay?: Date | null | 'unknown';
}

/**
 * The person's pay basis for ONE pay week. Never null (§4.1). The order of the checks is the
 * order of the failure classes, safest refusal first:
 *
 *   1. The history could not be read → anyone the catalog calls salaried is `unknown`.
 *   2. The Pay Structure and the LATEST history row disagree (a failed history write, a shadow
 *      structure filed under another department winning the catalog) → `unknown`.
 *   3. A basis or salary change dated INSIDE the week → `unknown` (a partial week).
 *   4. The row in force on the week's first day decides: salary → checked for period, currency,
 *      and a start or last day inside the week; hourly/none → `hourly`.
 */
export function resolveSalaryBasis(input: ResolveSalaryBasisInput): SalaryBasis {
  const { rows, historyState, structure } = input;
  const ws = day(input.weekStart);
  const we = day(input.weekEnd);

  if (historyState === 'not_configured') {
    // The table does not exist, so no salary can have been saved through the app. A structure
    // claiming one anyway is a contradiction — refuse rather than guess.
    if (structure.kind === 'salary') {
      return {
        kind: 'unknown',
        reason: 'history_unavailable',
        detail: 'The Pay Structure says salary, but the salary history is not set up.',
      };
    }
    return { kind: 'hourly' };
  }

  if (historyState === 'unavailable') {
    if (structure.kind === 'salary') {
      return {
        kind: 'unknown',
        reason: 'history_unavailable',
        detail: 'The salary history could not be read, so this salaried week is held.',
      };
    }
    return { kind: 'hourly' };
  }

  const latest = rows[0];
  if (latest && rows.length > 1) {
    // Two aliases of one person both carrying a row on the newest date, saying different things.
    const tie = rows.find((r, i) => i > 0 && r.effectiveFrom.getTime() === latest.effectiveFrom.getTime());
    if (tie && !sameBasis(tie, latest)) {
      return {
        kind: 'unknown',
        reason: 'structure_mismatch',
        detail: `Two salary history rows dated ${latest.effectiveIso} disagree.`,
      };
    }
  }

  // ── 2. Pay Structure ⇄ latest history row ──
  if (structure.kind !== 'unavailable') {
    if (structure.kind === 'salary') {
      if (!latest || latest.basis !== 'salary' || !sameSalary(latest, structure)) {
        return {
          kind: 'unknown',
          reason: 'structure_mismatch',
          detail: latest
            ? 'The Pay Structure says salary, but the dated salary history says otherwise. Re-save the salary.'
            : 'The Pay Structure says salary, but no dated salary row exists. Re-save the salary.',
        };
      }
    } else if (latest && latest.basis !== 'hourly') {
      return {
        kind: 'unknown',
        reason: 'structure_mismatch',
        detail:
          structure.kind === 'none'
            ? 'The salary history says salary, but no individual Pay Structure exists for this person.'
            : 'The salary history says salary, but the winning Pay Structure is hourly.',
      };
    }
  }

  // ── 3/4. Row in force on the first day, and any change inside the week ──
  const inForce = rows.find((r) => r.effectiveFrom.getTime() <= ws) ?? null;
  for (const r of rows) {
    const t = r.effectiveFrom.getTime();
    if (t <= ws || t > we) continue;
    if (r.basis === 'unreadable') {
      return { kind: 'unknown', reason: 'unreadable_row', detail: `A salary history row dated ${r.effectiveIso} is unreadable.` };
    }
    const changes = inForce ? !sameBasis(r, inForce) : r.basis !== 'hourly';
    if (changes) {
      return {
        kind: 'unknown',
        reason: 'changed_mid_week',
        detail: `The pay basis changes on ${r.effectiveIso}, inside this pay week.`,
      };
    }
  }

  if (!inForce || inForce.basis === 'hourly') return { kind: 'hourly' };
  if (inForce.basis === 'unreadable') {
    return {
      kind: 'unknown',
      reason: 'unreadable_row',
      detail: `The salary history row dated ${inForce.effectiveIso} is unreadable.`,
    };
  }

  if (!PRICEABLE_SALARY_PERIODS.includes(inForce.period)) {
    return {
      kind: 'unknown',
      reason: 'period_not_priced',
      detail: `A salary per ${inForce.period} cannot be paid on the weekly run yet.`,
    };
  }
  if (!SALARY_CURRENCIES.includes(inForce.currency)) {
    return {
      kind: 'unknown',
      reason: 'currency_not_priced',
      detail: `A salary held in ${inForce.currency} cannot be paid yet.`,
    };
  }
  const start = input.startDate ? day(input.startDate) : null;
  if (start != null && start > ws) {
    return {
      kind: 'unknown',
      reason: 'partial_week',
      detail: `Started ${fmtDay(new Date(start))}, inside this pay week — a partial salary week is not priced yet.`,
    };
  }
  if (input.lastDay === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'partial_week',
      detail: 'Offboarded with no recorded last day — a partial salary week is not priced yet.',
    };
  }
  const last = input.lastDay ? day(input.lastDay) : null;
  if (last != null && last < we) {
    return {
      kind: 'unknown',
      reason: 'partial_week',
      detail: `Last day ${fmtDay(new Date(last))}, inside this pay week — a partial salary week is not priced yet.`,
    };
  }

  return {
    kind: 'salary',
    period: inForce.period,
    amount: inForce.amount,
    currency: inForce.currency,
    effectiveFrom: inForce.effectiveIso,
  };
}

export type PricedSalaryWeek =
  | {
      ok: true;
      /** PHP-equivalent the week pays (USD converted at the cycle FX), rounded to centavos. */
      amountPhp: number;
      amountNative: number;
      currency: PayCurrency;
      period: SalaryPeriod;
      effectiveFrom: string;
    }
  | { ok: false; reason: SalaryUnknownReason; detail: string };

/**
 * What a salaried week pays: the flat weekly amount, converted to PHP-equivalent at the cycle FX
 * exactly as a USD hourly rate is (`resolve-rate.ts` toResolved). A USD salary with no usable FX
 * refuses — a ₱0 week would otherwise look like a paid one.
 */
export function priceSalaryWeek(
  basis: Extract<SalaryBasis, { kind: 'salary' }>,
  fx: FxRates,
): PricedSalaryWeek {
  if (basis.period !== 'week') {
    return { ok: false, reason: 'period_not_priced', detail: `A salary per ${basis.period} cannot be paid on the weekly run yet.` };
  }
  const factor = phpPerUnit(basis.currency, fx);
  if (!(factor > 0)) {
    return { ok: false, reason: 'fx_unavailable', detail: `No ${basis.currency}→PHP rate is set for this cycle.` };
  }
  return {
    ok: true,
    amountPhp: Math.round(basis.amount * factor * 100) / 100,
    amountNative: basis.amount,
    currency: basis.currency,
    period: basis.period,
    effectiveFrom: basis.effectiveFrom,
  };
}

/** What ONE person's week pays, as both engines consume it. */
export type SalaryWeekOutcome =
  | { kind: 'hourly' }
  | { kind: 'salary'; pay: Extract<PricedSalaryWeek, { ok: true }> }
  | { kind: 'held'; reason: SalaryUnknownReason; detail: string };

/**
 * The single entry point both pay engines call (the wizard's calcResults and the server's
 * computeCurrentPay), so the basis AND the money are decided by one function. `week` null means
 * the engine could not place the pay week: anyone the records call salaried is then held.
 */
export function resolveSalaryWeek(
  args: {
    history: SalaryHistoryByEmail;
    historyState: SalaryHistoryState;
    emails: Iterable<string>;
    structure: StructureBasisClaim;
    week: { start: Date; end: Date } | null;
    startDate?: Date | null;
    lastDay?: Date | null | 'unknown';
  },
  fx: FxRates,
): SalaryWeekOutcome {
  const rows = args.historyState === 'loaded' ? salaryRowsForEmails(args.history, args.emails) : [];
  if (!args.week) {
    const claimsSalary = args.structure.kind === 'salary' || rows.some((r) => r.basis !== 'hourly');
    return claimsSalary
      ? { kind: 'held', reason: 'week_unknown', detail: 'The pay week could not be placed, so the salary cannot be dated.' }
      : { kind: 'hourly' };
  }
  const basis = resolveSalaryBasis({
    rows,
    historyState: args.historyState,
    structure: args.structure,
    weekStart: args.week.start,
    weekEnd: args.week.end,
    startDate: args.startDate,
    lastDay: args.lastDay,
  });
  if (basis.kind === 'hourly') return basis;
  if (basis.kind === 'unknown') return { kind: 'held', reason: basis.reason, detail: basis.detail };
  const priced = priceSalaryWeek(basis, fx);
  return priced.ok ? { kind: 'salary', pay: priced } : { kind: 'held', reason: priced.reason, detail: priced.detail };
}

/** Short label for the reason a salaried week was held (Step 2 chip, validation, reports). */
export function salaryHeldLabel(reason: SalaryUnknownReason): string {
  switch (reason) {
    case 'partial_week':
      return 'Salary held — partial week';
    case 'changed_mid_week':
      return 'Salary held — changed mid-week';
    case 'structure_mismatch':
      return 'Salary held — records disagree';
    case 'history_unavailable':
      return 'Salary held — history unavailable';
    case 'period_not_priced':
      return 'Salary held — period not priced';
    case 'currency_not_priced':
      return 'Salary held — currency not priced';
    case 'fx_unavailable':
      return 'Salary held — no FX rate';
    case 'week_unknown':
      return 'Salary held — pay week unknown';
    case 'leavers_unavailable':
      return 'Salary held — leaver list unavailable';
    case 'unreadable_row':
    default:
      return 'Salary held — unreadable record';
  }
}
