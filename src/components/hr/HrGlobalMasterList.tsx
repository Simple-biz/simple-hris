'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sheet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import DeptFilter from './DeptFilter';

const PAGE_SIZE = 20;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function tenure(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return '—';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years -= 1; months += 12; }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return days <= 0 ? 'New' : `${days}d`;
}

type AddForm = {
  name: string;
  department: string;
  workEmail: string;
  personalEmail: string;
  startDate: string;
  location: string;
  phoneNumber: string;
};

const EMPTY_FORM: AddForm = {
  name: '',
  department: '',
  workEmail: '',
  personalEmail: '',
  startDate: '',
  location: '',
  phoneNumber: '',
};

export default function HrGlobalMasterList() {
  const [roster, setRoster] = useState<EmployeeRow[]>(
    () => getHrTabCache<EmployeeRow[]>(HR_TAB_CACHE_KEYS.globalMasterList) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList));
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [page, setPage] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);

  const fetchRoster = useCallback(async (mode: 'initial' | 'quiet' = 'quiet') => {
    if (mode === 'initial') setLoading(true);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as { employees?: EmployeeRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      const rows = json.employees ?? [];
      setRoster(rows);
      setHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList, rows);
    } catch (e) {
      if (mode === 'initial') toast.error(e instanceof Error ? e.message : 'Failed to load master list');
    } finally {
      if (mode === 'initial') setLoading(false);
    }
  }, []);

  // Cold load only — a warm cache (tab revisit) paints instantly; liveness is
  // maintained by the Realtime + poll below.
  useEffect(() => {
    if (hasHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList)) return;
    void fetchRoster('initial');
  }, [fetchRoster]);

  // Live data: Realtime on global_master_list when it's in the publication,
  // otherwise the 30s poll + tab-focus refresh keep the table fresh — so a Sheet
  // sync or an add made by another HR user shows up without a manual reload.
  useLiveRefresh({
    tables: ['global_master_list'],
    channel: 'hr-global-master-list',
    onRefresh: () => void fetchRoster('quiet'),
  });

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/cron/sync-master-from-sheet', { method: 'POST' });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        updated?: number;
        activeCount?: number | null;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Sync failed');
      const parts: string[] = [];
      if (typeof json.inserted === 'number') parts.push(`${json.inserted} added`);
      if (typeof json.updated === 'number') parts.push(`${json.updated} updated`);
      if (typeof json.activeCount === 'number') parts.push(`${json.activeCount} active`);
      toast.success(`Synced from Google Sheet${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      await fetchRoster('quiet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [fetchRoster]);

  const handleAdd = useCallback(async () => {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!form.workEmail.trim() && !form.personalEmail.trim()) {
      toast.error('Enter at least one email (work or personal)');
      return;
    }
    setAdding(true);
    try {
      const res = await fetch('/api/hr/global-master-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        sheetAppended?: boolean;
        sheetReason?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not add employee');
      toast.success(
        json.sheetAppended
          ? `${form.name.trim()} added — mirrored to the Google Sheet`
          : `${form.name.trim()} added to the master list${json.sheetReason ? ` (Sheet: ${json.sheetReason})` : ' (not written to the Sheet)'}`,
      );
      setForm(EMPTY_FORM);
      setAddOpen(false);
      await fetchRoster('quiet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add employee');
    } finally {
      setAdding(false);
    }
  }, [form, fetchRoster]);

  const filtered = useMemo(() => {
    setPage(0);
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (dept && (r.department ?? '').trim() !== dept) return false;
      if (!q) return true;
      return [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [roster, search, dept]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const setField = (k: keyof AddForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-6 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/90">
              <Sheet className="h-3 w-3 shrink-0" />
              HR &middot; Global Master List
            </div>
            <h1 className="mt-1 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              The synced roster, in one place.
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              Mirrors the Google Sheet master list. Pull the latest with{' '}
              <span className="font-semibold">Sync from Google Sheet</span>; anyone you{' '}
              <span className="font-semibold">Add</span> here is written straight back to the Sheet.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="gap-2 bg-white/15 text-white backdrop-blur-sm hover:bg-white/25"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? 'Syncing…' : 'Sync from Google Sheet'}
            </Button>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger
                render={<Button type="button" className="gap-2 bg-white text-emerald-800 hover:bg-emerald-50" />}
              >
                <Plus className="h-4 w-4" />
                Add employee
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add to the Global Master List</DialogTitle>
                  <DialogDescription>
                    Creates a roster row and mirrors it into the Google Sheet. Pay rates are set
                    separately in Accounting.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-2 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label htmlFor="gml-name" className="text-xs">Name <span className="text-red-500">*</span></Label>
                    <Input id="gml-name" value={form.name} onChange={setField('name')} placeholder="Full name" className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-dept" className="text-xs">Department</Label>
                    <Input id="gml-dept" value={form.department} onChange={setField('department')} placeholder="e.g. Lead Gen" className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-start" className="text-xs">Start date</Label>
                    <Input id="gml-start" type="date" value={form.startDate} onChange={setField('startDate')} className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-work" className="text-xs">Work email</Label>
                    <Input id="gml-work" type="email" value={form.workEmail} onChange={setField('workEmail')} placeholder="name@simple.biz" className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-personal" className="text-xs">Personal email</Label>
                    <Input id="gml-personal" type="email" value={form.personalEmail} onChange={setField('personalEmail')} placeholder="name@gmail.com" className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-location" className="text-xs">Location</Label>
                    <Input id="gml-location" value={form.location} onChange={setField('location')} placeholder="City / province" className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="gml-phone" className="text-xs">Contact number</Label>
                    <Input id="gml-phone" value={form.phoneNumber} onChange={setField('phoneNumber')} placeholder="+63…" className="mt-1" />
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  At least one email is required. Identity is keyed on (Personal Email, Department) —
                  a work email already in use by an active employee is rejected.
                </p>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={adding}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={handleAdd} disabled={adding} className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700">
                    {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {adding ? 'Adding…' : 'Add & mirror to Sheet'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      {/* Table */}
      <Card className="border-zinc-100 shadow-sm dark:border-zinc-800">
        <CardHeader className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <CardTitle className="text-sm font-semibold">Active roster</CardTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {loading ? 'Loading…' : `${filtered.length} of ${roster.length} shown`}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <DeptFilter rows={roster} getDept={(r) => r.department} value={dept} onChange={setDept} />
              <div className="relative w-full sm:w-48 sm:shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, ID…"
                  className="h-9 border-zinc-200 pl-8 text-xs dark:border-zinc-700"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-zinc-400">
              {roster.length === 0
                ? 'No active employees. Click “Sync from Google Sheet” to pull the master list.'
                : 'No rows match your search.'}
            </p>
          ) : (
            <>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-100 bg-zinc-50/90 text-[11px] font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5">Employee ID</th>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Dept</th>
                    <th className="px-4 py-2.5">Work email</th>
                    <th className="px-4 py-2.5">Personal email</th>
                    <th className="px-4 py-2.5">Start date</th>
                    <th className="px-4 py-2.5">Tenure</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/60">
                  {pageRows.map((r, i) => (
                    <tr
                      key={`${r.work_email ?? r.personal_email ?? r.employee_id ?? i}`}
                      className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30"
                    >
                      <td data-label="Employee ID" className="px-4 py-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{r.employee_id ?? '—'}</td>
                      <td data-label="Name" className="px-4 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.name ?? '—'}</td>
                      <td data-label="Dept" className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.department ?? '—'}</td>
                      <td data-label="Work email" className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.work_email ?? '—'}</td>
                      <td data-label="Personal email" className="px-4 py-2 font-mono text-zinc-500 dark:text-zinc-400">{r.personal_email ?? '—'}</td>
                      <td data-label="Start date" className="px-4 py-2 text-zinc-400">{fmtDate(r.start_date)}</td>
                      <td data-label="Tenure" className="px-4 py-2 tabular-nums text-zinc-400">{tenure(r.start_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                <p className="text-[11px] text-zinc-400">
                  {filtered.length === 0
                    ? '0'
                    : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}`}{' '}
                  of {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)}>
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">
                    {safePage + 1} / {totalPages}
                  </span>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
