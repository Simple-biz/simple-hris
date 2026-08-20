/**
 * READ-ONLY probe for the Sprint 27 grooming pass. Temporary — delete after the pass.
 *
 * Step 1 is one cheap `boardGroups` call, per the skill's API-budget rule: never plan a big read
 * without first proving the daily budget is alive.
 */
import {
  MONDAY_BOARDS,
  PLAN_TASKS,
  TASK_COLS,
  boardGroups,
  columnLabels,
  isOurTask,
  listBoardItems,
  taskItemName,
} from './monday.mts';

const groups = await boardGroups(MONDAY_BOARDS.tasks);
console.log('=== GROUPS · Sprint Tasks (live) ===');
for (const g of groups) console.log(`  ${g.id}  ${g.title}`);

if (process.argv.includes('--groups-only')) process.exit(0);

console.log('\n=== Sprint label settings_str (live) ===');
const sprintLabels = await columnLabels(MONDAY_BOARDS.tasks, TASK_COLS.sprint);
console.log(
  Object.entries(sprintLabels)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([i, n]) => `${i}=${n}`)
    .join(' · '),
);

const all = await listBoardItems(MONDAY_BOARDS.tasks, [
  TASK_COLS.status,
  TASK_COLS.type,
  TASK_COLS.sprint,
  TASK_COLS.estimatedSp,
  TASK_COLS.actualSp,
  TASK_COLS.completed,
]);
const ours = all.filter((t) => isOurTask(t.name));
console.log(`\n=== ${all.length} items on the board · ${ours.length} OURS (plan declares ${PLAN_TASKS.length}) ===`);

const planByName = new Map(PLAN_TASKS.map((t) => [taskItemName(t), t]));

// Every row that is NOT Done, wherever it sits — this is the real candidate pool for a sprint move,
// and reading it off the board rather than the plan is what catches drift the plan cannot see.
const open = ours.filter((r) => (r.cols[TASK_COLS.status] || '') !== 'Done');
console.log(`\n=== NOT-Done rows on the board: ${open.length} ===`);
for (const r of open) {
  const p = planByName.get(r.name);
  console.log(
    `  ${r.id.padEnd(12)} ${(r.cols[TASK_COLS.status] || '(blank)').padEnd(18)} ` +
      `sprint=${(r.cols[TASK_COLS.sprint] || '(blank)').padEnd(10)} est=${(r.cols[TASK_COLS.estimatedSp] || '-').padStart(2)} ` +
      `group=${r.groupTitle.padEnd(24)} plan=${p ? `${p.sprint}/${p.done ? 'done' : 'open'}/${p.sp}sp` : 'NOT IN PLAN'}\n` +
      `               ${r.name}`,
  );
}

// Anything physically parked in a non-sprint lane, regardless of status.
const parked = ours.filter((r) => /backlog|re-scop|rescop/i.test(r.groupTitle));
console.log(`\n=== rows sitting in a Backlog / For Re-scoping GROUP: ${parked.length} ===`);
for (const r of parked) {
  console.log(
    `  ${r.id.padEnd(12)} ${(r.cols[TASK_COLS.status] || '(blank)').padEnd(18)} label=${(r.cols[TASK_COLS.sprint] || '(blank)').padEnd(10)} group=${r.groupTitle.padEnd(24)} ${r.name}`,
  );
}

const orphans = ours.filter((r) => !planByName.has(r.name)).map((r) => r.name);
const missing = PLAN_TASKS.map(taskItemName).filter((n) => !ours.some((r) => r.name === n));
console.log(`\n=== name parity ===`);
console.log(`  on board, not in plan: ${orphans.length}${orphans.length ? '\n    ' + orphans.join('\n    ') : ''}`);
console.log(`  in plan, not on board: ${missing.length}${missing.length ? '\n    ' + missing.join('\n    ') : ''}`);
