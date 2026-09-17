'use client';

/**
 * HR → MESA → FPU: classes with an enrollment window, and the people who
 * enrolled in each. Approve = a seat. Mark completed = FPU date stamped +
 * MESA membership opened from that date. Governing doc:
 * docs/features/fpu-enrollment.md.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GraduationCap,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  Inbox,
  CheckCircle2,
  XCircle,
  Clock,
  Award,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/date-only';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { fetchRosterStatusMap, type RosterEmailStatus } from '@/lib/roster/roster-emails';
import { normEmail } from '@/lib/email/norm-email';
import { offboardReasonLabel } from '@/lib/hr/offboard-reasons';
import { BulkBar, reportBulk, runBulk, SelectCheckbox, useRowSelection } from '@/components/mesa/bulk-selection';
import {
  FPU_CLASS_NAME_MAX,
  fpuClassCode,
  fpuClassLabel,
  fpuClassPhase,
  nextFpuBatch,
  sortFpuClasses,
  type FpuClass,
  type FpuEnrollmentStatus,
} from '@/lib/mesa/fpu-class';
import { fpuEligibleFrom } from '@/lib/mesa/fpu-eligibility';

type Counts = Record<FpuEnrollmentStatus, number>;

interface EnrollmentRow {
  id: string;
  email: string;
  full_name: string;
  department: string;
  shift_schedule_est: string;
  created_at: string;
  class_id: string | null;
  status: FpuEnrollmentStatus;
  start_date_used: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  completed_on: string | null;
}

interface CompleteResult {
  completed: { id: string; email: string; full_name: string }[];
  toEnroll: { id: string; workEmail: string; name: string; since: string }[];
  alreadyMembers: { email: string; full_name: string }[];
  noRateRow: { email: string; full_name: string }[];
  skipped: { id: string; email: string; status: string }[];
  error: string | null;
}

type StatusFilter = 'all' | FpuEnrollmentStatus;

const STATUS_LABEL: Record<FpuEnrollmentStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  completed: 'Completed',
};

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${res.status} — non-JSON response`);
  }
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { cache: 'no-store', ...init });
  const json = await readJson<T & { error?: string | null }>(res);
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const fmtShort = (iso: string | null | undefined) => (iso ? formatDateOnly(iso) : '—');
const fmtStamp = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function HrFpuEnrollments() {
  const [classes, setClasses] = useState<FpuClass[]>([]);
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const [migrated, setMigrated] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [roster, setRoster] = useState<Map<string, RosterEmailStatus> | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [busy, setBusy] = useState(false);
  const [classDialog, setClassDialog] = useState<{ mode: 'create' } | { mode: 'edit'; cls: FpuClass } | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<FpuClass | null>(null);

  const today = useMemo(() => manilaTodayIso(), []);

  const loadClasses = useCallback(async (pickDefault: boolean) => {
    setLoadingClasses(true);
    try {
      const [json, rosterMap] = await Promise.all([
        requestJson<{ classes: FpuClass[]; counts: Record<string, Counts>; migrated: boolean }>('/api/hr/fpu-classes'),
        fetchRosterStatusMap().catch(() => null),
      ]);
      const sorted = sortFpuClasses(json.classes ?? []);
      setClasses(sorted);
      setCounts(json.counts ?? {});
      setMigrated(json.migrated !== false);
      setRoster(rosterMap);
      setError(null);
      if (pickDefault) {
        // Default to the class that needs attention: open now, else the newest.
        const open = sorted.find((c) => fpuClassPhase(c, today) === 'open');
        setSelectedId((prev) => prev ?? open?.id ?? sorted[0]?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load FPU classes');
    } finally {
      setLoadingClasses(false);
    }
  }, [today]);

  const loadRows = useCallback(async (classId: string) => {
    setLoadingRows(true);
    try {
      const json = await requestJson<{ rows: EnrollmentRow[]; migrated: boolean }>(`/api/hr/fpu-enrollments?class_id=${encodeURIComponent(classId)}`);
      setRows(json.rows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load enrollments');
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => {
    void loadClasses(true);
  }, [loadClasses]);

  useEffect(() => {
    if (selectedId) void loadRows(selectedId);
    else setRows([]);
  }, [selectedId, loadRows]);

  const selected = useMemo(() => classes.find((c) => c.id === selectedId) ?? null, [classes, selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.full_name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        formatDeptLabel(r.department).toLowerCase().includes(q) ||
        r.shift_schedule_est.toLowerCase().includes(q)
      );
    });
  }, [rows, query, statusFilter]);

  const sel = useRowSelection(filtered, (r) => r.id);
  const selStatuses = useMemo(() => new Set(sel.selectedRows.map((r) => r.status)), [sel.selectedRows]);
  const canDecide = sel.selectedRows.length > 0 && !selStatuses.has('completed');
  const canComplete = sel.selectedRows.length > 0 && selStatuses.size === 1 && selStatuses.has('approved');

  const refreshAll = async () => {
    await loadClasses(false);
    if (selectedId) await loadRows(selectedId);
  };

  const decide = async (status: 'approved' | 'denied' | 'pending') => {
    if (!canDecide || busy) return;
    setBusy(true);
    try {
      const json = await requestJson<{ updated: number; skipped: number }>('/api/hr/fpu-enrollments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: sel.selectedRows.map((r) => r.id), status }),
      });
      const verb = status === 'approved' ? 'Approved' : status === 'denied' ? 'Denied' : 'Reset';
      reportBulk(verb, json.updated, json.skipped);
      sel.clear();
      await refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (completedOn: string) => {
    if (!canComplete || busy) return;
    setBusy(true);
    try {
      const out = await requestJson<CompleteResult>('/api/hr/fpu-enrollments/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: sel.selectedRows.map((r) => r.id), completed_on: completedOn }),
      });
      // MESA membership opens through the ONE route that mints accounts — per
      // person, exactly as the old HR opt-in approval did. The server has already
      // excluded anyone who is a member or holds an open account under an alias.
      const enrolled = await runBulk(out.toEnroll, async (t) => {
        const res = await fetch('/api/toggle-mesa-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workEmail: t.workEmail, mesaMember: true, name: t.name, since: t.since }),
        });
        if (!res.ok) {
          const j = await readJson<{ error?: string }>(res).catch(() => ({} as { error?: string }));
          throw new Error(`${t.workEmail}: ${j.error ?? `HTTP ${res.status}`}`);
        }
      });
      reportBulk('Completed', out.completed.length, out.skipped.length, out.error);
      if (out.toEnroll.length) reportBulk('Opted in to MESA', enrolled.ok, enrolled.fail, enrolled.firstError);
      if (out.alreadyMembers.length) {
        toast.info(`${out.alreadyMembers.length} already in MESA — not re-enrolled`, {
          description: out.alreadyMembers.map((m) => m.email).join(', '),
        });
      }
      if (out.noRateRow.length) {
        toast.warning(`${out.noRateRow.length} with no rate row — FPU date not stamped`, {
          description: out.noRateRow.map((m) => m.email).join(', '),
        });
      }
      setCompleteOpen(false);
      sel.clear();
      await refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not mark completed');
    } finally {
      setBusy(false);
    }
  };

  const deleteClass = async (cls: FpuClass) => {
    setBusy(true);
    try {
      await requestJson<{ success: boolean }>(`/api/hr/fpu-classes?id=${encodeURIComponent(cls.id)}`, { method: 'DELETE' });
      toast.success(`${fpuClassLabel(cls)} deleted`);
      setConfirmDelete(null);
      setSelectedId((prev) => (prev === cls.id ? null : prev));
      await loadClasses(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  const total = (c: FpuClass) => {
    const k = counts[c.id];
    return k ? k.pending + k.approved + k.denied + k.completed : 0;
  };

  return (
    <div className="space-y-4">
      {!migrated && (
        <Notice tone="amber">FPU classes are not set up yet — run <code>scripts/apply-fpu-classes-migration.mts --apply</code>.</Notice>
      )}
      {error && <Notice tone="rose">{error}</Notice>}

      {/* Class strip */}
      <div className="flex flex-wrap items-center gap-2">
        {loadingClasses && classes.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading classes…</span>
        ) : (
          classes.map((c) => {
            const phase = fpuClassPhase(c, today);
            const k = counts[c.id];
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'group inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors',
                  active
                    ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-sm dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-100'
                    : 'border-zinc-200 bg-white text-zinc-700 hover:border-teal-300 hover:bg-teal-50/40 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:border-teal-700',
                )}
              >
                <GraduationCap className={cn('h-3.5 w-3.5', active ? 'text-teal-600 dark:text-teal-300' : 'text-zinc-400')} />
                <span className="font-semibold">{fpuClassLabel(c)}</span>
                {c.name && <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{fpuClassCode(c)}</span>}
                <PhasePill phase={phase} />
                {k && k.pending > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" title="Pending review">
                    {k.pending}
                  </span>
                )}
              </button>
            );
          })
        )}
        <Button type="button" size="sm" variant="outline" disabled={!migrated || busy || loadingClasses} onClick={() => setClassDialog({ mode: 'create' })} className="h-8 gap-1 text-xs">
          <Plus className="h-3.5 w-3.5" /> New class
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void refreshAll()} disabled={loadingClasses || loadingRows} className="ml-auto h-8 gap-1 text-xs text-zinc-500">
          <RefreshCw className={cn('h-3.5 w-3.5', (loadingClasses || loadingRows) && 'animate-spin')} /> Refresh
        </Button>
      </div>

      {!selected ? (
        <Card className="border-dashed border-teal-200 dark:border-teal-900/60">
          <CardContent className="flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
            <Inbox className="h-6 w-6 text-zinc-400" />
            {migrated ? 'No FPU class yet. Create one to open enrollment.' : 'Waiting for the migration.'}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
          {/* Selected class header */}
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white">{fpuClassLabel(selected)}</h3>
                {selected.name && <span className="text-xs text-zinc-500 dark:text-zinc-400">{fpuClassCode(selected)}</span>}
                <PhasePill phase={fpuClassPhase(selected, today)} />
              </div>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Enrollment {fmtShort(selected.opens_on)} – {fmtShort(selected.closes_on)} · Class {fmtShort(selected.class_starts_on)}
                {selected.class_ends_on ? ` – ${fmtShort(selected.class_ends_on)}` : ''}
                {selected.schedule_note ? ` · ${selected.schedule_note}` : ''}
                {' · '}eligible if 3 months in by {fmtShort(selected.class_starts_on)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={busy} onClick={() => setClassDialog({ mode: 'edit', cls: selected })}>
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              {total(selected) === 0 && (
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-[11px] text-rose-700 hover:bg-rose-50 dark:text-rose-300" disabled={busy} onClick={() => setConfirmDelete(selected)}>
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
            <div className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60">
              {(['all', 'pending', 'approved', 'denied', 'completed'] as StatusFilter[]).map((s) => {
                const n = s === 'all' ? rows.length : rows.filter((r) => r.status === s).length;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    className={cn(
                      'rounded px-2 py-1 text-[11px] font-semibold transition-colors',
                      statusFilter === s ? 'bg-teal-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                    )}
                  >
                    {s === 'all' ? 'All' : STATUS_LABEL[s]} <span className="tabular-nums opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 border-zinc-200 bg-white pl-8 text-xs dark:border-zinc-800 dark:bg-zinc-900/60" />
            </div>
          </div>

          {sel.selectedRows.length > 0 && (
            <BulkBar count={sel.selectedRows.length} onClear={sel.clear}>
              <Button type="button" size="sm" disabled={!canDecide || busy} onClick={() => void decide('approved')} className="h-7 gap-1 bg-teal-600 text-[11px] text-white hover:bg-teal-700">
                <CheckCircle2 className="h-3 w-3" /> Approve
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!canDecide || busy} onClick={() => void decide('denied')} className="h-7 gap-1 text-[11px] text-rose-700 dark:text-rose-300">
                <XCircle className="h-3 w-3" /> Deny
              </Button>
              <Button type="button" size="sm" disabled={!canComplete || busy} onClick={() => setCompleteOpen(true)} title={canComplete ? 'Stamp the FPU date and open MESA membership' : 'Select approved rows only'} className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-40">
                <Award className="h-3 w-3" /> Mark completed
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={!canDecide || busy} onClick={() => void decide('pending')} className="h-7 gap-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            </BulkBar>
          )}

          <CardContent className="p-0">
            {loadingRows && rows.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
                <Inbox className="h-6 w-6 text-zinc-400" />
                {rows.length === 0 ? 'No enrollments yet.' : 'Nothing matches.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                    <tr>
                      <th className="w-8 px-4 py-2.5">
                        <SelectCheckbox checked={sel.allSelected} indeterminate={sel.someSelected && !sel.allSelected} onChange={sel.toggleAll} ariaLabel="Select all visible" />
                      </th>
                      <th className="px-4 py-2.5">Employee</th>
                      <th className="px-4 py-2.5">Department</th>
                      <th className="px-4 py-2.5">Shift (EST)</th>
                      <th className="px-4 py-2.5">Tenure</th>
                      <th className="px-4 py-2.5">Submitted</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {filtered.map((r) => {
                      const st = roster?.get(normEmail(r.email) ?? '') ?? null;
                      const offGml = roster !== null && (!st || !st.active);
                      const eligibleFrom = r.start_date_used ? fpuEligibleFrom(r.start_date_used) : null;
                      const tenureOk = eligibleFrom ? eligibleFrom <= selected.class_starts_on : null;
                      return (
                        <tr key={r.id} className={cn('transition-colors hover:bg-teal-50/30 dark:hover:bg-teal-950/20', sel.selectedKeys.has(r.id) && 'bg-teal-50/50 dark:bg-teal-950/30')}>
                          <td className="px-4 py-2.5">
                            <SelectCheckbox checked={sel.selectedKeys.has(r.id)} onChange={() => sel.toggle(r.id)} ariaLabel={`Select ${r.full_name}`} />
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-zinc-900 dark:text-white">{r.full_name}</span>
                              {offGml && (
                                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200" title={st?.offBoardedAt ? `Offboarded — ${offboardReasonLabel(st.offBoardedReason)} (${fmtStamp(st.offBoardedAt)})` : 'Not found on the Global Master List'}>
                                  Off GML
                                </Badge>
                              )}
                            </div>
                            <p className="font-mono text-[11px] text-zinc-500">{r.email}</p>
                          </td>
                          <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{formatDeptLabel(r.department) || '—'}</td>
                          <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{r.shift_schedule_est || '—'}</td>
                          <td className="px-4 py-2.5 text-xs">
                            {tenureOk === null ? (
                              <span className="text-zinc-400">no start date</span>
                            ) : tenureOk ? (
                              <span className="text-emerald-700 dark:text-emerald-300" title={`Started ${fmtShort(r.start_date_used)}`}>✓ since {fmtShort(r.start_date_used)}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" title="Class start date moved after this enrollment">
                                <AlertTriangle className="h-3 w-3" /> eligible {fmtShort(eligibleFrom)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">{fmtStamp(r.created_at)}</td>
                          <td className="px-4 py-2.5">
                            <StatusBadge status={r.status} />
                            {r.status === 'completed' && r.completed_on && <p className="mt-0.5 text-[11px] text-zinc-500">FPU {fmtShort(r.completed_on)}</p>}
                            {r.status !== 'pending' && r.status !== 'completed' && r.reviewed_by && (
                              <p className="mt-0.5 text-[11px] text-zinc-500" title={r.review_notes ?? undefined}>{r.reviewed_by.split('@')[0]} · {fmtStamp(r.reviewed_at)}</p>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {classDialog && (
        <ClassDialog
          mode={classDialog.mode}
          cls={classDialog.mode === 'edit' ? classDialog.cls : null}
          classes={classes}
          busy={busy}
          onClose={() => setClassDialog(null)}
          onSaved={async (saved) => {
            setClassDialog(null);
            await loadClasses(false);
            setSelectedId(saved.id);
          }}
        />
      )}

      {completeOpen && selected && (
        <CompleteDialog
          count={sel.selectedRows.length}
          defaultDate={selected.class_ends_on ?? today}
          busy={busy}
          onClose={() => setCompleteOpen(false)}
          onConfirm={(d) => void complete(d)}
        />
      )}

      {confirmDelete && (
        <Overlay onClose={() => setConfirmDelete(null)}>
          <h3 className="text-base font-bold text-zinc-900 dark:text-white">Delete {fpuClassLabel(confirmDelete)}?</h3>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">It has no enrollments. This cannot be undone.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</Button>
            <Button type="button" size="sm" className="bg-rose-600 text-white hover:bg-rose-700" disabled={busy} onClick={() => void deleteClass(confirmDelete)}>Delete</Button>
          </div>
        </Overlay>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function PhasePill({ phase }: { phase: 'upcoming' | 'open' | 'closed' }) {
  const cls = {
    open: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200',
    upcoming: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200',
    closed: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
  }[phase];
  const label = { open: 'Open', upcoming: 'Upcoming', closed: 'Closed' }[phase];
  return <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', cls)}>{label}</span>;
}

function StatusBadge({ status }: { status: FpuEnrollmentStatus }) {
  const map = {
    pending: { cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200', Icon: Clock },
    approved: { cls: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200', Icon: CheckCircle2 },
    denied: { cls: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200', Icon: XCircle },
    completed: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200', Icon: Award },
  }[status];
  return (
    <Badge variant="outline" className={cn('text-[10.5px] font-semibold uppercase tracking-wide', map.cls)}>
      <map.Icon className="mr-1 h-3 w-3" /> {STATUS_LABEL[status]}
    </Badge>
  );
}

function Notice({ tone, children }: { tone: 'amber' | 'rose'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-amber-200/80 bg-amber-50/70 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
      : 'border-rose-200/80 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100';
  return <div className={cn('rounded-lg border px-4 py-2.5 text-xs leading-relaxed', cls)}>{children}</div>;
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ClassDialog({
  mode,
  cls,
  classes,
  busy,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  cls: FpuClass | null;
  classes: FpuClass[];
  busy: boolean;
  onClose: () => void;
  onSaved: (saved: FpuClass) => void | Promise<void>;
}) {
  const thisYear = Number(manilaTodayIso().slice(0, 4));
  const [year, setYear] = useState(String(cls?.year ?? thisYear));
  const [batch, setBatch] = useState(String(cls?.batch ?? nextFpuBatch(classes, thisYear)));
  const [opens, setOpens] = useState(cls?.opens_on ?? '');
  const [closes, setCloses] = useState(cls?.closes_on ?? '');
  const [starts, setStarts] = useState(cls?.class_starts_on ?? '');
  const [ends, setEnds] = useState(cls?.class_ends_on ?? '');
  const [note, setNote] = useState(cls?.schedule_note ?? '');
  const [name, setName] = useState(cls?.name ?? '');
  const [saving, setSaving] = useState(false);

  // A new year defaults its batch to the next free number for THAT year.
  useEffect(() => {
    if (mode === 'create') setBatch(String(nextFpuBatch(classes, Number(year) || thisYear)));
  }, [year, classes, mode, thisYear]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        id: cls?.id,
        year: Number(year),
        batch: Number(batch),
        opens_on: opens,
        closes_on: closes,
        class_starts_on: starts,
        class_ends_on: ends || null,
        schedule_note: note.trim() || null,
        name: name.trim() || null,
      };
      const json = await requestJson<{ class: FpuClass }>('/api/hr/fpu-classes', {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast.success(`${fpuClassLabel(json.class)} ${mode === 'create' ? 'created' : 'saved'}`);
      await onSaved(json.class);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save class');
    } finally {
      setSaving(false);
    }
  };

  const code = fpuClassCode({ year: Number(year) || thisYear, batch: Number(batch) || 1 });
  const disabled = busy || saving;
  const ready = !!opens && !!closes && !!starts && Number(year) > 0 && Number(batch) > 0;

  return (
    <Overlay onClose={onClose}>
      <h3 className="text-base font-bold text-zinc-900 dark:text-white">{mode === 'create' ? 'New class' : 'Edit class'} · {code}</h3>
      <div className="mt-4">
        <Field label="Batch name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} placeholder={code} className="h-9" maxLength={FPU_CLASS_NAME_MAX} />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Year"><Input type="number" value={year} onChange={(e) => setYear(e.target.value)} disabled={disabled} className="h-9" /></Field>
        <Field label="Batch"><Input type="number" min={1} max={12} value={batch} onChange={(e) => setBatch(e.target.value)} disabled={disabled} className="h-9" /></Field>
        <Field label="Enrollment opens"><DatePicker value={opens} onChange={setOpens} disabled={disabled} required /></Field>
        <Field label="Enrollment closes"><DatePicker value={closes} onChange={setCloses} disabled={disabled} required min={opens || undefined} /></Field>
        <Field label="Class starts"><DatePicker value={starts} onChange={setStarts} disabled={disabled} required /></Field>
        <Field label="Class ends (optional)"><DatePicker value={ends} onChange={setEnds} disabled={disabled} min={starts || undefined} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Schedule (shown to employees)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} placeholder="Thursdays 5:00 PM EST · Fridays 5:00 AM PHT" className="h-9" maxLength={300} />
        </Field>
      </div>
      <p className="mt-3 text-[11.5px] text-zinc-500 dark:text-zinc-400">
        Employees need 3 months of service by the class start date. Enrollment is open through the close date, Manila time.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={disabled}>Cancel</Button>
        <Button type="button" size="sm" className="bg-teal-600 text-white hover:bg-teal-700" disabled={disabled || !ready} onClick={() => void save()}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {mode === 'create' ? 'Create' : 'Save'}
        </Button>
      </div>
    </Overlay>
  );
}

function CompleteDialog({
  count,
  defaultDate,
  busy,
  onClose,
  onConfirm,
}: {
  count: number;
  defaultDate: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (completedOn: string) => void;
}) {
  const [date, setDate] = useState(defaultDate);
  return (
    <Overlay onClose={onClose}>
      <h3 className="text-base font-bold text-zinc-900 dark:text-white">Mark {count} completed?</h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Stamps the FPU completion date and opens MESA membership from it — the ₱100 deduction and ₱300 match start with the first pay week whose Friday is on or after this date. Anyone already in MESA is not re-enrolled.
      </p>
      <div className="mt-4">
        <Field label="Completed on"><DatePicker value={date} onChange={setDate} disabled={busy} required /></Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="button" size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy || !date} onClick={() => onConfirm(date)}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Award className="mr-1.5 h-3.5 w-3.5" />}
          Complete {count}
        </Button>
      </div>
    </Overlay>
  );
}
