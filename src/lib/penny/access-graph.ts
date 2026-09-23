/**
 * WHO HOLDS ACCESS OVER WHOM — the reverse of `get_employee_access`.
 *
 * `get_employee_access` answers "what can X do". This answers the other
 * direction, which no tool could before 2026-09-23 (CEO: "Penny should know …
 * who has permissions on who"): who manages X, who can act on or see the pay of
 * anyone, who holds a role, who manages a department, who holds which tab.
 *
 * Pure — the tool (`get_access_map` in ceo-tools.ts) reads the three grant
 * tables and the active roster and hands them here, so the rules are testable
 * outside Next. Two rules it must never break:
 *
 * 1. **A manager covers a department by the SAME matcher the manager routes
 *    enforce** — `departmentMatchesManagedAssignments`, used by
 *    /api/manager/department-members and eight other routes. A home-grown
 *    comparison would answer "who can see X" differently from what the routes
 *    actually allow, which is the one thing a permissions answer cannot do.
 * 2. **Grants are joined to a PERSON, not an address.** A role keyed on an
 *    alternate work email belongs to the same human as a manager grant on their
 *    primary one; the roster's four email columns fold them together.
 */

import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { ELEVATED_ROLES, RATE_VISIBLE_ROLES } from '@/lib/auth/elevated-roles';

export type RoleGrant = {
  work_email: string;
  role: string;
  assigned_by: string | null;
  assigned_at: string | null;
};

export type ManagerGrant = {
  manager_email: string;
  department: string;
  assigned_by: string | null;
  assigned_at: string | null;
};

export type TabGrant = {
  work_email: string;
  view_key: string;
  feature: string;
  access: string;
  granted_by: string | null;
  granted_at: string | null;
};

export type RosterPerson = {
  name: string | null;
  work_email: string | null;
  personal_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
  department: string | null;
};

export type AccessData = {
  roles: readonly RoleGrant[];
  managers: readonly ManagerGrant[];
  tabs: readonly TabGrant[];
  roster: readonly RosterPerson[];
};

export type Holder = {
  email: string;
  name: string | null;
  /** false = the address matches nobody on the ACTIVE roster — a leaver or an
   *  unknown account still holding a grant, which is worth saying out loud. */
  on_active_roster: boolean;
};

const ELEVATED = new Set<string>(ELEVATED_ROLES);
const RATE_VISIBLE = new Set<string>(RATE_VISIBLE_ROLES);

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Folds every roster address onto the person's primary work email. */
export function buildIdentityIndex(roster: readonly RosterPerson[]): {
  canonical: (email: string) => string;
  holder: (email: string) => Holder;
  departmentsOf: (email: string) => string[];
} {
  const byEmail = new Map<string, { key: string; name: string | null }>();
  const depts = new Map<string, Set<string>>();
  for (const p of roster) {
    const key = norm(p.work_email) || norm(p.personal_email);
    if (!key) continue;
    for (const e of [p.work_email, p.personal_email, p.alternate_work_email, p.alternate_work_email_2]) {
      const n = norm(e);
      if (n && !byEmail.has(n)) byEmail.set(n, { key, name: p.name ?? null });
    }
    const d = (p.department ?? '').trim();
    if (d) {
      const set = depts.get(key) ?? new Set<string>();
      set.add(d);
      depts.set(key, set);
    }
  }
  const canonical = (email: string) => byEmail.get(norm(email))?.key ?? norm(email);
  return {
    canonical,
    holder: (email) => {
      const hit = byEmail.get(norm(email));
      return { email: hit?.key ?? norm(email), name: hit?.name ?? null, on_active_roster: !!hit };
    },
    departmentsOf: (email) => [...(depts.get(canonical(email)) ?? [])].sort(),
  };
}

function rolesByPerson(data: AccessData, canonical: (e: string) => string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of data.roles) {
    const key = canonical(r.work_email);
    if (!key) continue;
    const set = out.get(key) ?? new Set<string>();
    set.add(r.role);
    out.set(key, set);
  }
  return out;
}

export type ManagerEntry = Holder & {
  /** The grant label exactly as stored in `department_managers`. */
  grant_department: string;
  /** Which of the person's departments that grant covers. */
  covers_department: string;
  assigned_by: string | null;
  assigned_at: string | null;
  /** The grant only opens the Manager dashboard for someone holding the
   *  `manager` (or `admin`) role — /manager is gated on those two. */
  holds_manager_role: boolean;
};

function managerEntries(
  departments: readonly string[],
  data: AccessData,
  idx: ReturnType<typeof buildIdentityIndex>,
  roles: Map<string, Set<string>>,
): ManagerEntry[] {
  const seen = new Set<string>();
  const out: ManagerEntry[] = [];
  for (const g of data.managers) {
    const covered = departments.find((d) => departmentMatchesManagedAssignments(d, [g.department]));
    if (!covered) continue;
    const h = idx.holder(g.manager_email);
    const dedupe = `${h.email}|${norm(g.department)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const r = roles.get(h.email) ?? new Set<string>();
    out.push({
      ...h,
      grant_department: g.department,
      covers_department: covered,
      assigned_by: g.assigned_by,
      assigned_at: g.assigned_at,
      holds_manager_role: r.has('manager') || r.has('admin'),
    });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

export type CompanyWideEntry = Holder & {
  roles: string[];
  is_admin: boolean;
  /** Elevated = may view / act on ANY employee's data (admin, accounting, hr_coordinator). */
  can_act_on_any_employee: boolean;
  can_see_pay_rates: boolean;
};

/** Everyone whose ROLE reaches every employee, regardless of department. */
function companyWide(
  idx: ReturnType<typeof buildIdentityIndex>,
  roles: Map<string, Set<string>>,
): CompanyWideEntry[] {
  const out: CompanyWideEntry[] = [];
  for (const [key, set] of roles) {
    const list = [...set].sort();
    const elevated = list.some((r) => ELEVATED.has(r));
    const rate = list.some((r) => RATE_VISIBLE.has(r));
    if (!elevated && !rate) continue;
    out.push({
      ...idx.holder(key),
      roles: list,
      is_admin: set.has('admin'),
      can_act_on_any_employee: elevated,
      can_see_pay_rates: rate,
    });
  }
  return out.sort(
    (a, b) => Number(b.is_admin) - Number(a.is_admin) || a.email.localeCompare(b.email),
  );
}

/** Who holds access over ONE person. */
export function accessOverPerson(email: string, data: AccessData) {
  const idx = buildIdentityIndex(data.roster);
  const roles = rolesByPerson(data, idx.canonical);
  const target = idx.holder(email);
  const departments = idx.departmentsOf(email);
  const managers = managerEntries(departments, data, idx, roles).map((m) => ({
    ...m,
    is_the_person_themself: m.email === target.email,
  }));
  return {
    person: target,
    departments,
    department_managers: managers,
    company_wide_access: companyWide(idx, roles),
  };
}

/** Who manages a department — `query` is matched exactly as the routes match it. */
export function managersOfDepartment(query: string, data: AccessData) {
  const idx = buildIdentityIndex(data.roster);
  const roles = rolesByPerson(data, idx.canonical);
  const managers = managerEntries([query], data, idx, roles);
  const known = [...new Set(data.managers.map((g) => g.department.trim()).filter(Boolean))].sort();
  return { department: query, managers, known_department_grants: managers.length ? undefined : known };
}

/** Everyone holding one role (active grants only — the reader filters revoked). */
export function holdersOfRole(role: string, data: AccessData) {
  const idx = buildIdentityIndex(data.roster);
  const want = norm(role);
  const seen = new Set<string>();
  const holders: Array<Holder & { assigned_by: string | null; assigned_at: string | null }> = [];
  for (const r of data.roles) {
    if (norm(r.role) !== want) continue;
    const h = idx.holder(r.work_email);
    if (seen.has(h.email)) continue;
    seen.add(h.email);
    holders.push({ ...h, assigned_by: r.assigned_by, assigned_at: r.assigned_at });
  }
  holders.sort((a, b) => a.email.localeCompare(b.email));
  const known = [...new Set(data.roles.map((r) => r.role))].sort();
  return { role: want, holder_count: holders.length, holders, known_roles: holders.length ? undefined : known };
}

/**
 * Who can open one dashboard, and who holds each of its tabs. Admins bypass tab
 * gating everywhere, so they are listed once as `admins_bypass` rather than
 * against every tab. A tab grant on someone WITHOUT a role that opens the
 * dashboard is reported as `dormant` — the row exists but reaches nothing.
 */
export function dashboardAccess(
  view: string,
  data: AccessData,
  opts: {
    catalog: readonly { key: string; label: string }[];
    openingRoles: readonly string[];
  },
) {
  const idx = buildIdentityIndex(data.roster);
  const roles = rolesByPerson(data, idx.canonical);
  const opening = new Set(opts.openingRoles);
  const canOpen = (key: string) => [...(roles.get(key) ?? [])].some((r) => opening.has(r));

  const openers: Array<Holder & { via_roles: string[] }> = [];
  const admins: Holder[] = [];
  for (const [key, set] of roles) {
    if (set.has('admin')) admins.push(idx.holder(key));
    const via = [...set].filter((r) => opening.has(r) && r !== 'admin').sort();
    if (via.length) openers.push({ ...idx.holder(key), via_roles: via });
  }

  const tabs = opts.catalog.map((t) => {
    const grants = data.tabs
      .filter((g) => g.view_key === view && g.feature === t.key && (g.access === 'view' || g.access === 'edit'))
      .map((g) => {
        const h = idx.holder(g.work_email);
        return {
          ...h,
          access: g.access,
          granted_by: g.granted_by,
          granted_at: g.granted_at,
          dormant: !canOpen(h.email),
        };
      });
    // One line per person: the most permissive grant wins (edit > view), the
    // same merge fetchFeaturePermissionsForEmail applies at runtime.
    const best = new Map<string, (typeof grants)[number]>();
    for (const g of grants) {
      const cur = best.get(g.email);
      if (!cur || (cur.access === 'view' && g.access === 'edit')) best.set(g.email, g);
    }
    const holders = [...best.values()].sort((a, b) => a.email.localeCompare(b.email));
    return {
      tab: t.label,
      edit: holders.filter((h) => h.access === 'edit'),
      view: holders.filter((h) => h.access === 'view'),
    };
  });

  const byEmail = (a: Holder, b: Holder) => a.email.localeCompare(b.email);
  return {
    dashboard: view,
    can_open: openers.sort(byEmail),
    admins_bypass: admins.sort(byEmail),
    tabs,
  };
}

/** Org-wide headline: holders per role and managers per department. */
export function accessSummary(data: AccessData) {
  const idx = buildIdentityIndex(data.roster);
  const byRole = new Map<string, Set<string>>();
  for (const r of data.roles) {
    const set = byRole.get(r.role) ?? new Set<string>();
    set.add(idx.canonical(r.work_email));
    byRole.set(r.role, set);
  }
  const roles = [...byRole.entries()]
    .map(([role, set]) => ({
      role,
      holder_count: set.size,
      holders: [...set].sort().map((e) => idx.holder(e)),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));

  const byDept = new Map<string, Set<string>>();
  for (const g of data.managers) {
    const d = g.department.trim();
    if (!d) continue;
    const set = byDept.get(d) ?? new Set<string>();
    set.add(idx.canonical(g.manager_email));
    byDept.set(d, set);
  }
  const departments = [...byDept.entries()]
    .map(([department, set]) => ({ department, managers: [...set].sort() }))
    .sort((a, b) => a.department.localeCompare(b.department));

  const offRoster = new Set<string>();
  for (const r of data.roles) if (!idx.holder(r.work_email).on_active_roster) offRoster.add(idx.canonical(r.work_email));
  for (const g of data.managers) if (!idx.holder(g.manager_email).on_active_roster) offRoster.add(idx.canonical(g.manager_email));

  return {
    roles,
    department_managers: departments,
    grants_held_by_addresses_not_on_active_roster: [...offRoster].sort(),
  };
}
