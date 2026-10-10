/**
 * ONE-OFF (2026-10-10, Kane: "lets all unfinished SP or uncommitted this 12 Midnight lets transfer them
 * to Sprint 31"): roll the TWO open HRIS rows still filed under Sprint 30 into Sprint 31 — Sprint label
 * + group move. Nothing else is written. Modelled on tmp-move-s29-open.mts (the 09-29 rollover).
 *
 * WHICH TWO, AND WHY ONLY THESE. Pass 44 (item 429) closes every other Sprint 30 row Done on Kane's word
 * and files HSL scheduling under Backlog for V2, so after it lands these are the only S30 plan rows with
 * done:false. Both were re-measured read-only 2026-10-10 ~07:10Z:
 *   • Tickets emails: webhooks.config (saved 10-05 18:21Z) still has ticket_replied and ticket_moved
 *     active=false with an EMPTY url; N8N_TICKETS_* is absent from .env.local.
 *   • The null-preferred spike: not started. The only commit since S30 opened that names it is the
 *     10-05 backlog triage doc (53a0dec5).
 * An external step closes with dateBasis 'external' on the day it happens, which then falls inside S31,
 * and an unstarted row has no date at all, so neither can be mis-attributed by the move.
 *
 * NOT moved, on purpose: pass 44's Done rows finished inside S30 and stay there (pass 32's rule: a
 * Done date is the commit date). The 10-09 commits that have no row yet (items 432, 436, 437, 447, 448)
 * are S30 work by their commit dates, so they get S30 rows in a status pass, never an S31 filing.
 * Backlog rows (HSL scheduling, bare hsl overrides) are not in a sprint and do not roll.
 *
 * Run it AFTER pass 44's apply. Status, Actual SP and Completed Date are NEVER touched. Every target is
 * refused unless it is open, unscored, undated and physically in the Sprint 30 group. It REFUSES to run
 * at all until Sprint 31 is mirrored into hris-plan.ts (group id + label index + label + window, read
 * off the board with tmp-probe-s30.mts, never guessed) and the plan rows themselves say S31. Dry-run by
 * default; --apply to write. About 10 calls.
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
const PROGRESS = path.join(SKILL_DIR, 'scripts', 'tmp-move-s30-open.progress.json');
const done = new Set<string>(
  fs.existsSync(PROGRESS) ? (JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) as string[]) : [],
);

const S31_GROUP = (TASK_GROUPS as Record<string, string>).S31;
const S31_INDEX = (TASK_SPRINT_INDEX as Record<string, number>).S31;
if (!S31_GROUP || S31_INDEX === undefined) {
  console.error(
    'Sprint 31 is not mirrored into hris-plan.ts yet — refusing. Kane creates its group and Sprint label ' +
      'on the board by hand; read both off the board (tmp-probe-s30.mts), mirror all four maps, flip the ' +
      'two rows to S31, re-run.',
  );
  process.exit(2);
}

/** Name fragment → the board id recorded by the 09-29 rollover (tmp-move-s29-open.progress.json). */
const EXPECTED: Record<string, string> = {
  'Legacy rates-sheet cell can route': '12620645283',
  'Tickets board notifies the requester on every update': '12881288126',
};

const BODY =
  `**Sprint 30 → Sprint 31**: rollover on Kane's instruction of 2026-10-10 to move Sprint 30's unfinished work.\n\n` +
  `**Status, Actual SP and Completed Date are unchanged.** A sprint move is a scheduling fact, not a ` +
  `claim about progress. Re-measured read-only 2026-10-10: this row is either unstarted or held only by ` +
  `an external step that has not happened. When that step happens, it closes with an external ` +
  `Completed Date on that day, inside Sprint 31's window.`;

await withLock(async () => {
  await assertLabelsUnchanged();

  const targets: { id: string; name: string; sp: number }[] = [];
  for (const [frag, expectedId] of Object.entries(EXPECTED)) {
    const plan = (PLAN_TASKS as any[]).filter((t) => t.name.includes(frag));
    if (plan.length !== 1) throw new Error(`plan lookup for "${frag}" returned ${plan.length} rows`);
    if (plan[0].sprint !== 'S31')
      throw new Error(`plan still says ${plan[0].sprint} for "${frag}" — flip it to S31 in hris-plan.ts first`);
    if (plan[0].done) throw new Error(`"${frag}" is done:true in the plan — a Done row does not roll`);
    const name = taskItemName(plan[0]);
    const ids = await findItemIdsByExactName(MONDAY_BOARDS.tasks, name);
    if (ids.length !== 1) throw new Error(`"${name}" resolved to ${ids.length} board ids — refusing`);
    if (ids[0] !== expectedId)
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
    if (it.groupId !== TASK_GROUPS.S30)
      throw new Error(`${t.id} is in group ${it.groupTitle}, not Sprint 30 — another session moved it; re-measure`);
    const st = val(it, TASK_COLS.status);
    if (st === 'Done') throw new Error(`${t.id} is Done — a Done row is re-filed to where it FINISHED, never rolled`);
    if (val(it, TASK_COLS.actualSp)) throw new Error(`${t.id} carries Actual SP ${val(it, TASK_COLS.actualSp)} — not an open row`);
    if (val(it, TASK_COLS.completed)) throw new Error(`${t.id} carries Completed Date ${val(it, TASK_COLS.completed)} — not an open row`);
    console.log(`  · ${t.id}  ${String(t.sp).padStart(2)} SP  ${st.padEnd(15)} ${val(it, TASK_COLS.sprint)} → Sprint 31  ${t.name.slice(7, 76)}`);
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
      await setColumns(MONDAY_BOARDS.tasks, t.id, { [TASK_COLS.sprint]: { index: S31_INDEX } });
      await gql(M_MOVE, { item: t.id, group: S31_GROUP });
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
