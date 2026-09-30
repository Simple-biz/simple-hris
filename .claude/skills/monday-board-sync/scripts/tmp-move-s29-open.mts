/**
 * ONE-OFF (2026-09-29, Kane: "move unfinished task from 29 to 30 we have a new sprint"): roll the TEN
 * open HRIS rows still filed under Sprint 29 into Sprint 30 — Sprint label + group move. Nothing else
 * is written. Modelled on tmp-move-s28-pd.mts.
 *
 * WHICH TEN, AND WHY ONLY THESE. Every row below was re-measured read-only on 2026-09-29, and each is
 * either unstarted or held ONLY by a step outside git that has not happened:
 *   • 4 Employee Support rows: 0 employee_support / support_tickets grants
 *   • Tickets emails: ticket_replied / ticket_moved inactive, with an empty url
 *   • HSL scheduling: employee_schedule_periods absent
 *   • Lead Gen QC: the restore has not run (same 290 applied rows by carla@, 09-15 15:16Z)
 *   • 3 Ready to Start rows: the sheet-sync split, the null-preferred spike, the deletion cron.
 *     No commit touches them.
 * An external step closes with dateBasis 'external' on the day it happens, which falls inside S30,
 * and an unstarted row has no date at all, so none of these can be mis-attributed by the move. The
 * code-complete Pending Deploy rows of pass 36 STAY in S29. Their Done date is their commit date,
 * which falls in S29 (pass 32's rule). The two pass-35 rows go Done in S29 and are not touched here.
 * "Five employees still hold a rate override…" is in BACKLOG, not S29, so it is not in scope.
 *
 * Status, Actual SP and Completed Date are NEVER touched. Every target is refused unless it is open,
 * unscored, undated and physically in the Sprint 29 group. It REFUSES to run at all until Sprint 30 is
 * mirrored into hris-plan.ts (group id + label index read off the board, never guessed) and the plan
 * row itself says S30. Dry-run by default; --apply to write.
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
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-s29-open.progress.json');
const done = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

const S30_GROUP = (TASK_GROUPS as Record<string, string>).S30;
const S30_INDEX = (TASK_SPRINT_INDEX as Record<string, number>).S30;
if (!S30_GROUP || S30_INDEX === undefined) {
  console.error(
    'Sprint 30 is not mirrored into hris-plan.ts yet — refusing. Read its group id, label index and ' +
      'window off the board (tmp-probe-s30.mts), mirror all four maps, flip the ten rows to S30, re-run.',
  );
  process.exit(2);
}

/**
 * Name fragment → the board id recorded by an earlier pass, or null where none was recorded locally.
 * A second lock on the name lookup where we have one; a null still has to resolve to exactly one row.
 */
const EXPECTED: Record<string, string | null> = {
  'Google Sheet sync crons': '12620595935',
  'Legacy rates-sheet cell can route': '12620645283',
  'Deletion cron never re-checks': '12863029482',
  'Tickets board notifies the requester on every update': '12881288126',
  'Scheduling moves inside the HSL department and starts saving': '13070861896',
  'QC first pass never reached the applied rows': '13070853274',
  'The Support Tickets staff board renders its own queue': '13117360653',
  'Employee Support live chat': null,
  'Employee Support reaches the employee': null,
  'The Employee Support staff board’s read and triage API': null,
};

const BODY =
  `**Sprint 29 → Sprint 30**: rollover 2026-09-30, on Kane's instruction to move S29's unfinished work (asked 09-29, repeated 09-30).\n\n` +
  `**Status, Actual SP and Completed Date are unchanged.** A sprint move is a scheduling fact, not a ` +
  `claim about progress. Re-measured read-only 2026-09-29 and 2026-09-30: this row is either unstarted or held only by ` +
  `an external step that has not happened. When that step happens, it closes with an external ` +
  `Completed Date on that day, inside Sprint 30's window.`;

await withLock(async () => {
  await assertLabelsUnchanged();

  const targets: { id: string; name: string; sp: number }[] = [];
  for (const [frag, expectedId] of Object.entries(EXPECTED)) {
    const plan = (PLAN_TASKS as any[]).filter((t) => t.name.includes(frag));
    if (plan.length !== 1) throw new Error(`plan lookup for "${frag}" returned ${plan.length} rows`);
    if (plan[0].sprint !== 'S30')
      throw new Error(`plan still says ${plan[0].sprint} for "${frag}" — flip it to S30 in hris-plan.ts first`);
    if (plan[0].done) throw new Error(`"${frag}" is done:true in the plan — a Done row does not roll`);
    const name = taskItemName(plan[0]);
    const ids = await findItemIdsByExactName(MONDAY_BOARDS.tasks, name);
    if (ids.length !== 1) throw new Error(`"${name}" resolved to ${ids.length} board ids — refusing`);
    if (expectedId && ids[0] !== expectedId)
      throw new Error(`"${frag}" resolved to ${ids[0]}, expected ${expectedId} — board changed, re-measure`);
    targets.push({ id: ids[0], name, sp: plan[0].sp });
  }

  const live = await getItemsByIds(
    targets.map((t) => t.id),
    [TASK_COLS.status, TASK_COLS.actualSp, TASK_COLS.completed, TASK_COLS.sprint],
  );
  const val = (it: any, c: string) => it.cols[c] ?? '';
  for (const t of targets) {
    const it = live.find((x: any) => String(x.id) === t.id);
    if (!it) throw new Error(`${t.id} vanished between lookup and read`);
    if (done.has(t.id)) {
      console.log(`  ✓ ${t.id}  already moved per ledger`);
      continue;
    }
    if (it.groupId !== TASK_GROUPS.S29)
      throw new Error(`${t.id} is in group ${it.groupTitle}, not Sprint 29 — another session moved it; re-measure`);
    const st = val(it, TASK_COLS.status);
    if (st === 'Done') throw new Error(`${t.id} is Done — a Done row is re-filed to where it FINISHED, never rolled`);
    if (val(it, TASK_COLS.actualSp)) throw new Error(`${t.id} carries Actual SP ${val(it, TASK_COLS.actualSp)} — not an open row`);
    if (val(it, TASK_COLS.completed)) throw new Error(`${t.id} carries Completed Date ${val(it, TASK_COLS.completed)} — not an open row`);
    console.log(`  · ${t.id}  ${String(t.sp).padStart(2)} SP  ${st.padEnd(15)} ${val(it, TASK_COLS.sprint)} → Sprint 30  ${t.name.slice(7, 76)}`);
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
      await setColumns(MONDAY_BOARDS.tasks, t.id, { [TASK_COLS.sprint]: { index: S30_INDEX } });
      await gql(M_MOVE, { item: t.id, group: S30_GROUP });
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
