/**
 * ONE-OFF (2026-09-22, Kane-approved): roll the THREE still-unstarted Sprint 28 rows into Sprint 29
 * — Sprint label 105 + group move to group_mm739kne. Nothing else is written.
 *
 * SCOPE, per Kane's explicit choice this session ("the 3 unstarted only (10 SP)"):
 *   Google Sheet sync crons (5) · Legacy rates-sheet → hurupay guard (2) · Deletion cron (3).
 *
 * The FOUR Pending Deploy rows in Sprint 28 are deliberately NOT moved. Their code already landed
 * INSIDE S28 (2026-09-12 / 09-14) or earlier (tickets, 2026-08-21 = S27), while S29's attribution is
 * Sep 15-25 — so re-filing them would put each row's true Completed Date outside its own sprint and
 * pass.mts selfcheck() would refuse to ever mark them Done. That is the wall pass 30 hit on the
 * tickets row; this pass declines to build three more of them. Pending Deploy is finished code
 * awaiting a click-through, not unfinished work to reschedule.
 *
 * WHY A ONE-OFF AND NOT THE RECONCILER. Sprint is reconciler-owned, and hris-plan.ts has ALREADY
 * been moved to S29 for these three, so plan and board agree the moment this runs — there is no
 * drift for a later reconcile to fight. The full apply.mts path would additionally rewrite both
 * relation columns on ~290 rows and create pass 31's 9 unwritten rows, none of which was approved
 * here. Same shape as the Kane-approved tmp-move-s27-pending.mts (2026-09-01).
 *
 * Statuses, Actual SP and Completed Date are NEVER touched. Every target is refused unless it is
 * open, unscored and undated. Dry-run by default; --apply to write.
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
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-s28-open.progress.json');
const done = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

/** Name fragment → the board id MEASURED this session. A second lock on the name lookup. */
const EXPECTED: Record<string, string> = {
  'Google Sheet sync crons': '12620595935',
  'Legacy rates-sheet cell can route': '12620645283',
  'Deletion cron never re-checks': '12863029482',
};

const BODY =
  `**Sprint 28 → Sprint 29** — rollover pass 2026-09-22.\n\n` +
  `Still unstarted at Sprint 28's close, so it rolls forward into the live sprint. ` +
  `Kane approved the three Ready to Start rows only.\n\n` +
  `**Status, Actual SP and Completed Date are unchanged** — a sprint move is a scheduling fact, ` +
  `not a claim about progress. The four Pending Deploy rows stay in Sprint 28 on purpose: their ` +
  `code landed inside that sprint, and moving them would put their Completed Date outside ` +
  `Sprint 29 (Sep 15-25), which selfcheck() refuses.`;

await withLock(async () => {
  await assertLabelsUnchanged();

  const targets: { id: string; name: string; sp: number }[] = [];
  for (const [frag, expectedId] of Object.entries(EXPECTED)) {
    const plan = (PLAN_TASKS as any[]).filter((t) => t.name.includes(frag));
    if (plan.length !== 1) throw new Error(`plan lookup for "${frag}" returned ${plan.length} rows`);
    if (plan[0].sprint !== 'S29')
      throw new Error(`plan still says ${plan[0].sprint} for "${frag}" — edit hris-plan.ts first`);
    if (plan[0].done) throw new Error(`"${frag}" is done:true in the plan — a Done row does not roll`);
    const name = taskItemName(plan[0]);
    const ids = await findItemIdsByExactName(MONDAY_BOARDS.tasks, name);
    if (ids.length !== 1) throw new Error(`"${name}" resolved to ${ids.length} board ids — refusing`);
    if (ids[0] !== expectedId)
      throw new Error(`"${frag}" resolved to ${ids[0]}, expected ${expectedId} — board changed, re-measure`);
    targets.push({ id: ids[0], name, sp: plan[0].sp });
  }

  // Refuse any target that is not genuinely open, unscored and undated.
  const live = await getItemsByIds(
    targets.map((t) => t.id),
    [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.completed, TASK_COLS.sprint],
  );
  const val = (it: any, c: string) => it.cols[c] ?? '';
  for (const t of targets) {
    const it = live.find((x: any) => String(x.id) === t.id);
    if (!it) throw new Error(`${t.id} vanished between lookup and read`);
    if (it.groupId !== TASK_GROUPS.S28)
      throw new Error(`${t.id} is in group ${it.groupTitle}, not Sprint 28 — another session moved it; re-measure`);
    const st = val(it, TASK_COLS.status);
    if (st === 'Done') throw new Error(`${t.id} is Done — a Done row is re-filed to where it FINISHED, never rolled`);
    if (val(it, TASK_COLS.actualSp)) throw new Error(`${t.id} carries Actual SP ${val(it, TASK_COLS.actualSp)} — not an open row`);
    if (val(it, TASK_COLS.completed)) throw new Error(`${t.id} carries Completed Date ${val(it, TASK_COLS.completed)} — not an open row`);
    console.log(`  ${done.has(t.id) ? '✓' : '·'} ${t.id}  ${String(t.sp).padStart(2)} SP  ${st.padEnd(15)} ${val(it, TASK_COLS.sprint)} → Sprint 29  ${t.name.slice(7, 76)}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — ${targets.length} rows / ${targets.reduce((a, t) => a + t.sp, 0)} SP would move. Nothing written.`);
    return;
  }

  const M_MOVE = `mutation($item:ID!,$group:String!){move_item_to_group(item_id:$item,group_id:$group){id}}`;
  let moved = 0;
  try {
    for (const t of targets) {
      if (done.has(t.id)) continue;
      // Label first, then group — the order sync.ts uses. Then the evidence update.
      await setColumns(MONDAY_BOARDS.tasks, t.id, { [TASK_COLS.sprint]: { index: TASK_SPRINT_INDEX.S29 } });
      await gql(M_MOVE, { item: t.id, group: TASK_GROUPS.S29 });
      await postUpdate(t.id, BODY);
      done.add(t.id);
      moved++;
      fs.writeFileSync(PROGRESS, JSON.stringify([...done], null, 2), 'utf8');
    }
  } catch (e) {
    fs.writeFileSync(PROGRESS, JSON.stringify([...done], null, 2), 'utf8');
    const left = targets.filter((t) => !done.has(t.id)).length;
    if (e instanceof DailyLimitExceeded) {
      console.error(`\nBUDGET DIED after ${moved} moves — ${left} remain. Re-run --apply after 00:00 UTC.`);
      process.exit(3);
    }
    console.error(`\nFAILED after ${moved} moves — ${left} remain.`);
    throw e;
  }
  console.log(`\nmoved ${moved} rows · ${done.size}/${targets.length} per ledger`);
});
