/**
 * READ-ONLY: decompose the SP auditor's numbers on the "Simple HRIS Platform" portfolio row.
 * First call doubles as the budget probe (skill rule: probe before planning a pass).
 * ~7 calls total. DELETE AFTER USE.
 */
import { getItemsByIds } from './monday.mts';
const { HRIS_PROJECT_ITEM_ID, PLAN_TASKS, PROJECT_COLS, TASK_COLS, taskItemName } = await import(
  '../../../../src/lib/monday/hris-plan'
);

// call 1 — the project row itself (also the budget probe)
const [project] = await getItemsByIds(
  [HRIS_PROJECT_ITEM_ID],
  [PROJECT_COLS.totalSp, PROJECT_COLS.spCompleted, PROJECT_COLS.sprintTasks],
);
const linkedIds = project.linked[PROJECT_COLS.sprintTasks] ?? [];
console.log('=== Projects Portfolio · Simple HRIS Platform (live) ===');
console.log(`Total SP column:    ${project.cols[PROJECT_COLS.totalSp] || '(blank)'}`);
console.log(`SP Completed:       ${project.cols[PROJECT_COLS.spCompleted] || '(blank)'}`);
console.log(`Sprint Tasks link:  ${linkedIds.length} items`);

// calls 2..n — the linked tasks' SP columns (chunked 25/call by getItemsByIds)
const tasks = await getItemsByIds(linkedIds, [
  TASK_COLS.status,
  TASK_COLS.estimatedSp,
  TASK_COLS.actualSp,
]);
const num = (s: string | undefined) => Number(s) || 0;
const sumEst = tasks.reduce((a, t) => a + num(t.cols[TASK_COLS.estimatedSp]), 0);
const sumAct = tasks.reduce((a, t) => a + num(t.cols[TASK_COLS.actualSp]), 0);
const doneRows = tasks.filter((t) => t.cols[TASK_COLS.status] === 'Done');
const sumEstDone = doneRows.reduce((a, t) => a + num(t.cols[TASK_COLS.estimatedSp]), 0);
console.log(`\n=== ${tasks.length} LINKED tasks (of ${PLAN_TASKS.length} in plan) ===`);
console.log(`Σ Estimated SP (linked):        ${sumEst}`);
console.log(`Σ Actual SP (linked):           ${sumAct}`);
console.log(`Σ Estimated SP (linked ∧ Done): ${sumEstDone}  (${doneRows.length} Done rows)`);

// which plan rows are NOT linked — the structural undercount
const linkedNames = new Set(tasks.map((t) => t.name));
const missing = PLAN_TASKS.filter((t) => !linkedNames.has(taskItemName(t)));
console.log(`\n=== plan rows NOT in the project's Sprint Tasks relation: ${missing.length} · Σ ${missing.reduce((a, t) => a + t.sp, 0)} SP ===`);
for (const t of missing) console.log(`  ${String(t.sp).padStart(2)} SP  done=${t.done}  ${t.name.slice(0, 78)}`);

// Done rows with blank Actual SP — the known writer gap
const blankActualDone = doneRows.filter((t) => !t.cols[TASK_COLS.actualSp]);
console.log(`\nlinked Done rows with BLANK Actual SP: ${blankActualDone.length} · Σ est ${blankActualDone.reduce((a, t) => a + num(t.cols[TASK_COLS.estimatedSp]), 0)} SP`);
for (const t of blankActualDone) console.log(`  ${t.cols[TASK_COLS.estimatedSp].padStart(2)} SP  ${t.name.slice(0, 78)}`);
