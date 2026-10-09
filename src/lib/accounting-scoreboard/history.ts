/**
 * The History tab (Kane, 2026-10-09): every week the board holds, as one bar per week for the Team Score and for each
 * Overview card, plus the three highlight cards and the notes beside them. Pure, so the route and the panel share it.
 * Governing doc: docs/features/accounting-scoreboard-history.md.
 *
 * A week here is computed by the Overview's own calls (sectionHeadline, weekLight, sectionCard, teamScore), so a bar
 * and that week's Overview card can never disagree. What History adds is only which weeks, and what to point out.
 */

import { sectionCard, sectionHeadline, weekLight, type BoardContext } from './board';
import { buildLookup, type CollectionEntry, type ProblemEntry, type StoredEntry } from './scoring';
import { boardSections, overviewSections, rowSectionId, tabIdFor, type BoardSection, type CustomSection, type SectionSetting } from './sections';
import { weekPace, type Light } from './stoplight';
import { teamScore } from './team-score';
import type { PayrollEvent } from './payroll-cycle';
import type { BoardRow } from './types';
import { addDays, datesFor, isWeekStart, weekStartOf } from './week';

/** A window the panel asks for at a time: a quarter. One read of every week measured 13.8–71 s (2026-10-09). */
export const HISTORY_WINDOW_WEEKS = 13;
/** The most weeks one request may ask for. Past this the cells alone are 13+ pages. */
export const HISTORY_MAX_WEEKS = 26;
/** Writes are refused before 2024-01-01 (validate.ts), so no week can start earlier than its Sunday. */
export const HISTORY_EARLIEST_WEEK = '2023-12-31';

export interface HistoryWindow {
  /** Sunday key of the first week, inclusive. */
  from: string;
  /** Sunday key of the last week, inclusive. */
  to: string;
}

/** One card on one week: what the Overview card would have said that week. */
export interface HistoryCell {
  /** The card's headline in its own unit; null = nothing typed ("—", never 0). */
  value: number | null;
  light: Light;
  /** The Team Score card (0–100); null = left out of the Team Score that week. */
  score: number | null;
}

export interface HistoryWeek {
  weekStart: string;
  /** This week: judged on pace, drawn as "so far", and never a best or worst week. */
  partial: boolean;
  team: { score: number | null; light: Light };
  /** By section id (BoardSection.id). A card absent here was not on the Overview when this was computed. */
  cells: Record<string, HistoryCell>;
}

/** GET /api/accounting-scoreboard/history?from=&to= */
export interface HistoryPayload {
  from: string;
  to: string;
  /** US Eastern. */
  today: string;
  thisWeek: string;
  /** The first week that holds any number (a cell, a collection or a problem line); null on an empty board. */
  firstWeek: string | null;
  /** The cards, in the Overview's order, by section id. */
  sectionIds: string[];
  weeks: HistoryWeek[];
  generatedAt: string;
}

export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = from; w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

/**
 * `from` and `to` from the query string: Sunday keys, from ≤ to, at most HISTORY_MAX_WEEKS weeks, never after this
 * week, never before HISTORY_EARLIEST_WEEK. Every refusal names the rule.
 */
export function parseHistoryWindow(
  q: { from: string | null; to: string | null },
  thisWeek: string,
): { ok: true; value: HistoryWindow } | { ok: false; error: string } {
  const { from, to } = q;
  if (!from || !to) return { ok: false, error: 'from and to are both required (Sunday dates, YYYY-MM-DD).' };
  if (!isWeekStart(from)) return { ok: false, error: 'from must be a Sunday date (YYYY-MM-DD).' };
  if (!isWeekStart(to)) return { ok: false, error: 'to must be a Sunday date (YYYY-MM-DD).' };
  if (from > to) return { ok: false, error: 'from must be on or before to.' };
  if (to > thisWeek) return { ok: false, error: 'to cannot be after this week.' };
  if (from < HISTORY_EARLIEST_WEEK) return { ok: false, error: `from cannot be before ${HISTORY_EARLIEST_WEEK}.` };
  const weeks = weeksBetween(from, to).length;
  if (weeks > HISTORY_MAX_WEEKS) return { ok: false, error: `Ask for at most ${HISTORY_MAX_WEEKS} weeks at a time (asked for ${weeks}).` };
  return { ok: true, value: { from, to } };
}

/**
 * The windows the panel loads, newest first: this week's quarter, then each quarter before it, down to the first week
 * with a number. The last (oldest) window is cut at `firstWeek`, never past it.
 */
export function historyWindows(thisWeek: string, firstWeek: string | null, size = HISTORY_WINDOW_WEEKS): HistoryWindow[] {
  const floor = firstWeek && firstWeek <= thisWeek ? firstWeek : thisWeek;
  const out: HistoryWindow[] = [];
  for (let to = thisWeek; to >= floor; to = addDays(to, -7 * size)) {
    const from = addDays(to, -7 * (size - 1));
    out.push({ from: from < floor ? floor : from, to });
  }
  return out;
}

export interface HistoryInput {
  /** Every section on the board (boardSections): the cards are its Overview list, the groups its tabs. */
  sections: readonly BoardSection[];
  /** Every row, archived too: a past week belongs to the rows that held it. */
  rows: readonly BoardRow[];
  /** The window's cells. */
  entries: readonly StoredEntry[];
  /** The window's live collection lines. */
  collections: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[];
  /** The window's live problem lines. */
  problems: readonly Pick<ProblemEntry, 'date' | 'rowId' | 'typeId' | 'count'>[];
  /** Every Payroll Wizard start and pay-cycle close, ever. */
  payrollEvents: readonly PayrollEvent[];
  firstClosedPeriodEnd: string | null;
  today: string;
  nowIso: string;
}

/**
 * Every week of the window, oldest first. Each card is the Overview's: its headline (sectionHeadline), its light
 * (weekLight: this week on pace, a past week on its full goal) and its Team Score card (sectionCard), and the week's
 * Team Score is teamScore over those cards grouped by the tab each sits on.
 */
export function historyWeeks(input: HistoryInput, window: HistoryWindow): HistoryWeek[] {
  const cards = overviewSections(input.sections);
  const groups = cards.map((s) => {
    const groupId = tabIdFor(input.sections, s);
    return { groupId, groupLabel: input.sections.find((x) => x.id === groupId)?.tab ?? s.tab };
  });
  const rowsBySection = new Map<string, BoardRow[]>();
  for (const r of input.rows) {
    const id = rowSectionId(r);
    if (!rowsBySection.has(id)) rowsBySection.set(id, []);
    rowsBySection.get(id)!.push(r);
  }
  const ctx: BoardContext = {
    lookup: buildLookup(input.entries),
    collections: input.collections,
    problems: input.problems,
    payrollEvents: input.payrollEvents,
    firstClosedPeriodEnd: input.firstClosedPeriodEnd,
    today: input.today,
    nowIso: input.nowIso,
  };
  const thisWeek = weekStartOf(input.today);

  return weeksBetween(window.from, window.to).map((weekStart) => {
    const cells: Record<string, HistoryCell> = {};
    const teamCards = cards.map((s, i) => {
      const value = sectionHeadline(s, rowsBySection.get(s.id) ?? [], ctx, weekStart);
      const pace = weekPace(datesFor(weekStart, s.days), input.today);
      const card = sectionCard(s, value, ctx, weekStart, pace);
      cells[s.id] = { value, light: weekLight(s, value, ctx, weekStart, pace), score: card.score };
      return { ...groups[i], card };
    });
    const team = teamScore(teamCards);
    return { weekStart, partial: weekStart === thisWeek, team: { score: team.score, light: team.light }, cells };
  });
}

/** What the server reads for one window (server.ts readHistory). */
export interface HistoryRead extends Omit<HistoryInput, 'sections'> {
  settings: readonly SectionSetting[];
  customSections: readonly CustomSection[];
  firstWeek: string | null;
}

/** The route's answer: the window's weeks, computed for the board's sections today. */
export function historyPayload(read: HistoryRead, window: HistoryWindow): HistoryPayload {
  const sections = boardSections(read.settings, read.customSections);
  return {
    from: window.from,
    to: window.to,
    today: read.today,
    thisWeek: weekStartOf(read.today),
    firstWeek: read.firstWeek,
    sectionIds: overviewSections(sections).map((s) => s.id),
    weeks: historyWeeks({ ...read, sections }, window),
    generatedAt: read.nowIso,
  };
}

// ---------------------------------------------------------------------------
// What the panel points out. Every pick reads FULL weeks only (never this week, still running) and skips a week
// with nothing to judge: absence is never a week behind, and never a best or worst week.
// ---------------------------------------------------------------------------

export type HistoryRange = '12' | '26' | '52' | 'all';

/** The first week a range shows: the last N weeks through this week, never before the first week with a number. */
export function rangeStart(range: HistoryRange, thisWeek: string, firstWeek: string | null): string {
  const floor = firstWeek && firstWeek <= thisWeek ? firstWeek : thisWeek;
  if (range === 'all') return floor;
  const start = addDays(thisWeek, -7 * (Number(range) - 1));
  return start < floor ? floor : start;
}

export interface TeamHighlight {
  /** The last full week with a Team Score. */
  week: string | null;
  score: number | null;
  light: Light;
  /** The full week with a Team Score before it, and the change. */
  previousWeek: string | null;
  delta: number | null;
  /** The mean Team Score of the full weeks shown that have one, one decimal. */
  average: number | null;
  /** How many full weeks have a Team Score. */
  scoredWeeks: number;
}

export interface CardHighlight {
  sectionId: string;
  green: number;
  red: number;
  /** Weeks with a light (on track, close or behind). */
  judged: number;
  /** Behind this many judged weeks running, up to the latest judged full week. */
  behindRun: number;
}

export interface HistoryHighlights {
  team: TeamHighlight;
  /** The card on track the most weeks; null when none was ever on track. */
  steadiest: CardHighlight | null;
  /** The card behind the longest run right now, else the card behind the most weeks; null when none was behind. */
  attention: (CardHighlight & { reason: 'running' | 'most' }) | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** `weeks` oldest first; `sectionIds` in the Overview's order (the tie-break). */
export function historyHighlights(weeks: readonly HistoryWeek[], sectionIds: readonly string[]): HistoryHighlights {
  const full = weeks.filter((w) => !w.partial);
  const scored = full.filter((w) => w.team.score !== null);
  const last = scored.at(-1) ?? null;
  const prev = scored.length > 1 ? scored[scored.length - 2] : null;
  const team: TeamHighlight = {
    week: last?.weekStart ?? null,
    score: last?.team.score ?? null,
    light: last?.team.light ?? 'none',
    previousWeek: prev?.weekStart ?? null,
    delta: last && prev && last.team.score !== null && prev.team.score !== null ? round1(last.team.score - prev.team.score) : null,
    average: scored.length ? round1(scored.reduce((s, w) => s + (w.team.score ?? 0), 0) / scored.length) : null,
    scoredWeeks: scored.length,
  };

  const perCard: CardHighlight[] = sectionIds.map((id) => {
    const lights = full.map((w) => w.cells[id]?.light ?? 'none').filter((l) => l !== 'none');
    let behindRun = 0;
    for (let i = lights.length - 1; i >= 0 && lights[i] === 'red'; i--) behindRun++;
    return {
      sectionId: id,
      green: lights.filter((l) => l === 'green').length,
      red: lights.filter((l) => l === 'red').length,
      judged: lights.length,
      behindRun,
    };
  });
  // Ties keep the Overview's order: sort is stable.
  const steadiest = [...perCard].filter((c) => c.green > 0).sort((a, b) => b.green - a.green || b.green / b.judged - a.green / a.judged)[0] ?? null;
  const running = [...perCard].filter((c) => c.behindRun >= 2).sort((a, b) => b.behindRun - a.behindRun)[0];
  const most = [...perCard].filter((c) => c.red > 0).sort((a, b) => b.red - a.red || b.red / b.judged - a.red / a.judged)[0];
  const attention = running ? { ...running, reason: 'running' as const } : most ? { ...most, reason: 'most' as const } : null;
  return { team, steadiest, attention };
}

export type HistoryNote =
  | { kind: 'best_week'; week: string; score: number }
  | { kind: 'toughest_week'; week: string; score: number }
  | { kind: 'best_run'; week: string; from: string; weeks: number }
  | { kind: 'biggest_jump'; week: string; from: string; delta: number }
  | { kind: 'record'; week: string; sectionId: string; value: number }
  | { kind: 'this_week'; week: string; score: number | null; light: Light };

/**
 * The notes beside the charts, computed, never typed. `week` is the week a note points at (the one it selects).
 * `recordSectionId` names the card whose best week is a note (Collections' points, when it is on the Overview).
 */
export function historyNotes(weeks: readonly HistoryWeek[], recordSectionId: string | null): HistoryNote[] {
  const notes: HistoryNote[] = [];
  const full = weeks.filter((w) => !w.partial);
  const scored = full.filter((w) => w.team.score !== null) as (HistoryWeek & { team: { score: number } })[];

  if (scored.length) {
    // Ties go to the latest week: the record that stands now.
    const best = scored.reduce((a, b) => (b.team.score >= a.team.score ? b : a));
    notes.push({ kind: 'best_week', week: best.weekStart, score: best.team.score });
    if (scored.length > 1) {
      const worst = scored.reduce((a, b) => (b.team.score <= a.team.score ? b : a));
      if (worst.weekStart !== best.weekStart) notes.push({ kind: 'toughest_week', week: worst.weekStart, score: worst.team.score });
    }
  }

  // The longest run of back-to-back full weeks on track. A week with no Team Score ends a run.
  type Run = { from: string; to: string; weeks: number };
  let run = null as Run | null;
  let cur = null as Run | null;
  for (const w of full) {
    if (w.team.light === 'green') {
      cur = cur ? { ...cur, to: w.weekStart, weeks: cur.weeks + 1 } : { from: w.weekStart, to: w.weekStart, weeks: 1 };
      if (!run || cur.weeks >= run.weeks) run = cur;
    } else cur = null;
  }
  if (run && run.weeks >= 2) notes.push({ kind: 'best_run', week: run.to, from: run.from, weeks: run.weeks });

  // The biggest rise from one scored full week to the next scored one.
  // Ties go to the latest rise.
  const jump = scored
    .slice(1)
    .map((w, i) => ({ week: w.weekStart, from: scored[i].weekStart, delta: round1(w.team.score - scored[i].team.score) }))
    .filter((j) => j.delta > 0)
    .reduce<{ week: string; from: string; delta: number } | null>((a, b) => (!a || b.delta >= a.delta ? b : a), null);
  if (jump) notes.push({ kind: 'biggest_jump', ...jump });

  if (recordSectionId) {
    let rec: { week: string; value: number } | null = null;
    for (const w of full) {
      const v = w.cells[recordSectionId]?.value;
      if (v !== null && v !== undefined && (!rec || v >= rec.value)) rec = { week: w.weekStart, value: v };
    }
    if (rec) notes.push({ kind: 'record', week: rec.week, sectionId: recordSectionId, value: rec.value });
  }

  const now = weeks.find((w) => w.partial);
  if (now) notes.push({ kind: 'this_week', week: now.weekStart, score: now.team.score, light: now.team.light });
  return notes;
}
