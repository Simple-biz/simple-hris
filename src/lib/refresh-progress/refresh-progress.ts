/**
 * The Refresh modal every table's Refresh button opens (src/components/common/RefreshProgressDialog.tsx).
 * Pure, so the rules below are tested (refresh-progress.test.ts). Governing doc:
 * docs/features/table-refresh-progress.md.
 *
 * Kane, 2026-10-05: "Find all the tables that have refresh buttons and make sure that when we
 * refresh it will not reload the table as skeleton but rather a modal with a progress bar on it
 * and add appropriate text to it".
 *
 * These are the NPD loading card's accuracy rules (npd-dashboard.md § Loading a sheet), made
 * general, plus ui-standards.md § 10.1 ("the bar tracks completed STEPS, never elapsed time"):
 *   - Every line is a real step: one per read the surface really sends, then the page putting
 *     what arrived on the table. A line is done only when its read has answered, and then it
 *     says what came back ("Read 42 leave requests").
 *   - The bar crosses a line's share only when that line finishes. Inside a line the fill is an
 *     estimate (one long decelerating glide toward a ceiling it never passes), so NO percentage
 *     is printed anywhere.
 *   - It never moves backwards. It is full and green only once the rows are on the table.
 *   - A failure holds the bar where it stopped and turns it red; the dialog keeps the server's
 *     own sentence on screen with Try again (§ 10.1, § 12.4).
 * Reads may run one after another or side by side; a read the surface never needed (a
 * conditional second request) is dropped from the list when the reads finish, never shown done.
 *
 * The glide maths is NPD's (one curve implementation, tested in load-progress.test.ts).
 */

import { NPD_ARRIVE, NPD_GLIDE, glidePositionAt, type NpdEasing, type NpdGlide } from '@/lib/npd/load-progress';

export type RefreshEasing = NpdEasing;
export type RefreshGlide = NpdGlide;

/** One read the refresh sends, in the order the list shows them. */
export type RefreshStepSpec = {
  /** Stable key the surface reports against (`tracker.step(id, …)`). */
  readonly id: string;
  /** What the line says before and while the read runs, e.g. "Reading leave requests". */
  readonly label: string;
  /** What it says once answered, when the surface reports no count, e.g. "Read the leave requests". */
  readonly doneLabel?: string;
};

export type RefreshPlan = {
  /** What is being refreshed, as the title names it: "leave requests" → "Refreshing leave requests". */
  readonly subject: string;
  /** The reads, at least one. */
  readonly steps: readonly RefreshStepSpec[];
  /** The last line while the page applies what arrived. Default "Updating the table". */
  readonly applyLabel?: string;
  /** The last line once the rows are on screen. Default "Table updated". */
  readonly appliedLabel?: string;
};

export type RefreshLineState = 'todo' | 'current' | 'done' | 'failed' | 'skipped';

export type RefreshPhase =
  /** Reads in flight (or about to start). */
  | 'running'
  /** Every read answered; the page is putting the rows on the table. */
  | 'applying'
  /** The rows are on the table. */
  | 'done'
  | 'failed';

export type RefreshProgress = {
  /** One per run: Try again is a new run. */
  readonly runId: number;
  readonly plan: RefreshPlan;
  readonly phase: RefreshPhase;
  readonly states: Readonly<Record<string, RefreshLineState>>;
  /** A finished read's own sentence ("Read 42 leave requests"), when the surface reported one. */
  readonly details: Readonly<Record<string, string>>;
  readonly glide: RefreshGlide;
  /** The failure's sentence, shown as it came (already cleaned for display by the caller). */
  readonly error: string | null;
  /** The failure came after every read had answered: the page could not use what arrived. */
  readonly applyFailed: boolean;
};

/** A line's share of the track while it is in flight: it glides toward here and never past. */
export const REFRESH_IN_FLIGHT_SHARE = 0.8;
/** How long an in-flight glide takes to reach its ceiling: meant to arrive late, never early. */
export const REFRESH_READ_GLIDE_MS = 6000;
/** The page applying the rows is short and known to be short. */
export const REFRESH_APPLY_GLIDE_MS = 900;
/** The last, confident move to full once the rows are on the table. */
export const REFRESH_DONE_GLIDE_MS = 280;

export const DEFAULT_APPLY_LABEL = 'Updating the table';
export const DEFAULT_APPLIED_LABEL = 'Table updated';

const APPLY_LINE_ID = '__apply__';

let nextRunId = 1;

const isEnded = (p: RefreshProgress) => p.phase === 'done' || p.phase === 'failed';

/** A glide on from wherever the bar is now, never backwards. */
function glideOn(prev: RefreshGlide, target: number, ms: number, easing: RefreshEasing, now: number): RefreshGlide {
  const from = glidePositionAt(prev, now);
  return { from, to: Math.max(from, Math.min(1, target)), startedAt: now, ms, easing };
}

/** Stopped where it is (a failure). */
function hold(prev: RefreshGlide, now: number): RefreshGlide {
  const at = glidePositionAt(prev, now);
  return { from: at, to: at, startedAt: now, ms: 0, easing: prev.easing };
}

/**
 * Where the fill may glide to right now: every finished read's full share, plus most of the
 * share of each read in flight (and of the apply line while the page applies). Only `done` is 1.
 */
export function refreshTarget(p: RefreshProgress): number {
  if (p.phase === 'done') return 1;
  const listed = p.plan.steps.filter((s) => p.states[s.id] !== 'skipped');
  const total = listed.length + 1; // + the apply line
  const done = listed.filter((s) => p.states[s.id] === 'done').length;
  const inFlight = listed.filter((s) => p.states[s.id] === 'current').length + (p.phase === 'applying' ? 1 : 0);
  return Math.min(1, (done + REFRESH_IN_FLIGHT_SHARE * inFlight) / total);
}

/** The click: nothing has been sent yet, so nothing is filled. */
export function startRefresh(plan: RefreshPlan, now: number): RefreshProgress {
  if (plan.steps.length === 0) throw new Error('A refresh plan needs at least one read.');
  const ids = new Set<string>();
  for (const s of plan.steps) {
    if (s.id === APPLY_LINE_ID || ids.has(s.id)) throw new Error(`Refresh step id "${s.id}" is reserved or repeated.`);
    ids.add(s.id);
  }
  const states: Record<string, RefreshLineState> = {};
  for (const s of plan.steps) states[s.id] = 'todo';
  return {
    runId: nextRunId++,
    plan,
    phase: 'running',
    states,
    details: {},
    glide: { from: 0, to: 0, startedAt: now, ms: 0, easing: NPD_GLIDE },
    error: null,
    applyFailed: false,
  };
}

const knows = (p: RefreshProgress, id: string) => Object.prototype.hasOwnProperty.call(p.states, id);

/** A read was sent. */
export function beginStep(p: RefreshProgress, id: string, now: number): RefreshProgress {
  if (isEnded(p) || p.phase !== 'running' || !knows(p, id) || p.states[id] !== 'todo') return p;
  const next = { ...p, states: { ...p.states, [id]: 'current' as const } };
  return { ...next, glide: glideOn(p.glide, refreshTarget(next), REFRESH_READ_GLIDE_MS, NPD_GLIDE, now) };
}

/** A read answered. `detail` is its own sentence ("Read 42 leave requests"), or null. */
export function completeStep(p: RefreshProgress, id: string, detail: string | null, now: number): RefreshProgress {
  if (isEnded(p) || p.phase !== 'running' || !knows(p, id)) return p;
  const s = p.states[id];
  if (s !== 'current' && s !== 'todo') return p;
  const next: RefreshProgress = {
    ...p,
    states: { ...p.states, [id]: 'done' },
    details: detail ? { ...p.details, [id]: detail } : p.details,
  };
  return { ...next, glide: glideOn(p.glide, refreshTarget(next), REFRESH_READ_GLIDE_MS, NPD_GLIDE, now) };
}

/**
 * Every read the surface made has answered and it has handed its rows to the page. A read it
 * never sent is dropped from the list (skipped), never shown as done.
 */
export function applyRefresh(p: RefreshProgress, now: number): RefreshProgress {
  if (p.phase !== 'running') return p;
  const states: Record<string, RefreshLineState> = { ...p.states };
  for (const id of Object.keys(states)) {
    if (states[id] === 'todo') states[id] = 'skipped';
    // A read still marked in flight here was never reported back; it cannot be called done.
    if (states[id] === 'current') states[id] = 'skipped';
  }
  const next: RefreshProgress = { ...p, phase: 'applying', states };
  return { ...next, glide: glideOn(p.glide, refreshTarget(next), REFRESH_APPLY_GLIDE_MS, NPD_GLIDE, now) };
}

/** The rows are on the table. Only this fills the bar. */
export function finishRefresh(p: RefreshProgress, now: number): RefreshProgress {
  if (p.phase !== 'applying') return p;
  const next: RefreshProgress = { ...p, phase: 'done' };
  return { ...next, glide: glideOn(p.glide, 1, REFRESH_DONE_GLIDE_MS, NPD_ARRIVE, now) };
}

/**
 * The refresh failed; the bar holds where it is. `stepId` is the read that failed, when it is
 * known: only that line is marked failed, and a read still in flight beside it goes back to
 * unfinished (it did not fail, and it will not be reported). Without one (the surface reported a
 * failure itself), every read in flight is where it stopped.
 */
export function failRefresh(p: RefreshProgress, error: string, now: number, stepId?: string): RefreshProgress {
  if (isEnded(p)) return p;
  const states: Record<string, RefreshLineState> = { ...p.states };
  let marked = false;
  if (stepId !== undefined && knows(p, stepId) && p.phase === 'running') {
    states[stepId] = 'failed';
    marked = true;
    for (const id of Object.keys(states)) {
      if (id !== stepId && states[id] === 'current') states[id] = 'todo';
    }
    return { ...p, phase: 'failed', states, error, applyFailed: false, glide: hold(p.glide, now) };
  }
  for (const id of Object.keys(states)) {
    if (states[id] === 'current') {
      states[id] = 'failed';
      marked = true;
    }
  }
  // Failed between reads: the next read that had not started is where it stopped.
  if (!marked && p.phase === 'running') {
    const firstTodo = p.plan.steps.find((s) => states[s.id] === 'todo');
    if (firstTodo) {
      states[firstTodo.id] = 'failed';
      marked = true;
    }
  }
  // Nothing left to blame on a read: every read answered and the page could not use what arrived.
  return { ...p, phase: 'failed', states, error, applyFailed: !marked, glide: hold(p.glide, now) };
}

export type RefreshLine = { readonly id: string; readonly state: Exclude<RefreshLineState, 'skipped'>; readonly text: string };

/** The checklist: each read in plan order (skipped ones dropped), then the apply line. */
export function refreshLines(p: RefreshProgress): RefreshLine[] {
  const lines: RefreshLine[] = [];
  for (const s of p.plan.steps) {
    const state = p.states[s.id];
    if (!state || state === 'skipped') continue;
    const text = state === 'done' ? (p.details[s.id] ?? s.doneLabel ?? s.label) : s.label;
    lines.push({ id: s.id, state, text });
  }
  const applyState: RefreshLine['state'] =
    p.phase === 'done' ? 'done' : p.phase === 'applying' ? 'current' : p.phase === 'failed' && p.applyFailed ? 'failed' : 'todo';
  lines.push({
    id: APPLY_LINE_ID,
    state: applyState,
    text: applyState === 'done' ? (p.plan.appliedLabel ?? DEFAULT_APPLIED_LABEL) : (p.plan.applyLabel ?? DEFAULT_APPLY_LABEL),
  });
  return lines;
}

/** The dialog's heading. */
export function refreshTitle(p: RefreshProgress): string {
  if (p.phase === 'done') return `Refreshed ${p.plan.subject}`;
  if (p.phase === 'failed') return `Couldn't refresh ${p.plan.subject}`;
  return `Refreshing ${p.plan.subject}`;
}

/** The line the bar's value text carries: what is happening now (or what stopped). */
export function refreshCurrentText(p: RefreshProgress): string {
  const lines = refreshLines(p);
  const now = lines.find((l) => l.state === 'failed') ?? lines.find((l) => l.state === 'current');
  if (now) return now.text;
  if (p.phase === 'done') return refreshTitle(p);
  return lines[0]?.text ?? refreshTitle(p);
}

/**
 * What a screen reader is told: once per line change (no running counts), so it is not chatty.
 */
export function refreshAnnouncement(p: RefreshProgress): string {
  if (p.phase === 'done') return `${refreshTitle(p)}.`;
  if (p.phase === 'failed') return `${refreshTitle(p)}: ${p.error ?? 'the read failed'}`;
  return `${refreshTitle(p)}: ${refreshCurrentText(p)}`;
}

/** The bar's value for assistive tech: where this glide stops (it never claims more). */
export function refreshValueNow(p: RefreshProgress): number {
  return Math.round(p.glide.to * 100);
}

/** "1 leave request" / "42 leave requests", with thousands separators. */
export function countOf(n: number, singular: string, plural: string = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}
