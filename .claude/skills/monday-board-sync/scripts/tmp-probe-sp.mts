/** READ-ONLY: SP closed, by sprint and all-time, straight off the board. */
import { HRIS_PROJECT_ITEM_ID, MONDAY_BOARDS, PROJECT_COLS, TASK_COLS, PLAN_TASKS, getItemsByIds, isOurTask, listBoardItems } from './monday.mts';
const t = (await listBoardItems(MONDAY_BOARDS.tasks, [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.estimatedSp, TASK_COLS.sprint])).filter((x) => isOurTask(x.name));
const n = (v: string) => Number(v || 0);
const by: Record<string, { done: number; act: number; open: number; openEst: number }> = {};
let act = 0, done = 0, open = 0, openEst = 0, phantom = 0, doneNoSp = 0;
for (const r of t) {
  const s = r.cols[TASK_COLS.sprint] || '(none)';
  by[s] ??= { done: 0, act: 0, open: 0, openEst: 0 };
  if (r.cols[TASK_COLS.status] === 'Done') {
    done++; act += n(r.cols[TASK_COLS.actualSp]); by[s].done++; by[s].act += n(r.cols[TASK_COLS.actualSp]);
    if (!n(r.cols[TASK_COLS.actualSp])) doneNoSp++;
  } else {
    open++; openEst += n(r.cols[TASK_COLS.estimatedSp]); by[s].open++; by[s].openEst += n(r.cols[TASK_COLS.estimatedSp]);
    if (n(r.cols[TASK_COLS.actualSp])) phantom++;
  }
}
console.log(`OUR ROWS ON BOARD: ${t.length} · Done ${done} (Actual SP ${act}) · open ${open} (Est SP ${openEst})`);
console.log(`integrity: Done-with-no-Actual-SP ${doneNoSp} · phantom Actual SP on open rows ${phantom}`);
console.log('\nsprint          done   SP    open  estSP');
for (const k of Object.keys(by).sort()) {
  const b = by[k];
  console.log(`${k.padEnd(14)} ${String(b.done).padStart(4)} ${String(b.act).padStart(5)} ${String(b.open).padStart(6)} ${String(b.openEst).padStart(6)}`);
}
const staged = (PLAN_TASKS as any[]).filter((p) => p.done && !t.some((r) => r.name === `[HRIS] ${p.name}`));
console.log(`\nPLAN rows marked done:true that are NOT on the board (SP still OWED): ${staged.length} · ${staged.reduce((a, s) => a + s.sp, 0)} SP`);
const proj = await getItemsByIds([HRIS_PROJECT_ITEM_ID], [PROJECT_COLS.totalSp, PROJECT_COLS.spCompleted]);
if (proj[0]) console.log(`\nPortfolio rollup — Total SP ${proj[0].cols[PROJECT_COLS.totalSp]} · SP Completed ${proj[0].cols[PROJECT_COLS.spCompleted]}  (epic-level, NOT the task sum)`);
