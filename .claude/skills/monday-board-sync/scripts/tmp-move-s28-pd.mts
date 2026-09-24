/**
 * ONE-OFF (2026-09-24, Kane: "just make sure that unfinished tasks from 28 is moved to 29"): roll the
 * FOUR Pending Deploy rows still filed under Sprint 28 into Sprint 29 — Sprint label + group move.
 * Nothing else is written. These are the only open S28 rows (measured 2026-09-24 by status filter:
 * S28 held 98 of ours, 94 Done, these 4 Pending Deploy).
 *
 * WHY PASS 32 LEFT THEM AND WHY THEY MOVE NOW. Pass 32 (tmp-move-s28-open.mts) declined to move them
 * because their CODE landed inside S28, so a Done keyed on the commit date would fall outside S29.
 * Pass 34 re-measured all four, and every one is held ONLY by an external step not yet taken:
 * paystub_issues absent, employee_schedule_periods absent, the ticket_replied/ticket_moved workflows
 * inactive, the Lead Gen QC restore unrun. Their completion is that step, so they close with
 * dateBasis 'external' on the day it happens, which is 2026-09-24 or later and inside S29's window.
 * The pass 32 objection no longer applies. If a step slips past 2026-09-25, the row rolls again.
 *
 * Status, Actual SP and Completed Date are NEVER touched. Every target is refused unless it is open,
 * unscored and undated. Dry-run by default; --apply to write.
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
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-s28-pd.progress.json');
const done = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

/** Name fragment → the board id MEASURED this session. A second lock on the name lookup. */
const EXPECTED: Record<string, string> = {
  'Tickets board notifies the requester on every update': '12881288126',
  'Sending a second copy of a pay document asks first': '13034136298',
  'Scheduling moves inside the HSL department and starts saving': '13070861896',
  'QC first pass never reached the applied rows': '13070853274',
};

const BODY =
  `**Sprint 28 → Sprint 29**: rollover 2026-09-24, on Kane's instruction to move S28's unfinished work.

` +
  `**Status, Actual SP and Completed Date are unchanged.** A sprint move is a scheduling fact, not a ` +
  `claim about progress. This row is held only by an external step, which is not yet taken (see the ` +
  `2026-09-24 pass-34 evidence update). When the step happens, it closes with an external Completed ` +
  `Date on that day, inside Sprint 29's window.`;

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
