'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Loader2, Pencil, RotateCcw, UserMinus, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SmoothSelect, type SmoothSelectOption } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import {
  OFFBOARD_REASON_OPTIONS,
  type OffboardReason,
} from '@/lib/hr/offboard-reasons';

// Temporary Pause only suspends the account (no actual offboarding) — that
// call belongs to HR, so managers see it greyed out here rather than in the queue.
const REASON_OPTIONS: SmoothSelectOption<OffboardReason | ''>[] = [
  { value: '', label: 'Select a reason' },
  ...OFFBOARD_REASON_OPTIONS.map((r) => ({
    value: r.value,
    label: r.label,
    disabled: r.value === 'temporary_pause',
  })),
];

export interface OffboardCandidate {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
}

interface Props {
  open: boolean;
  people: OffboardCandidate[];
  onOpenChange: (open: boolean) => void;
  /** Called with the emails successfully queued so the caller can clear them. */
  onSubmitted?: (queuedKeys: string[]) => void;
}

type RowState = {
  key: string;
  reason: OffboardReason | '';
  note: string;
  /** true once the manager edits this row away from the shared default */
  overridden: boolean;
};

/** Stable per-person key (matches the selection key used in My Team). */
export function candidateKey(c: OffboardCandidate): string {
  return (c.work_email ?? c.personal_email ?? c.name ?? '').trim().toLowerCase();
}

function initials(name: string | null, email: string | null): string {
  if (name) {
    return name
      .split(/[\s,]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }
  return email?.[0]?.toUpperCase() ?? '?';
}

export default function ManagerOffboardQueueDialog({ open, people, onOpenChange, onSubmitted }: Props) {
  const [defaultReason, setDefaultReason] = useState<OffboardReason | ''>('');
  const [defaultNote, setDefaultNote] = useState('');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [submitting, setSubmitting] = useState(false);

  // Seed a row per person whenever the dialog opens (or the selection changes).
  useEffect(() => {
    if (!open) return;
    setDefaultReason('');
    setDefaultNote('');
    const next: Record<string, RowState> = {};
    for (const p of people) {
      const k = candidateKey(p);
      if (!k) continue;
      next[k] = { key: k, reason: '', note: '', overridden: false };
    }
    setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, people.map(candidateKey).join('|')]);

  // Pushing a shared default fills every row that hasn't been individually edited.
  const applyDefaultReason = (r: OffboardReason) => {
    setDefaultReason(r);
    setRows((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (!next[k].overridden) next[k] = { ...next[k], reason: r };
      }
      return next;
    });
  };
  const applyDefaultNote = (n: string) => {
    setDefaultNote(n);
    setRows((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (!next[k].overridden) next[k] = { ...next[k], note: n };
      }
      return next;
    });
  };

  const setRowReason = (k: string, r: OffboardReason) =>
    setRows((prev) => ({ ...prev, [k]: { ...prev[k], reason: r, overridden: true } }));
  const setRowNote = (k: string, n: string) =>
    setRows((prev) => ({ ...prev, [k]: { ...prev[k], note: n, overridden: true } }));
  const resetRow = (k: string) =>
    setRows((prev) => ({ ...prev, [k]: { ...prev[k], reason: defaultReason, note: defaultNote, overridden: false } }));

  const orderedPeople = useMemo(
    () => people.filter((p) => candidateKey(p)),
    [people],
  );

  // Everyone needs a reason; "other" needs a note.
  const invalid = orderedPeople.filter((p) => {
    const rs = rows[candidateKey(p)];
    if (!rs) return true;
    if (!rs.reason) return true;
    if (rs.reason === 'other' && !rs.note.trim()) return true;
    return false;
  });
  const canSubmit = orderedPeople.length > 0 && invalid.length === 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const items = orderedPeople.map((p) => {
        const rs = rows[candidateKey(p)];
        return {
          employee_name: p.name,
          employee_work_email: p.work_email,
          employee_personal_email: p.personal_email,
          department: p.department,
          reason: rs.reason,
          note: rs.note.trim() || null,
        };
      });
      const res = await fetch('/api/offboarding-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        inserted?: number;
        skipped?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);

      const inserted = json.inserted ?? 0;
      const skipped = json.skipped ?? 0;
      if (inserted > 0) {
        toast.success(`Sent ${inserted} ${inserted === 1 ? 'person' : 'people'} to HR for offboarding`, {
          description: skipped > 0 ? `${skipped} already in the queue and skipped.` : undefined,
        });
      } else {
        toast.info(json.message ?? 'Everyone selected is already in the offboarding queue.');
      }
      onOpenChange(false);
      onSubmitted?.(orderedPeople.map(candidateKey));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to queue offboarding');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className="grid max-h-[88vh] grid-rows-[auto_1fr_auto] gap-0 p-0 sm:max-w-[560px]"
      >
        {/* ── Header ── */}
        <div className="relative overflow-hidden rounded-t-xl bg-[#1a0a0a] px-5 pb-4 pt-5">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-rose-700 via-rose-400 to-rose-700" />
          <div className="relative flex items-start gap-3.5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-900/60 text-rose-200 ring-1 ring-rose-700/50">
              <Users className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-500/80">
                Queue for offboarding
              </p>
              <p className="mt-0.5 text-[15px] font-semibold leading-snug text-zinc-100">
                {orderedPeople.length} {orderedPeople.length === 1 ? 'person' : 'people'} → HR
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                HR reviews and handles the actual offboarding. Set a reason for everyone below,
                then tweak individuals if they differ.
              </p>
            </div>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="min-h-0 space-y-4 overflow-y-auto bg-zinc-950/60 p-5">
          {/* Shared defaults */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Default for everyone
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-zinc-400">Reason</label>
                <SmoothSelect
                  aria-label="Default reason"
                  value={defaultReason}
                  onChange={(v) => v && applyDefaultReason(v as OffboardReason)}
                  triggerClassName="w-full"
                  portal
                  options={REASON_OPTIONS}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-zinc-400">Note (optional)</label>
                <input
                  value={defaultNote}
                  onChange={(e) => applyDefaultNote(e.target.value)}
                  placeholder="Applies to all un-edited rows"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Per-person review */}
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {orderedPeople.map((p, idx) => {
                const k = candidateKey(p);
                const rs = rows[k];
                if (!rs) return null;
                const noteRequired = rs.reason === 'other';
                const rowInvalid = !rs.reason || (noteRequired && !rs.note.trim());
                return (
                  <motion.div
                    key={k}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.2, delay: Math.min(idx * 0.02, 0.16), ease: [0.22, 1, 0.36, 1] }}
                    className={cn(
                      'rounded-xl border bg-zinc-900/40 p-3',
                      rowInvalid ? 'border-rose-900/60' : 'border-zinc-800',
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[11px] font-bold text-zinc-300">
                        {initials(p.name, p.work_email ?? p.personal_email)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-100">
                          {p.name ?? p.work_email ?? p.personal_email}
                        </p>
                        <p className="truncate font-mono text-[10.5px] text-zinc-500">
                          {p.department ? `${p.department} · ` : ''}{p.work_email ?? p.personal_email ?? '—'}
                        </p>
                      </div>
                      {rs.overridden ? (
                        <button
                          type="button"
                          onClick={() => resetRow(k)}
                          title="Reset to the default reason/note"
                          className="inline-flex items-center gap-1 rounded-md border border-amber-700/50 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 hover:bg-amber-900/30"
                        >
                          <RotateCcw className="h-3 w-3" /> Custom
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600">
                          <Pencil className="h-3 w-3" /> Default
                        </span>
                      )}
                    </div>
                    <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                      <SmoothSelect
                        aria-label={`Reason for ${p.name ?? k}`}
                        value={rs.reason}
                        onChange={(v) => v && setRowReason(k, v as OffboardReason)}
                        triggerClassName="w-full"
                        portal
                        options={REASON_OPTIONS}
                      />
                      <input
                        value={rs.note}
                        onChange={(e) => setRowNote(k, e.target.value)}
                        placeholder={noteRequired ? 'Note required' : 'Note (optional)'}
                        className={cn(
                          'w-full rounded-lg border bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none',
                          noteRequired && !rs.note.trim()
                            ? 'border-rose-800/70 focus:border-rose-600'
                            : 'border-zinc-800 focus:border-zinc-600',
                        )}
                      />
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 rounded-b-xl border-t border-zinc-800 bg-zinc-950/80 p-4">
          {invalid.length > 0 && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              {invalid.length} {invalid.length === 1 ? 'person needs' : 'people need'} a reason
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={cn(
              'border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-200',
              invalid.length === 0 && 'ml-auto',
            )}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-1.5 border-0 bg-rose-700 text-white hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
            {submitting ? 'Sending…' : `Send ${orderedPeople.length} to HR`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
