/**
 * Independent re-read: did the board actually end up the way the pass claimed? Read-only.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/verify.mts
 *
 * **Never report a sync as done off the write log.** The write log says what was sent; only a
 * re-read says what the board holds. This script deliberately does not look at apply-result.json.
 *
 * Checks
 *   1. every pass row exists, with the intended Status and (for Done rows) the Completed Date
 *   2. every PLAN_TASKS row exists on the board byte-exact, and no orphan carries our prefix
 *   3. invariants an SP auditor would check: nothing over the 8-SP cap, open rows have an Estimated
 *      SP, unshipped rows carry no Actual SP, Done rows have a Completed Date
 *   4. the project rollup and its Sprint Tasks relation cover the whole plan
 *
 * It does NOT check that an epic's SP equals the sum of its tasks. HRIS epic SP is an independent
 * rollup of sub-features — HRIS-01 is 101 SP with zero task rows — so Gridline's sum-to-parent rule
 * is deliberately not ported. Asserting it would fail on almost every epic.
 */
import {
  EPIC_COLS,
  HRIS_PROJECT_ITEM_ID,
  MONDAY_BOARDS,
  PLAN_EPICS,
  PLAN_TASKS,
  PROJECT_COLS,
  TASK_COLS,
  epicItemName,
  getItemsByIds,
  isOurTask,
  listBoardItems,
  taskItemName,
} from './monday.mts';
import { ROWS } from './pass.mts';

const fails: string[] = [];
const num = (v: string) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

const [tasks, epics] = await Promise.all([
  listBoardItems(MONDAY_BOARDS.tasks, [
    TASK_COLS.status,
    TASK_COLS.estimatedSp,
    TASK_COLS.actualSp,
    TASK_COLS.completed,
    TASK_COLS.sprint,
    TASK_COLS.epic,
  ]),
  listBoardItems(MONDAY_BOARDS.epics, [EPIC_COLS.status, EPIC_COLS.sp, EPIC_COLS.linkedTasks]),
]);
const byName = new Map(tasks.map((t) => [t.name, t]));
const ours = tasks.filter((t) => isOurTask(t.name));
console.log(`re-read ${tasks.length} task items (${ours.length} ours) and ${epics.length} epics\n`);

console.log('=== 1  this pass ===');
for (const row of ROWS) {
  const itemName = taskItemName({ name: row.name });
  const it = byName.get(itemName);
  if (!it) {
    fails.push(`MISSING: ${itemName.slice(0, 78)}`);
    console.log(`  MISSING          ${row.name.slice(0, 70)}`);
    continue;
  }
  const status = it.cols[TASK_COLS.status] ?? '';
  const completed = it.cols[TASK_COLS.completed] ?? '';
  const act = num(it.cols[TASK_COLS.actualSp] ?? '');
  const problems: string[] = [];
  if (status !== row.status) problems.push(`status "${status}" want "${row.status}"`);
  if (row.status === 'Done') {
    if (completed !== row.completed) problems.push(`completed "${completed}" want "${row.completed}"`);
    if (act == null) problems.push('Done but no Actual SP');
  } else {
    if (completed) problems.push(`Completed Date "${completed}" on a ${row.status} row`);
    if (act != null) problems.push(`Actual SP ${act} on a ${row.status} row`);
  }
  if (!it.linked[TASK_COLS.epic]?.length) problems.push('not linked to an epic');
  console.log(`  ${problems.length ? 'FAIL' : 'OK  '} ${it.id} ${status.padEnd(18)} ${completed.padEnd(11)} ${row.name.slice(0, 52)}`);
  for (const p of problems) {
    console.log(`         ${p}`);
    fails.push(`${it.id} ${p}`);
  }
}

console.log('\n=== 2  board <-> plan name parity ===');
const planNames = new Set(PLAN_TASKS.map(taskItemName));
const missing = [...planNames].filter((n) => !byName.has(n));
const orphans = ours.filter((t) => !planNames.has(t.name));
console.log(`  plan tasks: ${PLAN_TASKS.length} · on board: ${planNames.size - missing.length} · missing: ${missing.length}`);
for (const m of missing) console.log(`     MISSING ${m.slice(0, 84)}`);
console.log(`  orphan rows carrying our prefix but absent from the plan: ${orphans.length}`);
for (const o of orphans) console.log(`     ORPHAN ${o.id} ${o.name.slice(0, 80)}`);
if (missing.length) fails.push(`${missing.length} plan tasks missing from the board`);
// An orphan is usually a renamed plan title: the old row keeps its execution state and the renamed
// one is recreated alongside. Not fatal, but it must never go unnoticed.
if (orphans.length) fails.push(`${orphans.length} orphan rows (likely renames) need reconciling by hand`);

console.log('\n=== 3  invariants ===');
const over: string[] = [];
const blankEst: string[] = [];
const phantomAct: string[] = [];
const doneNoDate: string[] = [];
const SHIPPED = new Set(['Done', 'Pending Deploy', 'Waiting for Review']);
for (const t of ours) {
  const est = num(t.cols[TASK_COLS.estimatedSp] ?? '');
  const act = num(t.cols[TASK_COLS.actualSp] ?? '');
  const status = t.cols[TASK_COLS.status] ?? '(blank)';
  const sp = est ?? act;
  if (sp != null && sp > 8) over.push(`${t.id} ${sp}SP ${status} ${t.name.slice(0, 58)}`);
  if (!SHIPPED.has(status) && est == null) blankEst.push(`${t.id} ${status} ${t.name.slice(0, 58)}`);
  if (act != null && status !== 'Done') phantomAct.push(`${t.id} act=${act} ${status} ${t.name.slice(0, 52)}`);
  if (status === 'Done' && !(t.cols[TASK_COLS.completed] ?? '')) doneNoDate.push(`${t.id} ${t.name.slice(0, 62)}`);
}
for (const [label, list] of [
  ['rows over the 8-SP cap', over],
  ['open rows with a blank Estimated SP', blankEst],
  ['unshipped rows carrying an Actual SP', phantomAct],
  ['Done rows with no Completed Date', doneNoDate],
] as [string, string[]][]) {
  console.log(`  ${label}: ${list.length}`);
  for (const x of list.slice(0, 12)) console.log(`     ${x}`);
  if (list.length > 12) console.log(`     ... and ${list.length - 12} more`);
}
if (over.length) fails.push(`${over.length} rows over the 8-SP cap`);
if (phantomAct.length) fails.push(`${phantomAct.length} unshipped rows carry an Actual SP`);
// Pre-existing Done rows with no date are a known historical artefact, reported but not fatal.
if (doneNoDate.length) console.log('     (historical: HRIS has never written Completed Date before this skill)');

console.log('\n=== 4  rollup ===');
const [project] = await getItemsByIds([HRIS_PROJECT_ITEM_ID], [
  PROJECT_COLS.totalSp,
  PROJECT_COLS.spCompleted,
  PROJECT_COLS.sprintTasks,
]);
const wantTotal = PLAN_EPICS.reduce((a, e) => a + e.sp, 0);
const epicByName = new Map(epics.map((e) => [e.name, e]));
const wantCompleted = PLAN_EPICS.reduce((a, e) => {
  const live = epicByName.get(epicItemName(e));
  return (live ? live.cols[EPIC_COLS.status] : e.status) === 'Shipped' ? a + e.sp : a;
}, 0);
const gotTotal = num(project?.cols[PROJECT_COLS.totalSp] ?? '');
const gotCompleted = num(project?.cols[PROJECT_COLS.spCompleted] ?? '');
const linked = project?.linked[PROJECT_COLS.sprintTasks]?.length ?? 0;
console.log(`  Total SP     ${gotTotal} (want ${wantTotal}) ${gotTotal === wantTotal ? 'OK' : 'DRIFT'}`);
console.log(`  SP Completed ${gotCompleted} (want ${wantCompleted}) ${gotCompleted === wantCompleted ? 'OK' : 'DRIFT'}`);
console.log(`  Sprint Tasks relation: ${linked} of ${PLAN_TASKS.length} plan tasks ${linked >= PLAN_TASKS.length ? 'OK' : 'INCOMPLETE'}`);
if (gotTotal !== wantTotal) fails.push(`project Total SP ${gotTotal} != ${wantTotal}`);
if (gotCompleted !== wantCompleted) fails.push(`project SP Completed ${gotCompleted} != ${wantCompleted}`);
if (linked < PLAN_TASKS.length) fails.push(`project Sprint Tasks relation covers ${linked}/${PLAN_TASKS.length}`);

const epicsMissing = PLAN_EPICS.filter((e) => !epicByName.has(epicItemName(e)));
if (epicsMissing.length) fails.push(`${epicsMissing.length} plan epics missing: ${epicsMissing.map((e) => e.code).join(', ')}`);

console.log('\n' + (fails.length ? `VERIFY FAIL (${fails.length}):\n  ${fails.join('\n  ')}` : 'VERIFY PASS — the board matches the pass'));
process.exit(fails.length ? 1 : 0);
