/**
 * ONE-OFF (2026-10-09, Kane: "OMS is already done for HSL lets put that in backlog thats for V2"): file
 * the HSL scheduling row under BACKLOG instead of Sprint 30 — Sprint label + group move. Nothing else is
 * written. Modelled on tmp-move-s29-open.mts.
 *
 * WHY A MOVER. The sprint label and group are reconciler-owned, and `apply.mts --only-new` never moves a
 * row; the full reconcile would, but it no longer fits a UTC day. So pass 44 flips the plan row to BL and
 * this script does the one move the lean path cannot.
 *
 * WHY ITS STATUS STAYS. The code shipped and is deployed; it is held at Pending Deploy because nobody has
 * saved a schedule period (employee_schedule_periods: 0 rows, re-measured 2026-10-09). Moving it to the
 * Backlog for V2 (item 427) is a scheduling fact, not a claim about progress. Status, Actual SP and
 * Completed Date are NEVER touched, and the row is refused unless it is open, unscored, undated and
 * physically in the Sprint 30 group. Dry-run by default; --apply to write. About 8 calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DailyLimitExceeded,
  MONDAY_BOARDS,
  PLAN_TASKS,
  SKILL_DIR,
  TASK_COLS,
  TASK_GROUPS,
  TASK_SPRINT_INDEX,
  assertLabelsUnchanged,
  findItemIdsByExactName,
  getItemsByIds,
  gql,
  postUpdate,
  setColumns,
  taskItemName,
  withLock,
} from './monday.mts';

const APPLY = process.argv.includes('--apply');
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-hsl-scheduling-bl.progress.json');
const done = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

const FRAG = 'Scheduling moves inside the HSL department and starts saving';
/** Recorded by the 2026-09-30 rollover (tmp-move-s29-open.progress.json). */
const EXPECTED_ID = '13070861896';
const BL_GROUP = TASK_GROUPS.BL;
const BL_INDEX = TASK_SPRINT_INDEX.BL;

const BODY =
  `**Sprint 30 → Backlog**: 2026-10-09, on Kane's word: "OMS is already done for HSL lets put that in backlog thats for V2". ` +
  `The 2026-10-08 call put HSL scheduling in V2 (session log item 427).\n\n` +
  `**Status, Actual SP and Completed Date are unchanged.** A sprint move is a scheduling fact, not a claim ` +
  `about progress. The code is deployed, and the row stays Pending Deploy until someone saves a schedule ` +
  `period in HSL → Scheduling (employee_schedule_periods: 0 rows, re-measured 2026-10-09).`;

await withLock(async () => {
  await assertLabelsUnchanged();

  const plan = (PLAN_TASKS as any[]).filter((t) => t.name.includes(FRAG));
  if (plan.length !== 1) throw new Error(`plan lookup returned ${plan.length} rows`);
  if (plan[0].sprint !== 'BL') throw new Error(`plan still says ${plan[0].sprint} — flip it to BL in hris-plan.ts first`);
  if (plan[0].done) throw new Error('the plan row is done:true — a Done row is filed where it FINISHED, never to the Backlog');
  const name = taskItemName(plan[0]);
  const ids = await findItemIdsByExactName(MONDAY_BOARDS.tasks, name);
  if (ids.length !== 1) throw new Error(`"${name}" resolved to ${ids.length} board ids — refusing`);
  if (ids[0] !== EXPECTED_ID) throw new Error(`resolved to ${ids[0]}, expected ${EXPECTED_ID} — board changed, re-measure`);
  const id = ids[0];

  if (done.has(id)) {
    console.log(`  ✓ ${id}  already moved per ledger`);
    return;
  }
  const [it] = await getItemsByIds([id], [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.completed, TASK_COLS.sprint]);
  if (!it) throw new Error(`${id} vanished between lookup and read`);
  const val = (c: string) => (it as any).cols[c] ?? '';
  if ((it as any).groupId === BL_GROUP) {
    console.log(`  ✓ ${id}  already in the Backlog group — nothing to move`);
    return;
  }
  if ((it as any).groupId !== TASK_GROUPS.S30)
    throw new Error(`${id} is in group ${(it as any).groupTitle}, not Sprint 30 — another session moved it; re-measure`);
  if (val(TASK_COLS.status) === 'Done') throw new Error(`${id} is Done — never moved to the Backlog`);
  if (val(TASK_COLS.actualSp)) throw new Error(`${id} carries Actual SP ${val(TASK_COLS.actualSp)} — not an open row`);
  if (val(TASK_COLS.completed)) throw new Error(`${id} carries Completed Date ${val(TASK_COLS.completed)} — not an open row`);
  console.log(`  · ${id}  ${plan[0].sp} SP  ${val(TASK_COLS.status).padEnd(15)} ${val(TASK_COLS.sprint)} → Backlog  ${name.slice(7, 80)}`);

  if (!APPLY) {
    console.log('\nDRY RUN — 1 row would move. Nothing written.');
    return;
  }
  const M_MOVE = `mutation($item:ID!,$group:String!){move_item_to_group(item_id:$item,group_id:$group){id}}`;
  try {
    // Label first, then group — the order sync.ts uses. Then the evidence update.
    await setColumns(MONDAY_BOARDS.tasks, id, { [TASK_COLS.sprint]: { index: BL_INDEX } });
    await gql(M_MOVE, { item: id, group: BL_GROUP });
    await postUpdate(id, BODY);
    done.add(id);
    fs.writeFileSync(PROGRESS, JSON.stringify([...done], null, 2), 'utf8');
  } catch (e) {
    if (e instanceof DailyLimitExceeded) {
      console.error('\nBUDGET DIED before the move finished. Re-run --apply after 00:00 UTC.');
      process.exit(3);
    }
    throw e;
  }
  const [after] = await getItemsByIds([id], [TASK_COLS.status, TASK_COLS.sprint]);
  console.log(`\nmoved. Re-read: group ${(after as any)?.groupTitle} · sprint ${(after as any)?.cols[TASK_COLS.sprint]} · status ${(after as any)?.cols[TASK_COLS.status]}`);
});
