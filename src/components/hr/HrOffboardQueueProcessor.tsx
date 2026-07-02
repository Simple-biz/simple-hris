'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  Loader2,
  SkipForward,
  Undo2,
  UserMinus,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  OFFBOARD_REASON_OPTIONS,
  type OffboardReason,
} from '@/lib/hr/offboard-reasons';
import type { OffboardingQueueRow } from '@/lib/supabase/offboarding-queue';

interface Props {
  open: boolean;
  items: OffboardingQueueRow[];
  onOpenChange: (open: boolean) => void;
  /** Refresh the queue + roster + history after the session ends. */
  onFinished: () => void;
}

type Outcome = 'completed' | 'dismissed' | 'returned' | 'skipped';

export default function HrOffboardQueueProcessor({ open, items, onOpenChange, onFinished }: Props) {
  const [idx, setIdx] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [reasonById, setReasonById] = useState<Record<string, OffboardReason | ''>>({});
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'offboard' | 'dismiss' | 'return'>(null);
  // When set, the reason box is shown for a dismiss (reject) or return (send back).
  const [actionMode, setActionMode] = useState<null | 'dismiss' | 'return'>(null);
  const [actionReason, setActionReason] = useState('');
  const claimedRef = useRef<string[]>([]);

  const itemsKey = useMemo(() => items.map((i) => i.id).join(','), [items]);

  // On open: claim the batch (→ 'processing') and seed editable reason/note.
  useEffect(() => {
    if (!open || items.length === 0) return;
    const ids = items.map((i) => i.id);
    claimedRef.current = ids;
    setIdx(0);
    setOutcomes({});
    setActionMode(null);
    setActionReason('');
    const r: Record<string, OffboardReason | ''> = {};
    const n: Record<string, string> = {};
    for (const it of items) {
      r[it.id] = (it.reason as OffboardReason) || '';
      n[it.id] = it.note ?? '';
    }
    setReasonById(r);
    setNoteById(n);
    fetch('/api/offboarding-queue', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action: 'claim' }),
    }).catch(() => {
      /* best-effort — claiming just drives the "Processing" badge */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemsKey]);

  const current = items[idx] ?? null;
  const total = items.length;
  const doneCount = Object.keys(outcomes).length;
  const finished = doneCount >= total;

  const advance = useCallback(() => {
    setActionMode(null);
    setActionReason('');
    setIdx((i) => Math.min(i + 1, total));
  }, [total]);

  const markOutcome = (id: string, o: Outcome) => setOutcomes((prev) => ({ ...prev, [id]: o }));

  // Close: release any still-'processing' (unhandled) rows back to pending, then refresh.
  const handleClose = useCallback(() => {
    const handled = new Set(Object.keys(outcomes));
    const toRelease = claimedRef.current.filter((id) => {
      const o = outcomes[id];
      // completed / dismissed / returned are terminal (they carry a non-skip
      // outcome, so they're retained); only skipped or never-reached rows go
      // back to pending. (The server release also only flips 'processing' rows,
      // so a terminal row could never be reverted even if it slipped through.)
      return !handled.has(id) || o === 'skipped';
    });
    if (toRelease.length > 0) {
      fetch('/api/offboarding-queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: toRelease, action: 'release' }),
      }).catch(() => {
        /* best-effort */
      });
    }
    onOpenChange(false);
    onFinished();
  }, [outcomes, onOpenChange, onFinished]);

  const handleOffboard = async () => {
    if (!current) return;
    const reason = reasonById[current.id] || '';
    const note = (noteById[current.id] ?? '').trim();
    if (!reason) {
      toast.error('Pick a reason before offboarding');
      return;
    }
    if (reason === 'other' && !note) {
      toast.error('A note is required when the reason is "Other"');
      return;
    }
    if (!current.employee_work_email) {
      toast.error('No work email on file — dismiss this request and handle manually');
      return;
    }
    setBusy('offboard');
    try {
      // 1) The actual account teardown (existing single-employee endpoint).
      const res = await fetch('/api/hr/offboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: current.employee_work_email, reason, note: note || null }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        webhook?: { fired: boolean; status: number | null; error: string | null };
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to off-board');

      // 2) Mark the queue row completed (notifies the requesting manager). The
      //    offboard above is the source of truth and already ran, so we advance
      //    regardless — but validate this bookkeeping call so a failure surfaces
      //    instead of silently leaving the row stuck in "processing".
      const who = current.employee_name ?? current.employee_work_email;
      const patchRes = await fetch(`/api/offboarding-queue/${current.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'completed', offboard_reason: reason, note: note || null }),
      }).catch(() => null);
      const patchJson = patchRes ? await patchRes.json().catch(() => ({})) : {};
      const queueUpdated = !!patchRes && patchRes.ok && (patchJson as { success?: boolean }).success === true;

      const webhookOk = json.webhook?.error == null && json.webhook?.fired;
      if (!queueUpdated) {
        toast.warning(`${who} off-boarded — but the queue entry didn't update`, {
          description: 'The person was off-boarded. Refresh the queue; the row may still show as Processing.',
          duration: 7000,
        });
      } else if (webhookOk) {
        toast.success(`${who} off-boarded`);
      } else {
        toast.warning(`${who} off-boarded — workflow didn't fire`, {
          description: `Roster updated, but the offboarding webhook returned: ${json.webhook?.error ?? 'unknown error'}.`,
          duration: 7000,
        });
      }
      // The account teardown succeeded — never re-offboard on retry, so record
      // it as completed locally even if the queue-row PATCH hiccupped.
      markOutcome(current.id, 'completed');
      advance();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to off-board');
    } finally {
      setBusy(null);
    }
  };

  // Dismiss (reject outright) or Return (send back to the manager for revision).
  // Both need a reason and notify the requesting manager.
  const handleReasonedDecision = async (mode: 'dismiss' | 'return') => {
    if (!current) return;
    const note = actionReason.trim();
    if (!note) {
      toast.error(mode === 'dismiss' ? 'A dismissal reason is required' : 'A reason for returning is required');
      return;
    }
    setBusy(mode);
    try {
      const decision = mode === 'dismiss' ? 'dismissed' : 'returned';
      const res = await fetch(`/api/offboarding-queue/${current.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Request failed');
      const who = current.employee_name ?? current.employee_email;
      if (mode === 'dismiss') {
        toast.success(`Request for ${who} dismissed`);
        markOutcome(current.id, 'dismissed');
      } else {
        toast.success(`Sent ${who} back to ${current.requested_by_name ?? current.requested_by}`);
        markOutcome(current.id, 'returned');
      }
      advance();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${mode}`);
    } finally {
      setBusy(null);
    }
  };

  const handleSkip = () => {
    if (!current) return;
    markOutcome(current.id, 'skipped');
    advance();
  };

  const initials = (name: string | null, email: string | null) =>
    name
      ? name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
      : email?.[0]?.toUpperCase() ?? '?';

  const completedCount = Object.values(outcomes).filter((o) => o === 'completed').length;
  const dismissedCount = Object.values(outcomes).filter((o) => o === 'dismissed').length;
  const returnedCount = Object.values(outcomes).filter((o) => o === 'returned').length;
  const skippedCount = Object.values(outcomes).filter((o) => o === 'skipped').length;

  const showDone = finished || (idx >= total && total > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && handleClose()}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-[480px]">
        {/* Header + progress */}
        <div className="relative overflow-hidden bg-[#1a0a0a] px-5 pb-4 pt-5">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-rose-700 via-rose-400 to-rose-700" />
          <div className="relative flex items-center justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-500/80">
                Process offboarding queue
              </p>
              <p className="mt-0.5 text-[15px] font-semibold text-zinc-100">
                {showDone ? 'All done' : `Person ${Math.min(idx + 1, total)} of ${total}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => !busy && handleClose()}
              disabled={!!busy}
              className="rounded-md p-1 text-zinc-600 transition-colors hover:bg-zinc-800/60 hover:text-zinc-300 disabled:opacity-40"
              aria-label="Close"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
          {/* progress track */}
          <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-zinc-800">
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-600 to-rose-400"
              initial={false}
              animate={{ width: `${total === 0 ? 0 : (doneCount / total) * 100}%` }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>

        {/* Body */}
        <div className="bg-zinc-950/60 p-5">
          <AnimatePresence mode="wait" initial={false}>
            {showDone ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col items-center gap-3 py-4 text-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-900/40 text-emerald-300 ring-1 ring-emerald-700/40">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold text-zinc-100">Queue processed</p>
                <p className="text-xs text-zinc-400">
                  {completedCount} offboarded · {dismissedCount} dismissed · {returnedCount} returned · {skippedCount} left pending
                </p>
                <Button
                  type="button"
                  onClick={handleClose}
                  className="mt-1 gap-1.5 border-0 bg-zinc-100 text-zinc-900 hover:bg-white"
                >
                  Done
                </Button>
              </motion.div>
            ) : current ? (
              <motion.div
                key={current.id}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -32 }}
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-4"
              >
                {/* Who */}
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-900/60 text-sm font-bold text-rose-200 ring-1 ring-rose-700/50">
                    {initials(current.employee_name, current.employee_work_email ?? current.employee_personal_email)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-zinc-100">
                      {current.employee_name ?? current.employee_work_email ?? current.employee_email}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-500">
                      {current.employee_work_email ?? current.employee_personal_email ?? '—'}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {current.department && (
                        <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-zinc-700/50">
                          {current.department}
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-500">
                        requested by {current.requested_by_name ?? current.requested_by}
                      </span>
                    </div>
                  </div>
                </div>

                {!current.employee_work_email && (
                  <p className="flex items-start gap-1.5 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    No work email on file — this person can’t be auto-offboarded. Dismiss and handle manually.
                  </p>
                )}

                {!actionMode ? (
                  <>
                    {/* Reason (pre-filled from the manager's request) */}
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                        Reason <span className="text-rose-500">*</span>
                        <span className="ml-1.5 font-normal normal-case tracking-normal text-zinc-600">from manager — editable</span>
                      </label>
                      <Select
                        value={reasonById[current.id] || ''}
                        onValueChange={(v) => v && setReasonById((p) => ({ ...p, [current.id]: v as OffboardReason }))}
                      >
                        <SelectTrigger className="w-full border-zinc-800 bg-zinc-900/80 text-sm text-zinc-200 data-[size=default]:h-9 hover:border-zinc-700">
                          <SelectValue placeholder="Select a reason" />
                        </SelectTrigger>
                        <SelectContent side="bottom" alignItemWithTrigger={false} className="border-zinc-800 bg-zinc-900">
                          {OFFBOARD_REASON_OPTIONS.map((r) => (
                            <SelectItem key={r.value} value={r.value} className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Note */}
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                        Note {reasonById[current.id] === 'other' && <span className="text-rose-500">*</span>}
                      </label>
                      <textarea
                        value={noteById[current.id] ?? ''}
                        onChange={(e) => setNoteById((p) => ({ ...p, [current.id]: e.target.value }))}
                        rows={2}
                        placeholder="Anything HR should record"
                        className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                      />
                    </div>
                  </>
                ) : (
                  /* Dismiss / Return reason box */
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                      {actionMode === 'dismiss' ? 'Dismissal reason' : 'Reason for returning'} <span className="text-rose-500">*</span>
                    </label>
                    <textarea
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      rows={2}
                      autoFocus
                      placeholder={
                        actionMode === 'dismiss'
                          ? 'Why are you dismissing this request? (the manager is notified)'
                          : 'What should the manager fix or reconsider? (sent back to them)'
                      }
                      className={cn(
                        'w-full resize-none rounded-lg bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none',
                        actionMode === 'dismiss'
                          ? 'border border-rose-900/50 focus:border-rose-700'
                          : 'border border-amber-900/50 focus:border-amber-600',
                      )}
                    />
                  </div>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Footer actions */}
        {!showDone && current && (
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950/80 p-4">
            {!actionMode ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActionMode('dismiss')}
                  disabled={!!busy}
                  className="gap-1.5 border-zinc-800 bg-transparent text-zinc-400 hover:border-rose-800/60 hover:bg-rose-950/20 hover:text-rose-300"
                >
                  <Ban className="h-3.5 w-3.5" /> Dismiss
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActionMode('return')}
                  disabled={!!busy}
                  title="Send this request back to the manager for revision"
                  className="gap-1.5 border-zinc-800 bg-transparent text-zinc-400 hover:border-amber-800/60 hover:bg-amber-950/20 hover:text-amber-300"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Return
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSkip}
                  disabled={!!busy}
                  className="ml-auto gap-1.5 border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-200"
                >
                  <SkipForward className="h-3.5 w-3.5" /> Skip
                </Button>
                <Button
                  type="button"
                  onClick={handleOffboard}
                  disabled={!!busy || !current.employee_work_email}
                  title="Off-boards the person and triggers the account-teardown automation"
                  className="gap-1.5 border-0 bg-rose-700 text-white hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600"
                >
                  {busy === 'offboard' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
                  Offboard
                  {idx + 1 < total && <ArrowRight className="h-3.5 w-3.5" />}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setActionMode(null); setActionReason(''); }}
                  disabled={!!busy}
                  className="border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-200"
                >
                  Back
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleReasonedDecision(actionMode)}
                  disabled={!!busy || !actionReason.trim()}
                  className={cn(
                    'ml-auto gap-1.5 border-0 text-white disabled:bg-zinc-800 disabled:text-zinc-600',
                    actionMode === 'dismiss' ? 'bg-rose-700 hover:bg-rose-600' : 'bg-amber-600 hover:bg-amber-500',
                  )}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : actionMode === 'dismiss' ? (
                    <Ban className="h-3.5 w-3.5" />
                  ) : (
                    <Undo2 className="h-3.5 w-3.5" />
                  )}
                  {actionMode === 'dismiss' ? 'Confirm dismiss' : 'Send back to manager'}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
