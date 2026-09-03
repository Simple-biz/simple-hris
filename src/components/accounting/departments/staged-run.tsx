'use client';

// The staged progress overlay + the ndjson stream consumer behind BOTH the
// Create a Department wizard and the Edit Department dialog.
//
// The route streams one JSON event per line (see registry.ts: `stage` start /
// done, then `done` with a summary, or `error`). The hook queues them and the
// paced applier reveals them one at a time (150 ms first, 420 ms after; reduced
// motion drops the pacing) so the checklist reads as steps even when the server
// finishes fast. A dropped connection with no terminal event is reported as an
// error attributed to the last stage underway; every server stage is idempotent
// (registry upserts by key / CAS, grants no-op, rates reuse ids) so retrying is
// safe -- EXCEPT a 409 stale-edit conflict, which is flagged so the dialog can
// offer "reload" instead of a retry that would fail the same way.

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { AlertTriangle, Building2, Check, CheckCircle2, Loader2, RefreshCw, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CreateDepartmentStageKey } from '@/lib/departments/registry';

export type StageKey = CreateDepartmentStageKey;
export type StageStatus = 'pending' | 'active' | 'done' | 'failed';

/** The wire shape both routes stream: shared stage/error lines, a typed summary. */
export type StageEvent<S> =
  | { type: 'stage'; stage: StageKey; status: 'start' | 'done'; note?: string }
  | { type: 'done'; summary: S }
  | { type: 'error'; stage: StageKey; message: string };

export interface RunView<S> {
  stages: Record<StageKey, StageStatus>;
  notes: Partial<Record<StageKey, string>>;
  error: { stage: StageKey; message: string; conflict: boolean } | null;
  summary: S | null;
}

function freshView<S>(): RunView<S> {
  return {
    stages: { department: 'pending', managers: 'pending', members: 'pending', rates: 'pending' },
    notes: {},
    error: null,
    summary: null,
  };
}

export function useStagedRun<S>() {
  const reducedMotion = useReducedMotion();
  const [view, setView] = useState<RunView<S> | null>(null);
  // Server events queue + how many are visually applied (paced reveal).
  const eventsRef = useRef<StageEvent<S>[]>([]);
  const conflictRef = useRef(false);
  const [received, setReceived] = useState(0);
  const [applied, setApplied] = useState(0);

  // Mid-run (no success or failure on screen yet) the owning modal must not be
  // dismissable -- closing would hide progress the user can't get back.
  const running = view !== null && view.summary === null && view.error === null;

  const reset = () => {
    setView(null);
    eventsRef.current = [];
    conflictRef.current = false;
    setReceived(0);
    setApplied(0);
  };

  /** Fires the request and consumes its ndjson body. `request` is a thunk so a
   *  retry re-sends the exact same payload. */
  const run = async (request: () => Promise<Response>, fallbackMessage: string) => {
    eventsRef.current = [];
    conflictRef.current = false;
    setReceived(0);
    setApplied(0);
    setView(freshView<S>());
    const push = (ev: StageEvent<S>) => {
      eventsRef.current.push(ev);
      setReceived(eventsRef.current.length);
    };
    try {
      const res = await request();
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || !contentType.includes('ndjson')) {
        const json = (await res.json().catch(() => null)) as { error?: string; conflict?: boolean } | null;
        if (res.status === 409 || json?.conflict) conflictRef.current = true;
        throw new Error(json?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let terminal = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const ev = JSON.parse(line) as StageEvent<S>;
            push(ev);
            if (ev.type === 'done' || ev.type === 'error') terminal = true;
          }
          nl = buffer.indexOf('\n');
        }
      }
      if (!terminal) {
        throw new Error('The connection dropped mid-save. Retrying is safe -- finished steps are skipped.');
      }
    } catch (e) {
      // Attribute the failure to whichever stage was last underway.
      let stage: StageKey = 'department';
      for (const ev of eventsRef.current) {
        if (ev.type === 'stage') stage = ev.stage;
      }
      push({ type: 'error', stage, message: e instanceof Error ? e.message : fallbackMessage });
    }
  };

  // Paced applier: reveal queued events one at a time.
  useEffect(() => {
    if (applied >= received) return;
    const delay = reducedMotion ? 0 : applied === 0 ? 150 : 420;
    const t = setTimeout(() => setApplied((a) => a + 1), delay);
    return () => clearTimeout(t);
  }, [applied, received, reducedMotion]);

  // Fold visually-applied events into the view.
  useEffect(() => {
    if (applied === 0) return;
    setView((prev) => {
      if (!prev) return prev;
      const next: RunView<S> = { ...prev, stages: { ...prev.stages }, notes: { ...prev.notes } };
      for (const ev of eventsRef.current.slice(0, applied)) {
        if (ev.type === 'stage') {
          next.stages[ev.stage] = ev.status === 'start' ? 'active' : 'done';
          if (ev.note) next.notes[ev.stage] = ev.note;
        } else if (ev.type === 'error') {
          // A stale-edit 409 lands in the stream as an error line too (the CAS
          // write is stage 1); the route uses one message for both paths.
          next.error = { stage: ev.stage, message: ev.message, conflict: conflictRef.current || /changed since you opened it/i.test(ev.message) };
          if (next.stages[ev.stage] !== 'done') next.stages[ev.stage] = 'failed';
        } else {
          next.summary = ev.summary;
        }
      }
      return next;
    });
  }, [applied]);

  return { view, running, run, reset };
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

export interface StagedProgressCopy {
  /** e.g. "Creating Medical Billing..." */
  runningTitle: string;
  runningDetail: string;
  errorTitle: string;
  /** Present once the run succeeded. */
  success: { title: string; detail: string; warnings: string[]; deptKey: string | null } | null;
}

export function StagedProgress({
  view,
  stageList,
  copy,
  onRetry,
  onBackToForm,
  onReload,
  onDone,
  onOpenPayStructure,
}: {
  view: RunView<unknown>;
  stageList: { key: StageKey; label: string }[];
  copy: StagedProgressCopy;
  onRetry: () => void;
  onBackToForm: () => void;
  /** Offered instead of Retry when the failure is a stale-edit conflict. */
  onReload?: () => void;
  onDone: () => void;
  onOpenPayStructure: (deptKey: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const { stages, notes, error } = view;
  const success = copy.success;

  return (
    <div className="p-6 sm:p-8">
      {/* Emblem */}
      <div className="flex justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {success ? (
            <motion.span
              key="success"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.span>
          ) : error ? (
            <motion.span
              key="error"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
            >
              <AlertTriangle className="h-8 w-8" />
            </motion.span>
          ) : (
            <motion.span
              key="building"
              className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-100 text-orange-600 dark:bg-blue-950/60 dark:text-blue-300"
              animate={reducedMotion ? undefined : { scale: [1, 1.06, 1] }}
              transition={reducedMotion ? undefined : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              {!reducedMotion && (
                <motion.span
                  className="absolute inset-0 rounded-2xl border-2 border-orange-400/60 dark:border-blue-500/50"
                  animate={{ scale: [1, 1.35], opacity: [0.7, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <Building2 className="h-8 w-8" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Headline */}
      <div className="mt-4 text-center">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100" aria-live="polite">
          {success ? success.title : error ? copy.errorTitle : copy.runningTitle}
        </h2>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {success ? success.detail : error ? error.message : copy.runningDetail}
        </p>
      </div>

      {/* Stage checklist */}
      <ol className="mx-auto mt-5 max-w-sm space-y-1.5">
        {stageList.map((stage) => {
          const status = stages[stage.key];
          return (
            <motion.li
              key={stage.key}
              layout
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                status === 'active'
                  ? 'border-orange-200 bg-orange-50/70 dark:border-blue-900/60 dark:bg-blue-950/30'
                  : status === 'failed'
                    ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/30'
                    : 'border-zinc-100 dark:border-zinc-900'
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {status === 'done' ? (
                    <motion.span
                      key="done"
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white"
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </motion.span>
                  ) : status === 'active' ? (
                    <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      <Loader2 className="h-4.5 w-4.5 animate-spin text-orange-500" />
                    </motion.span>
                  ) : status === 'failed' ? (
                    <motion.span
                      key="failed"
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"
                    >
                      <X className="h-3 w-3" strokeWidth={3} />
                    </motion.span>
                  ) : (
                    <motion.span
                      key="pending"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700"
                    />
                  )}
                </AnimatePresence>
              </span>
              <span
                className={`flex-1 text-sm ${
                  status === 'pending'
                    ? 'text-zinc-400 dark:text-zinc-500'
                    : status === 'failed'
                      ? 'font-medium text-red-700 dark:text-red-300'
                      : 'font-medium text-zinc-800 dark:text-zinc-200'
                }`}
              >
                {stage.label}
              </span>
              {notes[stage.key] && status === 'done' && (
                <span className="shrink-0 text-[10.5px] text-zinc-400 dark:text-zinc-500">{notes[stage.key]}</span>
              )}
            </motion.li>
          );
        })}
      </ol>

      {/* Warnings (success with caveats) */}
      {success && success.warnings.length > 0 && (
        <div className="mx-auto mt-4 max-w-sm rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Worth a look
          </p>
          <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
            {success.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 flex items-center justify-center gap-2">
        {success ? (
          <>
            {success.deptKey && (
              <Button type="button" size="sm" variant="outline" onClick={() => onOpenPayStructure(success.deptKey!)} className="gap-1">
                <Wallet className="h-3.5 w-3.5" />
                Open pay structure
              </Button>
            )}
            <Button type="button" size="sm" onClick={onDone} className="bg-orange-500 text-white hover:bg-orange-600">
              Done
            </Button>
          </>
        ) : error ? (
          error.conflict && onReload ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={onBackToForm}>
                Back to the form
              </Button>
              <Button type="button" size="sm" onClick={onReload} className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600">
                <RefreshCw className="h-3.5 w-3.5" />
                Reload and start over
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" onClick={onBackToForm}>
                Back to the form
              </Button>
              <Button type="button" size="sm" onClick={onRetry} className="bg-orange-500 text-white hover:bg-orange-600">
                Try again
              </Button>
            </>
          )
        ) : (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500" role="status">
            Hang tight -- this takes a few seconds.
          </p>
        )}
      </div>
    </div>
  );
}
