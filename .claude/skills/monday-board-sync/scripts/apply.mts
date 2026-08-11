/**
 * THE ONLY WRITER in this skill. Dry run unless BOTH --apply and a matching --approve <hash>.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/apply.mts                      # dry
 *   node --import tsx .claude/skills/monday-board-sync/scripts/apply.mts --apply --approve ab12cd34
 *
 * Two phases, in this order, because the second depends on the first:
 *
 *   1. STRUCTURE — runs the REAL production reconciler (`syncHrisBoard` from src/lib/monday/sync.ts,
 *      the same function behind Admin → Design & Specifications). Not a reimplementation: creating
 *      rows any other way would produce names the reconciler does not recognise, and it would then
 *      recreate them forever.
 *   2. CORRECTIONS — execution state the reconciler refuses to write on existing rows: Status,
 *      Actual SP, Completed Date, and the evidence update.
 *
 * The two phases touch disjoint columns, asserted at runtime. Hard rules for phase 2:
 *   • never creates or deletes an item
 *   • never writes a board relation — Linked Tasks and Sprint Tasks are full-set OVERWRITES, so
 *     anything written there is erased by the next reconcile
 *   • never touches Projects Portfolio (18419115953): its Status column is NOT create-only, the
 *     reconciler rewrites it every pass, and the collision would be silent
 *   • re-reads the board to resolve names → ids. `report.tasksCreated` holds the UNPREFIXED plan
 *     name, not the board name and not an id.
 */
import fs from 'node:fs';
import {
  KANE_USER_ID,
  MONDAY_BOARDS,
  PLAN_TASKS,
  PROPOSAL_PATH,
  SKILL_DIR,
  TASK_COLS,
  TASK_STATUS_INDEX,
  assertLabelsUnchanged,
  assertNameIsSafe,
  isOurTask,
  listBoardItems,
  loadToken,
  postUpdate,
  setColumns,
  taskItemName,
  withLock,
} from './monday.mts';
import { PASS_DATE, ROWS, selfcheck, updateBody } from './pass.mts';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const approved = args[args.indexOf('--approve') + 1];
const tag = APPLY ? 'APPLY' : 'DRY';

// ── gate 1: the pass must be internally honest ───────────────────────────────────────────────────
const bad = selfcheck();
if (bad.length) {
  console.error(`pass selfcheck FAILED — refusing to write:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

// ── gate 2: the write must be the thing Kane approved ────────────────────────────────────────────
// Dry-run-by-default is not enough on its own: a stray --apply would still write. Binding the run to
// a hash of the proposal means what gets written is provably what was shown.
if (APPLY) {
  if (!fs.existsSync(PROPOSAL_PATH)) {
    console.error(`no proposal at ${PROPOSAL_PATH} — run review.mts and show Kane the output first.`);
    process.exit(1);
  }
  const stored = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf8')) as { hash: string; generatedFor: string };
  if (!approved) {
    console.error(`--apply requires --approve <hash>. The current proposal's hash is ${stored.hash}.`);
    process.exit(1);
  }
  if (approved !== stored.hash) {
    console.error(
      `approval hash mismatch: you passed ${approved}, the current proposal is ${stored.hash}.\n` +
        `The proposal changed after it was approved — re-run review.mts and get approval for the new one.`,
    );
    process.exit(1);
  }
  if (stored.generatedFor !== PASS_DATE) {
    console.error(`proposal was generated for ${stored.generatedFor} but the pass is dated ${PASS_DATE} — re-run review.mts.`);
    process.exit(1);
  }
  console.log(`approval accepted: ${approved}`);
}

// ── gate 3: the labels this pass writes must still exist (the board is structure-locked) ─────────
await assertLabelsUnchanged();
console.log('labels verified against hris-plan.ts');

// ── gate 4: the corrector's columns must not overlap the reconciler's update payload ─────────────
const CORRECTOR_COLS = [TASK_COLS.status, TASK_COLS.completed] as const;
/** What sync.ts writes on an EXISTING row (sync.ts:239-248 / :180-184). Verified 2026-08-11. */
const RECONCILER_UPDATE_COLS = new Set<string>([
  TASK_COLS.type,
  TASK_COLS.estimatedSp,
  TASK_COLS.sprint,
  TASK_COLS.priority,
  TASK_COLS.project,
  TASK_COLS.epic,
]);
const overlap = CORRECTOR_COLS.filter((c) => RECONCILER_UPDATE_COLS.has(c));
if (overlap.length) {
  console.error(`corrector/reconciler column overlap — refusing to write: ${overlap.join(', ')}`);
  process.exit(1);
}
for (const row of ROWS) assertNameIsSafe(taskItemName({ name: row.name }));

await withLock(async () => {
  // ── phase 1: structure, via the real reconciler ────────────────────────────────────────────────
  process.env.MONDAY = loadToken();
  const { syncHrisBoard } = await import('../../../../src/lib/monday/sync');

  console.log(`\n[${tag}] phase 1 — structure (real reconciler)`);
  const report = await syncHrisBoard({ dryRun: !APPLY, ownerId: KANE_USER_ID });
  console.log(`  epics created: ${report.epicsCreated.length}${report.epicsCreated.length ? ' (' + report.epicsCreated.join(', ') + ')' : ''}`);
  console.log(`  tasks created: ${report.tasksCreated.length}`);
  for (const n of report.tasksCreated) console.log(`     + ${n.slice(0, 88)}`);
  console.log(`  epics patched: ${report.epicsUpdated} · tasks patched: ${report.tasksUpdated}`);
  console.log(`  rollup: Total SP ${report.projectTotalSp} · SP Completed ${report.projectCompletedSp}`);
  for (const w of report.warnings) console.log(`  WARNING: ${w}`);

  // ── phase 2: corrections ───────────────────────────────────────────────────────────────────────
  // Re-read rather than trusting the report: its arrays hold unprefixed plan names, and only the
  // board knows the ids of rows that were just created.
  console.log(`\n[${tag}] phase 2 — corrections (re-reading the board for ids)`);
  const live = await listBoardItems(MONDAY_BOARDS.tasks, [TASK_COLS.status, TASK_COLS.completed]);
  const byName = new Map<string, { id: string; count: number }>();
  for (const it of live.filter((i) => isOurTask(i.name))) {
    const hit = byName.get(it.name);
    // Duplicate names are a real hazard: the reconciler's Map silently keeps the last one, so a
    // corrector that picked arbitrarily could write to the row nobody reads.
    byName.set(it.name, { id: hit?.id ?? it.id, count: (hit?.count ?? 0) + 1 });
  }

  const applied: { item: string; id: string; status: string }[] = [];
  const skipped: string[] = [];

  for (const row of ROWS) {
    const itemName = taskItemName({ name: row.name });
    const hit = byName.get(itemName);
    if (!hit) {
      // In a dry run nothing was created, so a brand-new row legitimately has no id yet.
      skipped.push(`${APPLY ? 'NOT ON BOARD' : 'would be created this pass'}: ${itemName.slice(0, 76)}`);
      continue;
    }
    if (hit.count > 1) {
      skipped.push(`AMBIGUOUS — ${hit.count} board rows share this name, fix the duplicate first: ${itemName.slice(0, 66)}`);
      continue;
    }
    const vals: Record<string, unknown> = { [TASK_COLS.status]: { index: TASK_STATUS_INDEX[row.status] } };
    // Completed Date is written ONLY for Done. Anything else would be an invented record.
    if (row.status === 'Done' && row.completed) vals[TASK_COLS.completed] = { date: row.completed };

    console.log(`  ${hit.id} → ${row.status}${row.completed ? ` · completed ${row.completed}` : ''}  ${row.name.slice(0, 62)}`);
    if (APPLY) {
      await setColumns(MONDAY_BOARDS.tasks, hit.id, vals);
      await postUpdate(hit.id, updateBody(row));
      applied.push({ item: itemName, id: hit.id, status: row.status });
    }
  }

  if (skipped.length) {
    console.log('\n  skipped:');
    for (const s of skipped) console.log(`    - ${s}`);
  }

  const out = { tag, passDate: PASS_DATE, approved: approved ?? null, report, applied, skipped };
  if (APPLY) {
    fs.writeFileSync(`${SKILL_DIR}/apply-result.json`, JSON.stringify(out, null, 2), 'utf8');
  }

  console.log(`\n[${tag}] structure ${report.tasksCreated.length} created / ${report.tasksUpdated} patched · corrections ${applied.length} written`);
  console.log(
    APPLY
      ? 'Now VERIFY by re-reading the board — never report a sync as done off the write log:\n  node --import tsx .claude/skills/monday-board-sync/scripts/verify.mts'
      : 'dry run only — nothing was written.',
  );
  if (APPLY && PLAN_TASKS.length) {
    console.log(`plan is ${PLAN_TASKS.length} tasks; the project's Sprint Tasks relation was re-pointed at all of them.`);
  }
});
