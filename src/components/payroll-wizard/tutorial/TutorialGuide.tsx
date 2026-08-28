'use client';

/**
 * [WIZARD-TUTORIAL] Processing Tutorial Mode — a floating CHAT HEAD (not a
 * panel, not a modal — Kane, 2026-08-17 rework) shown to the LOCK DRIVER
 * while Payroll Processing is on. The head sits bottom-right like a messenger
 * bubble; tapping it toggles a compact speech balloon with the current step's
 * hint. The actual teaching is done by the spotlight rings drawn around the
 * step's [data-tutorial-target] indicators.
 *
 * Non-negotiable contract (Kane, 2026-08-17): this is a tutorial, never a
 * gate. The spotlight layer is pointer-events-none; nothing here disables the
 * wizard's own navigation; every step is skippable; the whole thing hides for
 * the cycle on "Hide for this cycle". Statuses are advisory badges derived in
 * `guide.ts` — they grant and deny nothing.
 *
 * Spectators never see this: they're already in read-only follow mode.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  TUTORIAL_STEPS,
  activeHslColumnLabel,
  deriveStepStatus,
  parseTutorialState,
  resolveStepTargets,
  serializeTutorialState,
  type TutorialPersistedState,
  type TutorialSignals,
  type TutorialStepDef,
} from '@/lib/payroll-wizard/tutorial/guide';

/** How long each HSL column keeps the spotlight before the ring moves on. */
const HSL_ROTATION_MS = 2600;

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

const DOT_TONE: Record<'pending' | 'attention' | 'done', string> = {
  done: 'bg-emerald-500 dark:bg-emerald-400',
  attention: 'bg-amber-500 dark:bg-amber-400',
  pending: 'bg-zinc-300 dark:bg-zinc-600',
};

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
  /** Per (driver email, cycle) — hiding one week never hides the next. */
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
  const activeStatus = activeDef ? statuses.get(activeDef.stepId) : undefined;

  // ── HSL column rotation (step 4's HSL tab only) ────────────────────────────
  // The ring takes turns across PAB / Tech Bonus / MESA / Adjustment /
  // Orphanage. Since HSL and Additions merged, step 4 only shows that table on
  // its HSL tab — so the timer runs while THAT tab is open, not for the whole
  // step. Rotating over the shared department table would name columns the
  // operator cannot see.
  const hslTabOpen = currentStep === 4 && mergedSignals.additionsHslTabActive;
  const [rotationTick, setRotationTick] = useState(0);
  const rotates = hslTabOpen && !persisted.dismissed && !persisted.collapsed;
  useEffect(() => {
    if (!rotates) return;
    const id = window.setInterval(() => setRotationTick((t) => t + 1), HSL_ROTATION_MS);
    return () => window.clearInterval(id);
  }, [rotates]);
  // Restart the rotation from the first column whenever the HSL tab is re-entered.
  useEffect(() => {
    if (hslTabOpen) setRotationTick(0);
  }, [hslTabOpen]);

  const rotatingLabel = hslTabOpen ? activeHslColumnLabel(mergedSignals, rotationTick) : null;
  // `collapsed` = balloon closed, head only. The head is always reachable.
  const balloonOpen = !persisted.collapsed;

  // ── Spotlight measurement ──────────────────────────────────────────────────
  // Finds this step's [data-tutorial-target] anchors and draws a ring around
  // each. A missing anchor is fine — the guide degrades to head-only.
  const measure = useCallback(() => {
    if (!activeDef || persisted.dismissed) {
      setSpots([]);
      return;
    }
    const next: SpotRect[] = [];
    // Targets are resolved per render, not read off the static def: step 2 rings
    // only the FX legs still unset; step 4 rotates the HSL columns on its HSL tab and
    // otherwise moves inside the System Bonus modal once it opens.
    for (const key of resolveStepTargets(activeDef.stepId, mergedSignals, rotationTick)) {
      const el = document.querySelector<HTMLElement>(`[data-tutorial-target="${key}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue; // hidden tab panes etc.
      next.push({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    }
    setSpots(next);
  }, [activeDef, persisted.dismissed, mergedSignals, rotationTick]);

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

  if (persisted.dismissed) return null;

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

      {/* Speech balloon — compact, anchored above the head. */}
      {balloonOpen && activeDef && (
        <div
          // FAB_STACK: sits above the chat head (which itself clears the
          // Payroll Notes readiness FAB) — head occupies bottom 96–144px, so
          // this starts at 168px. Keep in sync with the head's `bottom-24`.
          className="fixed bottom-[10.5rem] right-5 z-[45] w-[290px] max-w-[calc(100vw-2.5rem)] rounded-2xl rounded-br-md border border-indigo-200/80 bg-white/95 p-3.5 shadow-xl backdrop-blur dark:border-indigo-900/50 dark:bg-zinc-950/95"
          role="status"
          aria-label="Processing guide"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
              Step {activeDef.stepId} of {TUTORIAL_STEPS.length} · {activeDef.kind === 'review' ? 'Review' : 'Action'}
            </p>
            <button
              type="button"
              onClick={() => persist({ ...persisted, collapsed: true })}
              className="-mr-1 -mt-1 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Tuck the balloon away (the head stays)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-0.5 text-[13px] font-semibold text-zinc-900 dark:text-white">
            {activeDef.title}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {activeDef.hint}
          </p>
          {/* Names the column the ring is currently sitting on (step 4). */}
          {rotatingLabel && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none dark:bg-indigo-400" />
              Now showing: {rotatingLabel}
            </p>
          )}
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

          {/* Step dots — one per wizard step, colored by advisory status. */}
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {TUTORIAL_STEPS.map((def) => {
                const st = statuses.get(def.stepId);
                const isActive = def.stepId === currentStep;
                return (
                  <button
                    key={def.stepId}
                    type="button"
                    onClick={() => onGoToStep(def.stepId)}
                    title={`${def.stepId}. ${def.title}${st?.status === 'attention' && st.note ? ` — ${st.note}` : ''}`}
                    className={cn(
                      'h-2 rounded-full transition-all',
                      DOT_TONE[st?.status ?? 'pending'],
                      isActive ? 'w-4 ring-2 ring-indigo-400/60 dark:ring-indigo-500/60' : 'w-2 hover:scale-125',
                    )}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={currentStep <= 1}
                onClick={() => onGoToStep(Math.max(1, currentStep - 1))}
                className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-35 dark:text-zinc-400 dark:hover:bg-zinc-800"
                title="Previous step"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={currentStep >= TUTORIAL_STEPS.length}
                onClick={() => onGoToStep(Math.min(TUTORIAL_STEPS.length, currentStep + 1))}
                className="rounded-md bg-indigo-600 p-1 text-white transition hover:bg-indigo-700 disabled:opacity-35"
                title={activeStatus?.status === 'done' ? 'Next step' : 'Skip ahead — nothing is ever required'}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => persist({ ...persisted, dismissed: true })}
            className="mt-2 text-[10px] font-medium text-zinc-400 underline-offset-2 transition hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
          >
            Hide for this cycle
          </button>

          {/* Balloon tail — centered on the head's column (right-11 + half the
              tail ≈ the head's 52px-from-right center). */}
          <div
            aria-hidden
            className="absolute -bottom-[7px] right-11 h-3.5 w-3.5 rotate-45 border-b border-r border-indigo-200/80 bg-white/95 dark:border-indigo-900/50 dark:bg-zinc-950/95"
          />
        </div>
      )}

      {/* The chat head. Click toggles the balloon. */}
      <button
        type="button"
        onClick={() => persist({ ...persisted, collapsed: !persisted.collapsed })}
        className={cn(
          // Stacked ABOVE the Payroll Notes readiness FAB, which owns
          // right-5/bottom-5 at 64px (App.tsx mounts it for the whole wizard
          // tab, processing or not). bottom-24 clears its 84px top edge;
          // right-7 centers this 48px head on the FAB's center column so the
          // two read as one vertical stack. Moving either one means
          // re-checking the other — see FAB_STACK note below.
          'fixed bottom-24 right-7 z-[45] flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur transition hover:scale-105 active:scale-95',
          // Solid indigo-600 — the wizard's own accent (step-1 upload button,
          // the spotlight rings, the balloon chrome), not a gradient.
          'border-indigo-300/70 bg-indigo-600 text-white hover:bg-indigo-700 dark:border-indigo-700/60',
        )}
        title={balloonOpen ? 'Tuck the guide away' : 'Open the processing guide'}
        aria-label="Processing guide"
      >
        <GraduationCap className="h-5 w-5" />
        {/* Step number badge. */}
        <span className="absolute -left-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-white/70 bg-indigo-700 px-1 text-[10px] font-bold text-white shadow dark:border-zinc-900/70">
          {currentStep}
        </span>
        {/* Attention pulse — advisory, mirrors the balloon's amber note. */}
        {activeStatus?.status === 'attention' && (
          <>
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-white/70 bg-amber-500 shadow dark:border-zinc-900/70">
              <AlertTriangle className="h-2.5 w-2.5 text-white" />
            </span>
            <span className="pointer-events-none absolute inset-0 -z-10 animate-ping rounded-full bg-indigo-500/40 motion-reduce:hidden" />
          </>
        )}
      </button>
    </>
  );
}
