// Custom department registry -- departments created in-app from the Payment
// Catalog's "Department" tab (as opposed to the built-in payroll departments
// hardcoded in src/lib/payroll/department-bonus.ts, which the Google-Sheet
// master list sync populates).
//
// SELF-CONTAINED BY DESIGN: an in-app department does NOT depend on the Global
// Master List. Its people, sub-departments (HSL-style internal teams) and
// structure all live here; creation never writes roster rows or touches the
// master Google Sheet. The registry connects outward only through things that
// aren't the master list: department_managers oversight grants and the
// department-scoped Payment Catalog pay structure (keyed by this entry's
// `key`).
//
// Storage: a single JSON blob in `app_settings` under REGISTRY_SETTING_KEY
// (see registry-db.ts) -- deliberately no new table, so the feature needs no
// SQL migration. Department creation is rare and single-writer in practice.
//
// This module is CLIENT-SAFE: types + pure helpers only, no Supabase imports.

import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { hslSubDeptOptions, isPlaceableDeptLabel } from '@/lib/departments/hsl-subdept';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { PAY_CURRENCIES, type PayCurrency } from '@/lib/payment-catalog/pay-structure';

/** app_settings key holding the JSON registry (array of entries). */
export const DEPARTMENTS_REGISTRY_SETTING_KEY = 'payment_catalog.departments.registry';

export interface DepartmentSubUnit {
  /** Stable slug within the parent department (e.g. "intake_team"). */
  key: string;
  /** Display name (e.g. "Intake Team"). */
  name: string;
}

/**
 * Pay-structure department key for a SUB-department: `<parentKey>:<subKey>`
 * (e.g. "medical_billing:intake_team"). Same namespacing convention as the
 * built-in HSL sub-teams (`hsl:intake_specialist`), so the rate engine's
 * namespaced-key lookup resolves both. When a department has sub-departments,
 * base rates live on these keys — the parent department carries NO base rate.
 */
export function subDeptStructureKey(parentKey: string, subKey: string): string {
  return `${parentKey}:${subKey}`;
}

/** A person of an in-app department. The registry is their system of record --
 *  they may or may not also exist on the Global Master List, and this feature
 *  neither checks nor cares. Email is the identity key within a department. */
export interface DepartmentMemberRecord {
  name: string;
  /** Lower-cased; unique within the department. */
  workEmail: string;
  personalEmail?: string | null;
  /** Managers also carry a department_managers oversight grant. */
  isManager: boolean;
  /** Sub-department key (one of the entry's subDepartments) or null. */
  subDepartment?: string | null;
  /** YYYY-MM-DD, informational. */
  startDate?: string | null;
  addedBy?: string | null;
  /** ISO timestamp. */
  addedAt?: string | null;
}

export interface DepartmentRegistryEntry {
  /** Stable slug key -- doubles as the PayStructure.departmentKey for this
   *  department's Payment Catalog rates (e.g. "medical_billing"). */
  key: string;
  /** Display name (e.g. "Medical Billing"). */
  name: string;
  /** HSL-style internal teams. Empty when the department has none. */
  subDepartments: DepartmentSubUnit[];
  /** The department's people, managers included. */
  members: DepartmentMemberRecord[];
  createdBy: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /**
   * Former display names, oldest first. A RENAME keeps `key` (the slug of the
   * ORIGINAL name — it is the PayStructure.departmentKey, the prefix of every
   * `<key>:<sub>` rate row, and what the rate resolver / manager KPI card reach
   * by slugging a raw label) and files the old name here, so every resolver
   * still lands on this entry for cells that carry either label.
   */
  previousNames?: string[];
  /** Last edit attribution (Edit Department). Absent on never-edited entries. */
  updatedBy?: string | null;
  /** ISO timestamp of the last edit. */
  updatedAt?: string | null;
}

/** Slug used as both the registry key and the Payment Catalog departmentKey.
 *  "Medical Billing" -> "medical_billing". */
export function slugifyDeptKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Built-in payroll department keys (collisions with these are rejected). */
const BUILTIN_KEYS = new Set(DEPARTMENTS.map((d) => d.key));

/** Every display label that refers to `entry`: the current name first, then
 *  every former name (a renamed department keeps answering to its old label,
 *  because master-list cells and Hubstaff rows written before the rename still
 *  carry it). */
export function deptEntryLabels(entry: Pick<DepartmentRegistryEntry, 'name' | 'previousNames'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of [entry.name, ...(entry.previousNames ?? [])]) {
    const t = (label ?? '').trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * The `department_managers.department` label an in-app department's manager
 * grants are written under: the label whose slug IS the registry key — i.e. the
 * ORIGINAL name. Manager surfaces have no registry; they reach the department
 * by slugging the grant string (`customManagedKeys`), so a grant written under
 * a renamed label would silently drop the manager's KPI card. Falls back to the
 * current name for an entry whose key was never derived from any of its labels
 * (cannot happen for registry-created entries; defensive).
 */
export function managerGrantLabel(entry: Pick<DepartmentRegistryEntry, 'key' | 'name' | 'previousNames'>): string {
  for (const label of deptEntryLabels(entry)) {
    if (slugifyDeptKey(label) === entry.key) return label;
  }
  return entry.name.trim();
}

/** Does a raw label name this entry? Current or former display name (case-
 *  insensitive), or a slug that equals the key or any label's slug. */
function labelRefersToEntry(raw: string, entry: DepartmentRegistryEntry): boolean {
  const needle = raw.trim().toLowerCase();
  if (!needle) return false;
  const slug = slugifyDeptKey(raw);
  if (slug && slug === entry.key) return true;
  for (const label of deptEntryLabels(entry)) {
    if (label.toLowerCase() === needle) return true;
    if (slug && slugifyDeptKey(label) === slug) return true;
  }
  return false;
}

/** Resolves a raw department label to a department key, checking the built-in
 *  payroll map first, then the custom registry (current or former name, or
 *  slug match). Returns null for unknown strings -- same contract as
 *  normalizeDeptToKey. */
export function resolveDeptKeyWithRegistry(
  raw: string | null | undefined,
  registry: DepartmentRegistryEntry[],
): string | null {
  const builtin = normalizeDeptToKey(raw);
  if (builtin) return builtin;
  if (!raw) return null;
  if (!raw.trim()) return null;
  for (const entry of registry) {
    if (labelRefersToEntry(raw, entry)) return entry.key;
  }
  return null;
}

/** True when a raw department label refers to `entry` (current or former
 *  label, or slug match). */
export function rawDeptMatchesEntry(raw: string | null | undefined, entry: DepartmentRegistryEntry): boolean {
  if (!raw) return false;
  return labelRefersToEntry(raw, entry);
}

/**
 * `slug → key` for every registry label whose slug is NOT the key — i.e. the
 * labels a renamed department has worn. The catalog rate index files the
 * department's base structure under these too, so a master cell carrying the
 * NEW name (`resolve-rate.ts` slugs the raw label) still reaches the rate.
 * Built-in keys are never shadowed: a label that slugs to a built-in key is
 * skipped (validation refuses such names anyway).
 */
export function deptKeyAliasSlugs(registry: readonly DepartmentRegistryEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of registry) {
    for (const label of deptEntryLabels(entry)) {
      const slug = slugifyDeptKey(label);
      if (!slug || slug === entry.key || BUILTIN_KEYS.has(slug) || out.has(slug)) continue;
      out.set(slug, entry.key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create-department input (shared by the wizard and the API route)
// ---------------------------------------------------------------------------

export interface NewDepartmentMember {
  name: string;
  workEmail: string;
  personalEmail?: string | null;
  /** Managers are required (at least one) and also get a department_managers
   *  oversight row so the department shows on their Manager dashboard. */
  isManager: boolean;
  /** Sub-department key (one of input.subDepartments) or null. */
  subDepartment?: string | null;
  /** YYYY-MM-DD, informational (defaults to today, Manila). */
  startDate?: string | null;
}

export interface CreateDepartmentPayStructureInput {
  regularRate: number;
  otRate?: number;
  currency: PayCurrency;
}

export interface NewSubDepartment {
  /** Display name; the key is derived server-side via slugifyDeptKey. */
  name: string;
  /** This sub-department's BASE rate (the fallback for its people unless they
   *  get an individual structure), or null to skip — settable later from the
   *  Pay Structure tab under the `<parentKey>:<subKey>` entry. */
  payStructure: CreateDepartmentPayStructureInput | null;
}

export interface CreateDepartmentInput {
  name: string;
  subDepartments: NewSubDepartment[];
  members: NewDepartmentMember[];
  /** Department-wide starting rate, or null to skip (settable later from the
   *  Pay Structure tab either way). Only meaningful for a FLAT department:
   *  when sub-departments exist, base rates live on them and this must be
   *  null (validation enforces it). */
  payStructure: CreateDepartmentPayStructureInput | null;
}

const MAX_NAME_LEN = 60;
const MAX_SUB_DEPARTMENTS = 24;
const MAX_MEMBERS = 200;

function isEmailish(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** The people rules, shared by create and edit: at least one person, at least
 *  one Manager, unique valid work emails, sub-department picks that exist. */
function memberListError(
  members: NewDepartmentMember[],
  subKeys: ReadonlySet<string>,
  rosterNoun: string,
): string | null {
  if (members.length === 0) {
    return 'Add at least one person (a manager) to the department.';
  }
  if (members.length > MAX_MEMBERS) {
    return `Keep the ${rosterNoun} to ${MAX_MEMBERS} people or fewer.`;
  }
  const seenEmails = new Set<string>();
  let managers = 0;
  for (const m of members) {
    const who = m.name?.trim() || m.workEmail?.trim() || 'a member';
    if (!m.name?.trim()) return 'Every person needs a name.';
    const email = m.workEmail?.trim().toLowerCase() ?? '';
    if (!email || !isEmailish(email)) {
      return `${who} needs a valid work email.`;
    }
    if (seenEmails.has(email)) {
      return `${email} is listed twice.`;
    }
    seenEmails.add(email);
    if (m.personalEmail && !isEmailish(m.personalEmail)) {
      return `${who}'s personal email doesn't look like an email.`;
    }
    if (m.subDepartment && !subKeys.has(m.subDepartment)) {
      return `${who} is assigned to a sub-department that isn't defined.`;
    }
    if (m.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(m.startDate)) {
      return `${who}'s start date must be YYYY-MM-DD.`;
    }
    if (m.isManager) managers += 1;
  }
  if (managers === 0) {
    return 'Mark at least one person as the department Manager.';
  }
  return null;
}

/** A base-rate input's problem, or null when it is well-formed. */
function payStructureError(rate: CreateDepartmentPayStructureInput, who: string): string | null {
  if (!Number.isFinite(rate.regularRate) || rate.regularRate < 0) {
    return `${who}: enter a non-negative regular rate.`;
  }
  if (rate.otRate != null && (!Number.isFinite(rate.otRate) || rate.otRate < 0)) {
    return `${who}: OT rate must be a non-negative number.`;
  }
  if (!PAY_CURRENCIES.includes(rate.currency)) {
    return `${who}: currency must be PHP, USD, or COP.`;
  }
  return null;
}

/** Human-readable validity check, mirrored client-side (wizard gating) and
 *  server-side (the route re-runs it before writing anything). */
export function validateCreateDepartmentInput(input: CreateDepartmentInput): {
  ok: boolean;
  error?: string;
} {
  const name = input.name?.trim() ?? '';
  if (!name) return { ok: false, error: 'Enter a department name.' };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Department name must be ${MAX_NAME_LEN} characters or fewer.` };
  }
  const key = slugifyDeptKey(name);
  if (!key) return { ok: false, error: 'Department name needs at least one letter or number.' };
  if (normalizeDeptToKey(name) || BUILTIN_KEYS.has(key)) {
    return { ok: false, error: `"${name}" already exists as a built-in department.` };
  }

  if (input.subDepartments.length > MAX_SUB_DEPARTMENTS) {
    return { ok: false, error: `Keep it to ${MAX_SUB_DEPARTMENTS} sub-departments or fewer.` };
  }
  const subKeys = new Set<string>();
  for (const sub of input.subDepartments) {
    const subName = sub?.name?.trim() ?? '';
    if (!subName) return { ok: false, error: 'Sub-department names cannot be empty.' };
    if (subName.length > MAX_NAME_LEN) {
      return { ok: false, error: `Sub-department "${subName}" is too long (max ${MAX_NAME_LEN}).` };
    }
    const subKey = slugifyDeptKey(subName);
    if (!subKey) {
      return { ok: false, error: `Sub-department "${subName}" needs at least one letter or number.` };
    }
    if (subKeys.has(subKey)) {
      return { ok: false, error: `Sub-department "${subName}" is listed twice.` };
    }
    subKeys.add(subKey);
    const rate = sub.payStructure;
    if (rate) {
      if (!Number.isFinite(rate.regularRate) || rate.regularRate < 0) {
        return { ok: false, error: `${subName}: enter a non-negative regular rate.` };
      }
      if (rate.otRate != null && (!Number.isFinite(rate.otRate) || rate.otRate < 0)) {
        return { ok: false, error: `${subName}: OT rate must be a non-negative number.` };
      }
      if (!PAY_CURRENCIES.includes(rate.currency)) {
        return { ok: false, error: `${subName}: currency must be PHP, USD, or COP.` };
      }
    }
  }
  // With sub-departments, base rates live ON the sub-departments — the parent
  // department must not carry its own base rate (the HSL model).
  if (subKeys.size > 0 && input.payStructure) {
    return {
      ok: false,
      error: 'A department with sub-departments carries no department-wide rate — set base rates per sub-department instead.',
    };
  }

  const membersError = memberListError(input.members, subKeys, 'initial roster');
  if (membersError) return { ok: false, error: membersError };

  const pay = input.payStructure;
  if (pay) {
    if (!Number.isFinite(pay.regularRate) || pay.regularRate < 0) {
      return { ok: false, error: 'Enter a non-negative regular rate.' };
    }
    if (pay.otRate != null && (!Number.isFinite(pay.otRate) || pay.otRate < 0)) {
      return { ok: false, error: 'OT rate must be a non-negative number.' };
    }
    if (!PAY_CURRENCIES.includes(pay.currency)) {
      return { ok: false, error: 'Currency must be PHP, USD, or COP.' };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Creation progress protocol (the route streams these as ndjson lines; the
// wizard's staged loading animation advances on them)
// ---------------------------------------------------------------------------

export type CreateDepartmentStageKey = 'department' | 'managers' | 'members' | 'rates';

/** Stage order + labels ("Creating department, adding managers, adding members
 *  and setting pay rates") -- shared so the overlay and the route can't drift. */
export const CREATE_DEPARTMENT_STAGES: { key: CreateDepartmentStageKey; label: string }[] = [
  { key: 'department', label: 'Creating department' },
  { key: 'managers', label: 'Adding managers' },
  { key: 'members', label: 'Adding members' },
  { key: 'rates', label: 'Setting pay rates' },
];

export interface CreateDepartmentSummary {
  key: string;
  name: string;
  managersAdded: number;
  membersAdded: number;
  rateSet: boolean;
  /** How many sub-departments got their own base rate structure. */
  subRatesSet: number;
  /** Non-fatal issues worth surfacing. Creation still succeeded. */
  warnings: string[];
}

export type CreateDepartmentEvent =
  | { type: 'stage'; stage: CreateDepartmentStageKey; status: 'start' | 'done'; note?: string }
  | { type: 'done'; summary: CreateDepartmentSummary }
  | { type: 'error'; stage: CreateDepartmentStageKey; message: string };

// ---------------------------------------------------------------------------
// Edit-department input (shared by the Edit dialog and the PATCH route)
// ---------------------------------------------------------------------------

export interface EditSubDepartment {
  /** Existing sub-department key — IMMUTABLE (a rename is label-only, so the
   *  `<parent>:<sub>` rate row and every member's placement stay attached) —
   *  or null for a NEW sub-department, whose key derives from `name`. */
  key: string | null;
  name: string;
  /** Initial base rate for a NEW sub-department only. Must be null on an
   *  existing one: live rates are edited in Pay Structure (one write path). */
  payStructure: CreateDepartmentPayStructureInput | null;
}

export interface EditDepartmentInput {
  /** The registry key being edited. Never changes. */
  key: string;
  /** `app_settings.updated_at` of the registry the editor loaded (GET's
   *  `revision`). The server refuses a save against a newer revision (409)
   *  instead of clobbering a teammate's edit. */
  expectedRevision: string | null;
  name: string;
  subDepartments: EditSubDepartment[];
  members: NewDepartmentMember[];
}

/** The key an edit row ends up with: the pinned existing key, or the slug of a
 *  new sub-department's name. */
export function editSubKey(sub: EditSubDepartment): string {
  return sub.key ?? slugifyDeptKey(sub.name);
}

/** Mirrored client-side (Save gating) and server-side (the PATCH route re-runs
 *  it before writing anything). `registry` is the whole registry, so a rename
 *  cannot take another in-app department's current or former name. */
export function validateEditDepartmentInput(
  input: EditDepartmentInput,
  existing: DepartmentRegistryEntry,
  registry: readonly DepartmentRegistryEntry[],
): { ok: boolean; error?: string } {
  if (input.key !== existing.key) {
    return { ok: false, error: 'This edit targets a different department than the one loaded.' };
  }
  const name = input.name?.trim() ?? '';
  if (!name) return { ok: false, error: 'Enter a department name.' };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Department name must be ${MAX_NAME_LEN} characters or fewer.` };
  }
  if (!slugifyDeptKey(name)) {
    return { ok: false, error: 'Department name needs at least one letter or number.' };
  }
  if (name.toLowerCase() !== existing.name.trim().toLowerCase()) {
    if (normalizeDeptToKey(name) || BUILTIN_KEYS.has(slugifyDeptKey(name))) {
      return { ok: false, error: `"${name}" already exists as a built-in department.` };
    }
    for (const other of registry) {
      if (other.key === existing.key) continue;
      if (labelRefersToEntry(name, other)) {
        return { ok: false, error: `"${name}" is already used by ${other.name}.` };
      }
    }
  }

  if (input.subDepartments.length > MAX_SUB_DEPARTMENTS) {
    return { ok: false, error: `Keep it to ${MAX_SUB_DEPARTMENTS} sub-departments or fewer.` };
  }
  const existingSubKeys = new Set(existing.subDepartments.map((s) => s.key));
  const resultKeys = new Set<string>();
  for (const sub of input.subDepartments) {
    const subName = sub?.name?.trim() ?? '';
    if (!subName) return { ok: false, error: 'Sub-department names cannot be empty.' };
    if (subName.length > MAX_NAME_LEN) {
      return { ok: false, error: `Sub-department "${subName}" is too long (max ${MAX_NAME_LEN}).` };
    }
    if (sub.key != null) {
      if (!existingSubKeys.has(sub.key)) {
        return { ok: false, error: `Sub-department "${subName}" refers to a team this department doesn't have.` };
      }
      if (sub.payStructure) {
        return { ok: false, error: `${subName}: an existing sub-department's rate is managed in Pay Structure.` };
      }
    } else {
      if (!slugifyDeptKey(subName)) {
        return { ok: false, error: `Sub-department "${subName}" needs at least one letter or number.` };
      }
      if (sub.payStructure) {
        const rateErr = payStructureError(sub.payStructure, subName);
        if (rateErr) return { ok: false, error: rateErr };
      }
    }
    const key = editSubKey(sub);
    if (resultKeys.has(key)) {
      return { ok: false, error: `Sub-department "${subName}" is listed twice.` };
    }
    resultKeys.add(key);
  }

  const membersError = memberListError(input.members, resultKeys, 'roster');
  if (membersError) return { ok: false, error: membersError };

  return { ok: true };
}

/** What an edit changes, in the terms the Review step, the audit row and the
 *  route's grant/rate stages all use. Emails lower-cased. */
export interface DepartmentEditDiff {
  renamed: { from: string; to: string } | null;
  subsAdded: { key: string; name: string; rated: boolean }[];
  subsRenamed: { key: string; from: string; to: string }[];
  subsRemoved: { key: string; name: string }[];
  membersAdded: string[];
  membersRemoved: string[];
  /** Emails that end up Manager without having been one (added as manager, or promoted). */
  managersGranted: string[];
  /** Emails that stop being Manager (removed while manager, or demoted). */
  managersRevoked: string[];
  /** Kept members whose sub-department pick changed. */
  subReassigned: number;
  changed: boolean;
}

export function diffDepartmentEdit(
  existing: DepartmentRegistryEntry,
  input: EditDepartmentInput,
): DepartmentEditDiff {
  const nextName = input.name.trim();
  const renamed = nextName !== existing.name.trim() ? { from: existing.name.trim(), to: nextName } : null;

  const existingSubs = new Map(existing.subDepartments.map((s) => [s.key, s] as const));
  const nextSubKeys = new Set<string>();
  const subsAdded: DepartmentEditDiff['subsAdded'] = [];
  const subsRenamed: DepartmentEditDiff['subsRenamed'] = [];
  for (const sub of input.subDepartments) {
    const key = editSubKey(sub);
    const name = sub.name.trim();
    nextSubKeys.add(key);
    if (sub.key == null) {
      subsAdded.push({ key, name, rated: sub.payStructure != null });
    } else {
      const prev = existingSubs.get(sub.key);
      if (prev && prev.name.trim() !== name) subsRenamed.push({ key, from: prev.name.trim(), to: name });
    }
  }
  // A sub that is removed and re-added as NEW under the same slug counts as
  // removed AND added — its old rate row goes, the new one (if any) is written.
  const subsRemoved = existing.subDepartments
    .filter((s) => !nextSubKeys.has(s.key) || subsAdded.some((a) => a.key === s.key))
    .map((s) => ({ key: s.key, name: s.name.trim() }));

  const before = new Map(existing.members.map((m) => [m.workEmail.trim().toLowerCase(), m] as const));
  const after = new Map(input.members.map((m) => [m.workEmail.trim().toLowerCase(), m] as const));
  const membersAdded: string[] = [];
  const managersGranted: string[] = [];
  const managersRevoked: string[] = [];
  let subReassigned = 0;
  let detailsChanged = false;
  for (const [email, m] of after) {
    const prev = before.get(email);
    if (!prev) {
      membersAdded.push(email);
      if (m.isManager) managersGranted.push(email);
      continue;
    }
    if (m.isManager && !prev.isManager) managersGranted.push(email);
    if (!m.isManager && prev.isManager) managersRevoked.push(email);
    if ((m.subDepartment ?? null) !== (prev.subDepartment ?? null)) subReassigned += 1;
    if (
      prev.name !== m.name.trim() ||
      (prev.personalEmail ?? null) !== (m.personalEmail?.trim().toLowerCase() || null) ||
      (m.startDate != null && (prev.startDate ?? null) !== m.startDate)
    ) {
      detailsChanged = true;
    }
  }
  const membersRemoved: string[] = [];
  for (const [email, prev] of before) {
    if (after.has(email)) continue;
    membersRemoved.push(email);
    if (prev.isManager) managersRevoked.push(email);
  }

  const changed =
    renamed !== null ||
    subsAdded.length > 0 ||
    subsRenamed.length > 0 ||
    subsRemoved.length > 0 ||
    membersAdded.length > 0 ||
    membersRemoved.length > 0 ||
    managersGranted.length > 0 ||
    managersRevoked.length > 0 ||
    subReassigned > 0 ||
    detailsChanged;

  return {
    renamed,
    subsAdded,
    subsRenamed,
    subsRemoved,
    membersAdded,
    membersRemoved,
    managersGranted,
    managersRevoked,
    subReassigned,
    changed,
  };
}

/**
 * The registry entry after an edit — PURE, so the route writes exactly what the
 * Review step showed. Key, createdBy and createdAt never move; a rename files
 * the old name under `previousNames`; kept members keep their original
 * `addedBy`/`addedAt`, new ones are attributed to `actor` at `nowIso`.
 */
export function applyDepartmentEdit(
  existing: DepartmentRegistryEntry,
  input: EditDepartmentInput,
  actor: string,
  nowIso: string,
): DepartmentRegistryEntry {
  const name = input.name.trim();
  const renamed = name.toLowerCase() !== existing.name.trim().toLowerCase();
  const previousNames = (
    renamed
      ? deptEntryLabels({ name: existing.name, previousNames: existing.previousNames })
      : (existing.previousNames ?? [])
  ).filter((l) => l.trim() && l.trim().toLowerCase() !== name.toLowerCase());
  const byEmail = new Map(existing.members.map((m) => [m.workEmail.trim().toLowerCase(), m] as const));
  const members: DepartmentMemberRecord[] = input.members.map((m) => {
    const email = m.workEmail.trim().toLowerCase();
    const prev = byEmail.get(email);
    return {
      name: m.name.trim(),
      workEmail: email,
      personalEmail: m.personalEmail?.trim().toLowerCase() || null,
      isManager: m.isManager,
      subDepartment: m.subDepartment ?? null,
      startDate: m.startDate ?? prev?.startDate ?? null,
      addedBy: prev?.addedBy ?? actor,
      addedAt: prev?.addedAt ?? nowIso,
    };
  });
  return {
    key: existing.key,
    name,
    subDepartments: input.subDepartments.map((sub) => ({ key: editSubKey(sub), name: sub.name.trim() })),
    members,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    ...(previousNames.length > 0 ? { previousNames } : {}),
    updatedBy: actor,
    updatedAt: nowIso,
  };
}

/** Edit stage order + labels — the Edit dialog's overlay and the PATCH route
 *  share this list so they cannot drift. Members are written with the entry in
 *  the first stage (one CAS write), so there is no separate members stage. */
export const EDIT_DEPARTMENT_STAGES: { key: CreateDepartmentStageKey; label: string }[] = [
  { key: 'department', label: 'Saving changes' },
  { key: 'managers', label: 'Updating manager access' },
  { key: 'rates', label: 'Updating base rates' },
];

export interface EditDepartmentSummary {
  key: string;
  name: string;
  diff: DepartmentEditDiff;
  /** New sub-department base rates written. */
  ratesSet: number;
  /** Removed sub-departments whose own base-rate row was deleted. */
  ratesDeleted: number;
  /** Non-fatal issues worth surfacing. The save still succeeded. */
  warnings: string[];
}

export type EditDepartmentEvent =
  | { type: 'stage'; stage: CreateDepartmentStageKey; status: 'start' | 'done'; note?: string }
  | { type: 'done'; summary: EditDepartmentSummary }
  | { type: 'error'; stage: CreateDepartmentStageKey; message: string };

// ---------------------------------------------------------------------------
// Built-in (master-list) departments -- manager access is the ONE thing the
// app owns about them. Name and alias map are code (DEPARTMENTS); people come
// from the Sheet sync and move only via transfers. So "Edit" on a master-list
// card edits managers.
// (Kane, 2026-09-03: managers-only; the Payment Catalog may be a second write
// path for department_managers beside Admin -> Roles & permissions.
//  Kane, 2026-09-21: HSL is included too -- per SUB-TEAM, see BuiltinManagerScope.)
// ---------------------------------------------------------------------------

/** The one built-in whose grants are per-sub-team access keys. */
export const HSL_BUILTIN_KEY = 'hogan_smith_law';

/**
 * A writable manager-grant SCOPE on a master-list department.
 *
 * Manager access is a raw `department_managers.department` STRING, and "which
 * strings belong to this department" is really two different questions:
 *
 *  - A FLAT built-in: every raw variant Admin Roles ever offered ("Lead Gen",
 *    "Lead Generation", ...) normalizes to the one key and means the same
 *    access. ONE scope; new grants written under `DEPARTMENTS[].name`.
 *  - HSL: the raw string IS the sub-team access key (`hsl:<sub>`), and
 *    `normalizeDeptToKey` collapses every one of them to `hogan_smith_law`.
 *    Editing them as a single list is exactly how "remove a manager" would
 *    revoke KPI access to a sub-team nobody touched -- which is why HSL had no
 *    Edit at all before 2026-09-21. ONE SCOPE PER SUB-TEAM instead.
 *
 * A scope owns only the raw labels it claims. Anything else that normalizes to
 * the department -- a bare "HSL" grant, a retired `hsl:lead_nurture` -- is
 * UNSCOPED: surfaced read-only, never granted and never revoked here. See
 * `partitionBuiltinGrants`.
 */
export interface BuiltinManagerScope {
  /** Exact string written to `department_managers.department` for a new grant. */
  grantLabel: string;
  /** How the scope reads to a human ("HSL - Intake Specialist"). */
  displayName: string;
}

/**
 * The scopes a master-list department's Edit dialog may write. Empty for a key
 * that is not built-in, so no caller can invent one.
 */
export function builtinManagerScopes(key: string): BuiltinManagerScope[] {
  const dept = DEPARTMENTS.find((d) => d.key === key);
  if (!dept) return [];
  if (key !== HSL_BUILTIN_KEY) return [{ grantLabel: dept.name, displayName: dept.name }];
  // Both keyspaces: a placement-only sub-team is every bit as real a team to
  // manage as a KPI-scoring one.
  return hslSubDeptOptions().map((o) => ({ grantLabel: o.value, displayName: o.label }));
}

/**
 * Every built-in department's manager access is editable from the Department
 * tab. Kept as a named predicate because the tab and the route both ask.
 *
 * HSL was excluded until 2026-09-21; it is now editable through per-sub-team
 * scopes, which is what made the exclusion unnecessary rather than merely
 * inconvenient.
 */
export function isBuiltinManagersEditable(key: string): boolean {
  return BUILTIN_KEYS.has(key);
}

/** One live `department_managers` row, as stored. */
export interface BuiltinGrantRow {
  /** Raw `department_managers.department`, exactly as written. */
  department: string;
  managerEmail: string;
}

export interface BuiltinGrantPartition {
  /** Lower-cased grantLabel -> the manager emails currently holding that scope. */
  byScope: Map<string, string[]>;
  /**
   * Raw labels that belong to this department but that NO scope claims, with
   * their holders. The dialog shows them read-only; this editor never writes
   * or revokes them, so an unrecognized spelling can never be silently dropped.
   */
  unscoped: Array<{ label: string; managerEmail: string }>;
}

/**
 * Split a department's live grants across its scopes.
 *
 * FLAT built-in: a row is claimed when it NORMALIZES to the key, so every alias
 * spelling lands in the one list and a revoke still clears them all (unchanged
 * since 2026-09-03). HSL: a row is claimed only on an EXACT `hsl:<sub>` match --
 * normalizing would merge sixteen teams into one list and turn every revoke
 * into a family-wide revoke.
 */
export function partitionBuiltinGrants(
  key: string,
  rows: readonly BuiltinGrantRow[],
): BuiltinGrantPartition {
  const scopes = builtinManagerScopes(key);
  const byScope = new Map<string, string[]>(scopes.map((s) => [s.grantLabel.toLowerCase(), []]));
  const unscoped: Array<{ label: string; managerEmail: string }> = [];
  const perSubTeam = key === HSL_BUILTIN_KEY;
  const flatSlot = perSubTeam ? null : (scopes[0]?.grantLabel.toLowerCase() ?? null);

  for (const row of rows) {
    const label = (row.department ?? '').trim();
    const email = (row.managerEmail ?? '').trim().toLowerCase();
    if (!label || !email) continue;
    // Not this department at all.
    if (normalizeDeptToKey(label) !== key) continue;
    const slotKey = perSubTeam ? label.toLowerCase() : flatSlot;
    const slot = slotKey ? byScope.get(slotKey) : undefined;
    if (slot) {
      if (!slot.includes(email)) slot.push(email);
    } else {
      unscoped.push({ label, managerEmail: email });
    }
  }
  return { byScope, unscoped };
}

export interface BuiltinManagerInput {
  name: string;
  workEmail: string;
}

/** The FULL resulting manager set for ONE scope; the server diffs it. */
export interface BuiltinManagerScopeInput {
  grantLabel: string;
  managers: BuiltinManagerInput[];
}

export interface BuiltinManagersInput {
  /** A built-in DEPARTMENTS key (never a registry key). */
  builtinKey: string;
  /**
   * EXACTLY the scopes `builtinManagerScopes(builtinKey)` returns -- same set,
   * no extras, no omissions, no duplicates. A flat built-in sends one; HSL
   * sends one per sub-team.
   */
  scopes: BuiltinManagerScopeInput[];
  /**
   * People moving into / out of / within this department, applied as REAL
   * department transfers (see `BuiltinPersonMove`). Absent or empty means the
   * save touches manager access only.
   */
  people?: BuiltinPersonMove[];
}

const MAX_BUILTIN_MANAGERS = 50;

/** Mirrored client-side (Save gating) and server-side (PATCH). */
export function validateBuiltinManagersInput(input: BuiltinManagersInput): { ok: boolean; error?: string } {
  const key = input.builtinKey?.trim() ?? '';
  if (!BUILTIN_KEYS.has(key)) return { ok: false, error: 'That is not a built-in department.' };

  const expected = builtinManagerScopes(key);
  if (!Array.isArray(input.scopes) || input.scopes.length !== expected.length) {
    return { ok: false, error: 'That edit does not match the department’s manager scopes.' };
  }
  // The client may not invent, drop or duplicate a grant label: the set it sends
  // must be the set this department actually has.
  const want = new Map(expected.map((s) => [s.grantLabel.toLowerCase(), s.displayName] as const));
  const seenScopes = new Set<string>();
  for (const s of input.scopes) {
    const label = (s.grantLabel ?? '').trim().toLowerCase();
    if (!want.has(label)) {
      return { ok: false, error: `“${s.grantLabel}” is not a manager scope of this department.` };
    }
    if (seenScopes.has(label)) return { ok: false, error: `“${s.grantLabel}” is listed twice.` };
    seenScopes.add(label);
  }

  let total = 0;
  for (const s of input.scopes) {
    const where = want.get((s.grantLabel ?? '').trim().toLowerCase()) ?? s.grantLabel;
    if (!Array.isArray(s.managers)) return { ok: false, error: `${where} needs a manager list.` };
    if (s.managers.length > MAX_BUILTIN_MANAGERS) {
      return { ok: false, error: `Keep ${where} to ${MAX_BUILTIN_MANAGERS} managers or fewer.` };
    }
    const seen = new Set<string>();
    for (const m of s.managers) {
      const who = m.name?.trim() || m.workEmail?.trim() || 'a manager';
      if (!m.name?.trim()) return { ok: false, error: 'Every manager needs a name.' };
      const email = m.workEmail?.trim().toLowerCase() ?? '';
      if (!email || !isEmailish(email)) return { ok: false, error: `${who} needs a valid work email.` };
      if (seen.has(email)) return { ok: false, error: `${email} is listed twice under ${where}.` };
      seen.add(email);
    }
    total += s.managers.length;
  }
  // The documented invariant, at the granularity it was written: the DEPARTMENT
  // keeps a manager. Per-sub-team emptiness stays legal -- plenty of HSL teams
  // have no manager today and refusing the save would strand every other edit --
  // but `diffBuiltinManagerScopes` names each team going to zero so the Review
  // step can warn.
  if (total === 0) return { ok: false, error: 'Keep at least one Manager on the department.' };
  return { ok: true };
}

/** Which grants to add and revoke to turn `current` into `next` (emails
 *  lower-cased; order preserved from `next` / `current`). */
export function diffBuiltinManagers(
  current: Iterable<string>,
  next: Iterable<string>,
): { granted: string[]; revoked: string[]; changed: boolean } {
  const norm = (e: string) => e.trim().toLowerCase();
  const cur = new Set(Array.from(current, norm).filter(Boolean));
  const nxt = new Set(Array.from(next, norm).filter(Boolean));
  const granted = [...nxt].filter((e) => !cur.has(e));
  const revoked = [...cur].filter((e) => !nxt.has(e));
  return { granted, revoked, changed: granted.length > 0 || revoked.length > 0 };
}

/** What one scope gains and loses. */
export interface BuiltinManagersScopeDiff {
  grantLabel: string;
  displayName: string;
  granted: string[];
  revoked: string[];
  /** Managers left on this scope after the edit. */
  resulting: string[];
}

export interface BuiltinManagersDiff {
  scopes: BuiltinManagersScopeDiff[];
  changed: boolean;
  /** Distinct emails gaining access to at least one scope. */
  granted: string[];
  /** Distinct emails losing at least one scope. */
  revoked: string[];
  /**
   * Display names of scopes that HELD a manager and will end with none. Never a
   * block -- a sub-team with no manager is a legal (and today common) state --
   * but the Review step names them, because an HSL sub-team with no manager has
   * no KPI card and its sheet goes unscored.
   */
  emptied: string[];
}

/**
 * Diff a scoped edit against the live grants, scope by scope.
 *
 * Per-scope is the whole point: a revoke computed across the collapsed family
 * would take a manager off sixteen sub-teams when the accountant edited one.
 */
export function diffBuiltinManagerScopes(
  key: string,
  partition: BuiltinGrantPartition,
  input: BuiltinManagersInput,
): BuiltinManagersDiff {
  const scopes = builtinManagerScopes(key);
  const sent = new Map(
    (input.scopes ?? []).map((s) => [(s.grantLabel ?? '').trim().toLowerCase(), s.managers ?? []] as const),
  );
  const out: BuiltinManagersScopeDiff[] = [];
  const granted = new Set<string>();
  const revoked = new Set<string>();
  const emptied: string[] = [];

  for (const scope of scopes) {
    const lower = scope.grantLabel.toLowerCase();
    const current = partition.byScope.get(lower) ?? [];
    const next = (sent.get(lower) ?? [])
      .map((m) => (m.workEmail ?? '').trim().toLowerCase())
      .filter(Boolean);
    const d = diffBuiltinManagers(current, next);
    for (const e of d.granted) granted.add(e);
    for (const e of d.revoked) revoked.add(e);
    if (next.length === 0 && current.length > 0) emptied.push(scope.displayName);
    out.push({
      grantLabel: scope.grantLabel,
      displayName: scope.displayName,
      granted: d.granted,
      revoked: d.revoked,
      resulting: next,
    });
  }

  return {
    scopes: out,
    changed: out.some((s) => s.granted.length > 0 || s.revoked.length > 0),
    granted: [...granted],
    revoked: [...revoked],
    emptied,
  };
}

// ---------------------------------------------------------------------------
// Built-in department PEOPLE (2026-09-21).
//
// Kane ruled the master-list card's People step must WRITE. It does so as a
// REAL department transfer -- `applyDepartmentTransfer` + the master Sheet
// write-back, recorded as a `department_transfer_requests` row -- and never as
// a registry member record.
//
// Registry members are not a people source for pay (§5): a person "added" that
// way shows on the card, is paid nothing, and is invisible to the missing-bank
// readiness check. A built-in department's people ARE the roster, so moving one
// is a transfer and nothing else. [[hris-is-dept-source-of-truth]]: the applied
// transfer row is the strongest evidence the DB's department is deliberate, so
// the row is written, not bypassed.
// ---------------------------------------------------------------------------

/** One person moving into, out of, or within a built-in department. */
export interface BuiltinPersonMove {
  name: string;
  workEmail: string;
  personalEmail?: string | null;
  /** The person's CURRENT raw master-list Department cell. */
  fromDepartment: string;
  /** The raw label to write into the master cell. Must be PLACEABLE. */
  toDepartment: string;
}

export interface BuiltinPeopleInput {
  builtinKey: string;
  moves: BuiltinPersonMove[];
}

/**
 * How a move relates to the department being edited.
 *
 *  - `in`       arriving from somewhere else
 *  - `out`      leaving for somewhere else
 *  - `within`   a reshuffle inside the family (an HSL sub-team change) --
 *               legal, and the main reason HSL needs this at all
 *  - `unrelated` touches the department on neither side; always refused, because
 *               this dialog must not become a general-purpose transfer tool
 */
export type BuiltinMoveKind = 'in' | 'out' | 'within' | 'unrelated';

export function classifyBuiltinPersonMove(builtinKey: string, move: BuiltinPersonMove): BuiltinMoveKind {
  const from = normalizeDeptToKey(move.fromDepartment ?? '');
  const to = normalizeDeptToKey(move.toDepartment ?? '');
  const fromHere = from === builtinKey;
  const toHere = to === builtinKey;
  if (fromHere && toHere) return 'within';
  if (toHere) return 'in';
  if (fromHere) return 'out';
  return 'unrelated';
}

const MAX_PEOPLE_MOVES = 100;

/**
 * Mirrored client-side (Save gating) and server-side (PATCH).
 *
 * The load-bearing refusal is `isPlaceableDeptLabel`: a bare "HSL" target is NOT
 * a placement, because the sub-team is what carries the base rate, and accepting
 * one would put a person on a parent fallback that no longer exists (the
 * `hogan_smith_law` base row was deleted in the 2026-08-14 cutover). See
 * hsl-subdepartments.md and [[hsl-parent-department-cutover]].
 */
export function validateBuiltinPeopleInput(input: BuiltinPeopleInput): { ok: boolean; error?: string } {
  const key = input.builtinKey?.trim() ?? '';
  if (!BUILTIN_KEYS.has(key)) return { ok: false, error: 'That is not a built-in department.' };
  if (!Array.isArray(input.moves)) return { ok: false, error: 'Malformed people payload.' };
  if (input.moves.length > MAX_PEOPLE_MOVES) {
    return { ok: false, error: `Move at most ${MAX_PEOPLE_MOVES} people at a time.` };
  }

  const seen = new Set<string>();
  for (const m of input.moves) {
    const who = m.name?.trim() || m.workEmail?.trim() || 'someone';
    const email = m.workEmail?.trim().toLowerCase() ?? '';
    if (!email || !isEmailish(email)) return { ok: false, error: `${who} needs a valid work email.` };
    if (seen.has(email)) return { ok: false, error: `${email} is moved twice in one save.` };
    seen.add(email);

    const from = (m.fromDepartment ?? '').trim();
    const to = (m.toDepartment ?? '').trim();
    if (!from) return { ok: false, error: `${who} has no current department to move from.` };
    if (!to) return { ok: false, error: `${who} needs a destination department.` };
    if (from.toLowerCase() === to.toLowerCase()) {
      return { ok: false, error: `${who} is already in ${to}.` };
    }
    // A bare family label is not a placement. This is the guard that stops a
    // new HSL arrival landing on a parent base rate that was deleted.
    if (!isPlaceableDeptLabel(to)) {
      return {
        ok: false,
        error: `${to} is not a placement — pick the specific sub-team for ${who}.`,
      };
    }

    const kind = classifyBuiltinPersonMove(key, m);
    if (kind === 'unrelated') {
      return {
        ok: false,
        error: `${who}'s move touches neither side of this department — make it from the other department's card.`,
      };
    }
  }
  return { ok: true };
}

export interface BuiltinPeopleDiff {
  moves: Array<BuiltinPersonMove & { kind: BuiltinMoveKind }>;
  added: BuiltinPersonMove[];
  removed: BuiltinPersonMove[];
  reshuffled: BuiltinPersonMove[];
  changed: boolean;
}

export function diffBuiltinPeople(builtinKey: string, input: BuiltinPeopleInput): BuiltinPeopleDiff {
  const moves = (input.moves ?? []).map((m) => ({ ...m, kind: classifyBuiltinPersonMove(builtinKey, m) }));
  return {
    moves,
    added: moves.filter((m) => m.kind === 'in'),
    removed: moves.filter((m) => m.kind === 'out'),
    reshuffled: moves.filter((m) => m.kind === 'within'),
    changed: moves.length > 0,
  };
}

export const BUILTIN_MANAGERS_STAGES: { key: CreateDepartmentStageKey; label: string }[] = [
  { key: 'managers', label: 'Updating manager access' },
];

/** A master-list edit that also moves people runs BOTH stages. People move as
 *  real transfers, so the stage is deliberately separate and reported on its
 *  own -- a Sheet write-back failure must be visible, never folded into the
 *  manager result. */
export const BUILTIN_EDIT_STAGES: { key: CreateDepartmentStageKey; label: string }[] = [
  { key: 'managers', label: 'Updating manager access' },
  { key: 'members', label: 'Moving people' },
];

export interface BuiltinManagersSummary {
  key: string;
  name: string;
  granted: string[];
  revoked: string[];
  /** Per-scope, so an HSL save can say which sub-teams actually moved. */
  scopes: Array<{ displayName: string; granted: string[]; revoked: string[] }>;
  /** People-move outcome, when the save carried one. */
  people?: {
    moved: number;
    /** Moved on the master list but NOT mirrored to the Sheet -- the next sync
     *  can snap them back, so this is surfaced, never swallowed. */
    sheetUnsynced: Array<{ email: string; reason: string }>;
    /** Not on the active roster, so nothing moved. */
    notOnRoster: string[];
    failed: Array<{ email: string; reason: string }>;
  };
  warnings: string[];
}

export type BuiltinManagersEvent =
  | { type: 'stage'; stage: CreateDepartmentStageKey; status: 'start' | 'done'; note?: string }
  | { type: 'done'; summary: BuiltinManagersSummary }
  | { type: 'error'; stage: CreateDepartmentStageKey; message: string };
