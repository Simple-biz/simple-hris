'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  Check,
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  Loader2,
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
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';

const ROLES = [
  { key: 'viewer', label: 'Viewer', blurb: 'Read-only dashboard access.' },
  { key: 'hr_coordinator', label: 'HR Coordinator', blurb: 'Edit employee profiles.' },
  { key: 'payroll_coordinator', label: 'Payroll Coordinator', blurb: 'Upload CSVs, pre-flight payroll.' },
  { key: 'payroll_manager', label: 'Payroll Manager', blurb: 'Payment dispatch only.' },
  { key: 'finance', label: 'Finance / Accounting', blurb: 'Access the Accounting Dashboard.' },
  { key: 'manager', label: 'Manager', blurb: 'Approve time adjustments, manage own team.' },
  { key: 'admin', label: 'Admin', blurb: 'Full system access.' },
] as const;

type RoleKey = (typeof ROLES)[number]['key'];

const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r])) as Record<RoleKey, (typeof ROLES)[number]>;

const ROLE_GROUPS: { title: string; caption: string; keys: RoleKey[] }[] = [
  { title: 'Baseline', caption: 'Who can see what', keys: ['viewer'] },
  { title: 'Coordinators', caption: 'HR & payroll inputs', keys: ['hr_coordinator', 'payroll_coordinator'] },
  { title: 'Management', caption: 'Rates, dispatch & books', keys: ['payroll_manager', 'finance'] },
  { title: 'Team Lead', caption: 'Team-scoped approvals', keys: ['manager'] },
  { title: 'System', caption: 'Full control', keys: ['admin'] },
];

function rolePillClasses(role: RoleKey): string {
  const map: Record<RoleKey, string> = {
    viewer:
      'border-zinc-200/90 bg-zinc-100/90 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200',
    hr_coordinator:
      'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300/95 dark:border-emerald-600/40',
    payroll_coordinator:
      'border-violet-500/35 bg-violet-500/10 text-violet-800 dark:text-violet-300/95 dark:border-violet-600/40',
    payroll_manager:
      'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200/95 dark:border-amber-600/45',
    finance:
      'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:text-sky-200/95 dark:border-sky-600/40',
    manager:
      'border-indigo-500/35 bg-indigo-500/10 text-indigo-800 dark:text-indigo-300/95 dark:border-indigo-600/40',
    admin:
      'border-rose-500/40 bg-rose-500/10 text-rose-900 dark:text-rose-200/95 dark:border-rose-600/45',
  };
  return map[role];
}

function roleRowAccent(role: RoleKey): string {
  const map: Record<RoleKey, string> = {
    viewer: 'border-l-zinc-400 dark:border-l-zinc-500',
    hr_coordinator: 'border-l-emerald-500',
    payroll_coordinator: 'border-l-violet-500',
    payroll_manager: 'border-l-amber-500',
    finance: 'border-l-sky-500',
    manager: 'border-l-indigo-500',
    admin: 'border-l-rose-500',
  };
  return map[role];
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

const PAGE_SIZE = 10;

export default function AdminRoles() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EmployeeRow | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [allAssignments, setAllAssignments] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [mutating, setMutating] = useState<RoleKey | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    (async () => {
      try {
        const [empRes, ratesRes, hubRes, rolesRes] = await Promise.all([
          fetch('/api/employees', { cache: 'no-store' }),
          fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
          fetch('/api/hubstaff-hours', { cache: 'no-store' }),
          fetch('/api/employee-roles', { cache: 'no-store' }),
        ]);
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[] };
        const ratesJson = (await ratesRes.json()) as {
          rows?: Array<{
            work_email?: string | null;
            personal_email?: string | null;
            department?: string | null;
            name?: string | null;
          }>;
        };
        const hubJson = (await hubRes.json()) as {
          rows?: Array<Record<string, unknown>>;
          columns?: string[];
        };
        const rolesJson = (await rolesRes.json()) as { rows?: RoleRow[] };

        const merged = new Map<string, EmployeeRow>();
        const keyFor = (we: string | null | undefined, pe: string | null | undefined, nm?: string | null) =>
          (we ?? pe ?? nm ?? '').toString().trim().toLowerCase();

        for (const e of empJson.employees ?? []) {
          const k = keyFor(e.work_email, e.personal_email, e.name);
          if (!k) continue;
          merged.set(k, e);
        }

        for (const r of ratesJson.rows ?? []) {
          const k = keyFor(r.work_email, r.personal_email, r.name);
          if (!k || merged.has(k)) continue;
          merged.set(k, {
            name: r.name ?? null,
            work_email: r.work_email ?? null,
            personal_email: r.personal_email ?? null,
            department: r.department ?? null,
            start_date: null,
            employee_id: null,
          } as EmployeeRow);
        }

        for (const row of hubJson.rows ?? []) {
          const pickStr = (...keys: string[]): string | null => {
            for (const k of keys) {
              const v = row[k];
              if (v != null && String(v).trim() !== '') return String(v).trim();
            }
            return null;
          };
          const work_email = pickStr('Work Email', 'work_email', 'workEmail', 'email', 'Email');
          const personal_email = pickStr('Personal Email', 'personal_email');
          const name = pickStr('Name', 'Member', 'Employee', 'name');
          const k = keyFor(work_email, personal_email, name);
          if (!k || merged.has(k)) continue;
          merged.set(k, {
            name,
            work_email,
            personal_email,
            department: pickStr('Department', 'department'),
            start_date: null,
            employee_id: null,
          } as EmployeeRow);
        }

        setEmployees(Array.from(merged.values()));
        setAllAssignments(rolesJson.rows ?? []);
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
      return;
    }
    let cancelled = false;
    setRolesLoading(true);
    fetch(`/api/employee-roles?email=${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: RoleRow[] }) => {
        if (!cancelled) setRoles(j.rows ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load roles');
      })
      .finally(() => {
        if (!cancelled) setRolesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selWork, selPersonal]);

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? uniqueEmployees.filter((e) => {
          const hay = [e.name, e.work_email, e.personal_email, e.department, e.employee_id, e.start_date]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
      : uniqueEmployees;
    return [...base].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [uniqueEmployees, search]);

  useEffect(() => {
    setPage(1);
  }, [search]);

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

  async function refreshAll() {
    const res = await fetch('/api/employee-roles', { cache: 'no-store' });
    const json = (await res.json()) as { rows?: RoleRow[] };
    setAllAssignments(json.rows ?? []);
  }

  async function toggleRole(role: RoleKey) {
    const email = employeeIdentityEmail(selected);
    if (!email) {
      toast.error('This person has no email on file — add a work or personal email first.');
      return;
    }
    const currentlyHas = hasRole(role);
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

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50/50 dark:bg-zinc-950/30">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" aria-hidden />
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Loading people and assignments…</p>
      </div>
    );
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
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">People</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                {filtered.length} shown
              </Badge>
            </div>
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
              {search.trim() && uniqueEmployees.length !== filtered.length && (
                <span className="text-zinc-400"> · filtered from {uniqueEmployees.length}</span>
              )}
            </p>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 sm:px-4">
            <ul className="space-y-1.5" role="list">
              {pageSlice.map((e, i) => {
                const assignedRoles = assignmentsForEmployee(e, allAssignments);
                const isSel = selected === e;
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
                      <div
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold',
                          isSel
                            ? 'bg-orange-500 text-white shadow-sm'
                            : 'bg-gradient-to-br from-zinc-100 to-zinc-200/80 text-zinc-700 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-200',
                        )}
                      >
                        {initialsFromEmployee(e)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                          {e.name || employeeIdentityEmail(e) || '—'}
                        </p>
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
                                {ROLE_BY_KEY[r.role].label}
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
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white font-semibold shadow-sm dark:bg-zinc-800">
                    {initialsFromEmployee(selected)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                      {selected.name || identity || '—'}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-500">{identity || 'No email on file'}</p>
                  </div>
                </div>
                {roles.filter((r) => r.role === 'admin').length > 0 && (
                  <Badge className="shrink-0 gap-1 border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200">
                    <Crown className="h-3 w-3" aria-hidden />
                    Admin
                  </Badge>
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
                    Pick someone from the list to grant or revoke roles. Use search to narrow the directory.
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
                              'flex flex-col gap-3 rounded-xl border border-l-4 bg-white/80 p-3 shadow-sm transition-all sm:flex-row sm:items-center sm:justify-between dark:bg-zinc-900/35',
                              active
                                ? 'border-zinc-200/90 dark:border-zinc-700/90'
                                : 'border-zinc-200/90 dark:border-zinc-800/90',
                              roleRowAccent(key),
                            )}
                          >
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
    </div>
  );
}
