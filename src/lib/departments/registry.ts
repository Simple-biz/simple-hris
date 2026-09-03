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
