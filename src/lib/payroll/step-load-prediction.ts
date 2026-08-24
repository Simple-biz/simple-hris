/**
 * Payroll Wizard step-rail progress line — the prediction behind the bar.
 *
 * The wizard's loaders don't report progress (a `fetch` either is or isn't
 * done), so a determinate bar has to be predicted. The prediction is the step's
 * own history: how long that step took to load on this browser last time,
 * smoothed, in localStorage.
 *
 * Extracted from PayrollWizard.tsx so the one invariant that matters can be
 * proven in a test rather than asserted in a comment: the bar NEVER reaches
 * 100% on prediction alone. Only the data actually landing fills it. The whole
 * point of the line is to tell Accounting when the figures are safe to read —
 * a bar that hit 100% early would say so early, which is the exact mistake the
 * line exists to prevent.
 */

/** localStorage key for the remembered per-step load durations. */
export const STEP_LOAD_MS_KEY = 'hris.payrollWizard.stepLoadMs.v1';

/** Used for a step this browser has never timed. */
export const STEP_LOAD_MS_DEFAULT = 2600;

/**
 * Bounds on a remembered duration, so one pathological load (a dropped
 * connection, a laptop asleep mid-fetch) can't poison the prediction for every
 * refresh after it.
 */
export const STEP_LOAD_MS_MIN = 350;
export const STEP_LOAD_MS_MAX = 90_000;

/**
 * Weight of the newest sample in the exponential moving average. High enough
 * that the prediction tracks a genuinely slower week within a couple of
 * refreshes, low enough that one slow load doesn't become the new normal.
 */
export const STEP_LOAD_EMA_ALPHA = 0.35;

/** Fraction of the bar the prediction alone is allowed to fill. */
export const PREDICTED_CEILING = 0.9;
/** Absolute ceiling once a load overruns its prediction. Still short of 1. */
export const OVERRUN_CEILING = 0.99;

const clampDuration = (ms: number): number =>
  Math.min(Math.max(ms, STEP_LOAD_MS_MIN), STEP_LOAD_MS_MAX);

/**
 * Predicted progress, 0–1, from elapsed time against the remembered duration.
 *
 * Ramps linearly to {@link PREDICTED_CEILING} across the prediction, then eases
 * asymptotically toward {@link OVERRUN_CEILING} when a load runs longer than
 * history said it would — so an overrun keeps showing movement instead of
 * parking at a dead 90%, without ever claiming to be finished.
 */
export function predictedProgress(elapsedMs: number, estimateMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const est = Number.isFinite(estimateMs) ? clampDuration(estimateMs) : STEP_LOAD_MS_DEFAULT;
  if (elapsedMs <= est) return PREDICTED_CEILING * (elapsedMs / est);
  const overrun = (elapsedMs - est) / est;
  return PREDICTED_CEILING + (OVERRUN_CEILING - PREDICTED_CEILING) * (1 - Math.exp(-overrun));
}

/**
 * Fold an observed duration into the stored estimate. `prev` is whatever was in
 * storage — including the garbage that comes back from a hand-edited key, which
 * is why anything non-finite or non-positive is treated as "no history".
 */
export function foldLoadSample(prev: unknown, sampleMs: number): number {
  const sample = clampDuration(sampleMs);
  const hasHistory = typeof prev === 'number' && Number.isFinite(prev) && prev > 0;
  const next = hasHistory ? (prev as number) + STEP_LOAD_EMA_ALPHA * (sample - (prev as number)) : sample;
  return Math.round(clampDuration(next));
}

/** Coerce a stored value into a usable estimate, falling back to the default. */
export function coerceEstimate(stored: unknown): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0
    ? clampDuration(stored)
    : STEP_LOAD_MS_DEFAULT;
}

function readTable(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(STEP_LOAD_MS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    // Private mode, quota, or a hand-edited key. The default estimate holds.
    return {};
  }
}

/** How long this step took last time, smoothed. Falls back to the default. */
export function readStepLoadEstimate(stepId: number): number {
  return coerceEstimate(readTable()[String(stepId)]);
}

/** Record an observed load duration for next time. Best-effort by design. */
export function recordStepLoadDuration(stepId: number, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const table = readTable();
    table[String(stepId)] = foldLoadSample(table[String(stepId)], ms);
    window.localStorage.setItem(STEP_LOAD_MS_KEY, JSON.stringify(table));
  } catch {
    /* Nothing to do — the next load just uses the default again. */
  }
}
