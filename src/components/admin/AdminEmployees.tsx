'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Layers,
  Loader2,
  Mail,
  MapPin,
  Search,
  Shield,
  User,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeRateProfile } from '@/lib/supabase/employee-rate-profiles';

interface RoleAssignmentRow {
  id: string;
  work_email: string;
  role: string;
  assigned_by: string | null;
  assigned_at: string;
}

const ROLE_LABELS: Record<string, string> = {
  viewer: 'Viewer',
  hr_coordinator: 'HR Coordinator',
  payroll_coordinator: 'Payroll Coordinator',
  payroll_manager: 'Payroll Manager',
  orphanage_manager: 'Orphanage Manager',
  finance: 'Finance',
  admin: 'Admin',
};

const PAGE_SIZE = 10;

type DepartmentFilter = '__all__' | '__unassigned__' | string;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

function normalizePhotoUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  return null;
}

/** Collect profile picture URL from merged profile fields (any common column name). */
function photoFromFields(fields: { key: string; value: unknown }[]): string | null {
  for (const f of fields) {
    const nk = f.key.toLowerCase().replace(/\s+/g, '_');
    const looksLikePhotoKey =
      nk.includes('profile_photo') ||
      nk.includes('profile_picture') ||
      nk.includes('photo_url') ||
      nk.includes('avatar') ||
      nk.includes('picture_url') ||
      nk.endsWith('_photo') ||
      (nk === 'photo' && String(f.value ?? '').includes('http'));
    if (!looksLikePhotoKey) continue;
    const normalized = normalizePhotoUrl(String(f.value ?? ''));
    if (normalized) return normalized;
  }
  return null;
}

/** Map normalized email → profile photo URL from global master list (`/api/employees`). */
function buildPhotoLookup(employees: EmployeeRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of employees) {
    const url = normalizePhotoUrl(e.profile_photo_url ?? '');
    if (!url) continue;
    const we = normEmail(e.work_email);
    const pe = normEmail(e.personal_email);
    if (we) m.set(we, url);
    if (pe) m.set(pe, url);
  }
  return m;
}

function resolveProfilePhoto(p: EmployeeRateProfile, photoByEmail: Map<string, string>): string | null {
  for (const raw of [p.workEmail, p.personalEmail, p.subtitle]) {
    const n = normEmail(raw);
    if (n) {
      const u = photoByEmail.get(n);
      if (u) return u;
    }
  }
  return photoFromFields(p.fields);
}

function primaryEmailForAvatar(p: EmployeeRateProfile): string | null {
  return normEmail(p.workEmail) ?? normEmail(p.personalEmail) ?? normEmail(p.subtitle);
}

function ProfileAvatar({
  photoUrl,
  gravatarEmail,
  name,
  className,
  imgClassName = 'h-full w-full object-cover',
  fallbackClassName,
  alt = '',
}: {
  photoUrl: string | null;
  gravatarEmail: string | null;
  name: string;
  className?: string;
  imgClassName?: string;
  fallbackClassName: string;
  alt?: string;
}) {
  const [failedPhoto, setFailedPhoto] = useState(false);
  const [failedGravatar, setFailedGravatar] = useState(false);

  useEffect(() => {
    setFailedPhoto(false);
    setFailedGravatar(false);
  }, [photoUrl, gravatarEmail]);

  const gravSize = gravatarEmail ? '192' : '128';

  if (photoUrl && !failedPhoto) {
    return (
      <div className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Supabase/storage URL */}
        <img
          src={photoUrl}
          alt={alt}
          className={imgClassName}
          onError={() => setFailedPhoto(true)}
        />
      </div>
    );
  }

  if (gravatarEmail && !failedGravatar) {
    return (
      <div className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Gravatar redirect */}
        <img
          src={`/api/avatar?email=${encodeURIComponent(gravatarEmail)}&s=${gravSize}&d=404`}
          alt={alt}
          className={imgClassName}
          onError={() => setFailedGravatar(true)}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <div className={cn('flex h-full w-full items-center justify-center', fallbackClassName)}>{initials(name)}</div>
    </div>
  );
}

function rolesForProfile(p: EmployeeRateProfile, assignments: RoleAssignmentRow[]): RoleAssignmentRow[] {
  const set = new Set(
    [p.workEmail, p.personalEmail, p.subtitle]
      .map((e) => normEmail(e))
      .filter((x): x is string => Boolean(x)),
  );
  return assignments.filter((r) => {
    const re = normEmail(r.work_email);
    return re != null && set.has(re);
  });
}

function formatFieldValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

type FieldCategory = 'compensation' | 'banking' | 'location' | 'dates' | 'other';

function fieldCategory(key: string): FieldCategory {
  const k = key.toLowerCase();
  if (
    k.includes('rate') ||
    k.includes('pay') ||
    k.includes('salary') ||
    k.includes('bonus') ||
    k.includes('ot ') ||
    k === 'ot_rate' ||
    k.includes('hourly')
  )
    return 'compensation';
  if (
    k.includes('bank') ||
    k.includes('account') ||
    k.includes('routing') ||
    k.includes('iban') ||
    k.includes('swift')
  )
    return 'banking';
  if (
    k.includes('address') ||
    k.includes('street') ||
    k.includes('city') ||
    k.includes('zip') ||
    k.includes('postal') ||
    k.includes('country') ||
    k.includes('state') ||
    k.includes('province')
  )
    return 'location';
  if (k.includes('date') || k.includes('start') || k.includes('hired')) return 'dates';
  return 'other';
}

const CATEGORY_META: Record<
  FieldCategory,
  { label: string; icon: typeof Briefcase; order: number }
> = {
  compensation: { label: 'Compensation & rates', icon: Briefcase, order: 0 },
  banking: { label: 'Banking', icon: Building2, order: 1 },
  location: { label: 'Location', icon: MapPin, order: 2 },
  dates: { label: 'Dates', icon: Calendar, order: 3 },
  other: { label: 'Additional fields', icon: Layers, order: 4 },
};

function groupFields(fields: { key: string; value: unknown }[]) {
  const map = new Map<FieldCategory, { key: string; value: unknown }[]>();
  for (const f of fields) {
    const cat = fieldCategory(f.key);
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(f);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }));
  }
  return (['compensation', 'banking', 'location', 'dates', 'other'] as FieldCategory[]).filter(
    (c) => (map.get(c)?.length ?? 0) > 0,
  ).map((c) => ({ category: c, rows: map.get(c)! }));
}

export default function AdminEmployees() {
  const [profiles, setProfiles] = useState<EmployeeRateProfile[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [mergeNotes, setMergeNotes] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<RoleAssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>('__all__');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const photoByEmail = useMemo(() => buildPhotoLookup(employees), [employees]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profRes, roleRes, empRes] = await Promise.all([
          fetch('/api/employee-rate-profiles', { cache: 'no-store' }),
          fetch('/api/employee-roles', { cache: 'no-store' }),
          fetch('/api/employees', { cache: 'no-store' }),
        ]);
        const profJson = (await profRes.json()) as {
          profiles?: EmployeeRateProfile[];
          error?: string | null;
          mergeNotes?: string[];
        };
        const roleJson = (await roleRes.json()) as { rows?: RoleAssignmentRow[]; error?: string };
        const empJson = (await empRes.json()) as { employees?: EmployeeRow[]; error?: string | null };

        if (cancelled) return;
        if (profJson.error) toast.error(profJson.error);
        if (roleJson.error) toast.error(roleJson.error);
        if (empJson.error) toast.error(empJson.error);

        setProfiles(Array.isArray(profJson.profiles) ? profJson.profiles : []);
        setMergeNotes(Array.isArray(profJson.mergeNotes) ? profJson.mergeNotes : []);
        setAssignments(Array.isArray(roleJson.rows) ? roleJson.rows : []);
        setEmployees(Array.isArray(empJson.employees) ? empJson.employees : []);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load employees');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      const d = (p.department ?? '').trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [profiles]);

  // Precomputed lowercased search blob per profile. Without this, each keystroke
  // re-walked every profile's fields and joined strings — unusably laggy on large
  // rosters. This memo only re-runs when the profile list itself changes.
  const searchIndex = useMemo(() => {
    return profiles.map((p) => ({
      profile: p,
      blob: [
        p.displayName,
        p.department,
        p.organization,
        p.workEmail,
        p.personalEmail,
        p.subtitle,
        ...p.fields.map((f) => `${f.key} ${formatFieldValue(f.value)}`),
      ]
        .join(' ')
        .toLowerCase(),
    }));
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list: typeof profiles = [];
    for (const { profile: p, blob } of searchIndex) {
      if (departmentFilter !== '__all__') {
        const dep = (p.department ?? '').trim();
        if (departmentFilter === '__unassigned__') {
          if (dep !== '') continue;
        } else if (dep !== departmentFilter) {
          continue;
        }
      }
      if (q && !blob.includes(q)) continue;
      list.push(p);
    }
    list.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
    return list;
  }, [searchIndex, search, departmentFilter]);

  useEffect(() => {
    setPage(1);
  }, [search, departmentFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageSlice = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((p) => p.id === selectedId)) {
      setSelectedId(filtered[0]!.id);
    }
  }, [filtered, selectedId]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-zinc-50/50 dark:bg-zinc-950/30">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" aria-hidden />
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Loading merged profiles…</p>
      </div>
    );
  }

  const primary = selected ? primaryEmailForAvatar(selected) : null;
  const profilePhoto = selected ? resolveProfilePhoto(selected, photoByEmail) : null;
  const profileRoles = selected ? rolesForProfile(selected, assignments) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-gradient-to-b from-zinc-50/80 to-transparent p-4 sm:p-6 dark:from-zinc-950/50">
      <header className="shrink-0 space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/15 ring-1 ring-orange-500/25">
                <Users className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden />
              </span>
              Employees
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Directory merged from your Supabase tables (master list, hourly rates, Hubstaff, and any
              configured profile sources). Open a person to see every stored field.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/90 bg-white/90 px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
            <User className="h-4 w-4 text-zinc-400" aria-hidden />
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Profiles</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {profiles.length}
              </p>
            </div>
          </div>
        </div>
        {mergeNotes.length > 0 && (
          <div className="rounded-lg border border-amber-200/80 bg-amber-50/90 px-3 py-2 text-[12px] text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/25 dark:text-amber-100/90">
            <p className="font-semibold">Merge notes</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-900/95 dark:text-amber-200/85">
              {mergeNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 space-y-3 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Directory</CardTitle>
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
                  placeholder="Search names, emails, departments, any field…"
                  className="h-10 rounded-lg border-zinc-200 bg-white pl-9 dark:border-zinc-800 dark:bg-zinc-950/50"
                />
              </div>
              <label className="flex shrink-0 items-center gap-2">
                <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                  <Building2 className="h-3.5 w-3.5" aria-hidden />
                  Department
                </span>
                <select
                  value={departmentFilter}
                  onChange={(e) => setDepartmentFilter(e.target.value)}
                  className="h-10 min-w-[10.5rem] cursor-pointer rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                  aria-label="Filter by department"
                >
                  <option value="__all__">All departments</option>
                  <option value="__unassigned__">Unassigned</option>
                  {departmentOptions.map((dep) => (
                    <option key={dep} value={dep}>
                      {dep}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex shrink-0 items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
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
                  className="h-8 px-2"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500">
              Showing{' '}
              <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                {filtered.length === 0 ? 0 : pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)}
              </span>{' '}
              of <span className="font-mono font-medium">{filtered.length}</span>
            </p>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 sm:px-4">
            <ul className="space-y-1.5" role="list">
              {pageSlice.map((p) => {
                const isSel = p.id === selectedId;
                const rCount = rolesForProfile(p, assignments).length;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all',
                        isSel
                          ? 'border-orange-500/55 bg-orange-50/90 shadow-md shadow-orange-500/10 ring-1 ring-orange-500/20 dark:border-orange-500/45 dark:bg-orange-950/35'
                          : 'border-zinc-200/90 bg-white/60 hover:border-zinc-300 hover:bg-white dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/70',
                      )}
                    >
                      <ProfileAvatar
                        photoUrl={resolveProfilePhoto(p, photoByEmail)}
                        gravatarEmail={primaryEmailForAvatar(p)}
                        name={p.displayName}
                        className="h-10 w-10 shrink-0 overflow-hidden rounded-xl"
                        fallbackClassName={cn(
                          'text-xs font-bold',
                          isSel
                            ? 'bg-orange-500 text-white'
                            : 'bg-gradient-to-br from-zinc-100 to-zinc-200/80 text-zinc-700 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-200',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                          {p.displayName}
                        </p>
                        <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                          {p.workEmail || p.personalEmail || p.subtitle || '—'}
                        </p>
                        {p.department && (
                          <p className="mt-0.5 truncate text-[10px] text-zinc-400">{p.department}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {rCount > 0 && (
                          <span className="flex items-center gap-0.5 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            <Shield className="h-3 w-3" aria-hidden />
                            {rCount} role{rCount === 1 ? '' : 's'}
                          </span>
                        )}
                        <span className="text-[10px] text-zinc-400">{p.fields.length} fields</span>
                      </div>
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="rounded-xl border border-dashed border-zinc-200 py-10 text-center dark:border-zinc-800">
                  <p className="text-sm text-zinc-500">No profiles match this search.</p>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>

        <Card className="flex h-full min-h-0 flex-col overflow-hidden border-zinc-200/90 shadow-sm dark:border-zinc-800/80">
          <CardHeader className="shrink-0 border-b border-zinc-100 pb-4 dark:border-zinc-800/80">
            <CardTitle className="text-base font-semibold text-zinc-900 dark:text-white">Profile</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4">
            {!selected ? (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900/30">
                <User className="h-10 w-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Select an employee</p>
                <p className="max-w-sm text-xs text-zinc-500">
                  Choose someone from the directory to view emails, org, RBAC roles, and all merged database
                  columns.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <ProfileAvatar
                    photoUrl={profilePhoto}
                    gravatarEmail={primary}
                    name={selected.displayName}
                    alt={selected.displayName}
                    className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-100 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
                    fallbackClassName="bg-gradient-to-br from-orange-500/20 to-zinc-200 text-xl font-bold text-zinc-700 dark:from-orange-500/15 dark:to-zinc-800 dark:text-zinc-200"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                      {selected.displayName}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {selected.department && (
                        <Badge variant="outline" className="font-normal">
                          {selected.department}
                        </Badge>
                      )}
                      {selected.organization && (
                        <Badge variant="outline" className="font-normal">
                          {selected.organization}
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-1.5 text-sm">
                      {selected.workEmail && (
                        <p className="flex items-start gap-2 text-zinc-700 dark:text-zinc-300">
                          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                          <span>
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                              Work
                            </span>
                            <br />
                            <span className="font-mono text-[13px]">{selected.workEmail}</span>
                          </span>
                        </p>
                      )}
                      {selected.personalEmail && (
                        <p className="flex items-start gap-2 text-zinc-700 dark:text-zinc-300">
                          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                          <span>
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                              Personal
                            </span>
                            <br />
                            <span className="font-mono text-[13px]">{selected.personalEmail}</span>
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <section className="space-y-2">
                  <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">
                    <Shield className="h-3.5 w-3.5 text-orange-500" aria-hidden />
                    Roles
                  </h3>
                  {profileRoles.length === 0 ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-500">No roles assigned for this email.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2" role="list">
                      {profileRoles.map((r) => (
                        <li key={r.id}>
                          <Badge
                            variant="outline"
                            className="border-orange-500/30 bg-orange-500/5 text-[11px] font-medium text-zinc-800 dark:text-zinc-200"
                          >
                            {ROLE_LABELS[r.role] ?? r.role}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-4">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">
                    Data from database
                  </h3>
                  {groupFields(selected.fields).map(({ category, rows }) => {
                    const meta = CATEGORY_META[category];
                    const Icon = meta.icon;
                    return (
                      <div key={category} className="overflow-hidden rounded-xl border border-zinc-200/90 dark:border-zinc-800/80">
                        <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/90 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
                          <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                          <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                            {meta.label}
                          </span>
                          <span className="ml-auto font-mono text-[10px] text-zinc-400">{rows.length}</span>
                        </div>
                        <dl className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                          {rows.map((f) => (
                            <div
                              key={`${category}-${f.key}`}
                              className="grid grid-cols-1 gap-0.5 px-3 py-2 sm:grid-cols-[minmax(0,34%)_1fr] sm:gap-3"
                            >
                              <dt className="break-words text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                                {f.key}
                              </dt>
                              <dd className="break-words font-mono text-[12px] text-zinc-900 dark:text-zinc-100">
                                {formatFieldValue(f.value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    );
                  })}
                </section>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
