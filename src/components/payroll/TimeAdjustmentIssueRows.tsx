'use client';

/**
 * Accounting → Issues: the time-adjustment row and its three dialogs.
 *
 * Split out of `PabDisputeQueue.tsx` so the merged Issues table gains a third row
 * kind without another 600 lines in a 1,900-line file. Every rule these render is a
 * pure function in `src/lib/accounting/issues-time-adjustments.ts` (tested); this
 * file is JSX only. Doc: `docs/features/time-adjustment-requests.md` § Accounting flow.
 *
 * Accounting can ACT on `manager_approved` rows only — both stage-1 signatures in.
 * Upstream rows render read-only so a live request is never invisible here. Approve
 * requires a day total: `decideTimeAdjustment` treats null hours as "no override",
 * so an approval with no value would move no money, and the button stays disabled.
 */

import { useEffect, useState } from 'react';
import { Clock, Eye, ImageOff, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import {
  approvedHoursFromInputs,
  canApproveTimeAdjustment,
  fmtTimeAdjustmentHours,
  timeAdjustmentAwaitsAccounting,
  timeAdjustmentHoursPrefill,
  timeAdjustmentIsDeletable,
  timeAdjustmentReasonLabel,
  timeAdjustmentRequestedLabel,
  timeAdjustmentTrail,
  TIME_ADJUSTMENT_STATUS_BADGE,
} from '@/lib/accounting/issues-time-adjustments';

export type TimeAdjustmentDecideTarget = { row: TimeAdjustmentRow; action: 'approve' | 'deny' };

const ROLE_HINT = 'Requires accounting, hr_coordinator, or admin';

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toLocaleString();
}

/* ── The table row ────────────────────────────────────────────────────────── */

export function TimeAdjustmentIssueTableRow({
  row: r,
  canApprove,
  canDelete,
  acting,
  onView,
  onApprove,
  onDeny,
  onDelete,
}: {
  row: TimeAdjustmentRow;
  canApprove: boolean;
  canDelete: boolean;
  acting: boolean;
  onView: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onDelete: () => void;
}) {
  const badge = TIME_ADJUSTMENT_STATUS_BADGE[r.status];
  const actionable = timeAdjustmentAwaitsAccounting(r);
  const requested = timeAdjustmentRequestedLabel(r);
  const setHours = r.status === 'approved' ? fmtTimeAdjustmentHours(r.approved_hours) : null;
  const secondName = r.second_decided_by ?? r.second_approver_email;

  return (
    <TableRow className="border-indigo-100/70 transition-colors hover:bg-indigo-50/50 dark:border-indigo-900/30 dark:hover:bg-indigo-950/20">
      <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{r.work_email}</TableCell>
      <TableCell className="whitespace-nowrap text-sm text-zinc-700 dark:text-zinc-300">{r.adjust_date}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <Badge
            variant="outline"
            className="gap-1 border-sky-300 bg-sky-50 text-[10px] text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
          >
            <Clock className="h-3 w-3" />
            Time adjustment
          </Badge>
          <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{timeAdjustmentReasonLabel(r.reason)}</span>
        </div>
      </TableCell>
      <TableCell className="min-w-[220px] max-w-[320px] align-top text-xs text-zinc-600 dark:text-zinc-400">
        {requested && (
          <p className="font-mono text-[11px] font-medium text-emerald-700 dark:text-emerald-400">{requested}</p>
        )}
        {r.explanation ? (
          <p className="mt-0.5 whitespace-pre-line leading-snug">{r.explanation}</p>
        ) : !requested ? (
          '—'
        ) : null}
        <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
          Manager {r.manager_decided_by ?? '—'} · Second approver {secondName ?? '—'}
        </p>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={cn('text-[10px]', badge.className)}>
          {badge.label}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        {setHours ? (
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            {setHours}
          </span>
        ) : (
          <span className="text-[10px] text-zinc-400">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-zinc-500 dark:text-zinc-400">
        {r.decided_by ? (
          <div className="flex flex-col gap-0.5">
            <span>{r.decided_by}</span>
            {r.decision_note && <span className="text-[10px] italic">{r.decision_note}</span>}
          </div>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="min-w-[260px] text-right align-top">
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-indigo-200 px-2 text-[11px] text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
            title="View details and evidence"
            onClick={onView}
          >
            <Eye className="mr-1 h-3 w-3" />
            View
          </Button>
          {actionable && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!canApprove || acting}
                title={!canApprove ? ROLE_HINT : 'Set the day total and approve'}
                className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400"
                onClick={onApprove}
              >
                {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canApprove || acting}
                title={!canApprove ? ROLE_HINT : undefined}
                className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                onClick={onDeny}
              >
                Deny
              </Button>
            </>
          )}
          {timeAdjustmentIsDeletable(r) && canDelete && (
            <Button
              size="sm"
              variant="outline"
              disabled={acting}
              title="Delete this denied request (accounting / admin only)"
              className="h-7 w-7 border-zinc-200 p-0 text-rose-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-rose-400 dark:hover:border-rose-800 dark:hover:bg-rose-950/40"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ── The dialogs: View (with evidence + lightbox), Decide, Delete ─────────── */

export function TimeAdjustmentIssueDialogs({
  viewTarget,
  onCloseView,
  signedUrls,
  decideTarget,
  onCloseDecide,
  onSubmitDecide,
  acting,
  canApprove,
  deleteTarget,
  onCloseDelete,
  onConfirmDelete,
  deleting,
}: {
  viewTarget: TimeAdjustmentRow | null;
  onCloseView: () => void;
  signedUrls: Record<string, string>;
  decideTarget: TimeAdjustmentDecideTarget | null;
  onCloseDecide: () => void;
  /** Resolves true when the server accepted; the dialog closes only then. */
  onSubmitDecide: (
    row: TimeAdjustmentRow,
    action: 'approve' | 'deny',
    approvedHours: number | null,
    note: string,
  ) => Promise<boolean>;
  acting: boolean;
  canApprove: boolean;
  deleteTarget: TimeAdjustmentRow | null;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
  deleting: boolean;
}) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!lightboxUrl) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxUrl(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxUrl]);

  // Decide-dialog inputs reset per target: a legacy row prefills its claimed day
  // total, a segment row starts blank (the missed time is not the day total).
  const [hrs, setHrs] = useState('');
  const [mins, setMins] = useState('');
  const [note, setNote] = useState('');
  const decideRowId = decideTarget?.row.id ?? null;
  useEffect(() => {
    if (!decideTarget) return;
    const prefill = timeAdjustmentHoursPrefill(decideTarget.row);
    setHrs(prefill.hours);
    setMins(prefill.minutes);
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decideRowId]);

  const approvedHours = approvedHoursFromInputs(hrs, mins);
  const approveCheck = decideTarget
    ? canApproveTimeAdjustment({ row: decideTarget.row, canApprove, approvedHours })
    : null;
  const submitBlocked =
    acting ||
    !decideTarget ||
    (decideTarget.action === 'approve' && approveCheck != null && !approveCheck.ok) ||
    (decideTarget.action === 'deny' && !canApprove);

  return (
    <>
      {/* Evidence lightbox — above every dialog; Escape / click closes just this layer */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-in fade-in duration-200 motion-reduce:animate-none"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative max-h-[88vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightboxUrl} alt="Evidence" className="max-h-[88vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" />
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              aria-label="Close"
              className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800/90 text-white ring-1 ring-zinc-600 transition hover:bg-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* View details — same shell as the dispute and Bank Preferred View modals */}
      {viewTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px] animate-in fade-in duration-200 ease-out motion-reduce:animate-none"
          onClick={onCloseView}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Time adjustment details"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-950 motion-reduce:animate-none"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-sm shadow-sky-500/20 dark:from-sky-600 dark:to-indigo-700">
                  <Clock className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                    Time adjustment · {timeAdjustmentReasonLabel(viewTarget.reason)}
                  </p>
                  <h3 className="mt-0.5 truncate font-mono text-sm font-bold text-zinc-900 dark:text-white">
                    {viewTarget.work_email}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={onCloseView}
                aria-label="Close"
                className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Date</p>
                  <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{viewTarget.adjust_date}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Status</p>
                  <div className="mt-1">
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', TIME_ADJUSTMENT_STATUS_BADGE[viewTarget.status].className)}
                    >
                      {TIME_ADJUSTMENT_STATUS_BADGE[viewTarget.status].label}
                    </Badge>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Requested</p>
                <p className="mt-0.5 font-mono text-sm text-zinc-800 dark:text-zinc-200">
                  {timeAdjustmentRequestedLabel(viewTarget) ?? '—'}
                </p>
                {(viewTarget.requested_segments ?? []).length > 0 && (
                  <p className="mt-0.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
                    Missed time to ADD on top of what Hubstaff tracked — not the day total.
                  </p>
                )}
              </div>

              {viewTarget.explanation && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Employee explanation</p>
                  <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {viewTarget.explanation}
                  </p>
                </div>
              )}

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Proof attached ({viewTarget.image_paths.length})
                </p>
                {viewTarget.image_paths.length === 0 ? (
                  <p className="mt-1 text-xs italic text-zinc-400">No evidence images attached.</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {viewTarget.image_paths.map((p, idx) => {
                      const url = signedUrls[p];
                      return url ? (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setLightboxUrl(url)}
                          className="group relative h-20 w-20 overflow-hidden rounded-md border border-zinc-200 transition-transform duration-150 hover:scale-105 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-500"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`evidence ${idx + 1}`} className="h-full w-full object-cover" />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/25">
                            <Eye className="h-3.5 w-3.5 scale-0 text-white drop-shadow transition-transform group-hover:scale-100" />
                          </div>
                        </button>
                      ) : (
                        <div
                          key={idx}
                          title="Evidence link expired — refresh the queue"
                          className="flex h-20 w-20 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                        >
                          <ImageOff className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Decision trail</p>
                <ol className="mt-1.5 space-y-1.5">
                  {timeAdjustmentTrail(viewTarget).map((step, i) => {
                    const when = fmtWhen(step.when);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                        <div className="min-w-0">
                          <p className="text-zinc-700 dark:text-zinc-300">
                            <span className="font-medium">{step.who}</span> {step.what}
                            {when && <span className="ml-1.5 text-[10px] text-zinc-400">· {when}</span>}
                          </p>
                          {step.note && <p className="text-[11px] italic text-zinc-500 dark:text-zinc-400">{step.note}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              {viewTarget.status === 'approved' && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Day set to</p>
                  <p className="mt-0.5 font-mono text-sm text-emerald-700 dark:text-emerald-400">
                    {fmtTimeAdjustmentHours(viewTarget.approved_hours) ?? 'no override recorded'}
                  </p>
                </div>
              )}
            </div>

            <div className="flex shrink-0 justify-end border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <Button variant="outline" size="sm" onClick={onCloseView}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Decide — Approve needs the day total; Deny takes a note */}
      {decideTarget && (
        <Dialog open onOpenChange={(open) => { if (!open && !acting) onCloseDecide(); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {decideTarget.action === 'approve' ? 'Approve time adjustment' : 'Deny time adjustment'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {decideTarget.row.work_email} — {decideTarget.row.adjust_date} —{' '}
                {timeAdjustmentReasonLabel(decideTarget.row.reason)}
                {timeAdjustmentRequestedLabel(decideTarget.row) && (
                  <span className="mt-1 block font-mono text-[10.5px] text-emerald-700 dark:text-emerald-400">
                    {timeAdjustmentRequestedLabel(decideTarget.row)}
                  </span>
                )}
                {decideTarget.action === 'deny' && (
                  <span className="mt-1 block text-[10px] text-zinc-500">
                    Denying ends the request; the employee is notified with your note.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {decideTarget.action === 'approve' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Set the employee&apos;s FINAL total for this day</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="24"
                        placeholder="0"
                        value={hrs}
                        onChange={(e) => setHrs(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">hrs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="59"
                        placeholder="0"
                        value={mins}
                        onChange={(e) => setMins(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">mins</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    {(decideTarget.row.requested_segments ?? []).length > 0
                      ? 'Tracked hours PLUS the missed time above. This replaces the Hubstaff total for the day at pay-calc time; the tracked data itself is never changed.'
                      : 'Replaces the Hubstaff total for this day at pay-calc time; the tracked data itself is never changed.'}
                  </p>
                  {approveCheck && !approveCheck.ok && (
                    <p className="text-[10.5px] font-medium text-amber-700 dark:text-amber-400">{approveCheck.reason}</p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Decision note {decideTarget.action === 'approve' ? '(optional)' : '(recommended)'}</Label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="Optional note..."
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={onCloseDecide} disabled={acting}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={submitBlocked}
                title={approveCheck && !approveCheck.ok && decideTarget.action === 'approve' ? approveCheck.reason : undefined}
                className={decideTarget.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}
                onClick={async () => {
                  const ok = await onSubmitDecide(
                    decideTarget.row,
                    decideTarget.action,
                    decideTarget.action === 'approve' ? approvedHours : null,
                    note,
                  );
                  if (ok) onCloseDecide();
                }}
              >
                {acting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                {decideTarget.action === 'approve' ? 'Approve' : 'Deny'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete — denied rows only (the server refuses anything else) */}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => { if (!open && !deleting) onCloseDelete(); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950/60">
                  <Trash2 className="size-4 text-rose-600 dark:text-rose-400" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-sm">Delete time adjustment request</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs">
                    This permanently removes the record. Cannot be undone.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-2 text-[12.5px] text-zinc-700 dark:text-zinc-300">
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Employee</span>{' '}
                <span className="font-medium">{deleteTarget.work_email}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Date</span>{' '}
                <span className="font-medium">{deleteTarget.adjust_date}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Status</span>{' '}
                <span className="font-medium">{TIME_ADJUSTMENT_STATUS_BADGE[deleteTarget.status].label}</span>
              </p>
              <p className="rounded-md border border-amber-200/60 bg-amber-50/70 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                Only denied requests can be deleted; the employee&apos;s tracked hours are untouched either way. The
                deletion is logged as <code className="font-mono">time_adjustment.deleted</code>.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" disabled={deleting} onClick={onCloseDelete}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={deleting}
                onClick={onConfirmDelete}
                className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
