'use client';

/**
 * Manager-side bulk-create dialog for Orphanage Visit / CEO Visitation disputes.
 * Used by both Alyson (Orphanage view) and Carla (Accounting view) — the server function
 * `createOrphanageManagerSubmittedDispute` checks the actor's role and tags the audit
 * log accordingly. Submitted rows land at `orphanage_manager_approved` so Carla can give
 * the final Accounting decision in one click.
 *
 * Layout: two columns. Left = reason / people / note. Right = PAB-style calendar with
 * month nav and red/green cells driven by the selected employees' aggregated Hubstaff
 * hours. Click cells to multi-select dates; submit creates N people × M dates rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { normEmail } from '@/lib/email/norm-email';
import {
  buildPabCalendarWeeks,
  getCurrentPabMonth,
  getPabMonthRange,
  type PabCalendarDay,
} from '@/lib/hubstaff/calendar-column-dedupe';
import {
  fetchHoursByEmployee,
  type HubstaffHoursByEmployee,
} from '@/lib/hubstaff/fetch-hours-by-employee';
import {
  fetchOrphanageOverlap,
  type DisputesByEmployee,
} from '@/lib/pab-disputes/fetch-orphanage-overlap';
import {
  disputeGrantsPabForgiveness,
  disputeIsAwaitingResolution,
  disputeIsFinallyDenied,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';

export type EmployeeOption = {
  id: string;
  displayName: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  suspended: boolean;
};

type ReasonChoice = 'orphanage_visit' | 'ceo_visitation';

const REASON_OPTIONS: { code: ReasonChoice; label: string }[] = [
  { code: 'orphanage_visit', label: 'Orphanage Visit' },
  { code: 'ceo_visitation', label: 'CEO Visitation & Accommodation' },
];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export type CreateOrphanageStyleDisputeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful submit so the parent can refresh its queue. */
  onSubmitSuccess?: () => void;
  /** Default reason when the dialog opens. */
  defaultReason?: ReasonChoice;
  /**
   * Optional pre-fetched employee list. When provided, the dialog skips its own
   * `/api/employee-rate-profiles/summary` call and renders instantly. Pass this
   * from a parent that already loads the roster (Rates-style summary endpoint
   * is slow — keeping the data warm in the parent eliminates open-time lag).
   */
  employees?: EmployeeOption[];
  employeesLoading?: boolean;
  /**
   * Optional pre-fetched Hubstaff hours by employee. Same idea as `employees`:
   * fetching + parsing all source files takes seconds, so parents should warm
   * this on mount and pass it in. Falls back to an internal fetch if absent.
   */
  hoursByEmployee?: HubstaffHoursByEmployee;
  hoursLoading?: boolean;
  /**
   * Optional pre-fetched orphanage-style disputes by employee. Drives the calendar's
   * already-forgiven (green) / pending (amber) / denied (red-disabled) cell coloring,
   * and prevents the user from re-picking a day that already has a dispute on file.
   */
  disputesByEmployee?: DisputesByEmployee;
  disputesLoading?: boolean;
};

export default function CreateOrphanageStyleDisputeDialog({
  open,
  onOpenChange,
  onSubmitSuccess,
  defaultReason = 'orphanage_visit',
  employees: externalEmployees,
  employeesLoading: externalLoading,
  hoursByEmployee: externalHoursByEmployee,
  hoursLoading: externalHoursLoading,
  disputesByEmployee: externalDisputesByEmployee,
  disputesLoading: externalDisputesLoading,
}: CreateOrphanageStyleDisputeDialogProps) {
  const [reason, setReason] = useState<ReasonChoice>(defaultReason);
  const [explanation, setExplanation] = useState('');
  const [internalEmployees, setInternalEmployees] = useState<EmployeeOption[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const employees = externalEmployees ?? internalEmployees;
  const employeesLoading = externalLoading ?? internalLoading;
  /** Insertion-ordered list of normalized work-emails. Determines chip order + activePerson default. */
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  /** Per-person forgiven dates: email → Set&lt;ISO YYYY-MM-DD&gt;. Each person picks their own days. */
  const [perPersonDates, setPerPersonDates] = useState<Map<string, Set<string>>>(new Map());
  /** Which person's calendar is currently being edited. Null when no one is selected. */
  const [activePerson, setActivePerson] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Calendar nav state — defaults to the current PAB month.
  const initPab = useMemo(() => getCurrentPabMonth(), []);
  const [viewYear, setViewYear] = useState(initPab.year);
  const [viewMonth, setViewMonth] = useState(initPab.month);

  // Hubstaff data: emailNorm → (dayKey → seconds). Source = parent prop OR internal fetch.
  const [internalHoursByEmployee, setInternalHoursByEmployee] = useState<HubstaffHoursByEmployee>(new Map());
  const [internalHoursLoading, setInternalHoursLoading] = useState(false);
  const hoursByEmployee = externalHoursByEmployee ?? internalHoursByEmployee;
  const hubstaffLoading = externalHoursLoading ?? internalHoursLoading;

  // Orphanage-style disputes already on file: emailNorm → (dispute_date → row).
  // Drives "already forgiven" / "pending" cell states.
  const [internalDisputesByEmployee, setInternalDisputesByEmployee] = useState<DisputesByEmployee>(new Map());
  const [internalDisputesLoading, setInternalDisputesLoading] = useState(false);
  const disputesByEmployee = externalDisputesByEmployee ?? internalDisputesByEmployee;
  const disputesLoading = externalDisputesLoading ?? internalDisputesLoading;

  // Reset form each time the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setReason(defaultReason);
    setExplanation('');
    setSelectedEmployees([]);
    setPerPersonDates(new Map());
    setActivePerson(null);
    setSearch('');
    setViewYear(initPab.year);
    setViewMonth(initPab.month);
  }, [open, defaultReason, initPab]);

  // Fallback fetch — only fires when the parent didn't pre-load the roster.
  useEffect(() => {
    if (!open) return;
    if (externalEmployees) return;
    if (internalEmployees.length > 0 || internalLoading) return;
    let cancelled = false;
    setInternalLoading(true);
    fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { profiles?: EmployeeOption[] }) => {
        if (cancelled) return;
        const active = (json.profiles ?? []).filter((p) => !p.suspended);
        setInternalEmployees(active);
      })
      .catch(() => {
        if (!cancelled) setInternalEmployees([]);
      })
      .finally(() => {
        if (!cancelled) setInternalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, externalEmployees, internalEmployees.length, internalLoading]);

  // Fallback Hubstaff fetch — only runs when the parent didn't pre-warm via `hoursByEmployee` prop.
  // Parents (OrphanageApp, OrphanageVisits) call `fetchHoursByEmployee` on mount so the dialog
  // is instant; this exists for any caller that doesn't bother.
  useEffect(() => {
    if (!open) return;
    if (externalHoursByEmployee) return;
    if (internalHoursByEmployee.size > 0 || internalHoursLoading) return;
    const ac = new AbortController();
    setInternalHoursLoading(true);
    fetchHoursByEmployee({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setInternalHoursByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setInternalHoursLoading(false);
      });
    return () => ac.abort();
  }, [open, externalHoursByEmployee, internalHoursByEmployee.size, internalHoursLoading]);

  // Fallback orphanage-overlap fetch — same pattern as the hours fallback.
  useEffect(() => {
    if (!open) return;
    if (externalDisputesByEmployee) return;
    if (internalDisputesByEmployee.size > 0 || internalDisputesLoading) return;
    const ac = new AbortController();
    setInternalDisputesLoading(true);
    fetchOrphanageOverlap({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setInternalDisputesByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setInternalDisputesLoading(false);
      });
    return () => ac.abort();
  }, [open, externalDisputesByEmployee, internalDisputesByEmployee.size, internalDisputesLoading]);

  /** Map of normalized work email → option, used to render chip labels by name. */
  const employeesByEmail = useMemo(() => {
    const map = new Map<string, EmployeeOption>();
    for (const e of employees) {
      const we = normEmail(e.workEmail);
      const pe = normEmail(e.personalEmail);
      if (we) map.set(we, e);
      if (pe && !map.has(pe)) map.set(pe, e);
    }
    return map;
  }, [employees]);

  const selectedEmployeesSet = useMemo(() => new Set(selectedEmployees), [selectedEmployees]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return employees.filter((e) => {
        const we = normEmail(e.workEmail);
        return !!we && !selectedEmployeesSet.has(we);
      });
    }
    return employees.filter((e) => {
      const we = normEmail(e.workEmail) ?? '';
      if (selectedEmployeesSet.has(we)) return false;
      const haystack = `${e.displayName ?? ''} ${e.workEmail ?? ''} ${e.personalEmail ?? ''} ${e.department ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [employees, search, selectedEmployeesSet]);

  const handleAdd = useCallback((email: string) => {
    const we = normEmail(email);
    if (!we) return;
    setSelectedEmployees((prev) => (prev.includes(we) ? prev : [...prev, we]));
    // Always promote the newly-added person to active so the calendar swaps to their
    // hours immediately — saves the user a chip click to see what red days they have.
    setActivePerson(we);
    setSearch('');
    searchInputRef.current?.focus();
  }, []);

  const handleRemoveEmployee = useCallback((email: string) => {
    setSelectedEmployees((prev) => prev.filter((e) => e !== email));
    setPerPersonDates((prev) => {
      if (!prev.has(email)) return prev;
      const next = new Map(prev);
      next.delete(email);
      return next;
    });
    setActivePerson((prev) => {
      if (prev !== email) return prev;
      // Pick the next remaining person, if any.
      return null;
    });
  }, []);

  // When activePerson becomes null but we still have selected people, pick the first one.
  useEffect(() => {
    if (activePerson === null && selectedEmployees.length > 0) {
      setActivePerson(selectedEmployees[0]);
    }
  }, [activePerson, selectedEmployees]);

  /**
   * Hours map for the calendar — driven by the **active person** only. Each person picks
   * their own forgiveness days, so the calendar shows one person at a time.
   */
  const activePersonHoursByDateKey = useMemo(() => {
    if (!activePerson) return new Map<string, number>();
    return hoursByEmployee.get(activePerson) ?? new Map<string, number>();
  }, [activePerson, hoursByEmployee]);

  /**
   * Existing-disputes map for the active person. Drives the cell colors (green for already
   * forgiven, amber for pending stages, red+disabled for denied) so the user can SEE that
   * a day is already on file before clicking — and prevents the "already on file" submit
   * error from ever firing in the happy path.
   */
  const activePersonExistingDisputes = useMemo<Map<string, PabDayDisputeRow>>(() => {
    if (!activePerson) return new Map();
    return disputesByEmployee.get(activePerson) ?? new Map();
  }, [activePerson, disputesByEmployee]);

  /** PAB month range (first Mon on/after the 1st → Friday of last in-month week — same as EmployeePabCalendar). */
  const pabRange = useMemo(() => getPabMonthRange(viewYear, viewMonth), [viewYear, viewMonth]);

  const calendar = useMemo<PabCalendarDay[][] | null>(() => {
    const weeks = buildPabCalendarWeeks(pabRange.start, pabRange.end, activePersonHoursByDateKey);
    return weeks.length > 0 ? weeks : null;
  }, [pabRange, activePersonHoursByDateKey]);

  const goPrevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m <= 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goNextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m >= 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  /** Toggle a date for the active person only. Other people's selections are untouched. */
  const toggleDate = useCallback((iso: string) => {
    if (!activePerson) return;
    setPerPersonDates((prev) => {
      const next = new Map(prev);
      const current = next.get(activePerson) ?? new Set<string>();
      const updated = new Set(current);
      if (updated.has(iso)) updated.delete(iso);
      else updated.add(iso);
      if (updated.size === 0) next.delete(activePerson);
      else next.set(activePerson, updated);
      return next;
    });
  }, [activePerson]);

  /** Set of ISO dates picked for the active person — used to render the calendar's "picked" state. */
  const activePersonDates = useMemo<Set<string>>(() => {
    if (!activePerson) return new Set();
    return perPersonDates.get(activePerson) ?? new Set();
  }, [activePerson, perPersonDates]);

  /** Total disputes = sum of dates each selected person has picked. */
  const totalDisputes = useMemo(() => {
    let total = 0;
    for (const em of selectedEmployees) {
      total += perPersonDates.get(em)?.size ?? 0;
    }
    return total;
  }, [selectedEmployees, perPersonDates]);

  const canSubmit = totalDisputes > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const note = explanation.trim() || null;
      // Group selections by DATE so we can send one POST per (date, [people who picked it]).
      // Each person can have a different set of dates — pivoting keeps the API contract simple.
      const peopleByDate = new Map<string, string[]>();
      for (const em of selectedEmployees) {
        const dates = perPersonDates.get(em);
        if (!dates) continue;
        for (const d of dates) {
          if (!peopleByDate.has(d)) peopleByDate.set(d, []);
          peopleByDate.get(d)!.push(em);
        }
      }
      const responses = await Promise.all(
        [...peopleByDate.entries()].map(([d, people]) =>
          fetch('/api/pab-disputes/orphanage-manager-submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reason,
              dispute_date: d,
              employee_emails: people,
              explanation: note,
            }),
          })
            .then(async (res) => {
              const json = (await res.json()) as {
                created?: { id: string; work_email: string }[];
                skipped?: { work_email: string; reason: string }[];
                errors?: { work_email: string; error: string }[];
                error?: string;
              };
              return { ok: res.ok, json };
            })
            .catch((e) => ({
              ok: false,
              json: { error: e instanceof Error ? e.message : 'Network error' } as { error: string },
            })),
        ),
      );

      let createdCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      let topError: string | null = null;
      for (const r of responses) {
        const j = r.json as {
          created?: { id: string; work_email: string }[];
          skipped?: { work_email: string; reason: string }[];
          errors?: { work_email: string; error: string }[];
          error?: string;
        };
        createdCount += j.created?.length ?? 0;
        skippedCount += j.skipped?.length ?? 0;
        errorCount += j.errors?.length ?? 0;
        if (!r.ok && !topError) topError = j.error ?? 'Failed';
      }

      if (createdCount > 0) {
        const desc: string[] = [];
        if (skippedCount > 0) desc.push(`${skippedCount} skipped (already on file)`);
        if (errorCount > 0) desc.push(`${errorCount} failed`);
        toast.success(
          `${createdCount} ${createdCount === 1 ? 'dispute' : 'disputes'} sent to Accounting`,
          desc.length > 0 ? { description: desc.join(' · ') } : undefined,
        );
        onSubmitSuccess?.();
        onOpenChange(false);
      } else if (skippedCount > 0 && errorCount === 0 && !topError) {
        toast.warning(`${skippedCount} already on file — nothing new to create`);
      } else {
        toast.error(topError ?? 'No disputes created');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, reason, perPersonDates, selectedEmployees, explanation, onSubmitSuccess, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[95vw] max-w-[1200px] overflow-y-auto sm:!max-w-[1200px]">
        <DialogHeader>
          <DialogTitle>Create disputes</DialogTitle>
          <DialogDescription>
            Pick the people involved, then click the days they should be forgiven. Each row goes to
            Accounting for final approval. Hours stay as logged — the day flips green only after Accounting
            approves.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── Left: form fields ── */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="create-reason" className="text-xs">Reason</Label>
              <select
                id="create-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as ReasonChoice)}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 pr-8 text-xs text-zinc-700 transition-colors focus:border-pink-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-pink-400"
              >
                {REASON_OPTIONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">People involved</Label>
              <p className="text-[10px] leading-snug text-zinc-500 dark:text-zinc-500">
                Each person picks their own forgiven days. <span className="font-medium">Click a chip</span> to switch the calendar to that person.
              </p>
              <div className="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
                {selectedEmployees.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {selectedEmployees.map((email) => {
                      const opt = employeesByEmail.get(email);
                      const label = opt?.displayName?.trim() || email;
                      const dateCount = perPersonDates.get(email)?.size ?? 0;
                      const isActive = activePerson === email;
                      return (
                        <button
                          key={email}
                          type="button"
                          onClick={() => setActivePerson(email)}
                          disabled={submitting}
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-all ${
                            isActive
                              ? 'border-pink-500 bg-pink-100 text-pink-900 shadow-sm ring-2 ring-pink-300/40 dark:border-pink-400 dark:bg-pink-950/60 dark:text-pink-100 dark:ring-pink-500/30'
                              : 'border-pink-200 bg-pink-50 text-pink-700 hover:border-pink-300 hover:bg-pink-100 dark:border-pink-800/60 dark:bg-pink-950/40 dark:text-pink-300 dark:hover:bg-pink-950/60'
                          } disabled:cursor-not-allowed disabled:opacity-60`}
                        >
                          <span className="max-w-[10rem] truncate">{label}</span>
                          <span
                            className={`rounded-full px-1.5 font-mono text-[9px] tabular-nums ${
                              dateCount > 0
                                ? 'bg-pink-600 text-white dark:bg-pink-500'
                                : 'bg-pink-200 text-pink-700 dark:bg-pink-800 dark:text-pink-200'
                            }`}
                            title={`${dateCount} ${dateCount === 1 ? 'day' : 'days'} picked`}
                          >
                            {dateCount}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveEmployee(email);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRemoveEmployee(email);
                              }
                            }}
                            aria-label={`Remove ${label}`}
                            className="ml-0.5 inline-flex rounded-full p-0.5 hover:bg-pink-200/50 dark:hover:bg-pink-900/50"
                          >
                            <X className="h-3 w-3" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <Input
                    ref={searchInputRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={selectedEmployees.length === 0 ? '+ add person...' : 'Search to add another...'}
                    className="h-8 pl-8 text-xs"
                    disabled={submitting || employeesLoading}
                  />
                </div>
                {employeesLoading ? (
                  <div className="mt-2 flex items-center gap-2 px-1 py-1 text-[11px] text-zinc-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading employees…
                  </div>
                ) : search.trim().length > 0 ? (
                  <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-zinc-100 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-950/30">
                    {filteredEmployees.length === 0 ? (
                      <p className="px-2 py-2 text-[11px] text-zinc-400">No matches.</p>
                    ) : (
                      filteredEmployees.slice(0, 30).map((e) => {
                        const we = normEmail(e.workEmail);
                        if (!we) return null;
                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => handleAdd(we)}
                            className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-pink-50 dark:hover:bg-pink-950/30"
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
                                {e.displayName?.trim() || we}
                              </span>
                              {e.department ? (
                                <span className="truncate text-[9px] text-zinc-500">{e.department}</span>
                              ) : null}
                            </span>
                            <span className="truncate font-mono text-[10px] text-zinc-500">{we}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
              <p className="text-[10px] text-zinc-400">
                {selectedEmployees.length === 0
                  ? 'Type to search by name, email, or department.'
                  : `${selectedEmployees.length} ${selectedEmployees.length === 1 ? 'person' : 'people'} selected.`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="create-note" className="text-xs">
                Note <span className="text-zinc-400">(optional — visible to Accounting)</span>
              </Label>
              <textarea
                id="create-note"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                rows={3}
                disabled={submitting}
                placeholder="e.g., Travelled with Bob Apr 13–14, dinner with leadership Apr 14"
                className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 transition-colors focus:border-pink-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-pink-400"
              />
            </div>
          </div>

          {/* ── Right: PAB-style calendar ── */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Forgiven days</Label>
              {hubstaffLoading || disputesLoading ? (
                <span className="flex items-center gap-1 text-[10px] text-zinc-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {hubstaffLoading && disputesLoading
                    ? 'loading hours + disputes…'
                    : hubstaffLoading
                      ? 'loading hours…'
                      : 'loading disputes…'}
                </span>
              ) : null}
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={goPrevMonth}
                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                  {MONTH_NAMES[viewMonth]} <span className="font-mono tabular-nums">{viewYear}</span>
                </span>
                <button
                  type="button"
                  onClick={goNextMonth}
                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  aria-label="Next month"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {/* Day headers — Mon–Fri, matches EmployeePabCalendar */}
              <div className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] gap-1">
                <div />
                {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
                  <div key={i} className="text-center text-[8px] font-semibold text-zinc-400 dark:text-zinc-500">
                    {d}
                  </div>
                ))}
              </div>

              {/* Week rows — week-number column + 5 Mon–Fri cells */}
              {calendar?.map((week, wi) => (
                <div
                  key={wi}
                  className="mb-1 grid grid-cols-[1.5rem_repeat(5,1fr)] items-stretch gap-1"
                >
                  <div className="flex items-center justify-end text-[8px] font-medium text-zinc-400 dark:text-zinc-500">
                    {wi + 1}
                  </div>
                  {Array.from({ length: 5 }, (_, di) => {
                    const day: PabCalendarDay | undefined = week.find(
                      (d) => d.date.getDay() === di + 1,
                    );
                    if (!day) {
                      return (
                        <div
                          key={di}
                          className="flex h-10 items-center justify-center rounded-md border border-dashed border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900/20"
                        >
                          <span className="text-[7px] text-zinc-300 dark:text-zinc-700">—</span>
                        </div>
                      );
                    }
                    const hours = day.seconds / 3600;
                    const dayIso = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                    const isPicked = activePersonDates.has(dayIso);
                    const noActive = activePerson === null;
                    // Existing dispute on file for the active person? Drives the
                    // already-forgiven / pending / denied cell states so the user
                    // never sees "click to forgive" on a day that's already on file.
                    const existing = activePersonExistingDisputes.get(dayIso) ?? null;
                    const existingForgiven = !!existing && disputeGrantsPabForgiveness(existing);
                    const existingPending = !!existing && disputeIsAwaitingResolution(existing);
                    const existingDenied = !!existing && disputeIsFinallyDenied(existing);
                    // Below 7h on a Mon–Fri = forgiveness candidate. 0h (no data) counts —
                    // employee was probably out, which is exactly what the dispute exists for.
                    const isBelow7h = day.seconds < 7 * 3600;
                    // Clickable only if no existing dispute (any status) blocks re-picking.
                    const isClickable =
                      !noActive && !existing && (isBelow7h || isPicked);

                    let cellBorder: string;
                    let textColor: string;
                    if (isPicked) {
                      cellBorder =
                        'border-pink-500 bg-pink-100 ring-2 ring-pink-300/40 shadow-sm dark:border-pink-400 dark:bg-pink-950/60 dark:ring-pink-500/30';
                      textColor = 'text-pink-700 dark:text-pink-300';
                    } else if (noActive) {
                      cellBorder = 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40';
                      textColor = 'text-zinc-400 dark:text-zinc-500';
                    } else if (existingForgiven) {
                      // Already on file & forgiven by Accounting — show as a passing day.
                      cellBorder =
                        'border-emerald-400 bg-emerald-100 ring-1 ring-emerald-400/40 dark:border-emerald-600/70 dark:bg-emerald-950/50 dark:ring-emerald-500/30';
                      textColor = 'text-emerald-800 dark:text-emerald-300';
                    } else if (existingPending) {
                      // In-flight (manager review or accounting review) — yellow.
                      cellBorder =
                        'border-amber-400 bg-amber-50 ring-1 ring-amber-400/35 dark:border-amber-600/60 dark:bg-amber-950/35';
                      textColor = 'text-amber-700 dark:text-amber-400';
                    } else if (existingDenied) {
                      // Denied — keep red but explicitly disabled (re-pick is meaningless).
                      cellBorder =
                        'border-rose-400 bg-rose-50 dark:border-rose-700/70 dark:bg-rose-950/40';
                      textColor = 'text-rose-700 dark:text-rose-400';
                    } else if (day.passes) {
                      cellBorder =
                        'border-emerald-300 bg-emerald-50 dark:border-emerald-700/70 dark:bg-emerald-950/40';
                      textColor = 'text-emerald-700 dark:text-emerald-400';
                    } else {
                      cellBorder = 'border-red-300 bg-red-50 dark:border-red-700/70 dark:bg-red-950/40';
                      textColor = 'text-red-600 dark:text-red-400';
                    }

                    const titleParts: string[] = [`${day.dayLabel} ${day.dateStr}`];
                    if (noActive) titleParts.push('pick a person first');
                    else if (existingForgiven) titleParts.push(`already forgiven (${existing!.reason} · ${existing!.status})`);
                    else if (existingPending) titleParts.push(`pending review (${existing!.status})`);
                    else if (existingDenied) titleParts.push(`previously denied (${existing!.status}) — cannot re-pick`);
                    else if (day.passes) titleParts.push(`${hours.toFixed(2)}h ✓ — already passes`);
                    else if (!day.hasData) titleParts.push('no Hubstaff data — click to forgive');
                    else titleParts.push(`${hours.toFixed(2)}h — click to forgive`);

                    return (
                      <button
                        key={di}
                        type="button"
                        onClick={isClickable ? () => toggleDate(dayIso) : undefined}
                        disabled={!isClickable || submitting}
                        title={titleParts.join(' · ')}
                        className={`flex h-10 flex-col items-center justify-center gap-px rounded-md border transition-all duration-200 ${cellBorder} ${
                          isClickable
                            ? 'cursor-pointer hover:ring-2 hover:ring-orange-300/50'
                            : 'cursor-default'
                        }`}
                      >
                        <span className="text-[7px] leading-none text-zinc-400 dark:text-zinc-500">
                          {day.dateStr}
                        </span>
                        <span className={`font-mono text-[10px] font-bold leading-none ${textColor}`}>
                          {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 pt-2 text-[9px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-600 sm:text-[10px]">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 sm:h-2 sm:w-2" /> &lt; 7h — click to forgive
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 sm:h-2 sm:w-2" /> ≥ 7h
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 ring-1 ring-emerald-400 sm:h-2 sm:w-2" /> Already forgiven
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 sm:h-2 sm:w-2" /> Pending review
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-pink-500 ring-1 ring-pink-300 sm:h-2 sm:w-2" /> Picked
                </span>
                {activePerson ? (
                  <span className="ml-auto font-medium text-zinc-600 dark:text-zinc-400">
                    Editing: {employeesByEmail.get(activePerson)?.displayName?.trim() || activePerson}
                  </span>
                ) : null}
              </div>
            </div>

            {activePersonDates.size > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {[...activePersonDates].sort().map((iso) => (
                  <Badge
                    key={iso}
                    variant="outline"
                    className="gap-1 border-pink-200 bg-pink-50 font-mono text-[10px] text-pink-700 dark:border-pink-800/60 dark:bg-pink-950/40 dark:text-pink-300"
                  >
                    <CalendarDays className="h-3 w-3" />
                    {iso}
                    <button
                      type="button"
                      onClick={() => toggleDate(iso)}
                      disabled={submitting}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-pink-200/50 dark:hover:bg-pink-900/50"
                      aria-label={`Remove ${iso}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-zinc-400">
                {selectedEmployees.length === 0
                  ? 'Pick people first to see red days for them.'
                  : activePerson === null
                    ? 'Click a person chip to start picking their forgiven days.'
                    : 'Click any red day above to mark it forgiven for the active person. Days with ≥ 7h cannot be picked.'}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-pink-600 hover:bg-pink-700"
          >
            {submitting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            Submit ({totalDisputes} {totalDisputes === 1 ? 'dispute' : 'disputes'})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
