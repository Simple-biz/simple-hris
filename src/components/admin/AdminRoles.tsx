'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  AtSign,
  Briefcase,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  Loader2,
  LogOut,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
import EmployeeAvatar from '@/components/employee/EmployeeAvatar';
import { FEATURE_CATALOG, ROLE_TO_FEATURE_VIEW, type FeatureAccess, type FeatureViewKey } from '@/lib/rbac/feature-permissions';
import { HSL_DEPTS, HSL_DEPT_KEYS, hslAccessKey, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import { normalizeCurrency, CONTRACTOR_CURRENCIES, type ContractorCurrency } from '@/lib/contractor-currency';

// Roles are strictly DASHBOARD ACCESS now: one role unlocks one dashboard.
// The legacy viewer / payroll_coordinator / payroll_manager roles were retired
// 2026-06-18 and `finance` was renamed to `accounting`. Every role here is also
// assignable (see ASSIGNABLE_ROLE_KEYS).
const ROLES = [
  { key: 'hr_coordinator', label: 'HR', blurb: 'Unlocks the HR dashboard.' },
  { key: 'accounting', label: 'Accounting', blurb: 'Unlocks the Accounting dashboard.' },
  { key: 'manager', label: 'Manager', blurb: 'Unlocks the Manager dashboard.' },
  { key: 'qc', label: 'QC', blurb: 'Quality Control — first-pass KPI scoring for Leadgen/Callback/Discovery, sent to the manager for review.' },
  { key: 'orphanage_manager', label: 'Orphanage', blurb: 'Unlocks the Orphanage dashboard.' },
  { key: 'contractor', label: 'Contractor', blurb: 'Unlocks the Contractor dashboard (invoice management).' },
  { key: 'ceo', label: 'CEO', blurb: 'Unlocks the CEO dashboard, post company-wide announcements.' },
  { key: 'admin', label: 'Admin', blurb: 'Full system access — unlocks every dashboard.' },
] as const;

type RoleKey = (typeof ROLES)[number]['key'];

const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r])) as Record<RoleKey, (typeof ROLES)[number]>;

// Only these roles get an assign button. Each one unlocks a view in the
// top-right switcher (see `src/lib/rbac/views.ts → viewsForRoles`).
const ASSIGNABLE_ROLE_KEYS = [
  'admin',
  'ceo',
  'hr_coordinator',
  'accounting',
  'orphanage_manager',
  'contractor',
  'manager',
  'qc',
] as const satisfies readonly RoleKey[];

const ROLE_GROUPS: { title: string; caption: string; keys: RoleKey[] }[] = [
  {
    title: 'Roles',
    caption: 'Each role unlocks the matching view in the top-right switcher.',
    // Every assignable role EXCEPT qc (rendered on its own below, under Manager).
    // `manager` sits last here so the QC "Manager's assistant" group reads as
    // sitting directly beneath it.
    keys: ASSIGNABLE_ROLE_KEYS.filter((k) => k !== 'qc'),
  },
  {
    title: "Manager's assistant",
    caption:
      'QC officers do first-pass KPI scoring of Leadgen, Callback & Discovery for the department manager to review. QC has its own dashboard — assign it on its own (don’t also grant Manager).',
    keys: ['qc'],
  },
];

function rolePillClasses(role: RoleKey): string {
  const map: Record<RoleKey, string> = {
    hr_coordinator:
      'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300/95 dark:border-emerald-600/40',
    accounting:
      'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:text-sky-200/95 dark:border-sky-600/40',
    manager:
      'border-indigo-500/35 bg-indigo-500/10 text-indigo-800 dark:text-indigo-300/95 dark:border-indigo-600/40',
    qc:
      'border-orange-500/35 bg-orange-500/10 text-orange-800 dark:text-orange-300/95 dark:border-orange-600/40',
    orphanage_manager:
      'border-pink-500/35 bg-pink-500/10 text-pink-800 dark:text-pink-300/95 dark:border-pink-600/40',
    contractor:
      'border-blue-500/35 bg-blue-500/10 text-blue-800 dark:text-blue-300/95 dark:border-blue-600/40',
    ceo:
      'border-yellow-500/40 bg-yellow-500/10 text-yellow-900 dark:text-yellow-200/95 dark:border-yellow-600/45',
    admin:
      'border-rose-500/40 bg-rose-500/10 text-rose-900 dark:text-rose-200/95 dark:border-rose-600/45',
  };
  // Legacy/unknown role keys (e.g. retired roles still sitting in the DB until
  // the migration runs) fall back to neutral styling instead of crashing.
  return (map as Record<string, string>)[role] ??
    'border-zinc-200/90 bg-zinc-100/90 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200';
}

function roleRowAccent(role: RoleKey): string {
  const map: Record<RoleKey, string> = {
    hr_coordinator: 'border-l-emerald-500',
    accounting: 'border-l-sky-500',
    manager: 'border-l-indigo-500',
    qc: 'border-l-orange-500',
    orphanage_manager: 'border-l-pink-500',
    contractor: 'border-l-blue-500',
    ceo: 'border-l-yellow-500',
    admin: 'border-l-rose-500',
  };
  return (map as Record<string, string>)[role] ?? 'border-l-zinc-400 dark:border-l-zinc-500';
}

function employeeIdentityEmail(e: EmployeeRow | null): string {
  if (!e) return '';
  return (e.work_email?.trim() || e.personal_email?.trim() || '').trim();
}

function initialsFromEmployee(e: EmployeeRow): string {
  const base = (e.name?.trim() || e.work_email || e.personal_email || '?').replace(/\s+/g, ' ');
  const parts = base.split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase().slice(0, 2);
  return base.slice(0, 2).toUpperCase();
}

function assignmentsForEmployee(e: EmployeeRow, all: RoleRow[]): RoleRow[] {
  const we = (e.work_email ?? '').toLowerCase();
  const pe = (e.personal_email ?? '').toLowerCase();
  return all.filter((a) => {
    const ae = a.work_email.toLowerCase();
    return ae === we || (pe !== '' && ae === pe);
  });
}

interface RoleRow {
  id: string;
  work_email: string;
  role: RoleKey;
  assigned_by: string | null;
  assigned_at: string;
}

interface DepartmentManagerRow {
  id: string;
  manager_email: string;
  department: string;
  assigned_by: string | null;
  assigned_at: string;
  revoked_at: string | null;
}

const PAGE_SIZE = 10;

export default function AdminRoles() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EmployeeRow | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [allAssignments, setAllAssignments] = useState<RoleRow[]>([]);
  // Per-feature access for the currently selected user. Keyed view -> feature.
  // Default `{}` is read as "every feature hidden" by the gating helpers.
  const [featurePerms, setFeaturePerms] = useState<Partial<Record<FeatureViewKey, Record<string, FeatureAccess>>>>({});
  const [featurePermsLoading, setFeaturePermsLoading] = useState(false);
  const [featurePermMutating, setFeaturePermMutating] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [mutating, setMutating] = useState<RoleKey | null>(null);
  // When granting a role would create a QC↔Manager conflict, hold the pending
  // role here to surface a warning modal (instead of a native confirm).
  const [guardRole, setGuardRole] = useState<RoleKey | null>(null);
  const [forcingLogout, setForcingLogout] = useState(false);
  // Invoicing currency for the selected contractor (PHP/USD). Only meaningful
  // when the `contractor` role is granted.
  const [contractorCurrency, setContractorCurrency] = useState<ContractorCurrency>('PHP');
  const [currencyMutating, setCurrencyMutating] = useState(false);
  const [page, setPage] = useState(1);
  const [viewFilter, setViewFilter] = useState<'all' | 'with_roles'>('all');
  // Department picker for the People list. 'all' = no department filter.
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [departments, setDepartments] = useState<string[]>([]);
  const [deptAssignments, setDeptAssignments] = useState<DepartmentManagerRow[]>([]);
  const [deptMutating, setDeptMutating] = useState<string | null>(null);
  // Set of lowercased emails that aren't in master list / rates / Hubstaff —
  // either added manually here or surfaced from existing role assignments
  // pointing at off-roster addresses (founders, bots, contractors, etc.).
  const [customEmails, setCustomEmails] = useState<Set<string>>(new Set());
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [empRes, rolesRes, deptRes, mgrDeptRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-roles', { cache: 'no-store' }),
          fetch('/api/departments', { cache: 'no-store' }),
          fetch('/api/department-managers', { cache: 'no-store' }),
        ]);
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        const rolesJson = (await rolesRes.json()) as { rows?: RoleRow[] };
        const deptJson = (await deptRes.json()) as { departments?: string[] };
        const mgrDeptJson = (await mgrDeptRes.json()) as { rows?: DepartmentManagerRow[] };
        setDepartments(deptJson.departments ?? []);
        setDeptAssignments(mgrDeptJson.rows ?? []);

        // Directory is the Master List only (`/api/employees` → active_employees
        // view). We deliberately do NOT merge the rates CSV or Hubstaff sources
        // here — those surface people who aren't on the master list and bloat
        // the picker. Off-roster service accounts / contractors are added
        // explicitly via "Add by email" (tracked in customEmails below).
        const merged = new Map<string, EmployeeRow>();
        const keyFor = (we: string | null | undefined, pe: string | null | undefined, nm?: string | null) =>
          (we ?? pe ?? nm ?? '').toString().trim().toLowerCase();

        for (const e of empJson.employees ?? []) {
          const k = keyFor(e.work_email, e.personal_email, e.name);
          if (!k) continue;
          merged.set(k, e);
        }

        // Surface every email that already has a role assignment but isn't on
        // the master list. Lets admins keep managing permissions for off-roster
        // addresses (service accounts, founders, contractors, etc.) without
        // ghosting them from the UI on reload.
        const customSet = new Set<string>();
        for (const a of rolesJson.rows ?? []) {
          const k = (a.work_email ?? '').toLowerCase();
          if (!k || merged.has(k)) continue;
          customSet.add(k);
          merged.set(k, {
            name: null,
            work_email: a.work_email,
            personal_email: null,
            department: null,
            start_date: null,
            employee_id: null,
          } as EmployeeRow);
        }

        setEmployees(Array.from(merged.values()));
        setAllAssignments(rolesJson.rows ?? []);
        setCustomEmails(customSet);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const identity = employeeIdentityEmail(selected);
  const selWork = selected?.work_email ?? null;
  const selPersonal = selected?.personal_email ?? null;

  useEffect(() => {
    const email = (selWork?.trim() || selPersonal?.trim() || '').trim();
    if (!email) {
      setRoles([]);
      setRolesLoading(false);
      setFeaturePerms({});
      setFeaturePermsLoading(false);
      return;
    }
    let cancelled = false;
    setRolesLoading(true);
    setFeaturePermsLoading(true);
    Promise.all([
      fetch(`/api/employee-roles?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { rows?: RoleRow[] }) => j.rows ?? [])
        .catch((e: unknown) => {
          if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load roles');
          return [] as RoleRow[];
        }),
      fetch(`/api/employee-feature-permissions?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { rows?: Array<{ view_key: string; feature: string; access: FeatureAccess }> }) => {
          const out: Partial<Record<FeatureViewKey, Record<string, FeatureAccess>>> = {};
          for (const row of j.rows ?? []) {
            const view = row.view_key as FeatureViewKey;
            if (!out[view]) out[view] = {};
            (out[view] as Record<string, FeatureAccess>)[row.feature] = row.access;
          }
          return out;
        })
        .catch(() => ({} as Partial<Record<FeatureViewKey, Record<string, FeatureAccess>>>)),
      fetch(`/api/contractor/profile?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { profile?: { currency?: string | null } | null }) => normalizeCurrency(j.profile?.currency))
        .catch(() => 'PHP' as ContractorCurrency),
    ]).then(([rs, perms, currency]) => {
      if (cancelled) return;
      setRoles(rs);
      setFeaturePerms(perms);
      setContractorCurrency(currency);
    }).finally(() => {
      if (!cancelled) {
        setRolesLoading(false);
        setFeaturePermsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selWork, selPersonal]);

  /** Write a single feature-permission and refresh local state. */
  async function setFeatureAccess(view: FeatureViewKey, feature: string, access: 'hidden' | FeatureAccess) {
    const email = (selWork?.trim() || selPersonal?.trim() || '').trim();
    if (!email) return;
    const key = `${view}:${feature}`;
    setFeaturePermMutating(key);
    try {
      const res = await fetch('/api/employee-feature-permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, view, feature, access }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        toast.error(j.error || 'Failed to update permission');
        return;
      }
      setFeaturePerms((prev) => {
        const next = { ...prev };
        const bucket = { ...(next[view] ?? {}) };
        if (access === 'hidden') delete bucket[feature];
        else bucket[feature] = access;
        next[view] = bucket;
        return next;
      });
      toast.success(
        access === 'hidden'
          ? `Hid ${feature}`
          : `${access === 'edit' ? 'Edit' : 'View'} access on ${feature}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setFeaturePermMutating(null);
    }
  }

  /** Bulk-set every feature in a view to one access level. Provisions (or
   *  clears) a whole dashboard in one click — essential under the
   *  hidden-until-granted model where each tab is off by default. */
  async function setAllFeatureAccess(view: FeatureViewKey, access: 'hidden' | FeatureAccess) {
    const email = (selWork?.trim() || selPersonal?.trim() || '').trim();
    if (!email) return;
    const features = FEATURE_CATALOG[view] ?? [];
    if (features.length === 0) return;
    setFeaturePermMutating(`${view}:__all__`);
    try {
      const results = await Promise.all(
        features.map((f) =>
          fetch('/api/employee-feature-permissions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, view, feature: f.key, access }),
          })
            .then((r) => r.ok)
            .catch(() => false),
        ),
      );
      const failed = results.filter((ok) => !ok).length;
      setFeaturePerms((prev) => {
        const next = { ...prev };
        if (access === 'hidden') {
          next[view] = {};
        } else {
          const bucket: Record<string, FeatureAccess> = {};
          for (const f of features) bucket[f.key] = access;
          next[view] = bucket;
        }
        return next;
      });
      if (failed > 0) {
        toast.warning(`Updated with ${failed} failure${failed === 1 ? '' : 's'}`);
      } else {
        toast.success(
          access === 'hidden'
            ? 'Hid every tab'
            : `Granted ${access === 'edit' ? 'Edit' : 'View'} on every tab`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setFeaturePermMutating(null);
    }
  }

  const uniqueEmployees = useMemo(() => {
    const seen = new Set<string>();
    const out: EmployeeRow[] = [];
    employees.forEach((e, i) => {
      const key = (e.work_email ?? e.personal_email ?? e.name ?? `__row_${i}`).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    });
    return out;
  }, [employees]);

  const emailsWithRolesSet = useMemo(
    () => new Set(allAssignments.map((a) => a.work_email.trim().toLowerCase())),
    [allAssignments],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withRolesOnly = viewFilter === 'with_roles';
    const dept = deptFilter.trim().toLowerCase();
    const base = uniqueEmployees.filter((e) => {
      if (withRolesOnly) {
        const we = (e.work_email ?? '').trim().toLowerCase();
        const pe = (e.personal_email ?? '').trim().toLowerCase();
        if (!emailsWithRolesSet.has(we) && !emailsWithRolesSet.has(pe)) return false;
      }
      if (dept !== 'all') {
        // Off-roster / custom emails have no department, so they drop out of
        // any specific-department filter (only "All departments" shows them).
        if ((e.department ?? '').trim().toLowerCase() !== dept) return false;
      }
      if (q) {
        const hay = [e.name, e.work_email, e.personal_email, e.department, e.employee_id, e.start_date]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return [...base].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [uniqueEmployees, search, viewFilter, deptFilter, emailsWithRolesSet]);

  useEffect(() => {
    setPage(1);
  }, [search, viewFilter, deptFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageSlice = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const stats = useMemo(() => {
    const people = uniqueEmployees.length;
    const emailsWithRoles = new Set(allAssignments.map((a) => a.work_email.toLowerCase()));
    const withRoles = emailsWithRoles.size;
    const grants = allAssignments.length;
    return { people, withRoles, grants };
  }, [uniqueEmployees.length, allAssignments]);

  const hasRole = (role: RoleKey) => roles.some((r) => r.role === role);

  const selectedDeptAssignments = useMemo(() => {
    const target = identity.toLowerCase();
    if (!target) return [] as DepartmentManagerRow[];
    return deptAssignments.filter((d) => d.manager_email.toLowerCase() === target);
  }, [deptAssignments, identity]);

  const selectedDeptSet = useMemo(
    () => new Set(selectedDeptAssignments.map((d) => d.department.trim().toLowerCase())),
    [selectedDeptAssignments],
  );

  // True when this user has the HSL parent department assigned. Strict — the
  // HSL sub-departments section keys off this single flag.
  const hasHslParent = useMemo(
    () =>
      [...selectedDeptSet].some((d) => {
        const norm = d.replace(/[\s_-]+/g, '');
        return (
          norm === 'hogansmithlaw' ||
          norm === 'hsl' ||
          // Tolerate sheet variations like "HSL Department" or "Hogan-Smith-Law".
          norm.startsWith('hogansmithlaw')
        );
      }),
    [selectedDeptSet],
  );

  const selectedHslSubDepts = useMemo(() => {
    const out = new Set<HslDeptKey>();
    selectedDeptAssignments.forEach((d) => {
      const k = d.department.trim().toLowerCase();
      if (!k.startsWith('hsl:')) return;
      const sub = k.slice(4) as HslDeptKey;
      if ((HSL_DEPT_KEYS as readonly string[]).includes(sub)) out.add(sub);
    });
    return out;
  }, [selectedDeptAssignments]);

  async function refreshDeptAssignments() {
    try {
      const res = await fetch('/api/department-managers', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: DepartmentManagerRow[] };
      setDeptAssignments(json.rows ?? []);
    } catch {
      /* ignore */
    }
  }

  async function toggleDepartment(department: string) {
    if (!identity) {
      toast.error('Add an email first.');
      return;
    }
    const isOn = selectedDeptSet.has(department.trim().toLowerCase());
    setDeptMutating(department);
    try {
      const res = await fetch(
        isOn
          ? `/api/department-managers?email=${encodeURIComponent(identity)}&department=${encodeURIComponent(department)}`
          : '/api/department-managers',
        {
          method: isOn ? 'DELETE' : 'POST',
          headers: isOn ? undefined : { 'content-type': 'application/json' },
          body: isOn
            ? undefined
            : JSON.stringify({ manager_email: identity, department }),
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Failed to update department');
        return;
      }
      toast.success(
        isOn ? `Removed from ${department}` : `Now manages ${department}`,
      );
      await refreshDeptAssignments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setDeptMutating(null);
    }
  }

  async function refreshAll() {
    const res = await fetch('/api/employee-roles', { cache: 'no-store' });
    const json = (await res.json()) as { rows?: RoleRow[] };
    setAllAssignments(json.rows ?? []);
  }

  /** Adds an off-roster email as a synthetic row + auto-selects it so the
   *  admin can immediately grant roles. If the email already exists in the
   *  directory we just select that real row instead. */
  function handleAddCustomEmail() {
    const raw = customInput.trim().toLowerCase();
    if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      toast.error('Enter a valid email address.');
      return;
    }
    const existing = employees.find(
      (e) =>
        (e.work_email ?? '').toLowerCase() === raw ||
        (e.personal_email ?? '').toLowerCase() === raw,
    );
    if (existing) {
      setSelected(existing);
      setSearch('');
      setPage(1);
      setCustomInput('');
      setCustomInputOpen(false);
      toast.info(`${raw} is already in the directory — selected.`);
      return;
    }
    const newRow: EmployeeRow = {
      name: null,
      work_email: raw,
      personal_email: null,
      department: null,
      start_date: null,
      employee_id: null,
    };
    setEmployees((prev) => [...prev, newRow]);
    setCustomEmails((prev) => {
      const next = new Set(prev);
      next.add(raw);
      return next;
    });
    setSelected(newRow);
    setSearch('');
    setPage(1);
    setCustomInput('');
    setCustomInputOpen(false);
    toast.success(`Added ${raw}. Grant roles on the right.`);
  }

  /** Force-logout the selected person so their next request re-mints a JWT that
   *  reflects the roles/permissions just changed. Revoking already fires this
   *  automatically; this button lets an admin also reset the session after a
   *  GRANT (or feature-permission change), where the user would otherwise keep
   *  using a stale token until they happened to sign out. */
  async function forceLogoutSelected() {
    const email = employeeIdentityEmail(selected);
    if (!email) {
      toast.error('This person has no email on file — add a work or personal email first.');
      return;
    }
    setForcingLogout(true);
    try {
      const res = await fetch('/api/auth/force-logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, reason: 'manual session reset' }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; skipped?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Failed to reset session');
        return;
      }
      if (json.skipped === 'self') {
        toast.info("That's your own account — your session was left intact.");
        return;
      }
      toast.success(`Logged out ${email}. They'll sign in again with the updated access.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setForcingLogout(false);
    }
  }

  async function toggleRole(role: RoleKey, opts?: { bypassGuard?: boolean }) {
    const email = employeeIdentityEmail(selected);
    if (!email) {
      toast.error('This person has no email on file — add a work or personal email first.');
      return;
    }
    const currentlyHas = hasRole(role);

    // QC is a manager's-assistant view that REPLACES the Manager dashboard in the
    // switcher. Holding both `qc` and `manager` would surface both views and the
    // QC guard rail (only the QC tab) would no longer hold. Surface a warning
    // modal before granting that combination — the admin can still override.
    if (
      !opts?.bypassGuard &&
      !currentlyHas &&
      ((role === 'qc' && hasRole('manager')) || (role === 'manager' && hasRole('qc')))
    ) {
      setGuardRole(role);
      return;
    }

    setMutating(role);
    try {
      const res = await fetch(
        currentlyHas
          ? `/api/employee-roles?email=${encodeURIComponent(email)}&role=${role}`
          : '/api/employee-roles',
        {
          method: currentlyHas ? 'DELETE' : 'POST',
          headers: currentlyHas ? undefined : { 'content-type': 'application/json' },
          body: currentlyHas ? undefined : JSON.stringify({ work_email: email, role }),
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Failed to update role');
        return;
      }
      toast.success(currentlyHas ? `Revoked ${ROLE_BY_KEY[role].label}` : `Granted ${ROLE_BY_KEY[role].label}`);

      // Revoking access should kick the user out of any active session so
      // they can't keep using a stale JWT that still carries the revoked role.
      // Fire-and-forget — the role mutation succeeded regardless.
      if (currentlyHas) {
        void fetch('/api/auth/force-logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, reason: `revoked ${role}` }),
        }).then(async (r) => {
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            toast.warning('Role revoked, but force-logout failed', {
              description: j.error || `Status ${r.status}`,
            });
          }
        });
      }

      const r = await fetch(`/api/employee-roles?email=${encodeURIComponent(email)}`, {
        cache: 'no-store',
      });
      setRoles(((await r.json()) as { rows?: RoleRow[] }).rows ?? []);
      await refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setMutating(null);
    }
  }

  async function setCurrency(currency: ContractorCurrency) {
    if (currency === contractorCurrency) return;
    const email = employeeIdentityEmail(selected);
    if (!email) {
      toast.error('This person has no email on file — add a work or personal email first.');
      return;
    }
    const prev = contractorCurrency;
    setContractorCurrency(currency); // optimistic
    setCurrencyMutating(true);
    try {
      const res = await fetch('/api/contractor/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractor_email: email, currency }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setContractorCurrency(prev);
        toast.error(json.error || 'Failed to update currency');
        return;
      }
      toast.success(`Invoices set to ${currency}`);
    } catch (e) {
      setContractorCurrency(prev);
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setCurrencyMutating(false);
    }
  }

  if (loading) {
    return <AdminRolesSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-b from-zinc-50/80 to-transparent p-4 sm:p-6 dark:from-zinc-950/50">
      <header className="shrink-0 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/15 ring-1 ring-orange-500/25">
                <UserCog className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden />
              </span>
              Roles & permissions
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Grant access by role. Updates apply immediately and are written to the audit log.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Users className="h-4 w-4 text-zinc-400" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Directory</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {stats.people}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Eye className="h-4 w-4 text-zinc-400" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">With roles</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {stats.withRoles}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <Briefcase className="h-4 w-4 text-zinc-400" aria-hidden />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Active grants</p>
                <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {stats.grants}
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 space-y-3 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">People</CardTitle>
                <Badge variant="outline" className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  {filtered.length} shown
                </Badge>
                {customEmails.size > 0 && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-orange-300/80 bg-orange-50 font-mono text-[10px] text-orange-800 dark:border-orange-700/60 dark:bg-orange-950/40 dark:text-orange-200"
                  >
                    <AtSign className="h-2.5 w-2.5" aria-hidden />
                    {customEmails.size} custom
                  </Badge>
                )}
                {/* View tabs — All vs people who already hold at least one role. */}
                <div
                  role="tablist"
                  aria-label="People view"
                  className="ml-1 inline-flex items-center rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {(['all', 'with_roles'] as const).map((mode) => {
                    const active = viewFilter === mode;
                    const label = mode === 'all' ? 'All' : 'With roles';
                    const count = mode === 'all' ? stats.people : stats.withRoles;
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setViewFilter(mode)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                          active
                            ? 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
                            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                        )}
                      >
                        {label}
                        <span
                          className={cn(
                            'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 py-px font-mono text-[9.5px] font-semibold tabular-nums',
                            active
                              ? 'bg-white/20 text-white dark:bg-zinc-900/20 dark:text-zinc-900'
                              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                          )}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant={customInputOpen ? 'secondary' : 'outline'}
                onClick={() => {
                  setCustomInputOpen((v) => !v);
                  setCustomInput('');
                }}
                className="h-8 gap-1.5"
                title="Grant roles to an email that isn't in the master list (e.g. service accounts, contractors)"
              >
                {customInputOpen ? (
                  <>
                    <X className="h-3.5 w-3.5" aria-hidden />
                    Cancel
                  </>
                ) : (
                  <>
                    <AtSign className="h-3.5 w-3.5" aria-hidden />
                    Add by email
                  </>
                )}
              </Button>
            </div>

            {customInputOpen && (
              <div className="flex flex-col gap-2 rounded-xl border border-orange-200/80 bg-orange-50/60 p-3 sm:flex-row sm:items-center dark:border-orange-700/40 dark:bg-orange-950/20">
                <Mail
                  className="hidden shrink-0 text-orange-500 dark:text-orange-400 sm:block"
                  aria-hidden
                />
                <Input
                  autoFocus
                  type="email"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCustomEmail();
                    }
                  }}
                  placeholder="bot@simple.biz, contractor@external.com"
                  className="h-9 flex-1 rounded-lg border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950/50"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddCustomEmail}
                  disabled={!customInput.trim()}
                  className="h-9 gap-1 bg-orange-600 text-white hover:bg-orange-500 disabled:opacity-50 dark:bg-orange-600 dark:hover:bg-orange-500"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add to list
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, department…"
                  className="h-10 rounded-lg border-zinc-200 bg-white pl-9 dark:border-zinc-800 dark:bg-zinc-950/50"
                />
              </div>
              <div className="relative shrink-0 sm:w-48">
                <Building2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
                <select
                  value={deptFilter}
                  onChange={(e) => setDeptFilter(e.target.value)}
                  aria-label="Filter by department"
                  className="h-10 w-full appearance-none truncate rounded-lg border border-zinc-200 bg-white pl-8 pr-7 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-orange-500/30 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-200"
                >
                  <option value="all">All departments</option>
                  {departments.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
              </div>
              <div className="flex shrink-0 items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-zinc-700 dark:text-zinc-300"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-[4.5rem] text-center font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {currentPage} / {totalPages}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-zinc-700 dark:text-zinc-300"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
              Showing{' '}
              <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                {filtered.length === 0 ? 0 : pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)}
              </span>{' '}
              of <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{filtered.length}</span>
              {(search.trim() || deptFilter !== 'all' || viewFilter !== 'all') &&
                uniqueEmployees.length !== filtered.length && (
                  <span className="text-zinc-400"> · filtered from {uniqueEmployees.length}</span>
                )}
            </p>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 sm:px-4">
            <ul className="space-y-1.5" role="list">
              {pageSlice.map((e, i) => {
                const assignedRoles = assignmentsForEmployee(e, allAssignments);
                const isSel = selected === e;
                const isCustom = customEmails.has(
                  (e.work_email ?? '').toLowerCase(),
                );
                return (
                  <li key={`${employeeIdentityEmail(e) || e.name}-${pageStart + i}`}>
                    <button
                      type="button"
                      onClick={() => setSelected(e)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all',
                        isSel
                          ? 'border-orange-500/55 bg-orange-50/90 shadow-md shadow-orange-500/10 ring-1 ring-orange-500/20 dark:border-orange-500/45 dark:bg-orange-950/35 dark:shadow-none'
                          : 'border-zinc-200/90 bg-white/60 hover:border-zinc-300 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/70',
                      )}
                    >
                      {isCustom && !isSel ? (
                        <div
                          className={cn(
                            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold',
                            'bg-orange-50/70 text-orange-700 ring-2 ring-orange-300/60 dark:bg-orange-950/30 dark:text-orange-300 dark:ring-orange-700/45',
                          )}
                        >
                          <AtSign className="h-4 w-4" aria-hidden />
                        </div>
                      ) : (
                        <div
                          className={cn(
                            'shrink-0 rounded-xl ring-2',
                            isSel
                              ? 'ring-orange-400/70 dark:ring-orange-500/55'
                              : 'ring-zinc-200/70 dark:ring-zinc-800',
                          )}
                        >
                          <EmployeeAvatar
                            photoUrl={e.profile_photo_url ?? null}
                            googlePhotoUrl={e.google_photo_url ?? null}
                            email={e.work_email ?? e.personal_email ?? null}
                            initials={initialsFromEmployee(e)}
                            className="!rounded-xl h-10 w-10 text-xs"
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                            {e.name || employeeIdentityEmail(e) || '—'}
                          </p>
                          {isCustom && (
                            <span
                              className="shrink-0 rounded-md border border-orange-300/80 bg-orange-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-orange-800 dark:border-orange-700/60 dark:bg-orange-950/50 dark:text-orange-300"
                              title="Off-roster — granted via Add by email"
                            >
                              Custom
                            </span>
                          )}
                        </div>
                        <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                          {e.work_email || e.personal_email || 'No email'}
                        </p>
                        {e.department && (
                          <p className="mt-0.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500">{e.department}</p>
                        )}
                      </div>
                      <div className="flex max-w-[40%] shrink-0 flex-wrap justify-end gap-1">
                        {assignedRoles.length === 0 ? (
                          <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">No roles</span>
                        ) : (
                          <>
                            {assignedRoles.slice(0, 3).map((r) => (
                              <span
                                key={r.id}
                                className={cn(
                                  'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                                  rolePillClasses(r.role),
                                )}
                              >
                                {ROLE_BY_KEY[r.role]?.label ?? r.role}
                              </span>
                            ))}
                            {assignedRoles.length > 3 && (
                              <span className="rounded-md border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                                +{assignedRoles.length - 3}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="rounded-xl border border-dashed border-zinc-200 py-10 text-center dark:border-zinc-800">
                  <p className="text-sm text-zinc-500">No people match this search.</p>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>

        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 space-y-1 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-white">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                <ShieldCheck className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden />
              </span>
              {selected ? 'Role assignments' : 'Choose someone'}
            </CardTitle>
            {selected && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-200/90 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                  <div className="shrink-0 rounded-lg ring-1 ring-zinc-200/70 dark:ring-zinc-800">
                    <EmployeeAvatar
                      photoUrl={selected.profile_photo_url ?? null}
                      googlePhotoUrl={selected.google_photo_url ?? null}
                      email={selected.work_email ?? selected.personal_email ?? null}
                      initials={initialsFromEmployee(selected)}
                      className="rounded-lg h-9 w-9 text-xs"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                        {selected.name || identity || '—'}
                      </p>
                      {customEmails.has(identity.toLowerCase()) && (
                        <span
                          className="shrink-0 rounded-md border border-orange-300/80 bg-orange-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-orange-800 dark:border-orange-700/60 dark:bg-orange-950/50 dark:text-orange-300"
                          title="Off-roster — granted via Add by email. Not in master list."
                        >
                          Custom
                        </span>
                      )}
                    </div>
                    <p className="truncate font-mono text-[11px] text-zinc-500">{identity || 'No email on file'}</p>
                  </div>
                </div>
                {roles.filter((r) => r.role === 'admin').length > 0 && (
                  <Badge className="shrink-0 gap-1 border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200">
                    <Crown className="h-3 w-3" aria-hidden />
                    Admin
                  </Badge>
                )}
                {identity && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void forceLogoutSelected()}
                    disabled={forcingLogout}
                    title="Invalidate this person's active sessions so their next request picks up the roles/permissions you just changed."
                    className="h-8 shrink-0 gap-1.5 border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
                  >
                    {forcingLogout ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <LogOut className="h-3.5 w-3.5" aria-hidden />
                    )}
                    Reset session
                  </Button>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1 sm:px-4">
            {!selected ? (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
                <UserCog className="h-10 w-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Select a person</p>
                  <p className="max-w-xs text-xs text-zinc-500 dark:text-zinc-500">
                    Pick someone from the list to grant or revoke roles, or click{' '}
                    <span className="font-semibold text-orange-600 dark:text-orange-400">Add by email</span>{' '}
                    to grant access to a service account or off-roster address.
                  </p>
                </div>
              </div>
            ) : rolesLoading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16">
                <Loader2 className="h-6 w-6 animate-spin text-orange-500" aria-hidden />
                <p className="text-xs text-zinc-500">Loading current roles…</p>
              </div>
            ) : !identity ? (
              <div className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100/90">
                This record has no work or personal email, so roles cannot be assigned. Update the directory first.
              </div>
            ) : (
              <div className="space-y-6">
                {hasRole('manager') && (
                  <section className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2 border-b border-zinc-100 pb-1 dark:border-zinc-800/80">
                      <div>
                        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">
                          <Building2 className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" aria-hidden />
                          Departments managed
                        </h3>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                          Pick the departments this manager approves leave for. Any single
                          assigned manager can clear a request — no quorum.
                        </p>
                      </div>
                      <Badge variant="outline" className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                        {selectedDeptAssignments.length} active
                      </Badge>
                    </div>
                    {departments.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-[11px] text-zinc-500 dark:border-zinc-800">
                        No departments found in the master list yet.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {departments.map((dept) => {
                          const on = selectedDeptSet.has(dept.trim().toLowerCase());
                          const busy = deptMutating === dept;
                          return (
                            <button
                              key={dept}
                              type="button"
                              onClick={() => toggleDepartment(dept)}
                              disabled={busy}
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60',
                                on
                                  ? 'border-indigo-500/60 bg-indigo-500/15 text-indigo-800 hover:bg-indigo-500/20 dark:border-indigo-500/50 dark:bg-indigo-950/50 dark:text-indigo-200'
                                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-800 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-indigo-700/60 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-200',
                              )}
                            >
                              {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                              ) : on ? (
                                <Check className="h-3 w-3" aria-hidden />
                              ) : (
                                <Plus className="h-3 w-3" aria-hidden />
                              )}
                              {dept}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}

                {/* HSL sub-departments — visible ONLY when the parent "HSL" / "Hogan
                    Smith Law" department is assigned above. Toggling HSL off
                    automatically hides this section. */}
                {hasHslParent && (
                  <section className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2 border-b border-zinc-100 pb-1 dark:border-zinc-800/80">
                      <div>
                        <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">
                          <Building2 className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden />
                          HSL sub-departments
                        </h3>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                          Pick which Hogan Smith Law sub-departments this person scopes the
                          KPI calculator to. Each pick stores a granular <code>hsl:&lt;key&gt;</code> grant in
                          department_managers. Hidden unless the HSL parent department is
                          assigned above.
                        </p>
                      </div>
                      <Badge variant="outline" className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                        {selectedHslSubDepts.size} active
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {HSL_DEPT_KEYS.map((key) => {
                        const cfg = HSL_DEPTS[key];
                        const grantStr = hslAccessKey(key);
                        const on = selectedHslSubDepts.has(key);
                        const busy = deptMutating === grantStr;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleDepartment(grantStr)}
                            disabled={busy}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60',
                              on
                                ? 'border-violet-500/60 bg-violet-500/15 text-violet-800 hover:bg-violet-500/20 dark:border-violet-500/50 dark:bg-violet-950/50 dark:text-violet-200'
                                : 'border-zinc-200 bg-white text-zinc-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-800 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400 dark:hover:border-violet-700/60 dark:hover:bg-violet-950/30 dark:hover:text-violet-200',
                            )}
                            title={cfg.cadence === 'weekly' ? 'Weekly bonus' : 'Monthly bonus'}
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                            ) : on ? (
                              <Check className="h-3 w-3" aria-hidden />
                            ) : (
                              <Plus className="h-3 w-3" aria-hidden />
                            )}
                            {cfg.name}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {ROLE_GROUPS.map((group) => (
                  <section key={group.title} className="space-y-2">
                    <div className="flex items-baseline justify-between gap-2 border-b border-zinc-100 pb-1 dark:border-zinc-800/80">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">
                          {group.title}
                        </h3>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{group.caption}</p>
                      </div>
                    </div>
                    <ul className="space-y-2" role="list">
                      {group.keys.map((key) => {
                        const r = ROLE_BY_KEY[key];
                        const active = hasRole(key);
                        const busy = mutating === key;
                        return (
                          <li
                            key={key}
                            className={cn(
                              'flex flex-col gap-3 rounded-xl border border-l-4 bg-white/80 p-3 shadow-sm transition-all dark:bg-zinc-900/35',
                              active
                                ? 'border-zinc-200/90 dark:border-zinc-700/90'
                                : 'border-zinc-200/90 dark:border-zinc-800/90',
                              roleRowAccent(key),
                            )}
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <div
                                className={cn(
                                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                                  active
                                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500',
                                )}
                              >
                                {active ? <Check className="h-5 w-5" aria-hidden /> : <ShieldCheck className="h-5 w-5" aria-hidden />}
                              </div>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-semibold text-zinc-900 dark:text-white">{r.label}</p>
                                  {active && (
                                    <span
                                      className={cn(
                                        'rounded-md border px-1.5 py-px text-[10px] font-bold uppercase tracking-wide',
                                        rolePillClasses(key),
                                      )}
                                    >
                                      Active
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">{r.blurb}</p>
                                <p className="mt-1 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{key}</p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleRole(key)}
                              disabled={busy}
                              className={cn(
                                'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60',
                                active
                                  ? 'border border-red-200/90 bg-white text-red-600 hover:bg-red-50 dark:border-red-500/35 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40'
                                  : 'bg-orange-600 text-white shadow-sm hover:bg-orange-500 dark:bg-orange-600 dark:hover:bg-orange-500',
                              )}
                            >
                              {busy ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                  {active ? 'Revoking…' : 'Assigning…'}
                                </>
                              ) : active ? (
                                <>
                                  <X className="h-3.5 w-3.5" aria-hidden />
                                  Revoke
                                </>
                              ) : (
                                <>
                                  <Plus className="h-3.5 w-3.5" aria-hidden />
                                  Assign
                                </>
                              )}
                            </button>
                            </div>

                            {/* Per-tab access grid — appears for any granted
                                role whose dashboard has a feature catalog
                                (finance, hr_coordinator, manager,
                                orphanage_manager, ceo, contractor). Admins
                                bypass per-tab gates entirely so we deliberately
                                don't show a grid for the admin row. */}
                            {(() => {
                              const view = ROLE_TO_FEATURE_VIEW[key];
                              if (!active || !view) return null;
                              const features = FEATURE_CATALOG[view];
                              if (!features || features.length === 0) return null;
                              return (
                                <FeaturePermissionGrid
                                  view={view}
                                  features={features}
                                  perms={featurePerms[view] ?? {}}
                                  loading={featurePermsLoading}
                                  mutatingKey={featurePermMutating}
                                  onChange={(feature, access) => void setFeatureAccess(view, feature, access)}
                                  onBulkSet={(access) => void setAllFeatureAccess(view, access)}
                                />
                              );
                            })()}

                            {/* Invoicing currency — only for the contractor
                                role. Presets every new invoice this person
                                creates to the chosen currency. */}
                            {key === 'contractor' && active && (
                              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 dark:border-zinc-700/70 dark:bg-zinc-800/40">
                                <div className="min-w-0">
                                  <p className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200">Invoicing currency</p>
                                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Presets every new invoice this contractor creates.</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
                                  {CONTRACTOR_CURRENCIES.map((cur) => (
                                    <button
                                      key={cur}
                                      type="button"
                                      onClick={() => void setCurrency(cur)}
                                      disabled={currencyMutating}
                                      className={cn(
                                        'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                                        contractorCurrency === cur
                                          ? 'bg-blue-600 text-white shadow-sm'
                                          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                                      )}
                                    >
                                      {currencyMutating && contractorCurrency === cur && (
                                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                                      )}
                                      {cur}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <RoleConflictModal
        role={guardRole}
        personName={selected?.name?.trim() || 'This person'}
        onCancel={() => setGuardRole(null)}
        onConfirm={() => {
          const r = guardRole;
          setGuardRole(null);
          if (r) void toggleRole(r, { bypassGuard: true });
        }}
      />
    </div>
  );
}

/**
 * Warning modal shown before granting a QC↔Manager combination. QC is a
 * manager's-assistant view that replaces the Manager dashboard; holding both
 * surfaces two dashboards and defeats the QC guard rail. The admin can still
 * override. Renders nothing until a pending `role` is set.
 */
function RoleConflictModal({
  role,
  personName,
  onCancel,
  onConfirm,
}: {
  role: RoleKey | null;
  personName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!role) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [role, onCancel]);

  if (!role) return null;
  const addingLabel = ROLE_BY_KEY[role]?.label ?? role;
  const existing: RoleKey = role === 'qc' ? 'manager' : 'qc';
  const existingLabel = ROLE_BY_KEY[existing]?.label ?? existing;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="role-conflict-title"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-zinc-950/45 backdrop-blur-sm dark:bg-black/65"
        style={{ animation: 'qc-guard-fade 160ms ease-out' }}
      />
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-amber-200/80 bg-white shadow-2xl shadow-amber-900/10 dark:border-amber-900/50 dark:bg-[#16130c]"
        style={{ animation: 'qc-guard-pop 220ms cubic-bezier(0.16,1,0.3,1)' }}
      >
        {/* amber header band */}
        <div className="flex items-start gap-3 border-b border-amber-100 bg-gradient-to-br from-amber-50 to-orange-50/60 px-5 py-4 dark:border-amber-900/40 dark:from-amber-950/40 dark:to-orange-950/20">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="role-conflict-title" className="text-[15px] font-bold tracking-tight text-amber-950 dark:text-amber-100">
              Assign {addingLabel} alongside {existingLabel}?
            </h2>
            <p className="mt-0.5 text-[12.5px] text-amber-800/80 dark:text-amber-200/70">
              {personName} already holds the {existingLabel} role.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
          <p>
            <span className="font-semibold text-zinc-800 dark:text-zinc-100">QC is a manager&rsquo;s-assistant view</span>{' '}
            — it&rsquo;s meant to <span className="font-semibold">replace</span> the Manager dashboard, not run beside it.
          </p>
          <div className="flex items-start gap-2 rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
            <ArrowLeftRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
            <p className="text-[12.5px] text-zinc-600 dark:text-zinc-400">
              With both roles, {personName.split(' ')[0] || 'they'} will see <span className="font-medium text-zinc-800 dark:text-zinc-200">two dashboards</span> in the Switch View, and QC&rsquo;s guard rail (only the QC&nbsp;Calculator tab) no longer applies.
            </p>
          </div>
          <p className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
            Assign QC on its own unless this person is genuinely both a department manager <em>and</em> a QC officer.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <Button variant="outline" size="sm" className="h-9" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-9 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
            onClick={onConfirm}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Assign anyway
          </Button>
        </div>
      </div>

      <style jsx global>{`
        @keyframes qc-guard-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes qc-guard-pop {
          0% { opacity: 0; transform: translateY(10px) scale(0.97); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/**
 * Loading skeleton — mirrors the live layout (header with title + three stat
 * chips, then the two-pane People / Role-assignments grid) so the page doesn't
 * jump when data arrives.
 */
function AdminRolesSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-b from-zinc-50/80 to-transparent p-4 sm:p-6 dark:from-zinc-950/50"
      role="status"
      aria-busy="true"
      aria-label="Loading people and assignments"
    >
      {/* Header */}
      <header className="shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <Skeleton className="h-7 w-52" />
            </div>
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[3.25rem] w-24 rounded-xl" />
            ))}
          </div>
        </div>
      </header>

      {/* Two-pane grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Left: People list */}
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200/90 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
          <div className="shrink-0 space-y-3 border-b border-zinc-100 p-4 dark:border-zinc-800/80">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-14 rounded-full" />
              <Skeleton className="ml-auto h-8 w-28 rounded-md" />
            </div>
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-hidden px-3 pb-4 pt-2 sm:px-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-zinc-200/90 px-3 py-2.5 dark:border-zinc-800"
              >
                <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <Skeleton className="h-5 w-14 shrink-0 rounded-md" />
              </div>
            ))}
          </div>
        </div>

        {/* Right: Role assignments detail */}
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200/90 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
          <div className="shrink-0 space-y-3 border-b border-zinc-100 p-4 dark:border-zinc-800/80">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-5 w-40" />
            </div>
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-hidden px-3 pb-4 pt-2 sm:px-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-l-4 border-zinc-200/90 p-3 dark:border-zinc-800/90"
              >
                <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48 max-w-full" />
                </div>
                <Skeleton className="h-9 w-24 shrink-0 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-tab access grid. Each row is one feature (catalog-driven) with three
 * pill buttons: Hidden / View / Edit. Clicking a button writes the
 * permission and toasts the result; the parent owns the perms map and
 * mutation state.
 */
function FeaturePermissionGrid({
  view,
  features,
  perms,
  loading,
  mutatingKey,
  onChange,
  onBulkSet,
}: {
  view: FeatureViewKey;
  features: readonly { key: string; label: string }[];
  perms: Record<string, FeatureAccess>;
  loading: boolean;
  mutatingKey: string | null;
  onChange: (feature: string, access: 'hidden' | FeatureAccess) => void;
  onBulkSet: (access: 'hidden' | FeatureAccess) => void;
}) {
  const bulkBusy = mutatingKey === `${view}:__all__`;
  return (
    <div className="rounded-lg border border-zinc-200/80 bg-white/60 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
          Tab access
        </p>
        <div className="flex items-center gap-1">
          {bulkBusy && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" aria-hidden />}
          {(['edit', 'view', 'hidden'] as const).map((level) => (
            <button
              key={level}
              type="button"
              disabled={loading || bulkBusy}
              onClick={() => onBulkSet(level)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                level === 'edit'
                  ? 'border-emerald-300/70 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
                  : level === 'view'
                  ? 'border-amber-300/70 text-amber-700 hover:bg-amber-50 dark:border-amber-700/50 dark:text-amber-300 dark:hover:bg-amber-950/40'
                  : 'border-zinc-300/70 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
              )}
              title={`Set every tab to ${level}`}
            >
              {level === 'edit' ? 'All: Edit' : level === 'view' ? 'All: View' : 'Hide all'}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-2 text-[10px] text-zinc-400 dark:text-zinc-500">Hidden by default — pick a level per tab, or use the bulk actions above</p>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading permissions…
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-1.5">
          {features.map((f) => {
            const current = perms[f.key] ?? 'hidden';
            const busyKey = `${view}:${f.key}`;
            const busy = mutatingKey === busyKey;
            return (
              <li
                key={f.key}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-200">
                  {f.label}
                </span>
                <div
                  role="radiogroup"
                  aria-label={`${f.label} access`}
                  className="inline-flex items-center rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {(['hidden', 'view', 'edit'] as const).map((level) => {
                    const isActive = current === level;
                    const label = level === 'hidden' ? 'Hidden' : level === 'view' ? 'View' : 'Edit';
                    const palette =
                      level === 'hidden'
                        ? 'data-[active=true]:bg-zinc-200 data-[active=true]:text-zinc-900 dark:data-[active=true]:bg-zinc-700 dark:data-[active=true]:text-zinc-100'
                        : level === 'view'
                        ? 'data-[active=true]:bg-amber-500/15 data-[active=true]:text-amber-700 dark:data-[active=true]:bg-amber-500/20 dark:data-[active=true]:text-amber-300'
                        : 'data-[active=true]:bg-emerald-500/15 data-[active=true]:text-emerald-700 dark:data-[active=true]:bg-emerald-500/20 dark:data-[active=true]:text-emerald-300';
                    return (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        data-active={isActive}
                        disabled={busy || isActive}
                        onClick={() => onChange(f.key, level)}
                        className={cn(
                          'inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-[10.5px] font-semibold transition-colors disabled:cursor-default',
                          'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                          palette,
                          busy && 'opacity-60',
                        )}
                      >
                        {busy && isActive ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                        ) : null}
                        {label}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
