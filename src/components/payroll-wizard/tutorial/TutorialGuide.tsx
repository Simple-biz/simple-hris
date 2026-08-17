'use client';

/**
 * [WIZARD-TUTORIAL] Processing Tutorial Mode — the floating guide rail +
 * spotlight ring shown to the LOCK DRIVER while Payroll Processing is on.
 *
 * Non-negotiable contract (Kane, 2026-08-17): this is a tutorial, never a
 * gate. The spotlight layer is pointer-events-none; the rail never disables
 * the wizard's own navigation; every step is skippable; the whole thing is
 * dismissible (and stays dismissed for this cycle only). Statuses are
 * advisory badges derived in `guide.ts` — they grant and deny nothing.
 *
 * Spectators never see this: they're already in read-only follow mode.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  GraduationCap,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  TUTORIAL_STEPS,
  deriveStepStatus,
  parseTutorialState,
  serializeTutorialState,
  type TutorialPersistedState,
  type TutorialSignals,
  type TutorialStepDef,
} from '@/lib/payroll-wizard/tutorial/guide';

type SpotRect = { top: number; left: number; width: number; height: number };

function readPersisted(storageKey: string): TutorialPersistedState {
  try {
    return parseTutorialState(window.localStorage.getItem(storageKey));
  } catch {
    return { dismissed: false, collapsed: false, visitedSteps: [] };
  }
}

function writePersisted(storageKey: string, state: TutorialPersistedState) {
  try {
    window.localStorage.setItem(storageKey, serializeTutorialState(state));
  } catch {
    /* storage unavailable — the guide simply won't remember */
  }
}

function StatusIcon({ status }: { status: 'pending' | 'attention' | 'done' }) {
  if (status === 'done') {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  if (status === 'attention') {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />;
  }
  return <Circle className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />;
}

export default function TutorialGuide({
  signals,
  currentStep,
  onGoToStep,
  storageKey,
}: {
  signals: TutorialSignals;
  currentStep: number;
  /** The wizard's own setCurrentStep — the guide navigates, it never blocks. */
  onGoToStep: (step: number) => void;
  /** Per (driver email, cycle) — dismissing one week never hides the next. */
  storageKey: string;
}) {
  const [persisted, setPersisted] = useState<TutorialPersistedState>(() =>
    typeof window === 'undefined'
      ? { dismissed: false, collapsed: false, visitedSteps: [] }
      : readPersisted(storageKey),
  );
  const [spots, setSpots] = useState<SpotRect[]>([]);

  // Re-hydrate when the cycle (and therefore the key) changes.
  useEffect(() => {
    setPersisted(readPersisted(storageKey));
  }, [storageKey]);

  const persist = useCallback(
    (next: TutorialPersistedState) => {
      setPersisted(next);
      writePersisted(storageKey, next);
    },
    [storageKey],
  );

  // Mark the current wizard step visited (drives the advisory "done" on
  // review-type steps — landing on the step is the review).
  useEffect(() => {
    if (persisted.visitedSteps.includes(currentStep)) return;
    persist({
      ...persisted,
      visitedSteps: [...persisted.visitedSteps, currentStep],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist/persisted cycle; keyed on the step
  }, [currentStep]);

  const mergedSignals = useMemo<TutorialSignals>(
    () => ({ ...signals, visitedSteps: persisted.visitedSteps }),
    [signals, persisted.visitedSteps],
  );

  const statuses = useMemo(
    () =>
      new Map(
        TUTORIAL_STEPS.map((def) => [def.stepId, deriveStepStatus(def.stepId, mergedSignals)]),
      ),
    [mergedSignals],
  );

  const activeDef: TutorialStepDef | undefined = TUTORIAL_STEPS.find(
    (d) => d.stepId === currentStep,
  );

  // ── Spotlight measurement ──────────────────────────────────────────────────
  // Finds this step's [data-tutorial-target] anchors and draws a ring around
  // each. A missing anchor is fine — the guide degrades to rail-only.
  const measure = useCallback(() => {
    if (!activeDef || persisted.dismissed || persisted.collapsed) {
      setSpots([]);
      return;
    }
    const next: SpotRect[] = [];
    for (const key of activeDef.targets) {
      const el = document.querySelector<HTMLElement>(`[data-tutorial-target="${key}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue; // hidden tab panes etc.
      next.push({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    }
    setSpots(next);
  }, [activeDef, persisted.dismissed, persisted.collapsed]);

  useEffect(() => {
    measure();
    // The wizard re-renders freely under us (tabs, async loads) — listen wide
    // and keep a slow interval as the backstop. Cheap: reads a couple rects.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const interval = window.setInterval(measure, 900);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.clearInterval(interval);
    };
  }, [measure]);

  if (persisted.dismissed) {
    return (
      <button
        type="button"
        onClick={() => persist({ ...persisted, dismissed: false })}
        className="fixed bottom-5 right-5 z-[45] inline-flex items-center gap-2 rounded-full border border-indigo-300/70 bg-white/95 px-3.5 py-2 text-xs font-semibold text-indigo-700 shadow-lg backdrop-blur transition hover:bg-indigo-50 dark:border-indigo-700/60 dark:bg-zinc-900/95 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
        title="Reopen the processing guide"
      >
        <GraduationCap className="h-4 w-4" /> Guide
      </button>
    );
  }

  const activeStatus = activeDef ? statuses.get(activeDef.stepId) : undefined;
  const doneCount = TUTORIAL_STEPS.filter((d) => statuses.get(d.stepId)?.status === 'done').length;

  return (
    <>
      {/* Spotlight rings — never interactive, never block a click. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[44]">
        {spots.map((s, i) => (
          <div
            key={i}
            className="absolute rounded-xl border-2 border-indigo-500/90 shadow-[0_0_0_4px_rgba(99,102,241,0.15),0_0_24px_rgba(99,102,241,0.35)] transition-all duration-300 motion-reduce:transition-none dark:border-indigo-400/90"
            style={{ top: s.top, left: s.left, width: s.width, height: s.height }}
          />
        ))}
      </div>

      {/* Guide rail */}
      <aside
        className="fixed right-4 top-20 z-[45] w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-indigo-200/80 bg-white/95 shadow-xl backdrop-blur dark:border-indigo-900/50 dark:bg-zinc-950/95"
        aria-label="Payroll processing guide"
      >
        <div className="flex items-center gap-2 border-b border-indigo-100 bg-indigo-50/70 px-3.5 py-2.5 dark:border-indigo-900/40 dark:bg-indigo-950/30">
          <GraduationCap className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-white">
              Processing guide
            </p>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
              {doneCount}/{TUTORIAL_STEPS.length} steps look done · advisory only
            </p>
          </div>
          <button
            type="button"
            onClick={() => persist({ ...persisted, collapsed: !persisted.collapsed })}
            className="rounded-md p-1 text-zinc-500 transition hover:bg-white/70 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title={persisted.collapsed ? 'Expand the guide' : 'Collapse the guide'}
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', persisted.collapsed && '-rotate-90')} />
          </button>
          <button
            type="button"
            onClick={() => persist({ ...persisted, dismissed: true })}
            className="rounded-md p-1 text-zinc-500 transition hover:bg-white/70 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Dismiss for this cycle (reopen from the Guide pill)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!persisted.collapsed && (
          <div className="max-h-[min(60vh,540px)] overflow-y-auto">
            {/* Current step hint */}
            {activeDef && (
              <div className="border-b border-zinc-100 px-3.5 py-3 dark:border-zinc-800/80">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                  Step {activeDef.stepId} · {activeDef.kind === 'review' ? 'Review' : 'Action'}
                </p>
                <p className="mt-1 text-[13px] font-semibold text-zinc-900 dark:text-white">
                  {activeDef.title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {activeDef.hint}
                </p>
                {activeStatus?.note && (
                  <p
                    className={cn(
                      'mt-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug',
                      activeStatus.status === 'attention'
                        ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
                    )}
                  >
                    {activeStatus.note}
                  </p>
                )}
                <div className="mt-2.5 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={currentStep <= 1}
                    onClick={() => onGoToStep(Math.max(1, currentStep - 1))}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Back
                  </button>
                  <button
                    type="button"
                    disabled={currentStep >= 9}
                    onClick={() => onGoToStep(Math.min(9, currentStep + 1))}
                    className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-40"
                  >
                    {activeStatus?.status === 'done' ? 'Next step' : 'Skip ahead'}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* All steps */}
            <ol className="px-2 py-2">
              {TUTORIAL_STEPS.map((def) => {
                const st = statuses.get(def.stepId);
                const isActive = def.stepId === currentStep;
                return (
                  <li key={def.stepId}>
                    <button
                      type="button"
                      onClick={() => onGoToStep(def.stepId)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition',
                        isActive
                          ? 'bg-indigo-50 dark:bg-indigo-950/40'
                          : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                      )}
                    >
                      <StatusIcon status={st?.status ?? 'pending'} />
                      <span className="min-w-0">
                        <span
                          className={cn(
                            'block truncate text-xs font-medium',
                            isActive
                              ? 'text-indigo-800 dark:text-indigo-300'
                              : 'text-zinc-700 dark:text-zinc-300',
                          )}
                        >
                          {def.stepId}. {def.title}
                        </span>
                        {st?.status === 'attention' && st.note && (
                          <span className="block truncate text-[10px] text-amber-700 dark:text-amber-400">
                            {st.note}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </aside>
    </>
  );
}
