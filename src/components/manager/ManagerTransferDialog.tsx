'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Loader2, Search, UserRound, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';

interface Candidate {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Departments the requesting manager can pull people INTO. */
  myDepartments: string[];
  /** Called after a request is successfully raised. */
  onSubmitted?: () => void;
}

/** Local YYYY-MM-DD (for the date input default + min). */
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * "Request transfer in" — the receiving manager searches the Global Master List
 * for a person in another department, proposes an effective date, and sends the
 * request to that person's current manager to release or decline.
 */
export default function ManagerTransferDialog({ open, onOpenChange, myDepartments, onSubmitted }: Props) {
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [toDept, setToDept] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const soleDept = myDepartments.length === 1 ? myDepartments[0] : '';

  // Reset on open; default the target dept when the manager owns exactly one.
  useEffect(() => {
    if (open) {
      setQuery('');
      setDeptFilter('');
      setSelected(null);
      setToDept(soleDept);
      setEffectiveDate(todayLocal());
      setReason('');
    }
  }, [open, soleDept]);

  // Fetch candidates (debounced) whenever the dialog is open and the query or
  // department filter changes. The server also returns the full department list
  // so the filter dropdown is populated regardless of the active narrowing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      setLoadingCandidates(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (deptFilter) params.set('department', deptFilter);
      fetch(`/api/manager/transfer-candidates?${params.toString()}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { people?: Candidate[]; departments?: string[] }) => {
          if (cancelled) return;
          setCandidates(j.people ?? []);
          if (j.departments) setDepartments(j.departments);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingCandidates(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, deptFilter]);

  const currentDept = selected?.department?.trim() ?? '';

  const targetOptions = useMemo(
    () => myDepartments.filter((d) => d.toLowerCase() !== currentDept.toLowerCase()),
    [myDepartments, currentDept],
  );

  const canSubmit =
    !!selected &&
    !!toDept &&
    toDept.toLowerCase() !== currentDept.toLowerCase() &&
    !!effectiveDate &&
    !submitting;

  const searchRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = async () => {
    if (!selected || !toDept || !effectiveDate) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/department-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_name: selected.name,
          employee_work_email: selected.work_email,
          employee_personal_email: selected.personal_email,
          from_department: currentDept,
          to_department: toDept,
          proposed_effective_date: effectiveDate,
          reason: reason.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success(`Release request sent to ${currentDept || 'the current'} manager`);
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send transfer request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request transfer in</DialogTitle>
          <DialogDescription>
            Pick someone from another department. Their current manager must release them before the
            move takes effect on your chosen date.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Person picker */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Who do you want?
            </label>
            {selected ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2 dark:border-blue-950/50 dark:bg-blue-950/20">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {selected.name}
                  </div>
                  <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {selected.department || 'No department'}
                    {selected.work_email ? ` · ${selected.work_email}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                    <input
                      ref={searchRef}
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by name or work email"
                      className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                  <SmoothSelect
                    aria-label="Filter by department"
                    value={deptFilter}
                    onChange={(v) => setDeptFilter(v)}
                    triggerClassName="w-[42%] shrink-0"
                    searchable
                    searchPlaceholder="Search departments…"
                    options={[
                      { value: '', label: `All departments${departments.length ? ` (${departments.length})` : ''}` },
                      ...departments.map((d) => ({ value: d, label: d })),
                    ]}
                  />
                </div>
                <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
                  {loadingCandidates ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading…
                    </div>
                  ) : candidates.length === 0 ? (
                    <div className="py-6 text-center text-xs text-zinc-400">No people found.</div>
                  ) : (
                    candidates.map((c, i) => (
                      <button
                        key={`${c.work_email ?? c.personal_email ?? c.name}-${i}`}
                        type="button"
                        onClick={() => setSelected(c)}
                        className="flex w-full items-center gap-2.5 border-b border-zinc-50 px-3 py-2 text-left last:border-0 hover:bg-blue-50/60 dark:border-zinc-800/60 dark:hover:bg-blue-950/20"
                      >
                        <UserRound className="h-4 w-4 shrink-0 text-zinc-400" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            {c.name}
                          </span>
                          <span className="block truncate text-[11px] text-zinc-400">
                            {c.department || 'No department'}
                            {c.work_email ? ` · ${c.work_email}` : ''}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* current -> target preview */}
          {selected && (
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-md bg-white px-2 py-0.5 font-medium text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700">
                {currentDept || 'No department'}
              </span>
              <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
              <span
                className={cn(
                  toDept
                    ? 'rounded-md bg-blue-600 px-2 py-0.5 font-semibold text-white'
                    : 'rounded-md bg-white px-2 py-0.5 font-medium text-zinc-400 ring-1 ring-dashed ring-zinc-300 dark:bg-zinc-900 dark:ring-zinc-700',
                )}
              >
                {toDept || 'Select target'}
              </span>
            </div>
          )}

          {/* Target department (only when the manager owns more than one) */}
          {myDepartments.length > 1 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Transfer into
              </label>
              <SmoothSelect
                aria-label="Transfer into department"
                value={toDept}
                onChange={(v) => setToDept(v)}
                triggerClassName="w-full"
                options={[
                  { value: '', label: 'Select a department' },
                  ...targetOptions.map((d) => ({ value: d, label: d })),
                ]}
              />
            </div>
          )}

          {/* Effective date */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              <CalendarClock className="h-3.5 w-3.5" />
              Proposed effective date
            </label>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <p className="mt-1 text-[11px] text-zinc-400">
              Defaults to today. A <strong>past</strong> date is allowed for a backdated transfer — the
              rate change Accounting sets will prorate retroactively from it.
            </p>
          </div>

          {/* Reason */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Reason <span className="text-zinc-400">(optional)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Why do you need this person?"
              className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
