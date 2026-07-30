// Payment Catalog -- System Bonuses (PAB + Technology Bonus + custom variants).
//
// PAB and the Technology Bonus used to be hardcoded PHP constants
// (PAB_BONUS_PHP = 5000, TECH_BONUS_PHP = 1850 in src/lib/payroll/dispatch-bonuses.ts).
// They are now editable rows in `payment_catalog_system_bonuses` carrying an
// AMOUNT plus a department ALLOWLIST -- the bonus is only paid to employees
// whose normalized department key is in `departmentKeys` (so US managers, who
// are paid in USD, can be excluded). See
// references/sql/create/create_payment_catalog_system_bonuses.sql.
//
// CUSTOM VARIANTS (added 2026-07-30): additional rows with a prefixed code
// (`pab:<slug>` / `tech:<slug>`) define a currency-denominated variant of the
// same engine-timed bonus for specific departments -- e.g. a USD Technology
// Bonus for the US team or a COP Perfect Attendance Bonus for a Colombian
// department. A variant keeps the built-in TIMING (PAB fires the final PAB
// week; Tech fires the 3rd-week salary) but overrides the AMOUNT for the
// departments in its allowlist; its native amount is converted to PHP at the
// live USD-anchored FX rate at resolve time (the pay engine stays PHP-pivot,
// same as Pay Structures / catalog bonuses). No schema change was needed --
// `code` is a text PK and COP was already allowed by add_cop_currency.sql.
//
// The helpers below are the SINGLE place the rows are turned into the
// {amount, enabled, dept-eligible} shape consumed by both the server payroll
// math (current-pay.ts / member-monthly-pay.ts) and the client surfaces
// (Payroll Wizard, Overview, Employee Dashboard / My Hours).

import { PAB_BONUS_PHP, TECH_BONUS_PHP } from '@/lib/payroll/dispatch-bonuses';
import { PAY_CURRENCIES, type PayCurrency } from '@/lib/payment-catalog/pay-structure';
import { officialFxRates, phpPerUnit, type FxRates } from '@/lib/fx/currency-fx';

/** The two engine timings a system bonus can follow. */
export type SystemBonusBase = 'pab' | 'tech';
/** Built-in row codes (kept for existing callers/UI). */
export type SystemBonusCode = SystemBonusBase;

export interface SystemBonus {
  /** Stable code = primary key. `'pab'`/`'tech'` are the built-ins; a custom
   *  variant uses `'pab:<slug>'` / `'tech:<slug>'` (prefix = engine timing). */
  code: string;
  /** Display label, e.g. "Perfect Attendance Bonus". */
  label: string;
  /** Amount in `currency` (native units -- whole pesos for COP by convention). */
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

/** Engine timing for a row code; null for a code this module doesn't know. */
export function systemBonusBase(code: string | null | undefined): SystemBonusBase | null {
  if (!code) return null;
  if (code === 'pab' || code.startsWith('pab:')) return 'pab';
  if (code === 'tech' || code.startsWith('tech:')) return 'tech';
  return null;
}

/** True for a custom variant code (`pab:*` / `tech:*`), false for built-ins. */
export function isCustomSystemBonusCode(code: string | null | undefined): boolean {
  return !!code && code.includes(':') && systemBonusBase(code) !== null;
}

const CUSTOM_CODE_RE = /^(pab|tech):[a-z0-9][a-z0-9-]{0,47}$/;

/** Mint a new custom-variant code from its label (slug + random suffix so two
 *  same-named variants never collide on the PK). */
export function makeCustomSystemBonusCode(base: SystemBonusBase, label: string): string {
  const slug =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'bonus';
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}:${slug}-${suffix}`.slice(0, 52);
}

/** Hardcoded fallbacks used when a row is missing (pre-migration / blank DB).
 *  Mirrors the legacy constants so nothing zeroes out before the table exists. */
export const SYSTEM_BONUS_DEFAULTS: Record<SystemBonusCode, { label: string; amount: number }> = {
  pab: { label: 'Perfect Attendance Bonus', amount: PAB_BONUS_PHP },
  tech: { label: 'Technology Bonus', amount: TECH_BONUS_PHP },
};

/** A resolved custom variant: native amount + PHP-equivalent + its allowlist. */
export interface SystemBonusVariant {
  code: string;
  label: string;
  amountNative: number;
  currency: PayCurrency;
  /** Native amount converted at the FX rates passed to resolveSystemBonuses. */
  amountPHP: number;
  /** Allowlist of canonical department keys (always non-empty for a variant). */
  deptKeys: Set<string>;
}

/** Resolved per-bonus config consumed by the pay math. */
export interface ResolvedSystemBonus {
  /** Built-in (base) amount, PHP-equivalent. */
  amountPHP: number;
  /** Built-in row's enabled flag (variants carry their own via inclusion). */
  enabled: boolean;
  /** Allowlist of canonical department keys (built-in row). */
  deptKeys: Set<string>;
  /** Enabled custom variants of this bonus, sorted by code for determinism. */
  variants: SystemBonusVariant[];
}

export interface ResolvedSystemBonuses {
  pab: ResolvedSystemBonus;
  tech: ResolvedSystemBonus;
}

function resolveOne(code: SystemBonusCode, rows: SystemBonus[], fx: FxRates): ResolvedSystemBonus {
  const row = rows.find((r) => r.code === code);
  const fallback = SYSTEM_BONUS_DEFAULTS[code].amount;

  // Enabled custom variants of this base. A variant with an EMPTY allowlist is
  // ignored defensively -- it would otherwise override every department.
  const variants: SystemBonusVariant[] = rows
    .filter(
      (r) =>
        isCustomSystemBonusCode(r.code) &&
        systemBonusBase(r.code) === code &&
        r.enabled !== false &&
        Array.isArray(r.departmentKeys) &&
        r.departmentKeys.length > 0 &&
        Number.isFinite(r.amount),
    )
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => ({
      code: r.code,
      label: r.label,
      amountNative: r.amount,
      currency: r.currency,
      amountPHP: r.amount * phpPerUnit(r.currency, fx),
      deptKeys: new Set(r.departmentKeys),
    }));

  if (!row) {
    // No built-in row yet (pre-migration): keep the legacy amount, applies to
    // everyone (empty allowlist => fail-open in isDeptEligible).
    return { amountPHP: fallback, enabled: true, deptKeys: new Set<string>(), variants };
  }
  const amountNative = Number.isFinite(row.amount) ? row.amount : fallback;
  // Built-ins are PHP in practice (phpPerUnit -> 1); the conversion makes a
  // re-denominated built-in row behave like a variant would.
  const amountPHP = Number.isFinite(row.amount)
    ? amountNative * phpPerUnit(row.currency, fx)
    : fallback;
  return {
    amountPHP,
    enabled: row.enabled !== false,
    deptKeys: new Set(row.departmentKeys ?? []),
    variants,
  };
}

/** Turn the raw rows into the {pab, tech} config the pay math consumes.
 *  `fx` converts non-PHP variant amounts; omit it only on surfaces that have no
 *  FX handy (falls back to the official reference rates). */
export function resolveSystemBonuses(rows: SystemBonus[], fx: FxRates = officialFxRates()): ResolvedSystemBonuses {
  return { pab: resolveOne('pab', rows, fx), tech: resolveOne('tech', rows, fx) };
}

/** The custom variant covering `deptKey`, if any (first by code order wins). */
export function variantForDept(
  cfg: ResolvedSystemBonus,
  deptKey: string | null | undefined,
): SystemBonusVariant | null {
  if (!deptKey) return null;
  return cfg.variants.find((v) => v.deptKeys.has(deptKey)) ?? null;
}

/** The PHP amount this bonus pays to an employee in `deptKey`: the covering
 *  custom variant's converted amount, else the built-in base amount. Pair with
 *  isDeptEligible -- this only answers "how much", not "whether". */
export function systemBonusAmountForDept(
  cfg: ResolvedSystemBonus,
  deptKey: string | null | undefined,
): number {
  return variantForDept(cfg, deptKey)?.amountPHP ?? cfg.amountPHP;
}

/**
 * Whether an employee in `deptKey` is eligible for a bonus given its allowlist.
 *
 * A department covered by an enabled custom variant is ALWAYS eligible (the
 * variant is an explicit opt-in, even when the built-in row is disabled or
 * omits the department). Otherwise the built-in row decides, FAIL-OPEN: when
 * the allowlist is empty (pre-migration / not configured) OR the department
 * can't be resolved to a key (unmapped department string), the bonus still
 * applies. Only an explicitly non-empty allowlist that omits a resolvable
 * department key excludes that department. This preserves the legacy "everyone
 * gets it" behavior and ensures only deliberately-omitted departments (e.g.
 * us_manager_bonus, which always normalizes) are dropped.
 */
export function isDeptEligible(cfg: ResolvedSystemBonus, deptKey: string | null | undefined): boolean {
  if (variantForDept(cfg, deptKey)) return true;
  if (!cfg.enabled) return false;
  if (cfg.deptKeys.size === 0) return true; // not configured -> applies to all
  if (!deptKey) return true; // unmapped department -> fail-open
  return cfg.deptKeys.has(deptKey);
}

/** Human-readable validity check for an editor save. */
export function validateSystemBonus(
  s: Pick<SystemBonus, 'code' | 'label' | 'amount' | 'currency' | 'departmentKeys'>,
): { ok: boolean; error?: string } {
  const custom = isCustomSystemBonusCode(s.code);
  if (!custom && s.code !== 'pab' && s.code !== 'tech') {
    return { ok: false, error: 'Unknown system bonus code.' };
  }
  if (custom && !CUSTOM_CODE_RE.test(s.code)) {
    return { ok: false, error: 'Invalid custom system bonus code.' };
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
  if (custom) {
    if (!s.label || !s.label.trim()) {
      return { ok: false, error: 'Enter a name for the bonus.' };
    }
    if (s.departmentKeys.length === 0) {
      return { ok: false, error: 'Pick at least one department for a custom system bonus.' };
    }
  }
  return { ok: true };
}
