// One person's compensation, resolved exactly the way the payroll engine
// resolves it.
//
// This used to live inside BonusCatalog.tsx, serving only the Payment Catalog's
// Search tab. It moved here when the Certificate of Engagement started printing
// rates and bonuses: a COE goes to banks and embassies, so it must never quote a
// number the Search tab (or the engine) disagrees with. One resolver, two
// callers — a client tab and a server-side PDF renderer — hence a pure module
// with no React and no Supabase imports.
//
// Rate precedence, from current-pay.ts: an employee-scope catalog structure
// overrides everything; the rates sheet is the middle layer; a department-scope
// base rate applies only when there is no sheet row at all.

import {
  isDeptEligible,
  variantForDept,
  SYSTEM_BONUS_DEFAULTS,
  type ResolvedSystemBonuses,
  type SystemBonus,
  type SystemBonusCode,
} from '@/lib/payment-catalog/system-bonus';
import type { PayCurrency, PayStructure } from '@/lib/payment-catalog/pay-structure';
import type { BonusAssignment } from '@/lib/bonus-catalog/types';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { hslSubKeyFromRaw, hslSubDeptLabel } from '@/lib/departments/hsl-subdept';

/** Rates sheet row for one person — the engine's middle rate layer. */
export type SheetRate = { reg: number | null; ot: number | null };

/**
 * The minimum a caller must know about a person. Structurally satisfied by the
 * Payment Catalog's RosterEntry and by anything the server can assemble from
 * the master list.
 */
export interface PersonCompSubject {
  /** Primary (usually work) email, lower-cased. */
  email: string;
  /** Every email the catalog may key this person's rows under (work + personal),
   *  lower-cased. Dispatch resolves structures across aliases, so anything that
   *  mirrors it must match the same way. */
  aliases: string[];
  /** Department label as the roster/master list spells it. */
  department: string;
}

/** Prebuilt lookups shared across result rows and the open person card.
 *  Mirrors the engine's indexes: later-one-wins on duplicate structure keys
 *  (buildCatalogRateIndex) and work-then-personal email for the sheet. */
export interface PersonCompIndexes {
  structByEmail: Map<string, PayStructure>;
  deptStructByKey: Map<string, PayStructure>;
  sheetRateByEmail: Map<string, SheetRate>;
  resolvedSystem: ResolvedSystemBonuses;
  systemBonuses: SystemBonus[];
  assignments: BonusAssignment[];
  customDepartments: { key: string; name: string }[];
}

/** A PAB/Tech row as it applies to one person, in the currency they're paid. */
export interface PersonSystemBonusRow {
  code: string;
  label: string;
  amount: number;
  currency: PayCurrency;
}

/** Everything the catalog knows about one person's compensation. */
export interface PersonComp {
  deptKey: string | null;
  /** Their employee-scope catalog structure, when one exists (any alias). */
  override: PayStructure | undefined;
  /** Their rates-sheet row (the engine's middle rate layer), when present. */
  sheetRate: SheetRate | null;
  /** The department-scope base rate their department falls back to. */
  deptBase: PayStructure | undefined;
  /** The layer the engine actually pays: employee catalog -> sheet -> dept base. */
  rateSource: 'individual' | 'sheet' | 'department' | 'none';
  employeeAssignments: BonusAssignment[];
  commonAssignments: { assignment: BonusAssignment; excluded: boolean }[];
  systemRows: PersonSystemBonusRow[];
}

/** Roster department label -> canonical key, custom departments included. */
export function resolveRosterDeptKey(
  department: string,
  customDepartments: { key: string; name: string }[],
): string | null {
  const mapped = normalizeDeptToKey(department);
  if (mapped) return mapped;
  const nameKey = department.trim().toLowerCase();
  if (!nameKey) return null;
  const custom = customDepartments.find((d) => d.name.trim().toLowerCase() === nameKey);
  return custom?.key ?? (slugifyDeptKey(department) || null);
}

/** Sheet rates arrive as text ("1,234.50") — same parse the engine uses. */
export function parseRateText(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function computePersonComp(person: PersonCompSubject, idx: PersonCompIndexes): PersonComp {
  const aliases = person.aliases.length ? person.aliases : [person.email.toLowerCase()];
  const aliasSet = new Set(aliases);

  // First alias with a structure wins, like resolveEmployeeCatalogRate.
  let override: PayStructure | undefined;
  for (const a of aliases) {
    override = idx.structByEmail.get(a);
    if (override) break;
  }
  let sheetRate: SheetRate | null = null;
  for (const a of aliases) {
    const hit = idx.sheetRateByEmail.get(a);
    if (hit) {
      sheetRate = hit;
      break;
    }
  }
  const hasSheet = sheetRate != null && (sheetRate.reg != null || sheetRate.ot != null);

  // The roster label resolves the department; a stored override's key is the
  // last resort (only blank/punctuation-only labels resolve to nothing).
  const deptKey =
    resolveRosterDeptKey(person.department, idx.customDepartments) ?? override?.departmentKey ?? null;

  // MUST mirror resolveDeptCatalogRate: a namespaced sub-department label
  // (`hsl:intake_specialist`) carries its OWN base rate and is resolved BEFORE
  // the collapse to the parent key, with the parent as fallback. This card's
  // whole contract is that it states what the engine will pay — showing the
  // parent ₱225 for someone the engine prices off their sub-team rate is
  // exactly the misstatement the Search tab was built to avoid.
  //
  // `deptKey` deliberately stays the PARENT key: it also keys dept-scoped BONUS
  // assignments below, and HSL bonuses are assigned on `hogan_smith_law`.
  const subKey = hslSubKeyFromRaw(person.department);
  const deptBase =
    (subKey ? idx.deptStructByKey.get(hslSubDeptLabel(subKey)) : undefined) ??
    (deptKey ? idx.deptStructByKey.get(deptKey) : undefined);

  // Engine precedence (current-pay.ts): the individual catalog rate overrides
  // everything; the dept base applies only when there is NO sheet rate.
  const rateSource: PersonComp['rateSource'] = override
    ? 'individual'
    : hasSheet
      ? 'sheet'
      : deptBase
        ? 'department'
        : 'none';

  const employeeAssignments = idx.assignments.filter(
    (a) => a.scope === 'employee' && aliasSet.has((a.employeeEmail ?? '').toLowerCase()),
  );
  const commonAssignments = (
    deptKey
      ? idx.assignments.filter((a) => a.scope === 'department' && a.departmentKey === deptKey)
      : []
  ).map((assignment) => ({
    assignment,
    excluded: (assignment.excludedEmails ?? []).some((e) => aliasSet.has(e.toLowerCase())),
  }));

  // Engine semantics exactly: isDeptEligible fail-opens on unresolvable
  // departments; a custom `pab:*`/`tech:*` currency variant covering this
  // person's department replaces the built-in amount (shown in its native
  // currency — the engine converts to PHP at the live FX rate at payout).
  const systemRows = (['pab', 'tech'] as SystemBonusCode[]).flatMap<PersonSystemBonusRow>((code) => {
    const cfg = idx.resolvedSystem[code];
    if (!isDeptEligible(cfg, deptKey)) return [];
    const variant = variantForDept(cfg, deptKey);
    if (variant) {
      return [
        {
          code: variant.code,
          label: variant.label,
          amount: variant.amountNative,
          currency: variant.currency,
        },
      ];
    }
    const row = idx.systemBonuses.find((b) => b.code === code);
    return [
      {
        code,
        label: row?.label ?? SYSTEM_BONUS_DEFAULTS[code].label,
        amount: cfg.amountPHP,
        currency: 'PHP' as PayCurrency,
      },
    ];
  });

  return {
    deptKey,
    override,
    sheetRate: hasSheet ? sheetRate : null,
    deptBase,
    rateSource,
    employeeAssignments,
    commonAssignments,
    systemRows,
  };
}

/** The rate layer the engine pays, in its native currency. `null` when the
 *  person has no rate anywhere — a COE cannot be issued in that case. */
export function winningRate(
  comp: PersonComp,
): { regular: number; ot: number | null; currency: PayCurrency; source: PersonComp['rateSource'] } | null {
  if (comp.rateSource === 'individual' && comp.override) {
    return {
      regular: comp.override.regularRate,
      ot: comp.override.otRate ?? null,
      currency: comp.override.currency,
      source: 'individual',
    };
  }
  if (comp.rateSource === 'sheet' && comp.sheetRate?.reg != null) {
    // The rates sheet is PHP-only by construction.
    return { regular: comp.sheetRate.reg, ot: comp.sheetRate.ot, currency: 'PHP', source: 'sheet' };
  }
  if (comp.rateSource === 'department' && comp.deptBase) {
    return {
      regular: comp.deptBase.regularRate,
      ot: comp.deptBase.otRate ?? null,
      currency: comp.deptBase.currency,
      source: 'department',
    };
  }
  return null;
}
