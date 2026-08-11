/**
 * READ-ONLY: dump OUR rows and nothing else, plus the live groups and label indices.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/pull-state.mts
 *
 * The boards are SHARED. Sprint Tasks holds ~2,172 items of which ~135 are ours; Roadmap & Epics
 * holds 208 of which 37 are ours. A group listing is mostly other teams' work, so always filter by
 * name — never treat "everything in the Sprint 26 group" as ours.
 *
 * Groups and labels are re-queried every run. A cached list goes stale: Sprint 26 was missing from
 * the earlier notes entirely, and the board is structure-locked so a label this skill needs can only
 * be added by hand on the board.
 */
import {
  EPIC_COLS,
  MONDAY_BOARDS,
  PLAN_EPICS,
  PLAN_TASKS,
  TASK_COLS,
  boardGroups,
  columnLabels,
  isOurEpic,
  isOurTask,
  listBoardItems,
} from './monday.mts';

console.log('=== GROUPS · Sprint Tasks (live) ===');
for (const g of await boardGroups(MONDAY_BOARDS.tasks)) console.log(`  ${g.id}  ${g.title}`);
console.log('\n=== GROUPS · Roadmap & Epics (live) ===');
for (const g of await boardGroups(MONDAY_BOARDS.epics)) console.log(`  ${g.id}  ${g.title}`);

console.log('\n=== LABELS (structure-locked — the API cannot add one) ===');
for (const [label, col] of [
  ['Status', TASK_COLS.status],
  ['Type', TASK_COLS.type],
  ['Sprint', TASK_COLS.sprint],
  ['Priority', TASK_COLS.priority],
] as [string, string][]) {
  const live = await columnLabels(MONDAY_BOARDS.tasks, col);
  const rendered = Object.entries(live)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([i, name]) => `${i}=${name}`)
    .join(' · ');
  console.log(`  ${label.padEnd(9)} ${rendered}`);
}

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
const ourTasks = tasks.filter((t) => isOurTask(t.name));
const ourEpics = epics.filter((e) => isOurEpic(e.name));

console.log(
  `\n=== SPRINT TASKS — ${tasks.length} items total, ${ourTasks.length} OURS (plan declares ${PLAN_TASKS.length}) ===`,
);
const bySprint = new Map<string, typeof ourTasks>();
for (const t of ourTasks) {
  const key = t.cols[TASK_COLS.sprint] || '(no sprint)';
  bySprint.set(key, [...(bySprint.get(key) ?? []), t]);
}
for (const [sprint, rows] of [...bySprint.entries()].sort()) {
  const sp = rows.reduce((a, r) => a + (Number(r.cols[TASK_COLS.estimatedSp]) || 0), 0);
  console.log(`\n-- ${sprint} · ${rows.length} rows · ${sp} SP`);
  console.log(`   ${'id'.padEnd(12)} ${'est'.padStart(3)} ${'act'.padStart(3)} ${'status'.padEnd(18)} ${'completed'.padEnd(11)} name`);
  for (const r of rows) {
    console.log(
      `   ${r.id.padEnd(12)} ${(r.cols[TASK_COLS.estimatedSp] || '-').padStart(3)} ${(r.cols[TASK_COLS.actualSp] || '-').padStart(3)} ` +
        `${(r.cols[TASK_COLS.status] || '(blank)').padEnd(18)} ${(r.cols[TASK_COLS.completed] || '-').padEnd(11)} ${r.name.slice(0, 74)}`,
    );
  }
}

console.log(`\n=== ROADMAP & EPICS — ${epics.length} items total, ${ourEpics.length} OURS (plan declares ${PLAN_EPICS.length}) ===`);
for (const e of ourEpics.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
  const linked = e.linked[EPIC_COLS.linkedTasks]?.length ?? 0;
  // The TAB between code and title is load-bearing: JSON.stringify keeps it visible as \t.
  console.log(
    `  ${e.id.padEnd(12)} sp=${(e.cols[EPIC_COLS.sp] || '-').padStart(4)} ${(e.cols[EPIC_COLS.status] || '-').padEnd(12)} linked=${String(linked).padStart(3)}  ${JSON.stringify(e.name).slice(0, 74)}`,
  );
}

// A plan status that disagrees with the board is drift the reconciler will never fix on its own:
// it writes epic Status at create only, so the board wins forever.
console.log('\n=== PLAN vs BOARD epic status drift ===');
let drift = 0;
for (const pe of PLAN_EPICS) {
  const live = ourEpics.find((e) => e.name.startsWith(`${pe.code}\t`));
  const boardStatus = live?.cols[EPIC_COLS.status] ?? '(not on board)';
  if (boardStatus !== pe.status) {
    drift++;
    console.log(`  ${pe.code.padEnd(9)} plan "${pe.status}" vs board "${boardStatus}"`);
  }
}
console.log(`  ${drift} epic(s) drifting — the reconciler writes epic Status at CREATE only, so the board wins until one side is corrected by hand.`);
