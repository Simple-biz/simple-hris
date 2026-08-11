/**
 * THE REVIEW — read-only. Run this FIRST, every pass, and show the output to Kane before anything
 * is written. Prints what the pass would do to the board and writes proposal.json plus an approval
 * hash; `apply.mts` refuses to run unless it is handed that exact hash back.
 *
 * Usage:  node --import tsx .claude/skills/monday-board-sync/scripts/review.mts
 */
import fs from 'node:fs';
import {
  MONDAY_BOARDS,
  PLAN_EPICS,
  PLAN_TASKS,
  PROPOSAL_PATH,
  TASK_COLS,
  TASK_SPRINT_LABELS,
  boardGroups,
  epicItemName,
  isOurTask,
  listBoardItems,
  proposalHash,
  taskItemName,
} from './monday.mts';
import { EPIC_COLS } from './monday.mts';
import { PASS_DATE, ROWS, selfcheck } from './pass.mts';

const bad = selfcheck();
if (bad.length) {
  console.error(`pass selfcheck FAILED — refusing to propose anything:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// Groups are re-queried every pass: a cached list goes stale (Sprint 26 was absent from the old notes).
const groups = await boardGroups(MONDAY_BOARDS.tasks);
console.log(`Sprint Tasks groups (live): ${groups.length}`);
for (const key of Object.keys(TASK_SPRINT_LABELS) as (keyof typeof TASK_SPRINT_LABELS)[]) {
  const label = TASK_SPRINT_LABELS[key];
  const hit = groups.find((g) => g.title.startsWith(label));
  console.log(`  ${key.padEnd(4)} ${label.padEnd(10)} → ${hit ? `${hit.id}  ${hit.title}` : 'NO MATCHING GROUP'}`);
}

const [liveTasks, liveEpics] = await Promise.all([
  listBoardItems(MONDAY_BOARDS.tasks, [
    TASK_COLS.status,
    TASK_COLS.actualSp,
    TASK_COLS.estimatedSp,
    TASK_COLS.completed,
    TASK_COLS.sprint,
  ]),
  listBoardItems(MONDAY_BOARDS.epics, [EPIC_COLS.status, EPIC_COLS.sp]),
]);
const ours = liveTasks.filter((t) => isOurTask(t.name));
const taskByName = new Map(liveTasks.map((t) => [t.name, t]));
const epicByName = new Map(liveEpics.map((e) => [e.name, e]));

console.log(
  `\nboard: ${liveTasks.length} task items (${ours.length} ours) · ${liveEpics.length} epics (${liveEpics.filter((e) => /^HRIS-\d/.test(e.name)).length} ours)`,
);

// ── structure the reconciler would write ─────────────────────────────────────────────────────────
const willCreate = PLAN_TASKS.filter((t) => !taskByName.has(taskItemName(t)));
const willPatch = PLAN_TASKS.length - willCreate.length;
const epicsMissing = PLAN_EPICS.filter((e) => !epicByName.has(epicItemName(e)));

// Board rows that carry our prefix but are NOT in the plan: a rename orphan or an ad-hoc row. The
// reconciler will never touch these, and it will recreate the plan version alongside.
const planNames = new Set(PLAN_TASKS.map(taskItemName));
const orphans = ours.filter((t) => !planNames.has(t.name));

console.log('\n=== STRUCTURE (written by the real reconciler, imported from src/lib/monday/sync.ts) ===');
console.log(`  epics to create:  ${epicsMissing.length}${epicsMissing.length ? ' → ' + epicsMissing.map((e) => e.code).join(', ') : ''}`);
console.log(`  tasks to create:  ${willCreate.length}`);
for (const t of willCreate) {
  console.log(`     + [${t.epic}] ${TASK_SPRINT_LABELS[t.sprint].padEnd(10)} ${String(t.sp).padStart(2)}SP ${t.done ? 'Done ' : 'Ready'} ${t.name.slice(0, 78)}`);
}
console.log(`  tasks to patch:   ${willPatch}  (SP / type / sprint label / relations — never Status, never Actual SP)`);
console.log(`  orphan rows on the board, not in the plan: ${orphans.length}`);
for (const o of orphans) console.log(`     ! ${o.id} ${o.name.slice(0, 88)}`);

// ── corrections the reconciler cannot make ───────────────────────────────────────────────────────
console.log('\n=== CORRECTIONS (execution state — Status / Actual SP / Completed Date / update) ===');
const corrections: {
  name: string;
  itemName: string;
  exists: boolean;
  from: { status: string; completed: string };
  to: { status: string; completed: string };
  changes: string[];
}[] = [];

for (const row of ROWS) {
  const itemName = taskItemName({ name: row.name });
  const live = taskByName.get(itemName);
  const from = { status: live?.cols[TASK_COLS.status] ?? '(new)', completed: live?.cols[TASK_COLS.completed] ?? '' };
  const to = { status: row.status, completed: row.completed ?? '' };
  const changes: string[] = [];
  if (from.status !== to.status) changes.push(`Status ${from.status || '(blank)'} → ${to.status}`);
  if (to.completed && from.completed !== to.completed) changes.push(`Completed Date ${from.completed || '(blank)'} → ${to.completed}`);
  changes.push('post evidence update');
  corrections.push({ name: row.name, itemName, exists: Boolean(live), from, to, changes });
  console.log(`  ${row.status === 'Done' ? '✓' : '·'} ${(live ? live.id : 'NEW').padEnd(12)} ${row.status.padEnd(18)} ${row.name.slice(0, 74)}`);
  console.log(`      ${changes.join(' · ')}`);
  if (row.blockers?.length) for (const b of row.blockers) console.log(`      BLOCKED: ${b}`);
}

// ── rollup ───────────────────────────────────────────────────────────────────────────────────────
const totalSp = PLAN_EPICS.reduce((a, e) => a + e.sp, 0);
const completedSp = PLAN_EPICS.reduce((a, e) => {
  const live = epicByName.get(epicItemName(e));
  const status = live ? live.cols[EPIC_COLS.status] : e.status;
  return status === 'Shipped' ? a + e.sp : a;
}, 0);
console.log('\n=== PROJECT ROLLUP (Simple HRIS Platform) ===');
console.log(`  Total SP     → ${totalSp}`);
console.log(`  SP Completed → ${completedSp}   (live board status per epic; HRIS-22 reads Cancelled so it is excluded)`);
console.log(`  Sprint Tasks relation → all ${PLAN_TASKS.length} plan tasks (full-set overwrite, not additive)`);

const doneRows = ROWS.filter((r) => r.status === 'Done');
const proposal = {
  passDate: PASS_DATE,
  epicsToCreate: epicsMissing.map((e) => e.code),
  tasksToCreate: willCreate.map((t) => ({ name: taskItemName(t), sprint: t.sprint, sp: t.sp, done: t.done })),
  tasksToPatch: willPatch,
  corrections: corrections.map((c) => ({ item: c.itemName, to: c.to, changes: c.changes })),
  rollup: { totalSp, completedSp, sprintTasksLinked: PLAN_TASKS.length },
  orphans: orphans.map((o) => ({ id: o.id, name: o.name })),
};
const hash = proposalHash(proposal);
fs.writeFileSync(PROPOSAL_PATH, JSON.stringify({ hash, generatedFor: PASS_DATE, proposal }, null, 2), 'utf8');

console.log('\n' + '─'.repeat(96));
console.log(`SUMMARY  ${willCreate.length} rows created · ${willPatch} patched · ${corrections.length} corrected`);
console.log(`         ${doneRows.length} Done (Completed Date ${PASS_DATE}) · ${ROWS.length - doneRows.length} not Done, kept in Backlog`);
console.log(`         SP going Done this pass: ${doneRows.reduce((a, r) => a + (PLAN_TASKS.find((t) => t.name === r.name)?.sp ?? 0), 0)}`);
console.log(`\nproposal: ${PROPOSAL_PATH}`);
console.log(`APPROVAL HASH: ${hash}`);
console.log('\nNothing has been written. To apply, Kane must approve, then:');
console.log(`  node --import tsx .claude/skills/monday-board-sync/scripts/apply.mts --apply --approve ${hash}`);
