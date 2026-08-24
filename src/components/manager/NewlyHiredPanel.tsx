'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarCheck, CheckCircle2, ClipboardCheck, Copy, Download, FileSpreadsheet, FileText, Layers, Loader2, Phone, RotateCcw, Search, UserPlus, X, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatWeekLabel } from '@/lib/hr/hiring-week';
import { isLeadGenDepartment } from '@/lib/hr/calltools-username';
import type { HrPendingStatus } from '@/lib/supabase/hr-pending-employees';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import {
  attendanceRate,
  buildOrientationWeeks,
  pickChecklistWeek,
  weekKeyFromIso,
  OFF_CHECKLIST_LABEL,
  UNDATED_WEEK,
  type OrientationHire,
} from '@/lib/manager/orientation-weekly';
import { downloadOrientationPdf } from '@/lib/manager/orientation-pdf';

/**
 * Shape returned by `/api/manager/pending-hires`. Subset of
 * `HrPendingEmployeeRow` — keep in sync with `src/lib/supabase/hr-pending-employees.ts`.
 */
type PendingHireRow = {
  id: number;
  created_at: string;
  name: string;
  personal_email: string;
  work_email: string | null;
  department: string;
  job_description: string | null;
  start_date: string | null;
  status: HrPendingStatus;
  /** Intake channel — 'onboarding_bypass' marks a manual (Bypass) onboard. */
  source: string | null;
  orientation_attended_at: string | null;
  orientation_attended_by: string | null;
  orientation_note: string | null;
  no_show_at: string | null;
  no_show_by: string | null;
  no_show_note: string | null;
  /** Lead Gen only: the CallTools dialer username minted on the hire's linked
   *  onboarding submission (null for other departments / not yet minted). */
  calltools_username: string | null;
};

/**
 * A hire HR onboarded manually via the Onboarding tab's Bypass flow. They were
 * promoted instantly (account pre-existing, orientation auto-stamped), so the
 * manager has nothing to action — the card is informational, they sit under
 * the week they were ONBOARDED (created_at, not a checklist batch), and they
 * are excluded from selection / bulk runs.
 */
function isManualOnboard(r: PendingHireRow): boolean {
  return r.source === 'onboarding_bypass';
}

interface NewlyHiredPanelProps {
  viewerEmail: string | null;
  teamGate:
    | { kind: 'loading' }
    | { kind: 'elevated' }
    | { kind: 'department'; departments: string[] }
    | { kind: 'error'; message: string };
}

function fmtLongDate(raw: string | null): string {
  if (!raw) return '—';
  const isoOnly = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const d = new Date(`${isoOnly}T00:00:00`);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Formats a full timestamp as a long date in Manila (company tz). Used for the
 * orientation-attended date, which the manager now picks explicitly — slicing
 * the UTC portion (as fmtLongDate does) could show the day before for an early
 * Manila morning. Date-only fields keep using fmtLongDate.
 */
function fmtManilaDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Today's calendar date (YYYY-MM-DD) in Manila — the default orientation date. */
function manilaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** A stored orientation timestamp -> YYYY-MM-DD (Manila) for the date input. */
function manilaInputDate(iso: string | null): string {
  if (!iso) return manilaToday();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return manilaToday();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Sentinel batch key for hires whose date can't be parsed into a week. */
const UNKNOWN_BATCH = 'unknown';

/**
 * The hiring "batch" a hire belongs to — **HR's New Hire Checklist week**
 * (`hr_new_hire_checklist.period_start`), matched on personal email.
 *
 * This used to be derived from the hire's own dates (`start_date ?? created_at`)
 * and that was wrong for nearly half the roster: `start_date` is null on 973 of
 * 974 live rows, so it always degraded to `created_at` — when HR STAGED the
 * hire, typically the Friday or Saturday BEFORE the week they orient. Measured
 * 2026-08-24, that filed 439 of 954 matched hires (46%) one week early. Kane's
 * ruling: the week must match HR's checklist.
 *
 * Falls back to the staged-week derivation only when the email is on no
 * checklist row at all, so a hire is never dropped — see `OFF_CHECKLIST_LABEL`.
 * Returns a `YYYY-MM-DD` Sunday key (sortable) or `UNKNOWN_BATCH`.
 */
function batchKeyOf(r: PendingHireRow, checklistWeeks: Map<string, string[]>): string {
  // Manually onboarded (Bypass) hires belong to no checklist batch by design —
  // they group under the week HR onboarded them (created_at), never their
  // possibly backdated start_date, so they always surface in a recent week.
  if (!isManualOnboard(r)) {
    const hrWeek = pickChecklistWeek(r.personal_email, r.created_at, checklistWeeks);
    if (hrWeek) return hrWeek;
  }
  return weekKeyFromIso(r.created_at) ?? UNKNOWN_BATCH;
}

/** Human label for a batch key ("Jun 28 – Jul 4, 2026" / "No batch date"). */
function batchLabelOf(key: string): string {
  return key === UNKNOWN_BATCH ? 'No batch date' : formatWeekLabel(key);
}

/** Sort batch keys newest-first, with the unknown bucket always last. */
function sortBatchKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    if (a === UNKNOWN_BATCH) return 1;
    if (b === UNKNOWN_BATCH) return -1;
    return a < b ? 1 : a > b ? -1 : 0;
  });
}

// ── CSV / Excel export ──────────────────────────────────────────────────────
// Detail columns for a hire, in the order both exports render them. The Batch is
// a leading column in the CSV and the sheet title in the workbook, so it's kept
// out of this list.
const EXPORT_DETAIL_HEADERS = [
  'Name',
  'Personal Email',
  'Work Email',
  'CallTools Username',
  'Department',
  'Role',
  'Start Date',
  'Status',
  'Orientation / No-show Date',
  'Marked By',
  'Note',
] as const;

/** Human status for the export: mirrors the badge shown on each card. */
function exportStatusLabel(r: PendingHireRow): string {
  if (isManualOnboard(r)) return 'Manually onboarded';
  if (r.status === 'no_show') return 'Did not attend';
  return r.orientation_attended_at ? 'Orientation attended' : 'Awaiting orientation';
}

/** A hire's detail cells (no Batch), aligned 1:1 with EXPORT_DETAIL_HEADERS. */
function exportDetailValues(r: PendingHireRow): string[] {
  const isNoShow = r.status === 'no_show';
  const markedBy = isNoShow ? r.no_show_by : r.orientation_attended_by;
  const note = isNoShow ? r.no_show_note : r.orientation_note;
  const eventDate = isNoShow ? r.no_show_at : r.orientation_attended_at;
  // CallTools usernames only exist for Lead Gen hires; for everyone else the
  // cell is blank (rather than a misleading "not minted yet"), matching the
  // card which only surfaces the row for Lead Gen departments.
  const callTools = isLeadGenDepartment(r.department)
    ? (r.calltools_username ?? 'not minted yet')
    : '';
  return [
    r.name ?? '',
    r.personal_email ?? '',
    r.work_email ?? '',
    callTools,
    r.department ?? '',
    r.job_description ?? '',
    r.start_date ? fmtLongDate(r.start_date) : '',
    exportStatusLabel(r),
    eventDate ? fmtManilaDate(eventDate) : '',
    markedBy ?? '',
    note ?? '',
  ];
}

/** Escape one CSV cell (RFC 4180): quote when it holds a comma, quote or newline. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Group hires into batches (newest first) for the per-sheet workbook + display. */
function groupHiresByBatch(
  rows: PendingHireRow[],
  checklistWeeks: Map<string, string[]>,
): Array<{ key: string; label: string; rows: PendingHireRow[] }> {
  const byBatch = new Map<string, PendingHireRow[]>();
  for (const r of rows) {
    const k = batchKeyOf(r, checklistWeeks);
    const bucket = byBatch.get(k);
    if (bucket) bucket.push(r);
    else byBatch.set(k, [r]);
  }
  return sortBatchKeys([...byBatch.keys()]).map((key) => ({
    key,
    label: batchLabelOf(key),
    rows: byBatch.get(key) ?? [],
  }));
}

/** A valid, unique Excel sheet name: <=31 chars, none of []:*?/\, de-duped. */
function safeSheetName(desired: string, used: Set<string>): string {
  const base = (desired.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Batch').slice(0, 31);
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Today's date (YYYY-MM-DD, Manila) for a stable, sortable download filename. */
function exportStamp(): string {
  return manilaToday();
}

/** Trigger a browser download of `blob` as `filename`. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The weekly orientation tally.
 *
 * Reads from the same `buildOrientationWeeks` model the PDF renders, so the
 * screen and the export can never disagree. "Did not attend" is anyone with no
 * `orientation_attended_at` stamp — the sub-columns split that into people
 * already offboarded as no-shows and people nobody has marked either way.
 */
function OrientationSummaryCard({
  summary,
  loading,
  error,
  open,
  onToggle,
  onRetry,
}: {
  summary: ReturnType<typeof buildOrientationWeeks>;
  loading: boolean;
  error: string | null;
  open: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const { weeks, offChecklist, totals } = summary;
  const allWeeks = [...weeks, ...offChecklist];

  if (loading) {
    return (
      <Card className="border-blue-100/70 bg-white/60 dark:border-blue-950/50 dark:bg-zinc-950/40">
        <CardContent className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading orientation attendance…
        </CardContent>
      </Card>
    );
  }

  // No silent degradation: the week key comes from HR's checklist, and falling
  // back to the hire's own dates is the 46%-wrong grouping this replaced.
  if (error) {
    return (
      <Card className="border-rose-200/70 bg-rose-50/40 dark:border-rose-900/50 dark:bg-rose-950/15">
        <CardContent className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Orientation attendance couldn&apos;t load — {error}</span>
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={onRetry}>
            <RotateCcw className="h-3 w-3" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (allWeeks.length === 0) return null;

  const overallRate = attendanceRate(totals);

  const rateTone = (pct: number | null): string => {
    if (pct == null) return 'text-zinc-400';
    if (pct >= 95) return 'text-emerald-700 dark:text-emerald-300';
    if (pct >= 85) return 'text-amber-700 dark:text-amber-300';
    return 'text-rose-700 dark:text-rose-300';
  };

  return (
    <Card className="overflow-hidden border-blue-100/70 bg-gradient-to-br from-white to-blue-50/30 ring-1 ring-blue-500/5 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/10">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-950/20"
        >
          <CalendarCheck className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-semibold text-zinc-900 dark:text-white">Orientation attendance</span>
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {allWeeks.length} week{allWeeks.length === 1 ? '' : 's'}
          </span>
          <span className="ml-auto flex items-center gap-2 text-[11px] font-medium">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {totals.attended} attended
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5',
                totals.notAttended > 0
                  ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400',
              )}
            >
              {totals.notAttended} did not
            </span>
            <span className={cn('tabular-nums font-semibold', rateTone(overallRate))}>
              {overallRate == null ? '—' : `${overallRate}%`}
            </span>
          </span>
        </button>

        {open && (
          <div className="overflow-x-auto border-t border-blue-100/70 dark:border-blue-950/50">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="bg-blue-50/60 text-[10px] uppercase tracking-wide text-blue-700 dark:bg-blue-950/25 dark:text-blue-300">
                  <th scope="col" className="px-4 py-2 text-left font-semibold">Hiring week</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Hires</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Attended</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Did not attend</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">No-show</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Awaiting</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Rate</th>
                </tr>
              </thead>
              <tbody>
                {allWeeks.map((w) => {
                  const pct = attendanceRate(w);
                  return (
                    <tr
                      key={`${w.onChecklist ? 'hr' : 'off'}:${w.weekStart}`}
                      className="border-t border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="px-4 py-2 text-zinc-700 dark:text-zinc-200">
                        {w.weekStart === UNDATED_WEEK ? 'No date on record' : w.label}
                        {!w.onChecklist && (
                          <span
                            className="ml-2 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
                            title="These hires match no row in HR's New Hire Checklist, so they're shown under the week HR staged them instead."
                          >
                            {OFF_CHECKLIST_LABEL}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{w.total}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{w.attended}</td>
                      <td
                        className={cn(
                          'px-3 py-2 text-right tabular-nums font-semibold',
                          w.notAttended > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-400 dark:text-zinc-600',
                        )}
                      >
                        {w.notAttended}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{w.noShow}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{w.stillOpen}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums font-semibold', rateTone(pct))}>
                        {pct == null ? '—' : `${pct}%`}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-blue-200 bg-blue-50/40 font-semibold dark:border-blue-900 dark:bg-blue-950/20">
                  <td className="px-4 py-2 text-zinc-800 dark:text-zinc-100">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-200">{totals.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{totals.attended}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-rose-700 dark:text-rose-300">{totals.notAttended}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{totals.noShow}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{totals.stillOpen}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', rateTone(overallRate))}>
                    {overallRate == null ? '—' : `${overallRate}%`}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="px-4 py-2 text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Weeks are HR&apos;s New Hire Checklist weeks. <strong>Did not attend</strong> means nobody
              marked the hire as having attended orientation — split into <strong>no-show</strong>{' '}
              (already offboarded) and <strong>awaiting</strong> (still unmarked).
              {totals.unmatched > 0 && (
                <>
                  {' '}
                  {totals.unmatched} hire{totals.unmatched === 1 ? '' : 's'} match no checklist row and
                  appear under the week HR staged them.
                </>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function NewlyHiredPanel({ viewerEmail, teamGate }: NewlyHiredPanelProps) {
  const [rows, setRows] = useState<PendingHireRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [dateDraft, setDateDraft] = useState<Record<number, string>>({});
  const [confirmNoShow, setConfirmNoShow] = useState<PendingHireRow | null>(null);
  const [noShowNote, setNoShowNote] = useState('');
  // Filters: free-text search + a batch (hiring-week) picker so managers can
  // navigate one batch at a time, matching HR's New Hire Checklist weeks.
  const [searchQuery, setSearchQuery] = useState('');
  const [batchFilter, setBatchFilter] = useState<string>('all');
  // Multi-select: tick hires, pick one date, mark/update orientation for all.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDate, setBulkDate] = useState<string>(manilaToday());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Confirmation gate for the bulk "Did not attend" run — offboarding is
  // destructive, so we list everyone selected in a modal before firing.
  const [confirmBulkNoShow, setConfirmBulkNoShow] = useState(false);
  const [bulkNoShowNote, setBulkNoShowNote] = useState('');
  // Building the .xlsx lazy-loads the `xlsx` lib, so keep the button busy while
  // the dynamic import + write runs.
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  // Orientation HISTORY — a second, read-only fetch alongside the actionable
  // list. `/api/manager/pending-hires` deliberately returns only what a manager
  // can act on (`pending_work_email` / `ready` + recent Bypass), which as of
  // 2026-08-24 is 3 of the 40 people who were never marked orientation
  // attended: promoted hires (they attended) and no_show hires (the whole point
  // of the report) are filtered out before the client sees them. So the weekly
  // summary, the No-shows list and the PDF ride this instead. It never feeds
  // the actionable card list — that would put ~974 cards on screen instead of 3.
  const [history, setHistory] = useState<OrientationHire[]>([]);
  const [checklistWeeks, setChecklistWeeks] = useState<Map<string, string[]>>(new Map());
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(true);
  // Live progress for a bulk run (orientation mark OR no-show) — drives a modal
  // that shows, in real time, how many hires have actually been processed so
  // far. null when no bulk run is in flight or awaiting review. `kind` selects
  // the copy so the same tally UI serves both actions.
  const [bulkProgress, setBulkProgress] = useState<{
    kind: 'orientation' | 'no-show';
    total: number;
    done: number;
    ok: number;
    fail: number;
    current: string | null;
    failures: { name: string; error: string }[];
    finished: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/manager/pending-hires', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: PendingHireRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load newly hired list');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Loads the orientation history + the checklist week map. Kept separate from
   * `refresh` so a history failure can never blank the actionable list a
   * manager still needs to work, and vice versa.
   *
   * On failure the state is CLEARED rather than left stale: the weekly summary
   * refuses to render and the PDF button disables. There is no safe degradation
   * here — falling back to the hire's own dates is exactly the 46%-wrong week
   * key this replaced, and an export that silently prints wrong weeks is worse
   * than no export.
   */
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch('/api/manager/orientation-history', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: OrientationHire[];
        checklistWeeks?: Record<string, string[]>;
        error?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setHistory(json.rows ?? []);
      setChecklistWeeks(new Map(Object.entries(json.checklistWeeks ?? {})));
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load orientation history');
      setHistory([]);
      setChecklistWeeks(new Map());
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshHistory();
  }, [refresh, refreshHistory]);

  // Reload if the dept assignments arrive after first mount (the page first
  // renders with teamGate kind=loading; once it resolves we re-hit the API).
  useEffect(() => {
    if (teamGate.kind === 'loading') return;
    void refresh();
    void refreshHistory();
  }, [teamGate.kind, refresh, refreshHistory]);

  async function markAttended(id: number, attendedOn: string, isEdit = false) {
    setBusyId(id);
    try {
      const note = (noteDraft[id] ?? '').trim();
      const res = await fetch(`/api/manager/pending-hires/${id}/orientation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null, attendedOn }),
      });
      const json = (await res.json()) as {
        row?: PendingHireRow;
        webhook?: { fired: boolean; status: number | null; error: string | null } | null;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success(
        isEdit
          ? 'Orientation date updated (Start Date synced)'
          : 'Orientation marked as attended',
      );
      // The mark itself succeeded — but if the n8n notification (which carries
      // the CallTools username for Lead Gen provisioning) failed, say so, or
      // the dialer account silently never gets created.
      if (json.webhook?.error) {
        toast.warning('Attendance saved, but the n8n webhook failed', {
          description: `${json.webhook.error} — account provisioning (e.g. CallTools) may not have run.`,
        });
      }
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark orientation');
    } finally {
      setBusyId(null);
    }
  }

  async function unmarkAttended(id: number) {
    if (!confirm('Clear the orientation attendance for this hire?')) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/manager/pending-hires/${id}/orientation`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success('Orientation cleared');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clear orientation');
    } finally {
      setBusyId(null);
    }
  }

  async function markNoShow(r: PendingHireRow) {
    setBusyId(r.id);
    setConfirmNoShow(null);
    try {
      const res = await fetch(`/api/manager/pending-hires/${r.id}/no-show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noShowNote.trim() || null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.warning(`${r.name} marked as did not attend — offboarding triggered`, {
        description: r.work_email
          ? 'Same offboarding webhook HR uses: Workspace account removed and access revoked.'
          : 'No work account exists yet — recorded as a no-show only.',
      });
      setNoShowNote('');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark no-show');
    } finally {
      setBusyId(null);
    }
  }

  // ── Derived history state ────────────────────────────────────────────────
  // Declared ABOVE the early returns: these are hooks, and the empty/error
  // branches below return before the main render.

  /** The weekly tally. One model, three consumers: this panel, the No-shows
   *  list, and the PDF — so they can never disagree on a number. */
  const summary = useMemo(
    () => buildOrientationWeeks({ hires: history, checklistWeeksByEmail: checklistWeeks }),
    [history, checklistWeeks],
  );

  /**
   * No-shows come from the HISTORY read, never from `rows`.
   * `/api/manager/pending-hires` filters `status='no_show'` out entirely, so the
   * section below could never render from it — it was dead UI. History rows are
   * `HrPendingEmployeeRow`, a superset of `PendingHireRow` except the derived
   * CallTools username, which a no-show card does not show.
   */
  const noShowRows = useMemo<PendingHireRow[]>(
    () =>
      history
        .filter((h) => h.status === 'no_show')
        .map((h) => ({ ...(h as unknown as PendingHireRow), calltools_username: null }))
        .sort((a, b) => ((a.no_show_at ?? '') < (b.no_show_at ?? '') ? 1 : -1)),
    [history],
  );

  if (teamGate.kind === 'loading' || loading) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading new hire check list…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-rose-100/80 bg-gradient-to-br from-white to-rose-50/40 ring-1 ring-rose-500/10 dark:border-rose-950/50">
        <CardContent className="py-8 text-center text-sm text-rose-700 dark:text-rose-300">{error}</CardContent>
      </Card>
    );
  }

  // Nothing to action AND nothing on record. A manager with an empty actionable
  // list can still have weeks of attendance history worth reading, so the empty
  // state must clear BOTH reads before it takes over the tab.
  if (rows.length === 0 && history.length === 0) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
            <UserPlus className="h-6 w-6" />
          </div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No newly hired employees</p>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            When HR adds a new hire to a department you manage, they&apos;ll show up here. Mark their
            orientation as attended to unblock HR from promoting them to the master list.
          </p>
        </CardContent>
      </Card>
    );
  }

  const activeRows = rows.filter((r) => r.status !== 'no_show');

  // Batches (hiring weeks) present across every hire — powers the batch picker.
  // Counted over the actionable rows AND the no-shows so a week that exists only
  // as no-shows is still reachable from the dropdown.
  const pickerRows = [...rows, ...noShowRows];
  const batchCounts = new Map<string, number>();
  for (const r of pickerRows) {
    const k = batchKeyOf(r, checklistWeeks);
    batchCounts.set(k, (batchCounts.get(k) ?? 0) + 1);
  }
  const batchKeys = sortBatchKeys([...batchCounts.keys()]);

  // Search + batch filter. Search spans name, both emails, department and role.
  const q = searchQuery.trim().toLowerCase();
  const matches = (r: PendingHireRow): boolean => {
    if (batchFilter !== 'all' && batchKeyOf(r, checklistWeeks) !== batchFilter) return false;
    if (!q) return true;
    return [r.name, r.personal_email, r.work_email, r.department, r.job_description].some((v) =>
      (v ?? '').toLowerCase().includes(q),
    );
  };
  const visibleActive = activeRows.filter(matches);
  const visibleNoShow = noShowRows.filter(matches);
  const filtering = q !== '' || batchFilter !== 'all';

  // Visible active hires grouped into their batches, newest batch first.
  const activeByBatch = new Map<string, PendingHireRow[]>();
  for (const r of visibleActive) {
    const k = batchKeyOf(r, checklistWeeks);
    const bucket = activeByBatch.get(k);
    if (bucket) bucket.push(r);
    else activeByBatch.set(k, [r]);
  }
  const activeBatchKeys = sortBatchKeys([...activeByBatch.keys()]);

  // Selection is keyed by id and SURVIVES the search/batch filter: ticked hires
  // filtered out of view stay ticked, keep counting toward the toolbar tally,
  // and bulk actions run over every selected hire (visible or not). "Select all"
  // targets the visible rows only, but merges into / subtracts from the existing
  // selection instead of replacing it, so narrowing the search never drops
  // anyone. Manually onboarded (Bypass) cards are informational — no checkbox,
  // never selectable — so all the selection math runs over the selectable subset.
  const selectableAllActive = activeRows.filter((r) => !isManualOnboard(r));
  const selectedActiveRows = selectableAllActive.filter((r) => selected.has(r.id));
  const selectedActiveCount = selectedActiveRows.length;
  const selectableActive = visibleActive.filter((r) => !isManualOnboard(r));
  const visibleSelectedCount = selectableActive.filter((r) => selected.has(r.id)).length;
  const hiddenSelectedCount = selectedActiveCount - visibleSelectedCount;
  const allActiveSelected = selectableActive.length > 0 && visibleSelectedCount === selectableActive.length;
  const someActiveSelected = visibleSelectedCount > 0 && !allActiveSelected;

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllActive() {
    setSelected((prev) => {
      const next = new Set(prev);
      const everything = selectableActive.length > 0 && selectableActive.every((r) => prev.has(r.id));
      if (everything) for (const r of selectableActive) next.delete(r.id);
      else for (const r of selectableActive) next.add(r.id);
      return next;
    });
  }

  // Apply the chosen date to every selected hire: marks orientation for those
  // not yet attended and updates the date for those already marked (the POST is
  // idempotent). Runs sequentially so we can publish a live tally to the progress
  // modal and collect a per-hire failure list. The roster only refreshes once the
  // manager dismisses the modal (see closeBulkProgress) — refreshing mid-run would
  // flip `loading` true and unmount the modal along with its live counter.
  async function bulkApply() {
    const targets = selectedActiveRows.map((r) => ({ id: r.id, name: r.name }));
    if (targets.length === 0) return;
    setBulkBusy(true);
    setBulkProgress({ kind: 'orientation', total: targets.length, done: 0, ok: 0, fail: 0, current: null, failures: [], finished: false });
    let ok = 0;
    let fail = 0;
    let webhookFails = 0;
    let firstErr = '';
    const failures: { name: string; error: string }[] = [];
    for (const t of targets) {
      setBulkProgress((p) => (p ? { ...p, current: t.name } : p));
      try {
        const res = await fetch(`/api/manager/pending-hires/${t.id}/orientation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attendedOn: bulkDate }),
        });
        const json = (await res.json()) as {
          webhook?: { error: string | null } | null;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        ok += 1;
        // Mark saved but the per-hire n8n notification (CallTools provisioning
        // for Lead Gen) failed — tally it for the summary toast.
        if (json.webhook?.error) webhookFails += 1;
      } catch (e) {
        fail += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstErr) firstErr = msg;
        failures.push({ name: t.name, error: msg });
      }
      setBulkProgress((p) => (p ? { ...p, done: ok + fail, ok, fail, failures: [...failures] } : p));
    }
    setBulkProgress((p) => (p ? { ...p, current: null, finished: true } : p));
    if (fail === 0 && webhookFails === 0) {
      toast.success(`Orientation set for ${ok} hire${ok !== 1 ? 's' : ''}`, {
        description: 'Start Date syncs for any already promoted.',
      });
    } else if (fail === 0) {
      toast.warning(`Orientation set for ${ok}, but ${webhookFails} n8n webhook${webhookFails !== 1 ? 's' : ''} failed`, {
        description: 'Account provisioning (e.g. CallTools) may not have run for those hires.',
      });
    } else {
      toast.warning(`${ok} updated, ${fail} failed`, { description: firstErr || undefined });
    }
    setBulkBusy(false);
  }

  // Bulk "Did not attend": offboards every selected hire (same per-hire teardown
  // as the single no-show), driving the shared live-tally modal. Confirmed first
  // by the confirmBulkNoShow dialog, which lists everyone affected. Runs
  // sequentially so the tally is real and each failure is captured per hire.
  async function bulkNoShow() {
    const targets = selectedActiveRows.map((r) => ({ id: r.id, name: r.name }));
    if (targets.length === 0) return;
    const note = bulkNoShowNote.trim();
    setConfirmBulkNoShow(false);
    setBulkBusy(true);
    setBulkProgress({ kind: 'no-show', total: targets.length, done: 0, ok: 0, fail: 0, current: null, failures: [], finished: false });
    let ok = 0;
    let fail = 0;
    let firstErr = '';
    const failures: { name: string; error: string }[] = [];
    for (const t of targets) {
      setBulkProgress((p) => (p ? { ...p, current: t.name } : p));
      try {
        const res = await fetch(`/api/manager/pending-hires/${t.id}/no-show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: note || null }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        ok += 1;
      } catch (e) {
        fail += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstErr) firstErr = msg;
        failures.push({ name: t.name, error: msg });
      }
      setBulkProgress((p) => (p ? { ...p, done: ok + fail, ok, fail, failures: [...failures] } : p));
    }
    setBulkProgress((p) => (p ? { ...p, current: null, finished: true } : p));
    if (fail === 0) {
      toast.warning(`${ok} hire${ok !== 1 ? 's' : ''} marked did not attend — offboarding triggered`, {
        description: 'Workspace accounts removed and access revoked where one existed.',
      });
    } else {
      toast.warning(`${ok} offboarded, ${fail} failed`, { description: firstErr || undefined });
    }
    setBulkNoShowNote('');
    setBulkBusy(false);
  }

  // Dismiss the progress modal: clear the run, drop the selection, and only now
  // refresh the roster (which swaps in the loading skeleton).
  function closeBulkProgress() {
    setBulkProgress(null);
    setSelected(new Set());
    void refresh();
  }

  // Both exports reflect the CURRENT view (search + batch filter), active and
  // no-show hires alike, grouped into batches newest-first. Exporting what's on
  // screen is the least surprising behaviour: clear the filters to export all.
  function exportGroups() {
    return groupHiresByBatch([...visibleActive, ...visibleNoShow], checklistWeeks);
  }

  // Flat CSV — one leading Batch column, then the detail columns. A UTF-8 BOM
  // keeps Excel from mangling non-ASCII names.
  function exportCsv() {
    const groups = exportGroups();
    const lines = [['Batch', ...EXPORT_DETAIL_HEADERS].map(csvCell).join(',')];
    for (const g of groups) {
      for (const r of g.rows) {
        lines.push([g.label, ...exportDetailValues(r)].map(csvCell).join(','));
      }
    }
    const csv = '﻿' + lines.join('\r\n');
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `new-hire-check-list-${exportStamp()}.csv`,
    );
  }

  // Excel workbook — ONE SHEET PER BATCH (title row + count + header + hires),
  // mirroring HR's New Hire Checklist export. `xlsx` is dynamically imported so
  // it stays out of the panel's initial bundle.
  async function exportXlsx() {
    setXlsxBusy(true);
    try {
      const XLSX = await import('xlsx');
      const groups = exportGroups();
      const wb = XLSX.utils.book_new();
      const used = new Set<string>();
      if (groups.length === 0) {
        const ws = XLSX.utils.aoa_to_sheet([['No hires match the current view.']]);
        XLSX.utils.book_append_sheet(wb, ws, 'New Hires');
      } else {
        for (const g of groups) {
          const aoa: (string | number)[][] = [
            [`New Hire Check List — ${g.label}`],
            [`${g.rows.length} hire${g.rows.length === 1 ? '' : 's'}`],
            [],
            ['#', ...EXPORT_DETAIL_HEADERS],
          ];
          g.rows.forEach((r, i) => aoa.push([i + 1, ...exportDetailValues(r)]));
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          ws['!cols'] = [{ wch: 4 }, ...EXPORT_DETAIL_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }))];
          XLSX.utils.book_append_sheet(wb, ws, safeSheetName(g.label, used));
        }
      }
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      downloadBlob(
        new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `new-hire-check-list-${exportStamp()}.xlsx`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the Excel file');
    } finally {
      setXlsxBusy(false);
    }
  }

  /**
   * PDF — the weekly attendance report. Unlike CSV / Excel this is NOT the
   * on-screen view: it is the whole history for the manager's scope, because a
   * report filtered by whatever is typed in the search box is not a report.
   * Guarded by `historyError` at the button, so it can never print a document
   * built from a partial or wrongly-weeked roster.
   */
  async function exportPdf() {
    setPdfBusy(true);
    try {
      await downloadOrientationPdf({
        summary,
        generatedAt: new Date(),
        scopeLabel:
          teamGate.kind === 'elevated'
            ? 'All departments'
            : teamGate.kind === 'department' && teamGate.departments.length > 0
              ? teamGate.departments.map((d) => formatDeptLabel(d)).join(', ')
              : 'Your departments',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the PDF');
    } finally {
      setPdfBusy(false);
    }
  }

  function HireCard({ r }: { r: PendingHireRow }) {
    const attended = !!r.orientation_attended_at;
    const isBusy = busyId === r.id;
    const isNoShow = r.status === 'no_show';
    const isManual = isManualOnboard(r);
    // Date input value: the manager's in-progress edit, else the saved
    // orientation date (when attended), else today. `dateChanged` gates the
    // "Update date" button so we only re-POST when the date actually moved.
    const savedDate = attended ? manilaInputDate(r.orientation_attended_at) : manilaToday();
    const draftDate = dateDraft[r.id] ?? savedDate;
    const dateChanged = draftDate !== savedDate;

    // Manually onboarded (Bypass): already promoted with a pre-existing account,
    // orientation auto-stamped by HR — purely informational, nothing to action.
    // No checkbox (never part of a bulk run), no orientation buttons.
    if (isManual) {
      return (
        <Card className="overflow-hidden border border-violet-200/80 bg-gradient-to-br from-white to-violet-50/40 ring-1 ring-violet-500/10 dark:border-violet-900/50 dark:from-zinc-950 dark:to-violet-950/15">
          <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-900 dark:text-white">{r.name}</span>
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300" title={r.department ?? undefined}>
                  {formatDeptLabel(r.department)}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:border-violet-800/70 dark:bg-violet-950/30 dark:text-violet-300">
                  <UserPlus className="h-3 w-3" /> Manually onboarded
                </span>
              </div>
              <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {r.personal_email}
                {r.work_email ? ` · ${r.work_email}` : ''}
              </div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Onboarded {fmtLongDate(r.created_at)} by HR (Bypass — account pre-existing)
                {r.start_date ? ` · start ${fmtLongDate(r.start_date)}` : ''}
                {r.job_description ? ` · ${r.job_description}` : ''}
              </div>
              <div className="text-[11px] text-violet-700 dark:text-violet-300">
                Already active on the roster — no orientation needed from you.
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    if (isNoShow) {
      return (
        <Card className="overflow-hidden border border-rose-200/80 bg-gradient-to-br from-white to-rose-50/40 ring-1 ring-rose-500/10 dark:border-rose-900/50 dark:from-zinc-950 dark:to-rose-950/15">
          <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-zinc-900 dark:text-white">{r.name}</span>
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300" title={r.department ?? undefined}>
                  {formatDeptLabel(r.department)}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/30 dark:text-rose-300">
                  <XCircle className="h-3 w-3" /> Did not attend
                </span>
              </div>
              <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {r.personal_email}
                {r.work_email ? ` · ${r.work_email}` : ' · no work email'}
              </div>
              {r.no_show_at && (
                <div className="text-[11px] text-rose-700 dark:text-rose-300">
                  Marked {fmtLongDate(r.no_show_at)} by{' '}
                  <span className="font-mono">{r.no_show_by ?? '—'}</span>
                  {r.no_show_note ? (
                    <> — <span className="italic text-zinc-600 dark:text-zinc-400">&ldquo;{r.no_show_note}&rdquo;</span></>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card
        className={cn(
          'overflow-hidden border ring-1 transition-colors',
          attended
            ? 'border-emerald-200/80 bg-gradient-to-br from-white to-emerald-50/50 ring-emerald-500/10 dark:border-emerald-900/50 dark:from-zinc-950 dark:to-emerald-950/20'
            : 'border-amber-200/80 bg-gradient-to-br from-white to-amber-50/40 ring-amber-500/10 dark:border-amber-900/50 dark:from-zinc-950 dark:to-amber-950/15',
        )}
      >
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <input
              type="checkbox"
              aria-label={`Select ${r.name}`}
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-blue-600"
              checked={selected.has(r.id)}
              onChange={() => toggleOne(r.id)}
              disabled={isBusy || bulkBusy}
            />
            <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-zinc-900 dark:text-white">{r.name}</span>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300" title={r.department ?? undefined}>
                {formatDeptLabel(r.department)}
              </span>
              {attended ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" /> Orientation attended
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300">
                  <ClipboardCheck className="h-3 w-3" /> Awaiting orientation
                </span>
              )}
            </div>
            <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {r.personal_email}
              {r.work_email ? ` · ${r.work_email}` : ' · work email pending'}
            </div>
            {isLeadGenDepartment(r.department) && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Phone className="h-3 w-3 text-violet-500 dark:text-violet-400" aria-hidden />
                <span className="font-medium text-zinc-500 dark:text-zinc-400">CallTools</span>
                {r.calltools_username ? (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(r.calltools_username ?? '')
                        .then(() => toast.success('CallTools username copied'))
                        .catch(() => toast.error('Copy failed'));
                    }}
                    className="group/ctu inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 font-mono text-[11px] text-violet-800 transition hover:border-violet-300 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200 dark:hover:bg-violet-500/20"
                    title="Copy the dialer username"
                  >
                    {r.calltools_username}
                    <Copy className="h-2.5 w-2.5 opacity-40 transition group-hover/ctu:opacity-100" aria-hidden />
                  </button>
                ) : (
                  <span
                    className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                    title="Minted when the hire submits paperwork (or at mark-attended for older paperwork)"
                  >
                    not minted yet
                  </span>
                )}
              </div>
            )}
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Added {fmtLongDate(r.created_at)}
              {r.start_date ? ` · start ${fmtLongDate(r.start_date)}` : ''}
              {r.job_description ? ` · ${r.job_description}` : ''}
            </div>
            {attended && (
              <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                Attended {fmtManilaDate(r.orientation_attended_at)} · marked by{' '}
                <span className="font-mono">{r.orientation_attended_by ?? '—'}</span>
                {r.orientation_note ? (
                  <> — <span className="italic text-zinc-600 dark:text-zinc-400">&ldquo;{r.orientation_note}&rdquo;</span></>
                ) : null}
              </div>
            )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <label className="flex flex-col gap-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 sm:w-[200px] sm:items-end">
              Orientation date
              <DatePicker
                value={draftDate}
                max={manilaToday()}
                onChange={(v) => setDateDraft((s) => ({ ...s, [r.id]: v }))}
                required
                className="h-7 text-xs focus-visible:border-blue-400 focus-visible:ring-blue-200 dark:bg-zinc-950"
                disabled={isBusy}
              />
            </label>
            {!attended && (
              <input
                type="text"
                value={noteDraft[r.id] ?? ''}
                onChange={(e) => setNoteDraft((s) => ({ ...s, [r.id]: e.target.value }))}
                placeholder="Optional note"
                className="h-7 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 sm:w-[200px]"
                disabled={isBusy}
              />
            )}
            {attended ? (
              <div className="flex items-center gap-2 sm:justify-end">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 bg-gradient-to-r from-blue-600 to-blue-800 text-white hover:from-blue-700 hover:to-blue-900 disabled:opacity-50"
                  onClick={() => markAttended(r.id, draftDate, true)}
                  disabled={isBusy || !dateChanged}
                  title={dateChanged ? 'Save the new orientation date' : 'Pick a different date to update'}
                >
                  {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
                  Update date
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                  onClick={() => unmarkAttended(r.id)}
                  disabled={isBusy}
                >
                  {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  Clear
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 bg-gradient-to-r from-blue-600 to-blue-800 text-white hover:from-blue-700 hover:to-blue-900"
                onClick={() => markAttended(r.id, draftDate)}
                disabled={isBusy}
              >
                {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
                Mark orientation attended
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
              onClick={() => { setConfirmNoShow(r); setNoShowNote(''); }}
              disabled={isBusy}
              title="Did not attend = offboard: same offboarding webhook HR uses — Workspace account removed, access revoked. Cannot be undone."
            >
              <XCircle className="h-3 w-3" />
              Did not attend
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Hires from HR&apos;s New Hire Checklist, grouped by <strong>batch</strong> (the hiring week
        they belong to). Tap <strong>Mark orientation attended</strong> once the employee has shown up
        for orientation. HR cannot promote them to the master list until you do. Marking a hire{' '}
        <strong>Did not attend</strong> <strong className="text-rose-600 dark:text-rose-400">offboards
        them</strong> — it runs the same offboarding webhook HR uses (Google Workspace account removed and
        access revoked), so use it only when a hire truly never showed up. People HR onboarded{' '}
        <strong className="text-violet-700 dark:text-violet-300">manually</strong> (Bypass) also show up
        here — under the week they were onboarded rather than a checklist batch — purely for visibility;
        they&apos;re already active and need nothing from you.
      </p>

      {/* Search + batch filter. Kept above the list so managers can narrow to one
          batch (matching HR's checklist weeks) or search across all of them. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search name, email, department, or role…"
            className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-8 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          <Layers className="h-3.5 w-3.5 text-zinc-400" />
          <span className="sr-only sm:not-sr-only">Batch</span>
          <select
            value={batchFilter}
            onChange={(e) => setBatchFilter(e.target.value)}
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
          >
            <option value="all">All batches ({rows.length})</option>
            {batchKeys.map((k) => (
              <option key={k} value={k}>
                {batchLabelOf(k)} ({batchCounts.get(k) ?? 0})
              </option>
            ))}
          </select>
        </label>
        {/* Export the current view (respects search + batch). */}
        <div className="flex items-center gap-1.5 sm:ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={exportCsv}
            disabled={visibleActive.length + visibleNoShow.length === 0}
            title="Download the hires currently shown as a CSV"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void exportXlsx()}
            disabled={xlsxBusy || visibleActive.length + visibleNoShow.length === 0}
            title="Download the hires currently shown as an Excel workbook (one sheet per batch)"
          >
            {xlsxBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} Excel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={() => void exportPdf()}
            disabled={pdfBusy || historyLoading || historyError != null || summary.totals.total === 0}
            title={
              historyError
                ? `Orientation history failed to load — ${historyError}`
                : 'Download the weekly orientation attendance report (all weeks, not just the current view)'
            }
          >
            {pdfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} PDF
          </Button>
        </div>
      </div>

      {/* Weekly orientation attendance. Scoped to the manager's departments and
          deliberately NOT narrowed by the search / batch filters below — a
          tally that moves while you type is not a tally. */}
      <OrientationSummaryCard
        summary={summary}
        loading={historyLoading}
        error={historyError}
        open={summaryOpen}
        onToggle={() => setSummaryOpen((v) => !v)}
        onRetry={() => void refreshHistory()}
      />

      {visibleActive.length === 0 && visibleNoShow.length === 0 && (
        <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
          <CardContent className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
              <UserPlus className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {filtering ? 'No hires match your filters' : 'No newly hired employees'}
            </p>
            <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
              {filtering
                ? 'Try a different search or batch.'
                : "When HR adds a new hire to a department you manage, they'll show up here."}
            </p>
            {filtering && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => {
                  setSearchQuery('');
                  setBatchFilter('all');
                }}
              >
                <X className="h-3 w-3" /> Clear filters
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {(visibleActive.length > 0 || selectedActiveCount > 0) && (
        <div className="flex flex-col gap-3">
          {/* Multi-select toolbar: mark/update orientation OR bulk "Did not attend"
              for every ticked hire — including ones the search/batch filter has
              hidden, so searching never drops the selection. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-200/70 bg-blue-50/60 px-3 py-2 dark:border-blue-900/50 dark:bg-blue-950/20">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">
              <input
                type="checkbox"
                aria-label="Select all hires"
                className="h-4 w-4 cursor-pointer accent-blue-600"
                checked={allActiveSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someActiveSelected;
                }}
                onChange={toggleAllActive}
                disabled={bulkBusy}
              />
              {selectedActiveCount > 0
                ? `${selectedActiveCount} selected${hiddenSelectedCount > 0 ? ` (${hiddenSelectedCount} hidden by filters)` : ''}`
                : `Select all (${visibleActive.length})`}
            </label>
            {selectedActiveCount > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                  Orientation date
                  <DatePicker
                    value={bulkDate}
                    max={manilaToday()}
                    onChange={setBulkDate}
                    required
                    containerClassName="w-40"
                    className="h-7 text-xs focus-visible:border-blue-400 focus-visible:ring-blue-200 dark:bg-zinc-950"
                    disabled={bulkBusy}
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 bg-gradient-to-r from-blue-600 to-blue-800 px-3 text-xs text-white hover:from-blue-700 hover:to-blue-900"
                  onClick={() => void bulkApply()}
                  disabled={bulkBusy}
                  title="Mark/update orientation for all selected hires to this date"
                >
                  {bulkBusy && bulkProgress?.kind === 'orientation' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
                  {bulkBusy && bulkProgress?.kind === 'orientation'
                    ? `Marking… ${bulkProgress.done}/${bulkProgress.total}`
                    : `Mark / update selected (${selectedActiveCount})`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-rose-200 px-3 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                  onClick={() => { setBulkNoShowNote(''); setConfirmBulkNoShow(true); }}
                  disabled={bulkBusy}
                  title="Mark all selected hires as did not attend — offboards them (same webhook HR uses). Cannot be undone."
                >
                  <XCircle className="h-3 w-3" />
                  Did not attend ({selectedActiveCount})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelected(new Set())}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>

          {/* Cards grouped by batch (hiring week), newest batch first. */}
          {activeBatchKeys.map((k) => {
            const batchRows = activeByBatch.get(k) ?? [];
            return (
              <div key={k} className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  <Layers className="h-3 w-3" /> {batchLabelOf(k)}
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                    {batchRows.length}
                  </span>
                </p>
                {batchRows.map((r) => <HireCard key={r.id} r={r} />)}
              </div>
            );
          })}
        </div>
      )}

      {visibleNoShow.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-3 w-3" /> No-shows ({visibleNoShow.length})
          </p>
          {visibleNoShow.map((r) => <HireCard key={r.id} r={r} />)}
        </div>
      )}

      {/* Confirm "Did not attend" dialog */}
      {confirmNoShow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-rose-200 bg-white p-6 shadow-xl dark:border-rose-900/50 dark:bg-zinc-950">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-rose-700 text-white">
                <XCircle className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-white">Did not attend = offboard {confirmNoShow.name}?</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Marking <span className="font-medium">{confirmNoShow.name}</span> as a no-show <strong>offboards them</strong> — the same account teardown HR runs for a departing employee. This cannot be undone.
                </p>
              </div>
            </div>
            {confirmNoShow.work_email ? (
              <ul className="mt-3 space-y-1 rounded-lg border border-rose-200 bg-rose-50/70 p-2.5 text-[11px] leading-relaxed text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-300">
                <li>• Google Workspace account (<span className="font-mono">{confirmNoShow.work_email}</span>) disabled &amp; deleted</li>
                <li>• HRIS &amp; app access revoked immediately</li>
                <li>• Fires the same offboarding webhook HR uses (Workspace + Hubstaff teardown)</li>
                <li>• Removed from the promote queue — HR can&apos;t promote them</li>
              </ul>
            ) : (
              <p className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                No work account exists yet — this just records the no-show; nothing to tear down.
              </p>
            )}
            <input
              type="text"
              value={noShowNote}
              onChange={(e) => setNoShowNote(e.target.value)}
              placeholder="Optional note (e.g. unreachable, rescheduled)"
              className="mt-3 h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { setConfirmNoShow(null); setNoShowNote(''); }}
                disabled={busyId === confirmNoShow.id}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-1.5 bg-gradient-to-br from-rose-500 to-rose-700 text-white hover:opacity-90"
                onClick={() => void markNoShow(confirmNoShow)}
                disabled={busyId === confirmNoShow.id}
              >
                {busyId === confirmNoShow.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <XCircle className="h-3.5 w-3.5" />
                )}
                Confirm no-show
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk "Did not attend" confirm — lists everyone selected before firing
          the offboarding teardown for each. Destructive + irreversible. */}
      {confirmBulkNoShow && (() => {
        const targets = selectedActiveRows;
        const withAccount = targets.filter((r) => !!r.work_email).length;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 shadow-xl dark:border-rose-900/50 dark:bg-zinc-950">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-rose-700 text-white">
                  <XCircle className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                    Did not attend = offboard {targets.length} hire{targets.length !== 1 ? 's' : ''}?
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Each of these hires is <strong>offboarded</strong> — the same account teardown HR
                    runs for a departing employee. This cannot be undone.
                  </p>
                </div>
              </div>

              <div className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50/60 p-2 dark:border-rose-900/50 dark:bg-rose-950/20">
                {targets.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 text-[11px] text-rose-700 dark:text-rose-300">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{r.name}</span>
                      <span className="ml-1.5 text-rose-500/80 dark:text-rose-400/80">{r.department}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-rose-500/80 dark:text-rose-400/80">
                      {r.work_email ? r.work_email : 'no work account'}
                    </span>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                {withAccount > 0
                  ? `${withAccount} of ${targets.length} have a Google Workspace account that will be disabled & deleted and access revoked. The rest are recorded as no-shows only.`
                  : 'None have a work account yet — this just records the no-shows; nothing to tear down.'}
              </p>

              <input
                type="text"
                value={bulkNoShowNote}
                onChange={(e) => setBulkNoShowNote(e.target.value)}
                placeholder="Optional note applied to all (e.g. batch never onboarded)"
                className="mt-3 h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
              />

              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmBulkNoShow(false)}
                  disabled={bulkBusy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5 bg-gradient-to-br from-rose-500 to-rose-700 text-white hover:opacity-90"
                  onClick={() => void bulkNoShow()}
                  disabled={bulkBusy}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Confirm — offboard {targets.length}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Live bulk progress — real-time tally of how many hires have actually
          been processed, with a per-hire failure list on completion. Serves both
          the orientation-mark and the no-show runs (copy varies by kind). */}
      {bulkProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-blue-200 bg-white p-6 shadow-xl dark:border-blue-900/50 dark:bg-zinc-950">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white',
                  !bulkProgress.finished
                    ? 'bg-gradient-to-br from-blue-500 to-blue-700'
                    : bulkProgress.fail === 0
                      ? 'bg-gradient-to-br from-emerald-500 to-emerald-700'
                      : 'bg-gradient-to-br from-amber-500 to-amber-700',
                )}
              >
                {!bulkProgress.finished ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : bulkProgress.fail === 0 ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                  {bulkProgress.kind === 'no-show'
                    ? bulkProgress.finished
                      ? 'Offboarding complete'
                      : 'Marking did not attend…'
                    : bulkProgress.finished
                      ? 'Orientation marking complete'
                      : 'Marking orientation attended…'}
                </p>
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {bulkProgress.finished
                    ? `${bulkProgress.ok} of ${bulkProgress.total} ${bulkProgress.kind === 'no-show' ? 'offboarded' : 'marked as attended'}`
                    : bulkProgress.current
                      ? `Now ${bulkProgress.kind === 'no-show' ? 'offboarding' : 'marking'} ${bulkProgress.current}`
                      : 'Starting…'}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                <span>{bulkProgress.done} of {bulkProgress.total} processed</span>
                <span>{Math.round((bulkProgress.done / bulkProgress.total) * 100)}%</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    bulkProgress.fail === 0
                      ? 'bg-gradient-to-r from-blue-500 to-emerald-500'
                      : 'bg-gradient-to-r from-blue-500 to-amber-500',
                  )}
                  style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" /> {bulkProgress.ok} {bulkProgress.kind === 'no-show' ? 'offboarded' : 'marked'}
                </span>
                {bulkProgress.fail > 0 && (
                  <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-300">
                    <XCircle className="h-3 w-3" /> {bulkProgress.fail} failed
                  </span>
                )}
              </div>
            </div>

            {bulkProgress.failures.length > 0 && (
              <div className="mt-3 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50/60 p-2 dark:border-rose-900/50 dark:bg-rose-950/20">
                {bulkProgress.failures.map((f, i) => (
                  <div key={i} className="text-[11px] text-rose-700 dark:text-rose-300">
                    <span className="font-medium">{f.name}</span> — {f.error}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                size="sm"
                className="gap-1.5 bg-gradient-to-br from-blue-600 to-blue-800 text-white hover:opacity-90 disabled:opacity-60"
                onClick={closeBulkProgress}
                disabled={!bulkProgress.finished}
              >
                {bulkProgress.finished ? (
                  'Done'
                ) : (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {viewerEmail && (
        <p className="text-[10px] italic text-zinc-400 dark:text-zinc-500">
          Signed in as <span className="font-mono">{viewerEmail}</span> — attendance markers are
          attributed to this email.
        </p>
      )}
    </div>
  );
}
