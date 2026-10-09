/**
 * HRIS Total Project SP and SP Completed — session log item 340's ADDITIVE method, which Kane approved
 * as the project figure on 2026-10-08 ("yep", answering item 154 (a)).
 *
 * Why additive. The epics were forecast in July at whole-feature granularity, and every task row
 * filed since Sprint 26 (Aug 4) is work on top of that forecast. So per epic:
 *
 *   total     = max(forecast, child SP filed BEFORE Sprint 26) + child SP filed from Sprint 26 on
 *   uncovered = for an epic NOT Shipped: max(0, forecast − ALL child SP)   ← forecast no row covers
 *   completed = total − open task SP − uncovered
 *
 * Uncovered is measured against ALL children, not just the pre-Sprint-26 ones. That is the definition
 * that reproduces item 340's recorded figures exactly (3,289 / 2,999 on the 2026-10-08 plan, commit
 * f0eac591). A scratch copy of the instrument had drifted to "forecast − pre-Sprint-26 children" and
 * reported 485 uncovered instead of 150; it is not a reference.
 *
 * `sync.ts`'s portfolio rollup is a DIFFERENT number (Σ epic forecast, and Σ Shipped forecast). Showing
 * this figure on the Projects Portfolio is item 154's formula change, still Kane's (item 340).
 *
 * Pure: no I/O. Rows in the Backlog count as post-Aug-4 work, as they did in item 340.
 */

/** Sprints that closed before Sprint 26 (Aug 4): the history the July forecast already covers. */
export const PRE_FORECAST_SPRINTS: ReadonlySet<string> = new Set([
  'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25',
]);

export interface RollupEpic {
  code: string;
  sp: number;
  status: string;
}

export interface RollupTask {
  epic: string;
  sp: number;
  done: boolean;
  sprint: string;
}

export interface ProjectSp {
  /** Σ epic forecast — what the portfolio rollup in sync.ts shows as Total. */
  forecast: number;
  /** Item 340's Total Project SP. */
  total: number;
  /** Child task SP filed before Sprint 26 / from Sprint 26 on (Backlog included). */
  childPre: number;
  childPost: number;
  taskRows: number;
  taskSp: number;
  doneRows: number;
  doneSp: number;
  openRows: number;
  openSp: number;
  /** Forecast on non-Shipped epics that no task row covers, per epic and in all. */
  uncoveredByEpic: Record<string, number>;
  uncovered: number;
  /** Item 340's SP Completed. */
  completed: number;
}

/**
 * @param asShipped epic codes to treat as Shipped whatever their status says — "what if V1's epics
 *   were marked Shipped". Leave empty for the figure as recorded.
 */
export function projectSp(
  epics: readonly RollupEpic[],
  tasks: readonly RollupTask[],
  asShipped: readonly string[] = [],
): ProjectSp {
  const shipped = new Set(asShipped);
  const byEpic = new Map<string, RollupTask[]>();
  for (const t of tasks) byEpic.set(t.epic, [...(byEpic.get(t.epic) ?? []), t]);

  let forecast = 0;
  let total = 0;
  let childPre = 0;
  let childPost = 0;
  let uncovered = 0;
  const uncoveredByEpic: Record<string, number> = {};
  for (const e of epics) {
    const kids = byEpic.get(e.code) ?? [];
    const pre = kids.filter((t) => PRE_FORECAST_SPRINTS.has(t.sprint)).reduce((a, t) => a + t.sp, 0);
    const all = kids.reduce((a, t) => a + t.sp, 0);
    forecast += e.sp;
    childPre += pre;
    childPost += all - pre;
    total += Math.max(e.sp, pre) + (all - pre);
    if (e.status !== 'Shipped' && !shipped.has(e.code)) {
      const u = Math.max(0, e.sp - all);
      if (u > 0) {
        uncoveredByEpic[e.code] = u;
        uncovered += u;
      }
    }
  }

  const done = tasks.filter((t) => t.done);
  const open = tasks.filter((t) => !t.done);
  const doneSp = done.reduce((a, t) => a + t.sp, 0);
  const openSp = open.reduce((a, t) => a + t.sp, 0);
  return {
    forecast,
    total,
    childPre,
    childPost,
    taskRows: tasks.length,
    taskSp: doneSp + openSp,
    doneRows: done.length,
    doneSp,
    openRows: open.length,
    openSp,
    uncoveredByEpic,
    uncovered,
    completed: total - openSp - uncovered,
  };
}
