/**
 * Clearing one week's old-grid Payroll Problems counts, the plan only (pure). The script that runs it is
 * scripts/clear-accounting-scoreboard-problem-grid-week.mts.
 * Governing doc: docs/features/accounting-scoreboard.md § Payroll Problems.
 *
 * Carla, 2026-10-07 meeting (Open item 391): "we had added like the types after Monday and so the Monday ones have
 * no type […] I don't have an option to edit or delete the Monday problems because they're not under the log." The
 * board's rule is that the old grid takes no writes. Kane ruled W0.2 = (a) the same day: a one-off script clears
 * that week's grid counts, after a backup, and the team re-logs them with types. The app still takes no grid write.
 *
 * Old-grid counts are accounting_scoreboard_entries rows with slot 'day' on a payroll_problems row, read as "No type"
 * (UNTYPED_PROBLEMS in scoring.ts). A cleared cell is a DELETED entry, never a stored 0.
 */

import { addDays, isWeekStart } from './week';

/** The weeks Kane ruled may be cleared (W0.2 = (a), 2026-10-07: Monday 10-05's). Any other week needs a new ruling. */
export const RULED_WEEKS: readonly string[] = ['2026-10-04'];

/**
 * The round-3 migration was applied at 2026-10-06 ~18:04:22Z, and the grid has taken no write since. An entry saved at
 * or after this minute is not an old-grid count, so its week is refused rather than cleared.
 */
export const GRID_CUTOFF = '2026-10-06T18:04:00Z';

/** One stored old-grid cell, as the script reads it. */
export interface GridEntry {
  rowId: string;
  /** YYYY-MM-DD. */
  date: string;
  slot: string;
  value: number;
  /** When it was last saved (entries keep updated_at only). */
  updatedAt: string;
}

export interface GridClearPlan {
  ok: true;
  entries: GridEntry[];
  /** Σ of the counts cleared. */
  total: number;
  byDay: { date: string; entries: number; total: number }[];
  /** A row is named by the first 8 characters of its id, never its label: a row label is a person's name. */
  byRow: { row: string; entries: number; total: number }[];
}

export type GridClearResult = GridClearPlan | { ok: false; refusal: string };

const refuse = (refusal: string): GridClearResult => ({ ok: false, refusal });

/**
 * What clearing `week` would delete, or why it must not. `entries` is every entry on a payroll_problems row dated in
 * that week (Sunday through Saturday), whatever its slot, so a shape the script does not expect is refused, never
 * skipped.
 */
export function planGridClear(week: string, entries: readonly GridEntry[]): GridClearResult {
  if (!isWeekStart(week)) return refuse(`--week must be a Sunday written YYYY-MM-DD (the week's key); got "${week}"`);
  if (!RULED_WEEKS.includes(week)) return refuse(`${week} is not a week Kane ruled may be cleared (ruled: ${RULED_WEEKS.join(', ')})`);
  if (!entries.length) return refuse(`the week of ${week} holds no old-grid Payroll Problems counts: nothing to clear`);
  const last = addDays(week, 6);
  const cutoff = Date.parse(GRID_CUTOFF);
  for (const e of entries) {
    if (e.date < week || e.date > last) return refuse(`an entry dated ${e.date} is outside the week of ${week}`);
    if (e.slot !== 'day') return refuse(`an entry in slot "${e.slot}" (${e.date}) is not an old-grid day count`);
    const at = Date.parse(e.updatedAt);
    if (!Number.isFinite(at)) return refuse(`an entry dated ${e.date} has an unreadable save time "${e.updatedAt}"`);
    if (at >= cutoff) {
      return refuse(`an entry dated ${e.date} was saved ${e.updatedAt}, at or after the round-3 apply (${GRID_CUTOFF}): it is not an old-grid count`);
    }
  }
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.rowId.localeCompare(b.rowId));
  const days = new Map<string, { entries: number; total: number }>();
  const rows = new Map<string, { entries: number; total: number }>();
  for (const e of sorted) {
    const d = days.get(e.date) ?? { entries: 0, total: 0 };
    days.set(e.date, { entries: d.entries + 1, total: d.total + e.value });
    const key = e.rowId.slice(0, 8);
    const r = rows.get(key) ?? { entries: 0, total: 0 };
    rows.set(key, { entries: r.entries + 1, total: r.total + e.value });
  }
  return {
    ok: true,
    entries: sorted,
    total: sorted.reduce((s, e) => s + e.value, 0),
    byDay: [...days].map(([date, v]) => ({ date, ...v })),
    byRow: [...rows].map(([row, v]) => ({ row, ...v })).sort((a, b) => a.row.localeCompare(b.row)),
  };
}
