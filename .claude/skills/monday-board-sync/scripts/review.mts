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
  TASK_SPRINT_WINDOWS,
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

/**
 * The sprint whose scheduled window contains PASS_DATE, or null between sprints. Derived from the
 * windows rather than hardcoded, so it follows the board instead of going stale the way the "there
 * is no Sprint 27" note did. Used only to flag a Done row being moved INTO the live sprint.
 */
const LIVE_SPRINT =
  (Object.keys(TASK_SPRINT_WINDOWS) as (keyof typeof TASK_SPRINT_WINDOWS)[]).find(
    (k) => PASS_DATE >= TASK_SPRINT_WINDOWS[k].start && PASS_DATE <= TASK_SPRINT_WINDOWS[k].end,
  ) ?? null;

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

// ── SPRINT MOVES — the one reconciler write the review used to hide ──────────────────────────────
// "tasks to patch: 139" is true and useless: it cannot distinguish a pass that re-asserts 139 correct
// values from one that re-files 59 rows into different sprints. Both the 2026-08-13 re-attribution
// and the 2026-08-19 Sprint 27 pull were approved off a summary that never named a single row whose
// sprint changed — and a sprint label ASSERTS a date range, so a wrong one is the same class of
// falsehood as a wrong Completed Date. Worse, `sprint` was absent from the hashed proposal entirely,
// so an approval hash did not bind the moves it authorised. It does now.
const sprintMoves = PLAN_TASKS.flatMap((t) => {
  const live = taskByName.get(taskItemName(t));
  if (!live) return []; // a row still to be created is already listed above, with its sprint
  const from = live.cols[TASK_COLS.sprint] || '(blank)';
  const to = TASK_SPRINT_LABELS[t.sprint];
  return from === to ? [] : [{ id: live.id, name: taskItemName(t), from, to, sp: t.sp, done: t.done }];
});
console.log(`\n=== SPRINT MOVES (label + group) — ${sprintMoves.length} ===`);
if (!sprintMoves.length) console.log('  none — every row already carries the sprint the plan declares');
for (const m of sprintMoves) {
  // Flag a Done row being moved INTO the live sprint: that is how historical work gets credited to
  // the current period, which inflates the sprint's velocity and anything riding on it.
  const suspect =
    m.done && LIVE_SPRINT && m.to === TASK_SPRINT_LABELS[LIVE_SPRINT]
      ? '  <-- Done row entering the LIVE sprint, check the date'
      : '';
  console.log(`  ${m.id.padEnd(12)} ${String(m.sp).padStart(2)}SP ${(m.done ? 'Done ' : 'open ')} ${m.from.padEnd(10)} → ${m.to.padEnd(10)} ${m.name.slice(0, 62)}${suspect}`);
}

// ── corrections the reconciler cannot make ───────────────────────────────────────────────────────
console.log('\n=== CORRECTIONS (execution state — Status / Actual SP / Completed Date / update) ===');
const corrections: {
  name: string;
  itemName: string;
  exists: boolean;
  from: { status: string; completed: string; actualSp: string };
  to: { status: string; completed: string; actualSp: string };
  changes: string[];
}[] = [];

for (const row of ROWS) {
  const itemName = taskItemName({ name: row.name });
  const live = taskByName.get(itemName);
  // Actual SP is the plan's own sp, never a number chosen here — and it accompanies Done alone,
  // so a row moving OFF Done shows the clear as an explicit change rather than a silent leftover.
  const planSp = PLAN_TASKS.find((t) => t.name === row.name)?.sp;
  const from = {
    status: live?.cols[TASK_COLS.status] ?? '(new)',
    completed: live?.cols[TASK_COLS.completed] ?? '',
    actualSp: live?.cols[TASK_COLS.actualSp] ?? '',
  };
  const to = {
    status: row.status,
    completed: row.completed ?? '',
    actualSp: row.status === 'Done' ? String(planSp ?? '') : '',
  };
  const changes: string[] = [];
  if (from.status !== to.status) changes.push(`Status ${from.status || '(blank)'} → ${to.status}`);
  if (from.actualSp !== to.actualSp) {
    changes.push(`Actual SP ${from.actualSp || '(blank)'} → ${to.actualSp || '(cleared — not Done)'}`);
  }
  if (to.completed !== from.completed) {
    changes.push(`Completed Date ${from.completed || '(blank)'} → ${to.completed || '(cleared — not Done)'}`);
  }
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
  // Part of the hashed payload, not just the console: an approval must bind the sprint re-filings it
  // authorises, or `apply.mts` can re-file rows the approver never saw named.
  sprintMoves: sprintMoves.map((m) => ({ item: m.name, from: m.from, to: m.to })),
  corrections: corrections.map((c) => ({ item: c.itemName, to: c.to, changes: c.changes })),
  rollup: { totalSp, completedSp, sprintTasksLinked: PLAN_TASKS.length },
  orphans: orphans.map((o) => ({ id: o.id, name: o.name })),
};
const hash = proposalHash(proposal);
/**
 * A fingerprint of the pass's INPUTS — the plan and the pass rows — recomputable offline.
 *
 * The approval hash binds the proposal FILE, not the working tree, so `apply.mts` would accept a
 * still-valid hash and then write whatever `hris-plan.ts` says at the moment it runs. That is not
 * theoretical: on 2026-08-19 a proposal minted at 13:30 was still on disk after a second session
 * re-filed six rows into Sprint 27, and the stored hash described none of it. `apply.mts` recomputes
 * this and refuses on mismatch, so editing the plan after a review invalidates the approval — which
 * is exactly what an approval is supposed to mean.
 */
const inputsHash = proposalHash({ passDate: PASS_DATE, plan: PLAN_TASKS, rows: ROWS });
fs.writeFileSync(
  PROPOSAL_PATH,
  JSON.stringify({ hash, inputsHash, generatedFor: PASS_DATE, proposal }, null, 2),
  'utf8',
);

console.log('\n' + '─'.repeat(96));
console.log(
  `SUMMARY  ${willCreate.length} rows created · ${willPatch} patched · ${sprintMoves.length} re-filed to a different sprint · ${corrections.length} corrected`,
);
// Say where the held rows actually SIT — they are not all Backlog, and a summary that assumes so
// misreports the one thing this line exists to convey.
const heldBySprint = new Map<string, number>();
for (const r of ROWS.filter((r) => r.status !== 'Done')) {
  const sprint = PLAN_TASKS.find((t) => t.name === r.name)?.sprint;
  const label = sprint ? TASK_SPRINT_LABELS[sprint] : '(not in plan)';
  heldBySprint.set(label, (heldBySprint.get(label) ?? 0) + 1);
}
const heldText = [...heldBySprint].map(([label, n]) => `${n} in ${label}`).join(', ') || 'none';
// Each row carries its OWN Completed Date — the date the work finished, which is the whole point of
// selfcheck's git check. Printing PASS_DATE here claimed 60 rows completed today when they span
// Jul 29–Aug 12, i.e. it asserted in the approval-critical summary the exact error this skill exists
// to prevent. Show the real range instead.
const doneDates = doneRows.map((r) => r.completed).filter((d): d is string => Boolean(d)).sort();
const dateSpan = doneDates.length
  ? doneDates[0] === doneDates[doneDates.length - 1]
    ? doneDates[0]
    : `${doneDates[0]} … ${doneDates[doneDates.length - 1]}`
  : 'none';
console.log(`         ${doneRows.length} Done (Completed Dates ${dateSpan}) · ${ROWS.length - doneRows.length} held short of Done (${heldText})`);
// "SP going Done" counted every Done row in the pass, including rows ALREADY Done on the board that
// this pass only backfills a date onto — on 2026-08-19 that read "156 SP going Done" when not one row
// changed status. Same class of falsehood as the PASS_DATE bug: wrong in the approval-critical summary,
// which is the one place it must not be. Count only rows whose Status actually TRANSITIONS.
const transitions = corrections.filter((c) => c.from.status !== c.to.status);
const spTransitioning = transitions
  .filter((c) => c.to.status === 'Done')
  .reduce((a, c) => a + (PLAN_TASKS.find((t) => taskItemName(t) === c.itemName)?.sp ?? 0), 0);
console.log(
  `         status transitions: ${transitions.length}` +
    (transitions.length ? ` · SP newly reaching Done: ${spTransitioning}` : ' — no row changes status; this pass only backfills Completed Dates'),
);
console.log(`\nproposal: ${PROPOSAL_PATH}`);
console.log(`APPROVAL HASH: ${hash}`);
console.log('\nNothing has been written. To apply, Kane must approve, then:');
console.log(`  node --import tsx .claude/skills/monday-board-sync/scripts/apply.mts --apply --approve ${hash}`);
