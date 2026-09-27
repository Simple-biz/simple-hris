/**
 * Rotation order for the Accounting Overview's Payroll Notes card — the pure
 * decision layer (no I/O, no React) so node:test can pin it.
 *
 * The card spotlights ONE Wizard Setup step at a time and crossfades to the
 * next (Kane, 2026-09-26: "we prioritize Not yet done steps"). This module
 * decides what plays and in which order; the card only renders it.
 *
 * It never re-derives a step's status — it reads `WizardSetupStep.status`
 * exactly as `deriveWizardSetupSteps` produced it on the server, so the card
 * and the Readiness pane's checklist can never disagree about a row. A row
 * whose read failed arrives as `pending` ("Couldn't read…") and is spotlighted
 * as open, never folded into the done recap.
 */

import type { WizardSetupStep } from './wizard-setup-steps';

export type WizardSetupStatus = WizardSetupStep['status'];

/** Most urgent first. `pending` is the neutral end-state (not sent yet / no
 *  departments due / couldn't read) — still open, so still before any done row. */
const SEVERITY: Record<WizardSetupStatus, number> = {
  blocked: 0,
  attention: 1,
  pending: 2,
  done: 3,
};

export const DONE_RECAP_KEY = 'done-recap';

export type SpotlightSlide =
  | {
      kind: 'step';
      key: WizardSetupStep['key'];
      step: WizardSetupStep;
      /** 1-based position among OPEN steps; null when the slide is a done step
       *  (the all-done rotation). */
      openIndex: number | null;
      openTotal: number;
    }
  | {
      kind: 'recap';
      key: typeof DONE_RECAP_KEY;
      /** Done steps in rail order. */
      done: WizardSetupStep[];
    };

/**
 * - Any step open → every open step, most severe first (rail order breaks
 *   ties), then ONE recap slide listing the done steps (omitted when none are
 *   done). A done step never gets a slide of its own while anything is open —
 *   that is what "prioritize not-yet-done" buys: with 1 of 7 open, the open
 *   step holds half the airtime instead of a seventh.
 * - Nothing open → each done step in rail order, so the card still reads the
 *   week's facts ("Locked by carla@ · Sep 20") rather than freezing.
 * - No steps → no slides.
 */
export function buildSpotlightSlides(steps: readonly WizardSetupStep[]): SpotlightSlide[] {
  const indexed = steps.map((step, i) => ({ step, i }));
  const open = indexed
    .filter(({ step }) => step.status !== 'done')
    .sort((a, b) => SEVERITY[a.step.status] - SEVERITY[b.step.status] || a.i - b.i)
    .map(({ step }) => step);
  const done = steps.filter((s) => s.status === 'done');

  if (open.length === 0) {
    return done.map((step) => ({ kind: 'step', key: step.key, step, openIndex: null, openTotal: 0 }));
  }

  const slides: SpotlightSlide[] = open.map((step, i) => ({
    kind: 'step',
    key: step.key,
    step,
    openIndex: i + 1,
    openTotal: open.length,
  }));
  if (done.length > 0) slides.push({ kind: 'recap', key: DONE_RECAP_KEY, done });
  return slides;
}

/** The slide to show: the current one while it still exists (a refresh that
 *  keeps the step open must not yank the card back to the start), otherwise
 *  the first. Null only when there is nothing to show. */
export function resolveActiveKey(slides: readonly SpotlightSlide[], current: string | null): string | null {
  if (slides.length === 0) return null;
  if (current != null && slides.some((s) => s.key === current)) return current;
  return slides[0].key;
}

/** The slide after `current`, wrapping. An unknown `current` restarts at the
 *  first slide. */
export function nextSlideKey(slides: readonly SpotlightSlide[], current: string | null): string | null {
  if (slides.length === 0) return null;
  const at = current == null ? -1 : slides.findIndex((s) => s.key === current);
  if (at < 0) return slides[0].key;
  return slides[(at + 1) % slides.length].key;
}

/** The single most urgent status across the week's steps — drives the card's
 *  tone. An empty list reads `pending` (nothing to call done). */
export function worstSetupStatus(steps: readonly WizardSetupStep[]): WizardSetupStatus {
  let worst: WizardSetupStatus = 'done';
  for (const s of steps) if (SEVERITY[s.status] < SEVERITY[worst]) worst = s.status;
  return steps.length === 0 ? 'pending' : worst;
}
