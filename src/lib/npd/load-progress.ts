/**
 * The NPD sheet's loading card (src/components/npd/NpdLoadProgress.tsx). Pure, so the
 * rules below are tested (load-progress.test.ts). Governing doc:
 * docs/features/npd-dashboard.md § Loading a sheet.
 *
 * Kane, 2026-10-05: "on top of the Skeleton, lets add a loading bar modal that has
 * multiple loading text's that are appropriate to gathering data … separate from All
 * department and HSL … Make sure to make it accurate."
 *
 * ACCURATE means every line of text is a step that really happened or is really
 * happening, reported by the server as it goes (GET /api/accounting/npd streams them,
 * src/lib/npd/load-stream.ts):
 *   open    → the route checked access and found this tab × week's sheet (its header);
 *   read    → it is reading the sheet's rows from the database;
 *   verify  → it re-reads the header, so a save that landed mid-read is caught
 *             (and the read starts again, up to NPD_READ_ATTEMPTS times);
 *   receive → the rows are arriving in this browser: an EXACT count, N of M;
 *   layout  → this page is putting them on the grid;
 *   done    → the grid is on screen (set only after the rows are applied).
 * A step's length is unknown, so the bar's fill inside a step is an estimate: one long
 * decelerating glide toward a ceiling it never passes, and no percentage is printed.
 * Only `receive` moves by fact (rows received ÷ rows sent). Only `done` fills it, so a
 * full bar always means the grid is on screen. It never moves backwards.
 *
 * The glide is stored as numbers (from, to, start time, length, curve), not left to a
 * DOM animation, so a tab switched away from and back to resumes exactly where its bar
 * is now: each tab × week has its own progress, and switching tabs never restarts it.
 */

import { NPD_SHEET_LABELS, type NpdSheetKind } from './columns';

export type NpdLoadStep = 'open' | 'read' | 'verify' | 'receive' | 'layout' | 'done' | 'failed';

/** The checklist, in order. `done` and `failed` are end states, not lines. */
export const NPD_LOAD_STEPS = ['open', 'read', 'verify', 'receive', 'layout'] as const;
type ListedStep = (typeof NPD_LOAD_STEPS)[number];

/** How many times the server reads a sheet that keeps changing under it (npd-db.ts readNpdSheet). */
export const NPD_READ_ATTEMPTS = 3;

/** A CSS cubic-bezier, as numbers, so the same curve drives the DOM and the maths. */
export type NpdEasing = readonly [number, number, number, number];
/** Decelerating: quick to show it started, then a long crawl that never looks stuck (sync-progress.ts). */
export const NPD_GLIDE: NpdEasing = [0.08, 0.82, 0.17, 1];
/** A confident arrival, for short known moves. */
export const NPD_ARRIVE: NpdEasing = [0.16, 1, 0.3, 1];

export const easingCss = (e: NpdEasing) => `cubic-bezier(${e.join(', ')})`;

/** One glide of the fill: from `from` to `to` (shares of the track, 0–1) over `ms`, from `startedAt`. */
export type NpdGlide = {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly ms: number;
  readonly easing: NpdEasing;
};

/** Where each step's glide stops. Increasing, and below 1 until `done`. */
export const NPD_LOAD_CEILING = {
  open: 0.16,
  read: 0.56,
  verify: 0.64,
  /** `receive` spans this range exactly, by rows received. */
  receiveTo: 0.94,
  layout: 0.97,
  done: 1,
} as const;

/** How long a step's glide takes to reach its ceiling (it is meant to arrive late, never early). */
export function readGlideMs(rowCount: number | null): number {
  const n = rowCount ?? 600;
  return Math.min(8000, Math.max(1800, 1800 + n * 3));
}

const clamp01 = (n: number) => (n <= 0 ? 0 : n >= 1 ? 1 : n);

/** y on the curve for a given x (time share), as the browser computes `cubic-bezier`. */
export function easeAt(e: NpdEasing, x: number): number {
  const t0 = clamp01(x);
  if (t0 === 0 || t0 === 1) return t0;
  const [x1, y1, x2, y2] = e;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  // Bisection on x(t): monotonic for 0 ≤ x1, x2 ≤ 1, which every curve here is.
  let lo = 0;
  let hi = 1;
  let t = t0;
  for (let i = 0; i < 40; i += 1) {
    const v = bx(t);
    if (Math.abs(v - t0) < 1e-7) break;
    if (v < t0) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

/** Where the fill is at `now`. */
export function glidePositionAt(g: NpdGlide, now: number): number {
  if (g.ms <= 0 || g.to === g.from) return g.to;
  return g.from + (g.to - g.from) * easeAt(g.easing, (now - g.startedAt) / g.ms);
}

/** A glide on from wherever the bar is now, never backwards. */
function glideOn(prev: NpdGlide, target: number, ms: number, easing: NpdEasing, now: number): NpdGlide {
  const from = glidePositionAt(prev, now);
  return { from, to: Math.max(from, Math.min(1, target)), startedAt: now, ms, easing };
}

/** Stopped where it is (a failure). */
function hold(prev: NpdGlide, now: number): NpdGlide {
  const at = glidePositionAt(prev, now);
  return { from: at, to: at, startedAt: now, ms: 0, easing: prev.easing };
}

/** What the stream (and, for the last two, the page) reports. */
export type NpdLoadEvent =
  /** Attempt N's header: the sheet's saved row count. */
  | { readonly kind: 'header'; readonly attempt: number; readonly rowCount: number }
  /** Attempt N read this many rows from the database. */
  | { readonly kind: 'read'; readonly attempt: number; readonly rows: number }
  /** A save landed mid-read: the server reads it again as attempt N. */
  | { readonly kind: 'retry'; readonly attempt: number }
  /** The read is consistent; this many rows are on their way. */
  | { readonly kind: 'sheet'; readonly rows: number }
  /** This many more rows arrived. */
  | { readonly kind: 'rows'; readonly count: number }
  | { readonly kind: 'layout' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly error: string };

export type NpdLoadProgress = {
  /** One per load: a new load of the same tab × week is a new id. */
  readonly loadId: number;
  readonly sheet: NpdSheetKind;
  readonly week: string;
  readonly step: NpdLoadStep;
  /** The step that was running when it failed. */
  readonly failedAt: ListedStep | null;
  /** The sheet's saved row count, from its header (null until the header arrives). */
  readonly rowCount: number | null;
  readonly attempt: number;
  /** Rows the server is sending (null until the read is consistent). */
  readonly total: number | null;
  readonly received: number;
  readonly glide: NpdGlide;
  readonly error: string | null;
};

let nextLoadId = 1;

/** A load just sent its request: the server is checking access and finding the sheet. */
export function startLoadProgress(sheet: NpdSheetKind, week: string, now: number): NpdLoadProgress {
  return {
    loadId: nextLoadId++,
    sheet,
    week,
    step: 'open',
    failedAt: null,
    rowCount: null,
    attempt: 1,
    total: null,
    received: 0,
    glide: { from: 0, to: NPD_LOAD_CEILING.open, startedAt: now, ms: 2400, easing: NPD_GLIDE },
    error: null,
  };
}

const isEnd = (s: NpdLoadStep) => s === 'done' || s === 'failed';

/** The fill while rows arrive: exactly rows received ÷ rows sent across the receive range. */
export function receiveTarget(received: number, total: number): number {
  const share = total > 0 ? Math.min(1, received / total) : 1;
  return NPD_LOAD_CEILING.verify + (NPD_LOAD_CEILING.receiveTo - NPD_LOAD_CEILING.verify) * share;
}

/** The next progress after `e`. An ended load (done / failed) never moves again. */
export function advanceLoadProgress(p: NpdLoadProgress, e: NpdLoadEvent, now: number): NpdLoadProgress {
  if (isEnd(p.step)) return p;
  switch (e.kind) {
    case 'header':
      return {
        ...p,
        step: 'read',
        attempt: e.attempt,
        rowCount: e.rowCount,
        glide: glideOn(p.glide, NPD_LOAD_CEILING.read, readGlideMs(e.rowCount), NPD_GLIDE, now),
      };
    case 'read':
      return { ...p, step: 'verify', attempt: e.attempt, glide: glideOn(p.glide, NPD_LOAD_CEILING.verify, 1600, NPD_GLIDE, now) };
    case 'retry':
      // Back to reading, but the bar stays where it is and crawls on: it never runs backwards.
      return { ...p, step: 'read', attempt: e.attempt, glide: glideOn(p.glide, NPD_LOAD_CEILING.read, readGlideMs(p.rowCount), NPD_GLIDE, now) };
    case 'sheet':
      return { ...p, step: 'receive', total: e.rows, received: 0, glide: glideOn(p.glide, receiveTarget(0, e.rows), 260, NPD_ARRIVE, now) };
    case 'rows': {
      if (p.step !== 'receive' || p.total === null) return p;
      const received = Math.min(p.total, p.received + e.count);
      return { ...p, received, glide: glideOn(p.glide, receiveTarget(received, p.total), 260, NPD_ARRIVE, now) };
    }
    case 'layout':
      return { ...p, step: 'layout', glide: glideOn(p.glide, NPD_LOAD_CEILING.layout, 900, NPD_GLIDE, now) };
    case 'done':
      return { ...p, step: 'done', glide: glideOn(p.glide, NPD_LOAD_CEILING.done, 280, NPD_ARRIVE, now) };
    case 'failed':
      return { ...p, step: 'failed', failedAt: p.step as ListedStep, error: e.error, glide: hold(p.glide, now) };
  }
}

const n = (v: number) => v.toLocaleString('en-US');
const rowsWord = (v: number) => `${n(v)} ${v === 1 ? 'row' : 'rows'}`;

export type NpdLoadLine = { readonly step: ListedStep; readonly state: 'done' | 'current' | 'todo' | 'failed'; readonly text: string };

/**
 * The checklist on the card. Every line is a fact: a step done says what it found, the
 * current step says what is happening now, and a step not reached yet says only what it
 * will do. A sheet with no saved rows skips reading, checking and receiving, because the
 * server skips them too.
 */
export function loadLines(p: NpdLoadProgress | null): NpdLoadLine[] {
  const at: NpdLoadStep = p?.step ?? 'open';
  const order = (s: NpdLoadStep): number =>
    s === 'done' ? NPD_LOAD_STEPS.length : s === 'failed' ? NPD_LOAD_STEPS.indexOf(p?.failedAt ?? 'open') : NPD_LOAD_STEPS.indexOf(s);
  const now = order(at);
  const empty = p !== null && p.rowCount === 0 && (p.total === null || p.total === 0);
  const rows = p?.total ?? p?.rowCount ?? null;
  const steps = NPD_LOAD_STEPS.filter((s) => !(empty && (s === 'read' || s === 'verify' || s === 'receive')));
  return steps.map((step) => {
    const i = NPD_LOAD_STEPS.indexOf(step);
    const state: NpdLoadLine['state'] = at === 'failed' && i === now ? 'failed' : i < now ? 'done' : i === now ? 'current' : 'todo';
    return { step, state, text: lineText(step, state, p, rows) };
  });
}

function lineText(step: ListedStep, state: NpdLoadLine['state'], p: NpdLoadProgress | null, rows: number | null): string {
  const done = state === 'done';
  switch (step) {
    case 'open':
      if (!done) return 'Finding this week’s sheet';
      return p?.rowCount === 0 ? 'No sheet saved for this week yet' : `Found it: ${rowsWord(p?.rowCount ?? 0)} saved`;
    case 'read':
      if (done) return `Read ${rowsWord(p?.rowCount ?? 0)} from the database`;
      if (state !== 'todo' && p && p.attempt > 1) {
        return `Someone saved meanwhile · reading it again (try ${p.attempt} of ${NPD_READ_ATTEMPTS})`;
      }
      return p?.rowCount != null ? `Reading ${rowsWord(p.rowCount)} from the database` : 'Reading the rows from the database';
    case 'verify':
      return done ? 'Nobody saved while it was read' : 'Checking nobody saved while it was read';
    case 'receive':
      if (done) return `Received ${rowsWord(p?.total ?? 0)}`;
      if (state === 'todo' || !p || p.total === null) return 'Receiving the rows';
      return `Receiving rows · ${n(p.received)} of ${n(p.total)}`;
    case 'layout':
      if (done) return rows ? `Laid out ${rowsWord(rows)}` : 'Laid out the sheet';
      return rows ? `Laying out ${rowsWord(rows)}` : 'Laying out the sheet';
  }
}

/** The card's heading. */
export function loadTitle(sheet: NpdSheetKind, p: NpdLoadProgress | null): string {
  const label = NPD_SHEET_LABELS[sheet];
  if (p?.step === 'done') return `Loaded ${label}`;
  if (p?.step === 'failed') return `${label} could not be loaded`;
  return `Loading ${label}`;
}

/**
 * What a screen reader is told, once per step (no running counts, so it is not chatty).
 * The exact count is on the progress bar's value text instead.
 */
export function loadAnnouncement(sheet: NpdSheetKind, p: NpdLoadProgress | null): string {
  const label = NPD_SHEET_LABELS[sheet];
  switch (p?.step ?? 'open') {
    case 'open':
      return `Loading ${label}: finding this week’s sheet`;
    case 'read':
      return `Loading ${label}: reading the rows from the database`;
    case 'verify':
      return `Loading ${label}: checking nobody saved while it was read`;
    case 'receive':
      return `Loading ${label}: receiving the rows`;
    case 'layout':
      return `Loading ${label}: laying out the grid`;
    case 'done':
      return `${label} loaded`;
    case 'failed':
      return `${label} could not be loaded`;
  }
}

/** The bar's value for assistive tech: where this step's glide stops (it never claims more). */
export function loadValueNow(p: NpdLoadProgress | null): number {
  return Math.round((p?.glide.to ?? 0) * 100);
}
