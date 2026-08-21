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
  correctionValues,
  DailyLimitExceeded,
  TASK_GROUPS,
  TASK_PRIORITY_INDEX,
  TASK_SPRINT_INDEX,
  TASK_STATUS_INDEX,
  TASK_TYPE_INDEX,
  assertLabelsUnchanged,
  assertNameIsSafe,
  createItem,
  findItemIdsByExactName,
  isOurTask,
  listBoardItems,
  loadToken,
  postUpdate,
  proposalHash,
  setColumns,
  taskItemName,
  withLock,
} from './monday.mts';
import { PASS_DATE, ROWS, selfcheck, updateBody } from './pass.mts';
import type { PassRow } from './pass.mts';
import { queuePendingRows } from './pending-sp.mts';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
/**
 * LEAN MODE — for a pass that only ADDS rows and corrects them.
 *
 * The default path runs the real reconciler, which re-patches all 135 task rows and 37 epics and
 * then reads all ~2,300 board items to resolve ids: ~200 calls against a DAILY complexity budget,
 * to add one row. This mode does the same job for that row in three calls — an exact-name lookup,
 * a create carrying every reconciler-owned column, and the evidence update.
 *
 * It is safe against the recreate-forever trap for one reason only: the reconciler matches
 * BYTE-EXACT on `taskItemName(plan.name)`, and that is the exact string created here, sourced from
 * the same PLAN_TASKS entry. A name typed by hand would NOT be safe.
 *
 * What it deliberately does not do, and why the full pass still has to run eventually:
 *   • no board relations — Linked Tasks / Sprint Tasks are full-set OVERWRITES (writing one from
 *     here would erase the rest), so the epic link and project rollup stay unset until a reconcile
 *   • no epic creation, no re-patching of rows this pass does not name
 * Refuses outright if any row is missing from the board, since correcting an absent row is the one
 * thing this mode cannot do without the reconciler.
 */
const ONLY_NEW = args.includes('--only-new');
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
  const stored = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf8')) as {
    hash: string;
    inputsHash?: string;
    generatedFor: string;
  };
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
  // ── gate 2b: the SOURCE must still be what the proposal was minted from ────────────────────────
  // The hash above binds the proposal file; this binds the working tree. Without it a still-matching
  // hash authorises whatever `hris-plan.ts` happens to say when apply runs — and this checkout is
  // shared between sessions, so "happens to say" is a real state, not a hypothetical. A proposal
  // predating this check has no `inputsHash` and is treated as stale: fail closed, re-run review.
  const liveInputs = proposalHash({ passDate: PASS_DATE, plan: PLAN_TASKS, rows: ROWS });
  if (stored.inputsHash !== liveInputs) {
    console.error(
      stored.inputsHash
        ? `the plan or pass rows CHANGED after this proposal was reviewed ` +
          `(inputs ${stored.inputsHash} → ${liveInputs}).\n` +
          `The approval describes a different set of writes. Re-run review.mts and get approval for the new one.`
        : `this proposal predates the source-fingerprint check, so it cannot be proven to describe ` +
          `the current plan. Re-run review.mts.`,
    );
    process.exit(1);
  }
  console.log(`approval accepted: ${approved} (source verified: ${liveInputs})`);
}

// ── gate 3: the labels this pass writes must still exist (the board is structure-locked) ─────────
/**
 * Item names whose correction actually LANDED this run. Module-level so the outermost
 * DailyLimitExceeded handler can queue everything that did not, wherever the budget died —
 * including phase 1, before a single correction is attempted. Measured 2026-08-21: the
 * budget was already spent by 13:17Z, so apply.mts died on the label-gate read and the
 * in-loop handler never ran. A queue that only covers a mid-loop death is not a queue.
 */
const WRITTEN_ITEM_NAMES = new Set<string>();

// Inside the try: the label gate is the FIRST call that can hit a dead budget, and on
// 2026-08-21 that is exactly where it died.
try {
await assertLabelsUnchanged();
console.log('labels verified against hris-plan.ts');

// ── gate 4: the corrector's columns must not overlap the reconciler's update payload ─────────────
// Actual SP belongs here, not to the reconciler: sync.ts writes it ONLY in its create payload
// (sync.ts:256), and its update payload (sync.ts:239-245) omits it — so on a row that already
// exists, nobody wrote Actual SP at all and a row flipped to Done later kept a blank one forever.
// It stays disjoint from RECONCILER_UPDATE_COLS below, so the collision guard still holds.
const CORRECTOR_COLS = [TASK_COLS.status, TASK_COLS.completed, TASK_COLS.actualSp] as const;
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

// correctionValues now lives in monday.mts so the flush path shares the identical rule.

/** How a correction reads in the console — the same facts the proposal hash was taken over. */
const describe = (row: PassRow, planSp: number) =>
  `${row.status}${row.status === 'Done' ? ` · actual ${planSp} SP · completed ${row.completed}` : ''}`;

  await withLock(async () => {
  process.env.MONDAY = loadToken();

  // ── LEAN PATH — create only the rows this pass names, then correct them ────────────────────────
  if (ONLY_NEW) {
    console.log(`\n[${tag}] LEAN — reconciler skipped; only the ${ROWS.length} row(s) in this pass are touched`);
    console.log('  NOT written by this mode: epic relation, project rollup, and any re-patch of');
    console.log('  other rows. A later full reconcile fills those in — it matches this row by name.');

    const applied: { item: string; id: string; status: string }[] = [];
    const skipped: string[] = [];

    for (const row of ROWS) {
      const plan = PLAN_TASKS.find((t) => t.name === row.name);
      // selfcheck already enforces this, but the writer re-asserts rather than trusting a caller:
      // a name that is not in the plan is exactly the input that recreates rows forever.
      if (!plan) {
        skipped.push(`no PLAN_TASKS entry — refusing to create an unrecognised name: ${row.name.slice(0, 60)}`);
        continue;
      }
      const itemName = taskItemName({ name: plan.name });
      const existing = await findItemIdsByExactName(MONDAY_BOARDS.tasks, itemName);
      if (existing.length > 1) {
        skipped.push(`AMBIGUOUS — ${existing.length} board rows share this name, fix the duplicate first: ${itemName.slice(0, 60)}`);
        continue;
      }

      let id = existing[0];
      if (!id) {
        // Every reconciler-owned column rides the create, so the row is fully scored in one call
        // and a later reconcile has nothing to correct. Relations are deliberately absent.
        const createVals: Record<string, unknown> = {
          [TASK_COLS.owner]: { personsAndTeams: [{ id: KANE_USER_ID, kind: 'person' }] },
          [TASK_COLS.type]: { index: TASK_TYPE_INDEX[plan.type] },
          [TASK_COLS.status]: { index: TASK_STATUS_INDEX[row.status] },
          [TASK_COLS.estimatedSp]: String(plan.sp),
          [TASK_COLS.sprint]: { index: TASK_SPRINT_INDEX[plan.sprint] },
          ...(plan.priority ? { [TASK_COLS.priority]: { index: TASK_PRIORITY_INDEX[plan.priority] } } : {}),
          // Actual SP and Completed Date only ever accompany a Done row.
          ...(row.status === 'Done' ? { [TASK_COLS.actualSp]: String(plan.sp) } : {}),
          ...(row.status === 'Done' && row.completed ? { [TASK_COLS.completed]: { date: row.completed } } : {}),
        };
        console.log(`  create → ${plan.sprint} ${plan.sp}SP ${plan.type} ${row.status}  ${itemName.slice(0, 70)}`);
        if (!APPLY) {
          skipped.push(`would be created this pass: ${itemName.slice(0, 76)}`);
          continue;
        }
        id = await createItem(MONDAY_BOARDS.tasks, TASK_GROUPS[plan.sprint], itemName, createVals);
        console.log(`    created id ${id}`);
      } else {
        // Already on the board — this mode cannot patch reconciler-owned columns, so it corrects
        // only execution state, exactly like the normal phase 2.
        const vals = correctionValues(row, plan.sp);
        console.log(`  existing ${id} → ${describe(row, plan.sp)}  ${itemName.slice(0, 56)}`);
        if (APPLY) await setColumns(MONDAY_BOARDS.tasks, id, vals);
      }

      if (APPLY) {
        await postUpdate(id, updateBody(row));
        applied.push({ item: itemName, id, status: row.status });
      WRITTEN_ITEM_NAMES.add(itemName);
      }
    }

    if (skipped.length) {
      console.log('\n  skipped:');
      for (const s of skipped) console.log(`    - ${s}`);
    }
    if (APPLY) {
      fs.writeFileSync(
        `${SKILL_DIR}/apply-result.json`,
        JSON.stringify({ tag, mode: 'only-new', passDate: PASS_DATE, approved: approved ?? null, applied, skipped }, null, 2),
        'utf8',
      );
    }
    console.log(
      APPLY
        ? `\n[${tag}] ${applied.length} row(s) written. VERIFY by re-reading the board — never report a sync as done off the write log:\n  node --import tsx .claude/skills/monday-board-sync/scripts/verify.mts`
        : `\n[${tag}] dry run only — nothing was written.`,
    );
    return;
  }

  // ── phase 1: structure, via the real reconciler ────────────────────────────────────────────────
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
    // selfcheck already enforces this; the writer re-asserts rather than trusting a caller, because
    // Actual SP must come from the plan and never from a number chosen here.
    const plan = PLAN_TASKS.find((t) => t.name === row.name);
    if (!plan) {
      skipped.push(`no PLAN_TASKS entry — refusing to score a row the plan does not declare: ${row.name.slice(0, 60)}`);
      continue;
    }
    const vals = correctionValues(row, plan.sp);

    console.log(`  ${hit.id} → ${describe(row, plan.sp)}  ${row.name.slice(0, 52)}`);
    if (APPLY) {
      try {
        await setColumns(MONDAY_BOARDS.tasks, hit.id, vals);
        await postUpdate(hit.id, updateBody(row));
        applied.push({ item: itemName, id: hit.id, status: row.status });
        WRITTEN_ITEM_NAMES.add(itemName);
      } catch (e) {
        // A dead budget mid-corrections used to drop the TAIL of the pass on the
        // floor: the run ended, the rows were never written, and the SP was only
        // recoverable by re-deriving the whole pass from git. Now the unwritten
        // remainder (this row included) is persisted and flushed later on Kane's
        // word — see pending-sp.mts.
        // Re-thrown: the outermost handler owns queueing, so there is exactly ONE place
        // that decides what is owed, wherever the budget died.
        throw e;
      }
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
} catch (e) {
  // The ONE place that decides what the board is owed. Any DailyLimitExceeded -- the
  // phase-1 label gate, the structure reconcile, or mid-corrections -- lands here, and
  // every row whose correction did not land is persisted rather than lost.
  if (e instanceof DailyLimitExceeded) {
    const owed = ROWS.filter((r) => !WRITTEN_ITEM_NAMES.has(taskItemName({ name: r.name })));
    const q = queuePendingRows(owed, {
      passDate: PASS_DATE,
      approvalHash: approved ?? null,
      inputsHash: null,
      reason: 'DAILY_LIMIT_EXCEEDED',
      now: new Date().toISOString(),
    });
    const NL = String.fromCharCode(10);
    console.log('');
    console.log(`  BUDGET DIED. ${WRITTEN_ITEM_NAMES.size} correction(s) had landed.`);
    console.log(`  QUEUED ${q.queued} unwritten row(s) to pending-sp.json (${q.superseded} superseded).`);
    for (const l of String(e.message).split(NL).slice(1, 3)) console.log(l);
    console.log('');
    console.log('  Flush when the budget resets (Kane says "push"):');
    console.log('    node --import tsx .claude/skills/monday-board-sync/scripts/flush-pending.mts --apply');
    process.exitCode = 3;
  } else {
    throw e;
  }
}
