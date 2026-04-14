'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, Search, ShieldCheck, UserCog, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import type { EmployeeRow } from '@/lib/supabase/employees';

const ROLES = [
  { key: 'viewer',               label: 'Viewer',               blurb: 'Read-only dashboard access.' },
  { key: 'hr_coordinator',       label: 'HR Coordinator',       blurb: 'Edit employee profiles.' },
  { key: 'payroll_coordinator',  label: 'Payroll Coordinator',  blurb: 'Upload CSVs, pre-flight payroll.' },
  { key: 'payroll_manager',      label: 'Payroll Manager',      blurb: 'Edit rates, dispatch payroll.' },
  { key: 'finance',              label: 'Finance / Accounting', blurb: 'Access the Accounting Dashboard.' },
  { key: 'admin',                label: 'Admin',                blurb: 'Full system access.' },
] as const;

type RoleKey = (typeof ROLES)[number]['key'];

interface RoleRow {
  id: string;
  work_email: string;
  role: RoleKey;
  assigned_by: string | null;
  assigned_at: string;
}

const PAGE_SIZE = 8;

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

        // Merge all sources by lowercased work/personal email so employees that
        // only exist in hubstaff_hours or employee_hourly_rates still appear.
        const merged = new Map<string, EmployeeRow>();
        const keyFor = (we: string | null | undefined, pe: string | null | undefined, nm?: string | null) =>
          (we ?? pe ?? nm ?? '').toString().trim().toLowerCase();

        // 1) Primary source: global_master_list
        for (const e of empJson.employees ?? []) {
          const k = keyFor(e.work_email, e.personal_email, e.name);
          if (!k) continue;
          merged.set(k, e);
        }

        // 2) Fallback: employee_hourly_rates
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

        // 3) Last-resort fallback: hubstaff_hours (uses raw rows, so sniff common email keys)
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

  useEffect(() => {
    if (!selected?.work_email) {
      setRoles([]);
      return;
    }
    setRolesLoading(true);
    fetch(`/api/employee-roles?email=${encodeURIComponent(selected.work_email)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: RoleRow[] }) => setRoles(j.rows ?? []))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to load roles'))
      .finally(() => setRolesLoading(false));
  }, [selected]);

  // Dedupe on work_email (lowercase); fall back to personal_email then name.
  // Rows with no identity at all still get a synthetic key so they aren't dropped.
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
          const hay = [
            e.name,
            e.work_email,
            e.personal_email,
            e.department,
            e.employee_id,
            e.start_date,
          ]
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

  const hasRole = (role: RoleKey) => roles.some((r) => r.role === role);

  async function refreshAll() {
    const res = await fetch('/api/employee-roles', { cache: 'no-store' });
    const json = (await res.json()) as { rows?: RoleRow[] };
    setAllAssignments(json.rows ?? []);
  }

  async function toggleRole(role: RoleKey) {
    if (!selected?.work_email) return;
    const currentlyHas = hasRole(role);
    setMutating(role);
    try {
      const res = await fetch(
        currentlyHas
          ? `/api/employee-roles?email=${encodeURIComponent(selected.work_email)}&role=${role}`
          : '/api/employee-roles',
        {
          method: currentlyHas ? 'DELETE' : 'POST',
          headers: currentlyHas ? undefined : { 'content-type': 'application/json' },
          body: currentlyHas ? undefined : JSON.stringify({ work_email: selected.work_email, role }),
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Failed to update role');
        return;
      }
      toast.success(currentlyHas ? `Revoked ${role}` : `Granted ${role}`);
      // Refetch for selected + all
      const r = await fetch(`/api/employee-roles?email=${encodeURIComponent(selected.work_email)}`, {
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
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4 sm:p-5">
      <div className="flex shrink-0 flex-col gap-0.5">
        <h1 className="flex items-center gap-2 text-xl font-bold text-zinc-900 dark:text-white">
          <UserCog className="h-5 w-5 text-orange-500" />
          Role & Permissions
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Assign accounting, payroll, HR, and admin capabilities to employees. Changes are logged.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_1.2fr]">
        <Card className="flex h-full min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Employees</CardTitle>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[12rem] flex-1">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or email…"
                  className="pl-7"
                />
              </div>
              <div className="flex shrink-0 items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 border-zinc-200 text-zinc-800 dark:border-zinc-800 dark:text-zinc-300"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="px-2 font-mono text-zinc-600 dark:text-zinc-400">
                  {currentPage} / {totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 border-zinc-200 text-zinc-800 dark:border-zinc-800 dark:text-zinc-300"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Showing{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                {filtered.length === 0 ? 0 : pageStart + 1}–
                {Math.min(pageStart + PAGE_SIZE, filtered.length)}
              </span>{' '}
              of <span className="font-mono text-zinc-700 dark:text-zinc-300">{filtered.length}</span>
              {search.trim() && uniqueEmployees.length !== filtered.length && (
                <>
                  {' '}
                  <span className="text-zinc-400">
                    (filtered from {uniqueEmployees.length} total)
                  </span>
                </>
              )}
            </p>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto pr-2">
            <ul className="space-y-1">
              {pageSlice.map((e, i) => {
                const emailKey = (e.work_email ?? e.personal_email ?? '').toLowerCase();
                const assignedRoles = allAssignments.filter(
                  (a) => a.work_email.toLowerCase() === (e.work_email ?? '').toLowerCase(),
                );
                const isSel =
                  !!selected &&
                  (selected.work_email ?? '').toLowerCase() === (e.work_email ?? '').toLowerCase();
                return (
                  <li key={`${emailKey}-${pageStart + i}`}>
                    <button
                      type="button"
                      onClick={() => setSelected(e)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                        isSel
                          ? 'border-orange-500/50 bg-orange-50 shadow-sm dark:border-orange-500/40 dark:bg-orange-950/30'
                          : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/60'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-500/20 to-blue-500/20 text-xs font-semibold uppercase text-orange-700 dark:text-orange-300">
                          {(e.name?.trim() || e.work_email || '?').slice(0, 1)}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                            {e.name || e.work_email || '—'}
                          </p>
                          <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {e.work_email || e.personal_email || '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {assignedRoles.length === 0 ? (
                          <span className="text-[10px] italic text-zinc-400">no roles</span>
                        ) : (
                          assignedRoles.slice(0, 3).map((r) => (
                            <Badge
                              key={r.id}
                              variant="outline"
                              className="border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0 text-[10px] text-indigo-700 dark:text-indigo-300"
                            >
                              {r.role}
                            </Badge>
                          ))
                        )}
                        {assignedRoles.length > 3 && (
                          <Badge
                            variant="outline"
                            className="border-zinc-300 px-1.5 py-0 text-[10px] text-zinc-500 dark:border-zinc-700"
                          >
                            +{assignedRoles.length - 3}
                          </Badge>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-6 text-center text-xs text-zinc-500">No employees match.</li>
              )}
            </ul>
          </CardContent>
        </Card>

        <Card className="flex h-full min-h-0 flex-col overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-orange-500" />
              {selected
                ? `Roles for ${selected.name || selected.work_email}`
                : 'Select an employee'}
            </CardTitle>
            {selected?.work_email && (
              <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{selected.work_email}</p>
            )}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto">
            {!selected ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                Pick an employee from the list to manage their roles.
              </p>
            ) : rolesLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            ) : (
              <div className="space-y-2">
                {ROLES.map((r) => {
                  const active = hasRole(r.key);
                  const busy = mutating === r.key;
                  return (
                    <div
                      key={r.key}
                      className={`group flex items-center justify-between gap-3 rounded-lg border p-3 transition-all ${
                        active
                          ? 'border-emerald-500/40 bg-gradient-to-r from-emerald-50/60 to-white shadow-sm dark:border-emerald-500/30 dark:from-emerald-950/30 dark:to-transparent'
                          : 'border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${
                            active
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-zinc-100 text-zinc-400 group-hover:bg-orange-500/10 group-hover:text-orange-500 dark:bg-zinc-800 dark:text-zinc-500'
                          }`}
                        >
                          {active ? <Check className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-zinc-900 dark:text-white">{r.label}</p>
                            {active && (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
                              >
                                ACTIVE
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{r.blurb}</p>
                          <p className="mt-0.5 font-mono text-[10px] text-zinc-400">{r.key}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleRole(r.key)}
                        disabled={busy}
                        className={`group/btn relative flex shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-4 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                          active
                            ? 'border border-red-200 bg-white text-red-600 hover:border-red-500 hover:bg-red-50 hover:text-red-700 hover:shadow-md hover:shadow-red-500/10 dark:border-red-500/30 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/30'
                            : 'bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm shadow-orange-500/30 hover:shadow-lg hover:shadow-orange-500/40 hover:brightness-110'
                        }`}
                      >
                        {busy ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>{active ? 'Revoking…' : 'Assigning…'}</span>
                          </>
                        ) : active ? (
                          <>
                            <X className="h-3.5 w-3.5 transition-transform group-hover/btn:rotate-90" />
                            <span>Revoke</span>
                          </>
                        ) : (
                          <>
                            <Plus className="h-3.5 w-3.5 transition-transform group-hover/btn:rotate-90" />
                            <span>Assign</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
