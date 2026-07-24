// Custom department registry -- departments created in-app from the Payment
// Catalog's "Department" tab (as opposed to the built-in payroll departments
// hardcoded in src/lib/payroll/department-bonus.ts, which the Google-Sheet
// master list sync populates).
//
// A department "exists" the moment its label lands in the Global Master List's
// "Department" column on at least one active row -- every dropdown
// (/api/departments), the People tab, and manager assignment pick it up from
// there automatically. What the roster CANNOT hold is the department's
// STRUCTURE: its sub-departments (HSL-style: one master-list department, many
// internal teams) and which member belongs to which sub-department. That
// structure lives here.
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

export interface DepartmentRegistryEntry {
  /** Stable slug key -- doubles as the PayStructure.departmentKey for this
   *  department's Payment Catalog rates (e.g. "medical_billing"). */
  key: string;
  /** Exact "Department" string written to Global Master List rows. */
  name: string;
  /** HSL-style internal teams. Empty when the department has none. */
  subDepartments: DepartmentSubUnit[];
  /** work email (lowercased) -> sub-department key, as assigned at creation.
   *  Advisory structure only -- the master list stays the roster's source of
   *  truth; this records which internal team each seeded member joined. */
  memberSubDepartments: Record<string, string>;
  createdBy: string | null;
  /** ISO timestamp. */
  createdAt: string;
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

/** Resolves a raw master-list "Department" string to a department key, checking
 *  the built-in payroll map first, then the custom registry (name or slug
 *  match). Returns null for unknown strings -- same contract as
 *  normalizeDeptToKey. */
export function resolveDeptKeyWithRegistry(
  raw: string | null | undefined,
  registry: DepartmentRegistryEntry[],
): string | null {
  const builtin = normalizeDeptToKey(raw);
  if (builtin) return builtin;
  if (!raw) return null;
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  const slug = slugifyDeptKey(raw);
  for (const entry of registry) {
    if (entry.name.trim().toLowerCase() === needle || entry.key === slug) return entry.key;
  }
  return null;
}

/** True when a roster row's raw "Department" string belongs to `entry`. */
export function rawDeptMatchesEntry(raw: string | null | undefined, entry: DepartmentRegistryEntry): boolean {
  if (!raw) return false;
  const needle = raw.trim().toLowerCase();
  return needle === entry.name.trim().toLowerCase() || slugifyDeptKey(raw) === entry.key;
}

// ---------------------------------------------------------------------------
// Create-department input (shared by the wizard and the API route)
// ---------------------------------------------------------------------------

export interface NewDepartmentMember {
  /** 'existing' -- picked from the active roster (a transfer into the new
   *  department); 'new' -- typed by hand (a fresh master-list row). */
  kind: 'existing' | 'new';
  name: string;
  workEmail: string;
  personalEmail?: string | null;
  /** The roster department an existing member transfers OUT of. */
  currentDepartment?: string | null;
  /** Managers are required (at least one) and also get a department_managers
   *  oversight row so the department shows on their Manager dashboard. */
  isManager: boolean;
  /** Sub-department key (one of input.subDepartments) or null. */
  subDepartment?: string | null;
  /** YYYY-MM-DD "Start Date" for kind 'new' rows (defaults to today, Manila). */
  startDate?: string | null;
}

export interface CreateDepartmentPayStructureInput {
  regularRate: number;
  otRate?: number;
  currency: PayCurrency;
}

export interface CreateDepartmentInput {
  name: string;
  /** Display names; keys are derived server-side via slugifyDeptKey. */
  subDepartments: string[];
  members: NewDepartmentMember[];
  /** Department-wide starting rate, or null to skip (settable later from the
   *  Pay Structure tab either way). */
  payStructure: CreateDepartmentPayStructureInput | null;
}

const MAX_NAME_LEN = 60;
const MAX_SUB_DEPARTMENTS = 24;
const MAX_MEMBERS = 200;

function isEmailish(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
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
    const subName = sub?.trim() ?? '';
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
  }

  if (input.members.length === 0) {
    return { ok: false, error: 'Add at least one person (a manager) to the department.' };
  }
  if (input.members.length > MAX_MEMBERS) {
    return { ok: false, error: `Keep the initial roster to ${MAX_MEMBERS} people or fewer.` };
  }
  const seenEmails = new Set<string>();
  let managers = 0;
  for (const m of input.members) {
    const who = m.name?.trim() || m.workEmail?.trim() || 'a member';
    if (!m.name?.trim()) return { ok: false, error: 'Every person needs a name.' };
    const email = m.workEmail?.trim().toLowerCase() ?? '';
    if (!email || !isEmailish(email)) {
      return { ok: false, error: `${who} needs a valid work email.` };
    }
    if (seenEmails.has(email)) {
      return { ok: false, error: `${email} is listed twice.` };
    }
    seenEmails.add(email);
    if (m.personalEmail && !isEmailish(m.personalEmail)) {
      return { ok: false, error: `${who}'s personal email doesn't look like an email.` };
    }
    if (m.subDepartment && !subKeys.has(m.subDepartment)) {
      return { ok: false, error: `${who} is assigned to a sub-department that isn't defined.` };
    }
    if (m.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(m.startDate)) {
      return { ok: false, error: `${who}'s start date must be YYYY-MM-DD.` };
    }
    if (m.isManager) managers += 1;
  }
  if (managers === 0) {
    return { ok: false, error: 'Mark at least one person as the department Manager.' };
  }

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
  /** Non-fatal issues worth surfacing (e.g. a Google Sheet write that needs a
   *  manual touch-up). Creation still succeeded. */
  warnings: string[];
}

export type CreateDepartmentEvent =
  | { type: 'stage'; stage: CreateDepartmentStageKey; status: 'start' | 'done'; note?: string }
  | { type: 'done'; summary: CreateDepartmentSummary }
  | { type: 'error'; stage: CreateDepartmentStageKey; message: string };
