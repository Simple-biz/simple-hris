/**
 * ONE-OFF (2026-10-08, Kane: "in the Projects Portfolio dont forget to udpate it"): refresh the HRIS row
 * on Projects Portfolio ("Simple HRIS Platform", item HRIS_PROJECT_ITEM_ID) WITHOUT a full reconcile.
 *
 * WHY NOT THE FULL PATH. Only `syncHrisBoard` writes this row (Status Live, Total SP, SP Completed and the
 * Sprint Tasks relation), and `apply.mts --only-new` returns before it ever runs. But the full reconcile
 * re-patches every plan row first: it was measured not to fit one UTC day's budget at 282 tasks, and the
 * plan is now ~550. A run that dies in that re-patch never reaches the rollup, which is the LAST step, and
 * leaves both relation columns half-overwritten. So every pass since 09-12 has added rows the portfolio's
 * Sprint Tasks relation never learned about.
 *
 * WHAT THIS DOES. It runs the REAL reconciler as a DRY RUN (two board listings, no writes) and takes its
 * own rollup: `projectTotalSp`, `projectCompletedSp` and `projectTaskIds`. Then it writes that ONE row
 * with `projectRollupColumns`, the same builder the full reconcile uses. So the values and the shape are
 * the reconciler's, not a copy. Nothing on Sprint Tasks or Roadmap & Epics is written, and no epic's Linked
 * Tasks: that debt still belongs to a full reconcile.
 *
 * REFUSES TO WRITE when the dry run would CREATE anything (an epic or a task missing from the board means
 * the relation would leave a row out: run the pass's `apply.mts --only-new` first), or when the write would
 * UNLINK a row the portfolio links today, unless `--allow-removals <n>` names exactly that count. The
 * relation is a full-set overwrite, so a removal is never silent.
 *
 * Dry run by default (~12 calls). `--apply` adds 1 write and 1 re-read.
 */
import {
  DailyLimitExceeded,
  HRIS_PROJECT_ITEM_ID,
  KANE_USER_ID,
  MONDAY_BOARDS,
  PLAN_TASKS,
  PROJECT_COLS,
  gql,
  loadToken,
  withLock,
} from './monday.mts';

const APPLY = process.argv.includes('--apply');
const ra = process.argv.indexOf('--allow-removals');
const ALLOW_REMOVALS = ra >= 0 ? Number(process.argv[ra + 1]) : 0;

type ProjectState = { status: string | null; totalSp: string | null; spCompleted: string | null; linked: number[] };

async function readProject(): Promise<ProjectState> {
  const d = await gql<{
    items: { id: string; column_values: { id: string; text: string | null; linked_item_ids?: string[] }[] }[];
  }>(
    `query($ids:[ID!],$cols:[String!]){items(ids:$ids){id column_values(ids:$cols){id text ... on BoardRelationValue{linked_item_ids}}}}`,
    {
      ids: [HRIS_PROJECT_ITEM_ID],
      cols: [PROJECT_COLS.status, PROJECT_COLS.totalSp, PROJECT_COLS.spCompleted, PROJECT_COLS.sprintTasks],
    },
  );
  const item = d.items[0];
  if (!item) throw new Error(`project item ${HRIS_PROJECT_ITEM_ID} not found`);
  const col = (id: string) => item.column_values.find((c) => c.id === id);
  return {
    status: col(PROJECT_COLS.status)?.text ?? null,
    totalSp: col(PROJECT_COLS.totalSp)?.text ?? null,
    spCompleted: col(PROJECT_COLS.spCompleted)?.text ?? null,
    linked: (col(PROJECT_COLS.sprintTasks)?.linked_item_ids ?? []).map(Number),
  };
}

try {
  process.env.MONDAY = loadToken();
  const { syncHrisBoard, projectRollupColumns } = await import('../../../../src/lib/monday/sync');

  const before = await readProject();
  console.log(
    `portfolio NOW: status ${before.status} · Total SP ${before.totalSp} · SP Completed ${before.spCompleted} · Sprint Tasks ${before.linked.length}`,
  );

  const report = await syncHrisBoard({ dryRun: true, ownerId: KANE_USER_ID });
  const ids = [...new Set(report.projectTaskIds)];
  const next = new Set(ids);
  const prev = new Set(before.linked);
  const added = ids.filter((id) => !prev.has(id));
  const removed = before.linked.filter((id) => !next.has(id));
  console.log(
    `portfolio NEXT: status Live · Total SP ${report.projectTotalSp} · SP Completed ${report.projectCompletedSp} · Sprint Tasks ${ids.length} (+${added.length} / -${removed.length})`,
  );

  const refusals: string[] = [];
  if (report.epicsCreated.length) refusals.push(`${report.epicsCreated.length} epic(s) missing from the board: ${report.epicsCreated.join(', ')}`);
  if (report.tasksCreated.length) {
    refusals.push(`${report.tasksCreated.length} plan task(s) not on the board yet; run the pass's apply.mts --only-new first`);
    for (const n of report.tasksCreated.slice(0, 20)) console.log(`     missing: ${n.slice(0, 90)}`);
  }
  if (ids.length !== report.projectTaskIds.length) refusals.push(`the id set has duplicates (${report.projectTaskIds.length} → ${ids.length})`);
  if (!report.tasksCreated.length && ids.length !== PLAN_TASKS.length) {
    refusals.push(`resolved ${ids.length} ids for ${PLAN_TASKS.length} plan tasks`);
  }
  if (removed.length) {
    console.log(`  would UNLINK ${removed.length} id(s) the portfolio links today: ${removed.slice(0, 30).join(', ')}`);
    if (removed.length !== ALLOW_REMOVALS) refusals.push(`${removed.length} removal(s), not allowed (pass --allow-removals ${removed.length} only after looking at them)`);
  }

  if (refusals.length) {
    for (const r of refusals) console.error(`  REFUSED: ${r}`);
    process.exit(2);
  }
  if (!APPLY) {
    console.log('\ndry run only — nothing was written. Re-run with --apply to write the portfolio row.');
    process.exit(0);
  }

  await withLock(async () => {
    await gql(
      `mutation($board:ID!,$item:ID!,$cols:JSON!){change_multiple_column_values(board_id:$board,item_id:$item,column_values:$cols){id}}`,
      {
        board: MONDAY_BOARDS.projects,
        item: HRIS_PROJECT_ITEM_ID,
        cols: projectRollupColumns(report.projectTotalSp, report.projectCompletedSp, ids),
      },
    );
  });

  // Re-read: never report a write as done off the write log.
  const after = await readProject();
  const afterSet = new Set(after.linked);
  const ok =
    after.status === 'Live' &&
    Number(after.totalSp) === report.projectTotalSp &&
    Number(after.spCompleted) === report.projectCompletedSp &&
    after.linked.length === ids.length &&
    ids.every((id) => afterSet.has(id));
  console.log(
    `portfolio READ BACK: status ${after.status} · Total SP ${after.totalSp} · SP Completed ${after.spCompleted} · Sprint Tasks ${after.linked.length}`,
  );
  console.log(ok ? 'VERIFIED: the row reads exactly what was written.' : 'MISMATCH: the row does not read what was written.');
  process.exit(ok ? 0 : 1);
} catch (e) {
  if (e instanceof DailyLimitExceeded) {
    console.error(e.message);
    process.exit(3);
  }
  throw e;
}
