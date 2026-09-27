/**
 * What the Accounting dashboard's greeting modal says — the pure decision layer
 * (no I/O, no React) so node:test can pin it.
 *
 * Kane, 2026-09-26: when an Accounting person opens the dashboard, greet them
 * and put the live payroll cycle's unfinished setup steps "in their face" —
 * e.g. USD → PHP / COP rates not updated, orphanage hours not synced — so they
 * fix them right away.
 *
 * Built on the SAME `wizardSetup` rows the Readiness pane and the Overview card
 * render. Nothing here re-derives a status: order comes from
 * `openStepsBySeverity`, status and detail are passed through verbatim, and the
 * only thing added is a headline per step key. A row whose read failed arrives
 * as `pending` and is listed as open with the label as its headline — never as
 * done, and never with a "fix this" imperative it may not deserve.
 */

import type { WizardSetup, WizardSetupStep } from './wizard-setup-steps';
import { openStepsBySeverity } from './wizard-setup-spotlight';

export const AWAITING_CSV_KEY = 'awaiting-csv';

export interface GreetingItem {
  key: WizardSetupStep['key'] | typeof AWAITING_CSV_KEY;
  stepNo: string;
  label: string;
  status: WizardSetupStep['status'];
  /** What to do, in words. Imperative for attention/blocked; the plain label
   *  for pending (not sent yet, nothing due, or couldn't read). */
  headline: string;
  /** The server's detail string, untouched ("PHP still 0 — Step 2"). */
  detail: string;
  /** The wizard step "Go to Step N" opens; null when `stepNo` isn't a step. */
  jumpStep: number | null;
  /** The upload the jump should put the wizard on; null = leave its cycle. */
  jumpSourceFile: string | null;
}

export interface CycleGreeting {
  /** False when nothing is left to do — the modal does not open (Kane, Q4). */
  shouldOpen: boolean;
  /** "The step we're on": the first unfinished row in RAIL order for the cycle
   *  in view, else the awaiting week's CSV, else null. Derived — the wizard's
   *  own current step is never stored anywhere readable. */
  nextUp: { stepNo: string; label: string; jumpStep: number | null } | null;
  /** Everything unfinished, most urgent first — the awaiting week's CSV leads
   *  (Kane, Q5), then open rows by severity. */
  items: GreetingItem[];
  /** Done rows in rail order, for the one-line recap. */
  done: WizardSetupStep[];
}

/** Imperative headline for an actionable (attention / blocked) row. */
const ACTION_HEADLINE: Record<WizardSetupStep['key'], string> = {
  csv: "Upload this week's Hubstaff CSV",
  fx: 'Update the USD → PHP / COP conversion rates',
  orphanage: 'Sync the orphanage hours',
  kpi: 'Get the pending KPI bonuses submitted',
  notes: 'Pull the Notes adjustments into the wizard',
  contractors: 'Review the pending contractor invoices',
  dispatch: 'Send this cycle to Payment Dispatch',
};

/** "5" → 5. Anything that isn't a positive whole number → null (no button). */
export function parseStepNo(stepNo: string): number | null {
  if (!/^\d+$/.test(stepNo.trim())) return null;
  const n = Number(stepNo.trim());
  return n >= 1 ? n : null;
}

function itemFor(step: WizardSetupStep, sourceFile: string | null): GreetingItem {
  const actionable = step.status === 'attention' || step.status === 'blocked';
  let headline = actionable ? ACTION_HEADLINE[step.key] : step.label;
  // The CSV row reads `attention` only when the newest upload's NAME is
  // unparseable ("can't tell") — the file may well be there.
  if (step.key === 'csv' && step.status === 'attention') headline = "Check this week's Hubstaff CSV upload";
  return {
    key: step.key,
    stepNo: step.stepNo,
    label: step.label,
    status: step.status,
    headline,
    detail: step.detail,
    jumpStep: parseStepNo(step.stepNo),
    jumpSourceFile: sourceFile,
  };
}

export function buildCycleGreeting(setup: WizardSetup): CycleGreeting {
  const items: GreetingItem[] = [];

  if (setup.awaitingWeekLabel) {
    items.push({
      key: AWAITING_CSV_KEY,
      stepNo: '1',
      label: 'Hubstaff CSV',
      status: 'blocked',
      headline: `Upload the ${setup.awaitingWeekLabel} Hubstaff CSV`,
      detail: "That pay week has closed and its CSV isn't uploaded yet — Step 1 starts the new cycle.",
      jumpStep: 1,
      // A new upload mints a new cycle; there is no file to point the wizard at yet.
      jumpSourceFile: null,
    });
  }

  for (const step of openStepsBySeverity(setup.steps)) items.push(itemFor(step, setup.matchedSourceFile));

  const firstOpenInRail = setup.steps.find((s) => s.status !== 'done') ?? null;
  const nextUp = firstOpenInRail
    ? { stepNo: firstOpenInRail.stepNo, label: firstOpenInRail.label, jumpStep: parseStepNo(firstOpenInRail.stepNo) }
    : setup.awaitingWeekLabel
      ? { stepNo: '1', label: `Hubstaff CSV for ${setup.awaitingWeekLabel}`, jumpStep: 1 }
      : null;

  return {
    shouldOpen: items.length > 0,
    nextUp,
    items,
    done: setup.steps.filter((s) => s.status === 'done'),
  };
}
