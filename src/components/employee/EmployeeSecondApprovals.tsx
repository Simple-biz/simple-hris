'use client';

/**
 * Time Adjustment Approvals — the second approver's surface, inside the EMPLOYEE portal.
 *
 * Kane's ruling 2026-08-27: a manager may name any active member of the requesting
 * employee's own team as the second approver, and that person needs no Manager access.
 * They review the request here rather than in the Manager dashboard, which is what makes
 * "ONLY time adjustments, no other management-level access" true by construction — a
 * named approver never loads that dashboard at all, so leaves, transfers, offboarding
 * and suspension are not merely hidden from them, they are unreachable.
 *
 * The feed is `/api/time-adjustments/second-approvals`, which can only ever return rows
 * naming the caller. Someone never named sees an empty list and the tab stays hidden.
 * See `docs/features/time-adjustment-requests.md`.
 */

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { CalendarDays, Check, Clock, ImageIcon, Loader2, ShieldCheck, X } from 'lucide-react';
import {
  TIME_ADJUSTMENT_REASONS,
  fmtAdjustmentSegments,
  type TimeAdjustmentRow,
} from '@/lib/supabase/time-adjustments';

const REASON_LABEL = (code: string) =>
  TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;

const fmtDate = (iso: string): string => {
  // Date-only column: split rather than `new Date(iso)`, which would shift the day
  // backwards for anyone east of UTC.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/**
 * Rows still owed this person's signature. Keyed on the DECISION, not the status: a
 * second approver may act while the row is still `pending` because the manager has not
 * gone first. Mirrors `taNeedsMySecondDecision` in the manager dashboard.
 */
const isMine = (r: TimeAdjustmentRow): boolean =>
  r.second_decision == null &&
  (r.status === 'pending' || r.status === 'awaiting_second_approval');

export default function EmployeeSecondApprovals() {
  const [rows, setRows] = useState<TimeAdjustmentRow[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null);

  const fetchRows = useCallback(() => {
    setLoading(true);
    fetch('/api/time-adjustments/second-approvals?evidence=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows?: TimeAdjustmentRow[]; signedUrls?: Record<string, string> }) => {
        setRows(json.rows ?? []);
        setSignedUrls(json.signedUrls ?? {});
      })
      .catch(() => {
        setRows([]);
        setSignedUrls({});
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight')
        setLightbox((lb) => lb && { ...lb, idx: (lb.idx + 1) % lb.urls.length });
      if (e.key === 'ArrowLeft')
        setLightbox((lb) => lb && { ...lb, idx: (lb.idx - 1 + lb.urls.length) % lb.urls.length });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const decide = async (id: string, action: 'second_approve' | 'second_deny') => {
    setDecidingId(id);
    try {
      const res = await fetch(`/api/time-adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, decision_note: notes[id]?.trim() || null }),
      });
      const json = (await res.json()) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error || 'Could not save your decision');
      toast.success(action === 'second_approve' ? 'Approved' : 'Declined');
      setNotes((p) => ({ ...p, [id]: '' }));
      fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save your decision');
    } finally {
      setDecidingId(null);
    }
  };

  const awaiting = rows.filter(isMine);
  const history = rows.filter((r) => !isMine(r));

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Time Adjustment Approvals
          </h1>
          <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            A manager asked you to countersign these. A time adjustment needs two
            approvals &mdash; the manager&rsquo;s and yours &mdash; before Accounting can
            act on it, and a decline from either of you stops it.
          </p>
        </header>

        {awaiting.length === 0 && history.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-300 px-5 py-10 text-center dark:border-zinc-700">
            <ShieldCheck className="mx-auto h-6 w-6 text-zinc-300 dark:text-zinc-600" aria-hidden />
            <p className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">
              Nothing needs your approval right now.
            </p>
          </div>
        )}

        {awaiting.length > 0 && (
          <section className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              Awaiting your approval &nbsp;&middot;&nbsp; {awaiting.length}
            </p>
            {awaiting.map((row) => (
              <ApprovalCard
                key={row.id}
                row={row}
                signedUrls={signedUrls}
                actionable
                busy={decidingId === row.id}
                note={notes[row.id] ?? ''}
                onNoteChange={(v) => setNotes((p) => ({ ...p, [row.id]: v }))}
                onDecide={decide}
                onImageClick={(urls, idx) => setLightbox({ urls, idx })}
              />
            ))}
          </section>
        )}

        {history.length > 0 && (
          <section className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              History &nbsp;&middot;&nbsp; {history.length}
            </p>
            {history.map((row) => (
              <ApprovalCard
                key={row.id}
                row={row}
                signedUrls={signedUrls}
                actionable={false}
                busy={false}
                note=""
                onNoteChange={() => {}}
                onDecide={decide}
                onImageClick={(urls, idx) => setLightbox({ urls, idx })}
              />
            ))}
          </section>
        )}
      </div>

      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
            onClick={() => setLightbox(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Evidence image"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.urls[lightbox.idx]}
              alt={`Evidence ${lightbox.idx + 1} of ${lightbox.urls.length}`}
              className="max-h-full max-w-full rounded-xl object-contain"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ApprovalCard({
  row,
  signedUrls,
  actionable,
  busy,
  note,
  onNoteChange,
  onDecide,
  onImageClick,
}: {
  row: TimeAdjustmentRow;
  signedUrls: Record<string, string>;
  actionable: boolean;
  busy: boolean;
  note: string;
  onNoteChange: (v: string) => void;
  onDecide: (id: string, action: 'second_approve' | 'second_deny') => void;
  onImageClick: (urls: string[], idx: number) => void;
}) {
  const urls = (row.image_paths ?? []).map((p) => signedUrls[p]).filter(Boolean);
  const managerActed = row.manager_decision != null;

  return (
    <article className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.work_email}</p>
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <CalendarDays className="h-3 w-3" aria-hidden />
          {fmtDate(row.adjust_date)}
        </span>
      </div>

      <dl className="space-y-1.5 text-[11px]">
        <div className="flex gap-2">
          <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">Reason</dt>
          <dd className="text-zinc-700 dark:text-zinc-300">{REASON_LABEL(row.reason)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">Missed time</dt>
          <dd className="inline-flex flex-wrap items-center gap-1 text-zinc-700 dark:text-zinc-300">
            <Clock className="h-3 w-3" aria-hidden />
            {fmtAdjustmentSegments(row.requested_segments)}
            {row.requested_hours != null && (
              <span className="font-medium">
                &nbsp;&middot;&nbsp;{row.requested_hours}h to add
              </span>
            )}
          </dd>
        </div>
      </dl>

      {row.explanation && (
        <p className="rounded-xl bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
          {row.explanation}
        </p>
      )}

      {urls.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {urls.map((u, i) => (
            <button
              key={u}
              type="button"
              onClick={() => onImageClick(urls, i)}
              className="relative h-14 w-14 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
              aria-label={`Open evidence image ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      ) : (
        <p className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
          <ImageIcon className="h-3 w-3" aria-hidden />
          No evidence was attached.
        </p>
      )}

      <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
        {row.second_approver_assigned_by
          ? `${row.second_approver_assigned_by} asked you to countersign. `
          : 'You were named as the second approver. '}
        {managerActed
          ? row.manager_decision === 'approved'
            ? 'The manager has already approved.'
            : 'The manager declined, so this request is already closed.'
          : 'The manager has not decided yet — you may go first.'}
      </p>

      {actionable ? (
        <div className="space-y-2">
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={2}
            placeholder="Optional note…"
            className="w-full resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(row.id, 'second_approve')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden />
              )}
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(row.id, 'second_deny')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-300 px-3.5 py-2 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Decline
            </button>
          </div>
        </div>
      ) : (
        row.second_decision && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            You {row.second_decision === 'approved' ? 'approved' : 'declined'} this
            {row.second_decision_note ? ` — “${row.second_decision_note}”` : '.'}
          </p>
        )
      )}
    </article>
  );
}
