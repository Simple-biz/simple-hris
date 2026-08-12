/**
 * READ-ONLY: verify ONE row by re-reading it, in a single call.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/verify-one.mts <itemId>
 *
 * `verify.mts` pages the whole ~2,300-item board, which is the right tool for a full pass and the
 * wrong one after a `--only-new` write. This confirms what the board actually holds for one item —
 * never report a sync as done off the write log.
 */
import { getItemsByIds, TASK_COLS } from './monday.mts';

const id = process.argv[2];
if (!id) {
  console.error('usage: verify-one.mts <itemId>');
  process.exit(1);
}

const [it] = await getItemsByIds([id], [
  TASK_COLS.status,
  TASK_COLS.type,
  TASK_COLS.sprint,
  TASK_COLS.estimatedSp,
  TASK_COLS.actualSp,
  TASK_COLS.completed,
  TASK_COLS.epic,
]);

if (!it) {
  console.error(`item ${id} NOT FOUND on the board — the write did not land.`);
  process.exit(1);
}

console.log(`name      : ${it.name}`);
console.log(`group     : ${it.groupTitle}`);
console.log(`status    : ${it.cols[TASK_COLS.status] || '(blank)'}`);
console.log(`type      : ${it.cols[TASK_COLS.type] || '(blank)'}`);
console.log(`sprint    : ${it.cols[TASK_COLS.sprint] || '(blank)'}`);
console.log(`est SP    : ${it.cols[TASK_COLS.estimatedSp] || '(blank)'}`);
console.log(`actual SP : ${it.cols[TASK_COLS.actualSp] || '(none — correct unless Done)'}`);
console.log(`completed : ${it.cols[TASK_COLS.completed] || '(none — correct unless Done)'}`);
console.log(
  `epic rel  : ${(it.linked[TASK_COLS.epic] ?? []).join(', ') || '(unset — a full reconcile owns this)'}`,
);
