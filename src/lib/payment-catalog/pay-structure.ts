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
  /** Regular hourly rate in `currency`. */
  regularRate: number;
  /** Overtime hourly rate in `currency` (optional). */
  otRate?: number;
  currency: PayCurrency;
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
  // Colombian peso also uses "$"; prefix to disambiguate from USD/PHP.
  COP: 'COP$',
};

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

/** Human-readable validity check for a pay structure. */
export function validatePayStructure(
  s: Pick<PayStructure, 'scope' | 'regularRate' | 'otRate' | 'currency' | 'employeeEmail'>,
): { ok: boolean; error?: string } {
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
