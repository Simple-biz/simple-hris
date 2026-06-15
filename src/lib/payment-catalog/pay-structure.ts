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
export type PayCurrency = 'PHP' | 'USD';

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

/** Format a rate in its currency, e.g. "$35.50/hr". */
export function formatRate(amount: number | null | undefined, currency: PayCurrency): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  return `${sym}${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}/hr`;
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
  if (s.currency !== 'PHP' && s.currency !== 'USD') {
    return { ok: false, error: 'Currency must be PHP or USD.' };
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
