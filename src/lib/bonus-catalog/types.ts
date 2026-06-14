// Bonus Catalog data model.
//
// A standalone, accountant-authored catalog of reusable bonus definitions plus
// the assignments that attach them either to a whole department ("common") or
// to a single employee ("specific"). Persisted as a JSON blob in `app_settings`
// under BONUS_CATALOG_KEY via the existing /api/app-settings route.
//
// This layer is intentionally decoupled from live payroll: it lets us define
// and validate bonus rules first; wiring computed results into the Payroll
// Wizard is a deliberate later step.

import { validateFormula } from './formula';

export const BONUS_CATALOG_KEY = 'bonus.catalog';
export const BONUS_CATALOG_VERSION = 1 as const;

/** How a bonus produces its peso amount. */
export type BonusKind = 'flat' | 'formula';

export interface BonusDef {
  id: string;
  name: string;
  description?: string;
  kind: BonusKind;
  /** For kind === 'flat'. */
  amount?: number;
  /** For kind === 'formula' (Excel-style syntax). */
  formula?: string;
  /** Author attribution (set server-side from the session). */
  createdBy?: string | null;
  createdAt?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export type AssignmentScope = 'department' | 'employee';

export interface BonusAssignment {
  id: string;
  bonusId: string;
  scope: AssignmentScope;
  /** Canonical department key (DEPARTMENTS[].key). Required for both scopes
   *  (employee assignments still record the department for grouping). */
  departmentKey: string;
  /** Lower-cased work/personal email. Required when scope === 'employee'. */
  employeeEmail?: string;
  /** Display name captured at assignment time. */
  employeeName?: string;
  /** For scope === 'department' only: lower-cased emails of department members
   *  who should NOT receive this common bonus. Empty/absent = applies to all. */
  excludedEmails?: string[];
  /** For scope === 'department' only: when true the common bonus is a "team
   *  effort" -- the manager enters its formula inputs ONCE for the whole
   *  department and every (non-excluded) member receives the result. When false
   *  (default) each member has their own inputs/amount. */
  sharedTeam?: boolean;
  /** Author attribution (set server-side from the session). */
  createdBy?: string | null;
  createdAt?: string | null;
}

export interface BonusCatalog {
  version: typeof BONUS_CATALOG_VERSION;
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
}

export function emptyCatalog(): BonusCatalog {
  return { version: BONUS_CATALOG_VERSION, bonuses: [], assignments: [] };
}

/** Coerce an unknown parsed blob into a well-formed catalog (defensive). */
export function normalizeCatalog(raw: unknown): BonusCatalog {
  if (!raw || typeof raw !== 'object') return emptyCatalog();
  const obj = raw as Partial<BonusCatalog>;
  const bonuses = Array.isArray(obj.bonuses)
    ? obj.bonuses.filter((b): b is BonusDef => !!b && typeof b.id === 'string' && typeof b.name === 'string')
    : [];
  const bonusIds = new Set(bonuses.map((b) => b.id));
  const assignments = Array.isArray(obj.assignments)
    ? obj.assignments.filter(
        (a): a is BonusAssignment =>
          !!a &&
          typeof a.id === 'string' &&
          typeof a.bonusId === 'string' &&
          bonusIds.has(a.bonusId) &&
          (a.scope === 'department' || a.scope === 'employee'),
      )
    : [];
  return { version: BONUS_CATALOG_VERSION, bonuses, assignments };
}

/** Parse the raw app_settings string value into a catalog. */
export function parseCatalog(value: string | null | undefined): BonusCatalog {
  if (!value) return emptyCatalog();
  try {
    return normalizeCatalog(JSON.parse(value));
  } catch {
    return emptyCatalog();
  }
}

/** The amount a flat bonus pays, or null when the bonus is formula-based. */
export function flatAmount(bonus: BonusDef): number | null {
  return bonus.kind === 'flat' ? (Number.isFinite(bonus.amount) ? (bonus.amount as number) : 0) : null;
}

/** Human-readable validity check for a bonus definition. */
export function validateBonus(bonus: Pick<BonusDef, 'kind' | 'amount' | 'formula'>): {
  ok: boolean;
  error?: string;
} {
  if (bonus.kind === 'flat') {
    if (bonus.amount == null || !Number.isFinite(bonus.amount)) {
      return { ok: false, error: 'Enter a numeric amount.' };
    }
    return { ok: true };
  }
  const res = validateFormula(bonus.formula ?? '');
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Stable, collision-resistant id without external deps. */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
