// Payment Catalog -- Pay Structure data model.
//
// The authoritative starting compensation (Regular Rate + OT Rate) for a whole
// department ("common") or a single employee ("specific"). HR onboarding reads
// the department-scoped structures as the SOURCE OF TRUTH for prefilled rates
// (see src/lib/supabase/department-rates.ts).
//
// Each entry carries its own currency because the org pays a mix of PHP staff
// and USD contractors / US managers. Default is PHP, switchable to USD per row.

export type PayScope = 'department' | 'employee';
export type PayCurrency = 'PHP' | 'USD' | 'COP';

/** All supported currencies, in display order. Iterate this instead of
 *  hardcoding `['PHP','USD']` so a new currency is a one-line addition. */
export const PAY_CURRENCIES: readonly PayCurrency[] = ['PHP', 'USD', 'COP'];

/**
 * A stored or submitted currency, narrowed to `PayCurrency`. A legacy row with no currency is
 * PHP, and so is anything unrecognised. **COP is kept.** Every Payment Catalog read and write
 * path goes through this one function. Each used to hand-roll `=== 'USD' ? 'USD' : 'PHP'`,
 * which silently stored a COP rate or bonus as pesos even though the editor offered COP.
 * That is how 22,200 COP/hr was paid as ₱22,200/hr (item 373, bonus-catalog.md §5.7).
 */
export function toPayCurrency(raw: unknown): PayCurrency {
  return (PAY_CURRENCIES as readonly unknown[]).includes(raw) ? (raw as PayCurrency) : 'PHP';
}

/**
 * How a structure prices a person (Kane, 2026-10-02 — docs/features/salaried-pay-basis.md):
 *   hourly → `regularRate` × Hubstaff hours, plus OT — every structure before this date.
 *   salary → a flat `salaryAmount` per `salaryPeriod`; Hubstaff hours move no money.
 * A salary is legal on an EMPLOYEE-scope structure only: a salary is a dated fact about a
 * person, never a department property (the DB CHECK `pay_structures_salary_shape` agrees).
 */
export type PayBasis = 'hourly' | 'salary';
export type SalaryPeriod = 'day' | 'week' | 'month';
export const SALARY_PERIODS: readonly SalaryPeriod[] = ['day', 'week', 'month'];

/**
 * The periods the pay engines can price TODAY. Day and month are in the data model, but how
 * a daily or monthly amount maps onto the weekly pay run is Kane's ruling and has not been
 * made (salaried-pay-basis.md, NEEDS 1/2). The editor shows them disabled and the server
 * refuses them, so no salary is ever stored that no engine can price.
 */
export const PRICEABLE_SALARY_PERIODS: readonly SalaryPeriod[] = ['week'];

/** A salary can be held in PHP or USD. COP is refused. The write path stopped storing COP as
 *  PHP on 2026-10-07 (`toPayCurrency`), but no engine has ever priced a COP salary and nobody
 *  has asked for one (bonus-catalog.md §5.7). Widening this is Kane's call, not a cleanup. */
export const SALARY_CURRENCIES: readonly PayCurrency[] = ['PHP', 'USD'];

export const SALARY_PERIOD_LABEL: Record<SalaryPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

const SALARY_PERIOD_SUFFIX: Record<SalaryPeriod, string> = { day: '/day', week: '/wk', month: '/mo' };

export interface PayStructure {
  id: string;
  scope: PayScope;
  /** Canonical department key (DEPARTMENTS[].key). Required for both scopes
   *  (employee structures still record the department for grouping). */
  departmentKey: string;
  /** Lower-cased work/personal email. Required when scope === 'employee'. */
  employeeEmail?: string;
  /** Display name captured at assignment time. */
  employeeName?: string;
  /** Regular hourly rate in `currency`. ALWAYS 0 on a salary structure: a reader that
   *  was never taught the salary basis then pays ₱0 (loud), never a plausible hourly
   *  figure (salaried-pay-basis.md §3.2). */
  regularRate: number;
  /** Overtime hourly rate in `currency` (optional). Absent on a salary structure. */
  otRate?: number;
  currency: PayCurrency;
  /** Absent on rows read before the salary migration — read it with `payBasisOf`. */
  payBasis?: PayBasis;
  /** Set exactly when `payBasis === 'salary'`. */
  salaryPeriod?: SalaryPeriod;
  /** The flat amount per `salaryPeriod`, in `currency`. Set exactly when salaried. */
  salaryAmount?: number;
  /** Author attribution (set server-side from the session). */
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export const CURRENCY_SYMBOL: Record<PayCurrency, string> = {
  // Peso sign is non-ASCII; build it from a char code so this source stays ASCII.
  PHP: String.fromCharCode(0x20b1),
  USD: '$',
  // Colombian peso also uses "$"; suffix the code ("$COP") to disambiguate an
  // amount from USD/PHP without reading as the redundant "COP$ COP" in chips.
  COP: '$COP',
};

/** Compact label for currency chips / toggles / badges (symbol + code).
 *  COP's symbol is already "$COP" (it carries the code), so appending the code
 *  again would read "$COP COP" — show it alone. PHP/USD show "symbol code"
 *  (e.g. "₱ PHP", "$ USD"). */
export function currencyChipLabel(c: PayCurrency): string {
  return c === 'COP' ? CURRENCY_SYMBOL[c] : `${CURRENCY_SYMBOL[c]} ${c}`;
}

/** Locale per currency for `toLocaleString` grouping/decimals. */
export const CURRENCY_LOCALE: Record<PayCurrency, string> = {
  PHP: 'en-PH',
  USD: 'en-US',
  COP: 'es-CO',
};

/** OT pay defaults to 1.5x the regular rate; a "custom" OT rate may override it. */
export const OT_MULTIPLIER = 1.5;

/** Default OT rate derived from the regular rate (1.5x), rounded to cents. */
export function defaultOtRate(regularRate: number): number {
  return Math.round(regularRate * OT_MULTIPLIER * 100) / 100;
}

/** True when `otRate` is effectively the auto 1.5x value (within a cent). */
export function isAutoOtRate(regularRate: number, otRate: number | null | undefined): boolean {
  if (otRate == null || !Number.isFinite(otRate)) return false;
  return Math.abs(otRate - defaultOtRate(regularRate)) <= 0.005;
}

/** Format a rate in its currency, e.g. "$35.50/hr".
 *  Always shows exactly 2 decimals so the exact cent amount is preserved and a
 *  whole-number rate never looks "rounded" (35 -> "35.00", 35.5 -> "35.50"). */
export function formatRate(amount: number | null | undefined, currency: PayCurrency): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  return `${sym}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr`;
}

/** The structure's basis; a row with no `payBasis` predates the salary migration and is hourly. */
export function payBasisOf(s: Pick<PayStructure, 'payBasis'>): PayBasis {
  return s.payBasis === 'salary' ? 'salary' : 'hourly';
}

/** A salary structure with both figures present — the only shape the engines price from. */
export function isSalaryStructure(
  s: Pick<PayStructure, 'payBasis' | 'salaryPeriod' | 'salaryAmount'>,
): s is Pick<PayStructure, 'payBasis'> & { payBasis: 'salary'; salaryPeriod: SalaryPeriod; salaryAmount: number } {
  return s.payBasis === 'salary' && s.salaryPeriod != null && s.salaryAmount != null;
}

/** "₱25,000.00/wk" — a salary in its currency, period-suffixed (never "/hr"). */
export function formatSalary(
  amount: number | null | undefined,
  period: SalaryPeriod,
  currency: PayCurrency,
): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  return `${sym}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${SALARY_PERIOD_SUFFIX[period]}`;
}

/** Human-readable validity check for a pay structure. */
export function validatePayStructure(
  s: Pick<
    PayStructure,
    'scope' | 'regularRate' | 'otRate' | 'currency' | 'employeeEmail' | 'payBasis' | 'salaryPeriod' | 'salaryAmount'
  >,
): { ok: boolean; error?: string } {
  if (s.payBasis != null && s.payBasis !== 'hourly' && s.payBasis !== 'salary') {
    return { ok: false, error: 'Pay basis must be hourly or salary.' };
  }
  if (s.payBasis === 'salary') {
    if (s.scope !== 'employee') {
      return { ok: false, error: 'A salary can only be set for an individual, never a whole department.' };
    }
    if (!s.salaryPeriod || !SALARY_PERIODS.includes(s.salaryPeriod)) {
      return { ok: false, error: 'Choose whether the salary is per day, week, or month.' };
    }
    if (!PRICEABLE_SALARY_PERIODS.includes(s.salaryPeriod)) {
      return {
        ok: false,
        error: `A salary per ${s.salaryPeriod} can't be paid yet — how it maps onto the weekly pay run hasn't been decided. Use a weekly salary.`,
      };
    }
    if (s.salaryAmount == null || !Number.isFinite(s.salaryAmount) || s.salaryAmount < 0) {
      return { ok: false, error: 'Enter a non-negative salary amount.' };
    }
    if (!SALARY_CURRENCIES.includes(s.currency)) {
      return { ok: false, error: 'A salary can be held in PHP or USD only.' };
    }
    if (!s.employeeEmail) {
      return { ok: false, error: 'Employee pay structure requires an email.' };
    }
    // The hourly rate on a salary row is pinned to 0 and OT is absent, so a reader that does
    // not know the salary basis prices ₱0 — never a believable hourly figure.
    if (s.regularRate !== 0 || s.otRate != null) {
      return { ok: false, error: 'A salary structure carries no hourly or OT rate.' };
    }
    return { ok: true };
  }
  if (s.salaryPeriod != null || s.salaryAmount != null) {
    return { ok: false, error: 'An hourly structure carries no salary figures.' };
  }
  if (s.regularRate == null || !Number.isFinite(s.regularRate) || s.regularRate < 0) {
    return { ok: false, error: 'Enter a non-negative regular rate.' };
  }
  if (s.otRate != null && (!Number.isFinite(s.otRate) || s.otRate < 0)) {
    return { ok: false, error: 'OT rate must be a non-negative number.' };
  }
  if (!PAY_CURRENCIES.includes(s.currency)) {
    return { ok: false, error: 'Currency must be PHP, USD, or COP.' };
  }
  if (s.scope === 'employee' && !s.employeeEmail) {
    return { ok: false, error: 'Employee pay structure requires an email.' };
  }
  return { ok: true };
}

/** Stable, collision-resistant id without external deps. */
export function newPayId(prefix = 'pay'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** The identifying fields of a pay structure — everything needed to decide which
 *  DB row a save belongs in, without carrying the rate figures around. */
export type PayStructureSlot = Pick<
  PayStructure,
  'id' | 'scope' | 'departmentKey' | 'employeeEmail'
>;

/** Normalized natural-key slot for a structure, or null when it occupies none.
 *  Mirrors the DB's unique indexes exactly:
 *    department scope → (department_key)                    [dept_uniq]
 *    employee scope   → (department_key, lower(email))      [emp_uniq]
 *  An employee row without an email falls outside `emp_uniq`'s partial
 *  predicate, so it has no slot (and `validatePayStructure` rejects it anyway). */
function slotKey(s: PayStructureSlot): string | null {
  const dept = (s.departmentKey ?? '').trim().toLowerCase();
  if (!dept) return null;
  if (s.scope === 'department') return `dept:${dept}`;
  const email = (s.employeeEmail ?? '').trim().toLowerCase();
  return email ? `emp:${dept}:${email}` : null;
}

/**
 * The id a save must actually write to: the row already occupying this
 * structure's NATURAL key slot, or the caller's own id when the slot is free.
 *
 * WHY THIS EXISTS (2026-08-04 bug): `id` is only a surrogate — the DB's real
 * uniqueness is the natural key (see `slotKey`). The Payroll Wizard's inline
 * "Set rate" editor (Readiness → No Pay Rate, and the Offboarded tab) has no
 * structures list in hand, so it mints a FRESH `newPayId()` every time it
 * opens. Upserting on `id` alone then degraded to a plain INSERT for anyone who
 * already had a structure and surfaced the raw Postgres text
 * "duplicate key value violates unique constraint
 * ...pay_structures_emp_uniq" in the dialog — for any of the ~714 people who
 * already had one. Resolving the slot here makes "set this person's rate" mean
 * the same thing from every surface, whether or not the caller happens to know
 * the existing id.
 *
 * (The Payment Catalog tab never hit this because it passes
 * `existing?.id ?? newPayId()` — it has the list. Callers that DO know the id
 * are unaffected: their id already owns the slot, so it's returned unchanged.)
 */
export function resolvePayStructureWriteTargetId(
  incoming: PayStructureSlot,
  occupants: readonly PayStructureSlot[],
): string {
  const want = slotKey(incoming);
  if (!want) return incoming.id;
  // First match wins so the choice is deterministic even if the unique index
  // were ever missing and real duplicates existed.
  const holder = occupants.find((o) => slotKey(o) === want);
  return holder ? holder.id : incoming.id;
}
