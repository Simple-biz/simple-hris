// Payment Catalog -- System Bonuses (PAB + Technology Bonus) data model.
//
// PAB and the Technology Bonus used to be hardcoded PHP constants
// (PAB_BONUS_PHP = 5000, TECH_BONUS_PHP = 1850 in src/lib/payroll/dispatch-bonuses.ts).
// They are now editable rows in `payment_catalog_system_bonuses` carrying an
// AMOUNT plus a department ALLOWLIST -- the bonus is only paid to employees
// whose normalized department key is in `departmentKeys` (so US managers, who
// are paid in USD, can be excluded). See
// references/create_payment_catalog_system_bonuses.sql.
//
// The helpers below are the SINGLE place the rows are turned into the
// {amount, enabled, dept-eligible} shape consumed by both the server payroll
// math (current-pay.ts / member-monthly-pay.ts) and the client surfaces
// (Payroll Wizard, Overview, Employee Dashboard / My Hours). Amounts are PHP.

import { PAB_BONUS_PHP, TECH_BONUS_PHP } from '@/lib/payroll/dispatch-bonuses';
import { PAY_CURRENCIES, type PayCurrency } from '@/lib/payment-catalog/pay-structure';

export type SystemBonusCode = 'pab' | 'tech';

export interface SystemBonus {
  /** Stable code = primary key. */
  code: SystemBonusCode;
  /** Display label, e.g. "Perfect Attendance Bonus". */
  label: string;
  /** Amount in `currency` (PHP in practice -- US managers are excluded). */
  amount: number;
  currency: PayCurrency;
  /** When false the bonus never pays regardless of attendance/timing. */
  enabled: boolean;
  /** Canonical DEPARTMENTS[].key allowlist -- only these departments are paid. */
  departmentKeys: string[];
  /** Author attribution (set server-side from the session). */
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

/** Hardcoded fallbacks used when a row is missing (pre-migration / blank DB).
 *  Mirrors the legacy constants so nothing zeroes out before the table exists. */
export const SYSTEM_BONUS_DEFAULTS: Record<SystemBonusCode, { label: string; amount: number }> = {
  pab: { label: 'Perfect Attendance Bonus', amount: PAB_BONUS_PHP },
  tech: { label: 'Technology Bonus', amount: TECH_BONUS_PHP },
};

/** Resolved per-bonus config consumed by the pay math. */
export interface ResolvedSystemBonus {
  amountPHP: number;
  enabled: boolean;
  /** Allowlist of canonical department keys. */
  deptKeys: Set<string>;
}

export interface ResolvedSystemBonuses {
  pab: ResolvedSystemBonus;
  tech: ResolvedSystemBonus;
}

function resolveOne(code: SystemBonusCode, rows: SystemBonus[]): ResolvedSystemBonus {
  const row = rows.find((r) => r.code === code);
  const fallback = SYSTEM_BONUS_DEFAULTS[code].amount;
  if (!row) {
    // No row yet (pre-migration): keep the legacy amount, applies to everyone
    // (empty allowlist => fail-open in isDeptEligible).
    return { amountPHP: fallback, enabled: true, deptKeys: new Set<string>() };
  }
  const amount = Number.isFinite(row.amount) ? row.amount : fallback;
  return {
    amountPHP: amount,
    enabled: row.enabled !== false,
    deptKeys: new Set(row.departmentKeys ?? []),
  };
}

/** Turn the raw rows into the {pab, tech} config the pay math consumes. */
export function resolveSystemBonuses(rows: SystemBonus[]): ResolvedSystemBonuses {
  return { pab: resolveOne('pab', rows), tech: resolveOne('tech', rows) };
}

/**
 * Whether an employee in `deptKey` is eligible for a bonus given its allowlist.
 *
 * FAIL-OPEN: when the allowlist is empty (pre-migration / not configured) OR the
 * department can't be resolved to a key (unmapped department string), the bonus
 * still applies. Only an explicitly non-empty allowlist that omits a resolvable
 * department key excludes that department. This preserves the legacy "everyone
 * gets it" behavior and ensures only deliberately-omitted departments (e.g.
 * us_manager_bonus, which always normalizes) are dropped.
 */
export function isDeptEligible(cfg: ResolvedSystemBonus, deptKey: string | null | undefined): boolean {
  if (!cfg.enabled) return false;
  if (cfg.deptKeys.size === 0) return true; // not configured -> applies to all
  if (!deptKey) return true; // unmapped department -> fail-open
  return cfg.deptKeys.has(deptKey);
}

/** Human-readable validity check for an editor save. */
export function validateSystemBonus(
  s: Pick<SystemBonus, 'code' | 'amount' | 'currency' | 'departmentKeys'>,
): { ok: boolean; error?: string } {
  if (s.code !== 'pab' && s.code !== 'tech') {
    return { ok: false, error: 'Unknown system bonus code.' };
  }
  if (s.amount == null || !Number.isFinite(s.amount) || s.amount < 0) {
    return { ok: false, error: 'Enter a non-negative amount.' };
  }
  if (!PAY_CURRENCIES.includes(s.currency)) {
    return { ok: false, error: 'Currency must be PHP, USD, or COP.' };
  }
  if (!Array.isArray(s.departmentKeys)) {
    return { ok: false, error: 'Department list is invalid.' };
  }
  return { ok: true };
}
