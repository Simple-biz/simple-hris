'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarHeart,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { PabDayDisputeRow } from '@/lib/supabase/pab-day-disputes';

const PAGE_SIZE = 15;
const ADMIN_NAME = 'Fran M';

type EmployeeOption = {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
};

export default function OrphanageVisits() {
  const [visits, setVisits] = useState<PabDayDisputeRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const [formEmail, setFormEmail] = useState('');
  const [formDate, setFormDate] = useState('');
  const [formNote, setFormNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [empQuery, setEmpQuery] = useState('');
  const [empFocused, setEmpFocused] = useState(false);
  const empBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (empBoxRef.current && !empBoxRef.current.contains(e.target as Node)) {
        setEmpFocused(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const [deleteDialog, setDeleteDialog] = useState<PabDayDisputeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchVisits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/pab-disputes/orphanage-visits', { cache: 'no-store' });
      const json = await res.json();
      setVisits(json.rows ?? []);
    } catch {
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchVisits(); }, [fetchVisits]);

  useEffect(() => {
    fetch('/api/employees', { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { employees?: EmployeeOption[] }) => {
        setEmployees(Array.isArray(json.employees) ? json.employees : []);
      })
      .catch(() => setEmployees([]));
  }, []);

  const employeeByEmail = useMemo(() => {
    const map = new Map<string, EmployeeOption>();
    for (const e of employees) {
      const key = (e.work_email ?? e.personal_email ?? '').toLowerCase();
      if (key) map.set(key, e);
    }
    return map;
  }, [employees]);

  const displayNameFor = useCallback((email: string) => {
    const hit = employeeByEmail.get(email.toLowerCase());
    return hit?.name ?? email;
  }, [employeeByEmail]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return visits;
    return visits.filter(v => {
      const name = displayNameFor(v.work_email).toLowerCase();
      const blob = [name, v.work_email, v.dispute_date, v.decision_note ?? ''].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [visits, searchQuery, displayNameFor]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [searchQuery]);

  const handleSubmit = useCallback(async () => {
    const email = formEmail.trim().toLowerCase();
    if (!email) { toast.error('Select an employee'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formDate)) { toast.error('Pick a valid visit date'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/pab-disputes/orphanage-visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email,
          visit_date: formDate,
          note: formNote.trim() || null,
          admin_name: ADMIN_NAME,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('Orphanage visit recorded');
      setFormEmail('');
      setFormDate('');
      setFormNote('');
      fetchVisits();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save visit');
    } finally {
      setSubmitting(false);
    }
  }, [formEmail, formDate, formNote, fetchVisits]);

  const handleDelete = useCallback(async () => {
    if (!deleteDialog) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/pab-disputes/orphanage-visits/${deleteDialog.id}?admin_name=${encodeURIComponent(ADMIN_NAME)}`,
        { method: 'DELETE' },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('Visit removed');
      setDeleteDialog(null);
      fetchVisits();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove visit');
    } finally {
      setDeleting(false);
    }
  }, [deleteDialog, fetchVisits]);

  const employeeOptions = useMemo(() => {
    return employees
      .filter(e => e.work_email || e.personal_email)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [employees]);

  const empResults = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return employeeOptions.slice(0, 8);
    return employeeOptions
      .filter(e => {
        const blob = [e.name ?? '', e.work_email ?? '', e.personal_email ?? '', e.department ?? '']
          .join(' ')
          .toLowerCase();
        return blob.includes(q);
      })
      .slice(0, 8);
  }, [employeeOptions, empQuery]);

  const selectEmployee = useCallback((email: string, name: string | null) => {
    setFormEmail(email);
    setEmpQuery(name ? `${name} · ${email}` : email);
    setEmpFocused(false);
  }, []);

  const clearEmployee = useCallback(() => {
    setFormEmail('');
    setEmpQuery('');
    setEmpFocused(true);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
            <CalendarHeart className="h-5 w-5 text-rose-500" />
            Orphanage Visits
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Record employee orphanage-visit dates. PAB forgives the visit day and the day after (4h floor) automatically.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchVisits} disabled={loading} className="shrink-0">
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Add-visit form */}
      <Card className="shrink-0 border-rose-200/70 bg-rose-50/40 dark:border-rose-900/40 dark:bg-rose-950/10">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="visit-employee" className="text-xs text-zinc-600 dark:text-zinc-400">Employee</Label>
            <div className="relative" ref={empBoxRef}>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <Input
                id="visit-employee"
                autoComplete="off"
                placeholder="Search by name, email, or department…"
                value={empQuery}
                onChange={e => {
                  setEmpQuery(e.target.value);
                  if (formEmail) setFormEmail('');
                  setEmpFocused(true);
                }}
                onFocus={() => setEmpFocused(true)}
                className="h-9 border-zinc-200 bg-white pl-9 pr-8 text-sm text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
              />
              {empQuery && (
                <button
                  type="button"
                  onClick={clearEmployee}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                  aria-label="Clear"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {empFocused && !formEmail && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  {empResults.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-zinc-500">
                      No employees match.
                    </div>
                  ) : (
                    empResults.map(e => {
                      const email = (e.work_email ?? e.personal_email ?? '').toLowerCase();
                      return (
                        <button
                          key={email}
                          type="button"
                          onMouseDown={(ev) => ev.preventDefault()}
                          onClick={() => selectEmployee(email, e.name ?? null)}
                          className="flex w-full flex-col px-3 py-2 text-left text-xs transition-colors hover:bg-rose-50 dark:hover:bg-rose-950/30"
                        >
                          <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
                            {e.name ?? email}
                          </span>
                          <span className="truncate text-[10px] text-zinc-500">
                            {email}{e.department ? ` · ${e.department}` : ''}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="w-full space-y-1.5 sm:w-44">
            <Label htmlFor="visit-date" className="text-xs text-zinc-600 dark:text-zinc-400">Visit date</Label>
            <Input
              id="visit-date"
              type="date"
              value={formDate}
              onChange={e => setFormDate(e.target.value)}
              className="h-9 border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="visit-note" className="text-xs text-zinc-600 dark:text-zinc-400">Note (optional)</Label>
            <Input
              id="visit-note"
              value={formNote}
              onChange={e => setFormNote(e.target.value)}
              placeholder="Optional note…"
              className="h-9 border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
            />
          </div>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || !formEmail || !formDate}
            className="h-9 shrink-0 bg-rose-600 hover:bg-rose-700"
          >
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            Add visit
          </Button>
        </CardContent>
      </Card>

      {/* Search */}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
        <div className="max-w-md flex-1 space-y-1.5">
          <Label htmlFor="visit-search" className="text-xs text-zinc-600 dark:text-zinc-500">Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              id="visit-search"
              placeholder="Name, email, date…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
            />
          </div>
        </div>
        <div className="text-xs text-zinc-500 sm:ml-auto">
          Total: <span className="font-mono text-zinc-700 dark:text-zinc-300">{visits.length}</span>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading visits…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <CalendarHeart className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">
            {visits.length === 0 ? 'No orphanage visits recorded yet.' : 'No visits match your filters.'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="flex shrink-0 items-center justify-between text-xs text-zinc-600 dark:text-zinc-500">
            <span>
              Showing <span className="font-mono">{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}</span> of <span className="font-mono">{filtered.length}</span>
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-8" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <span className="px-2 font-mono">{safePage} / {totalPages}</span>
              <Button variant="outline" size="sm" className="h-8" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
                <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Employee</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Email</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Visit date</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Note</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Recorded by</TableHead>
                  <TableHead className="w-[80px] text-right text-zinc-600 dark:text-zinc-400">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map(v => (
                  <TableRow key={v.id} className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40">
                    <TableCell className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{displayNameFor(v.work_email)}</TableCell>
                    <TableCell className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{v.work_email}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-zinc-700 dark:text-zinc-300">{v.dispute_date}</TableCell>
                    <TableCell className="max-w-[240px] truncate text-xs text-zinc-600 dark:text-zinc-400" title={v.decision_note ?? ''}>
                      {v.decision_note || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-zinc-500 dark:text-zinc-400">{v.decided_by ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-400"
                        onClick={() => setDeleteDialog(v)}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Confirm delete */}
      {deleteDialog && (
        <Dialog open onOpenChange={() => setDeleteDialog(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Remove orphanage visit</DialogTitle>
              <DialogDescription className="text-xs">
                {displayNameFor(deleteDialog.work_email)} — {deleteDialog.dispute_date}.
                This reverts PAB forgiveness for the visit day and the following day.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteDialog(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                className="bg-rose-600 hover:bg-rose-700"
              >
                {deleting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
