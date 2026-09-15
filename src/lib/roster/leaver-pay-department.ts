/**
 * A LEAVER's pay department — Kane's ruling, 2026-09-15: *"Please make sure that
 * the paystub department will change."*
 *
 * Context. The HRIS master list is the department source of truth for everyone
 * still on the roster (`hris-is-dept-source-of-truth`). A person who has LEFT is
 * different: their master row is frozen (`updateMasterListProfile` refuses
 * off-boarded rows, transfers auto-cancel, the employee cannot sign in), so the
 * only department signal Accounting can still move for a final check is the one
 * the Payroll Notes → Offboarded "Set rate" dialog writes — the `department_key`
 * of the individual Payment Catalog structure. Until this rule existed that pick
 * chose a catalog slot and nothing else: `michaelsy@` was saved 265 / Hogan three
 * times on 2026-09-15 while his stage kept saying Lead Gen (no weekend premium).
 *
 * The rule, in words: for a leaver, the department their EFFECTIVE individual
 * rate files under overrides the master label — but only when that structure was
 * touched on or after the day they left (or the departure is undated), and only
 * when it actually names a different department. Three guards, each closing a
 * way the rule could relabel someone Accounting never meant to move:
 *
 *   1. No individual structure → master (the status quo for most leavers).
 *   2. A structure last touched BEFORE the departure is history, not a final-pay
 *      decision. The HSL bulk rate set of 2026-08-17 gave many later Lead Gen
 *      leavers a `hogan_smith_law` structure; their properly-filed HRIS transfer
 *      to Lead Gen must still win. Undated departures ("fell off the sheet") have
 *      no such line to draw, so the structure speaks.
 *   3. Same department, different spelling → keep the MASTER label. An HSL
 *      sub-team cell (`hsl:filing_specialist`) and a `hogan_smith_law` structure
 *      resolve to one family; the sub-team is the more specific truth and must
 *      not collapse to the parent name.
 *
 * Pure — no I/O — so both readers (the wizard's final-pay roster overlay and the
 * Offboarded tab's payload) call the same function and can never disagree.
 */
import { normEmail } from '@/lib/email/norm-email';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { resolveDeptKeyWithRegistry, slugifyDeptKey, type DepartmentRegistryEntry } from '@/lib/departments/registry';
import type { CatalogRateIndex } from '@/lib/payroll/resolve-rate';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';

/** The three fields of an individual structure this rule reads. */
export interface LeaverDeptStructure {
  departmentKey: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type LeaverDeptSource = 'master' | 'catalog';

/**
 * The master-list label a department KEY prints as. `hsl:*` keys ARE the
 * master-cell convention for a sub-team placement and pass through verbatim;
 * built-ins print their catalog name; in-app registry departments print their
 * current name; anything else falls back to the key itself so a label is never
 * lost to an unknown key.
 */
export function deptLabelForKey(key: string, registry: readonly DepartmentRegistryEntry[] = []): string {
  const k = key.trim();
  if (!k) return k;
  if (k.toLowerCase().startsWith('hsl:')) return k;
  const builtin = DEPARTMENTS.find((d) => d.key === k);
  if (builtin) return builtin.name;
  const custom = registry.find((e) => e.key === k);
  if (custom) return custom.name;
  return k;
}

/** Canonical key for a master label, through the same three resolvers the
 *  wizard's department tiers use (built-in → registry → slug). */
export function deptKeyForLabel(label: string | null | undefined, registry: readonly DepartmentRegistryEntry[] = []): string | null {
  if (!label || !label.trim()) return null;
  return (
    normalizeDeptToKey(label) ??
    resolveDeptKeyWithRegistry(label, [...registry]) ??
    (slugifyDeptKey(label) || null)
  );
}

/** `YYYY-MM-DD` of an ISO timestamp / date string, or null. */
function dayOf(v: string | null | undefined): string | null {
  const m = (v ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * The individual structure a person's rate resolves to — the FIRST alias that
 * owns one, walked in the same order `resolvePeopleRate` / the wizard walk
 * (Hubstaff email first: THE payable identity). Null when none.
 */
export function pickLeaverStructure(
  index: CatalogRateIndex,
  aliases: readonly (string | null | undefined)[],
): PayStructure | null {
  for (const a of aliases) {
    const em = normEmail(a);
    if (!em) continue;
    const s = index.byEmail.get(em);
    if (s) return s;
  }
  return null;
}

export function leaverPayDepartment(args: {
  masterDepartment: string | null;
  /** `YYYY-MM-DD` (or ISO) they left; null when the departure is undated. */
  offBoardedAt: string | null;
  structure: LeaverDeptStructure | null;
  registry?: readonly DepartmentRegistryEntry[];
}): { department: string | null; source: LeaverDeptSource } {
  const registry = args.registry ?? [];
  const master = args.masterDepartment?.trim() ? args.masterDepartment.trim() : null;
  const s = args.structure;
  // 1. no individual structure → the master label stands.
  if (!s || !s.departmentKey?.trim()) return { department: master, source: 'master' };
  // 2. touched before the departure → history, not a final-pay decision.
  const touched = dayOf(s.updatedAt) ?? dayOf(s.createdAt);
  const left = dayOf(args.offBoardedAt);
  if (left && touched && touched < left) return { department: master, source: 'master' };
  // 3. same department under another spelling → keep the more specific master cell.
  const structureKey = s.departmentKey.trim();
  const structureFamily = normalizeDeptToKey(structureKey) ?? structureKey;
  const masterKey = deptKeyForLabel(master, registry);
  const masterFamily = masterKey ? (normalizeDeptToKey(masterKey) ?? masterKey) : null;
  if (masterKey === structureKey || (masterFamily && masterFamily === structureFamily)) {
    return { department: master, source: 'master' };
  }
  return { department: deptLabelForKey(structureKey, registry), source: 'catalog' };
}
