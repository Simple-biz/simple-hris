/**
 * Flush the pending-SP ledger to Monday. This is what runs when Kane says "push".
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/flush-pending.mts            # dry run
 *   node --import tsx .claude/skills/monday-board-sync/scripts/flush-pending.mts --apply    # write
 *
 * Cost: 1 cheap budget probe + 2 calls per row (exact-name lookup, then set +
 * update). A 10-row flush is ~21 calls, not the ~200 a full reconcile costs — so
 * a flush stays affordable even on a partly-spent budget. It writes ONLY the
 * corrector's columns (Status / Actual SP / Completed Date) and an item update,
 * never a relation, never structure — so it cannot collide with the reconciler.
 *
 * It refuses, rather than guesses, in every one of these cases:
 *   - the budget is still exhausted (queue left completely untouched)
 *   - an entry was never approved (no hash) — reported, never written
 *   - an entry no longer re-verifies against git or the plan (see revalidate())
 *   - the row's name is absent from the board, or ambiguous (duplicate names)
 *   - another apply/flush holds the lock
 */
import fs from 'node:fs';
import {
  MONDAY_BOARDS,
  boardGroups,
  findItemIdsByExactName,
  setColumns,
  postUpdate,
  withLock,
  DailyLimitExceeded,
  SKILL_DIR,
  correctionValues,
  taskItemName,
  PLAN_TASKS,
} from './monday.mts';
import { updateBody } from './pass.mts';
import { loadPending, unflushed, revalidate, markFlushed, flushFootnote, PENDING_PATH } from './pending-sp.mts';

const APPLY = process.argv.includes('--apply');
const NOW = new Date().toISOString();
const tag = APPLY ? 'FLUSH' : 'FLUSH (dry run)';

await withLock(async () => {
  const ledger = loadPending();
  const pending = unflushed(ledger);

  console.log(`[${tag}] ledger: ${PENDING_PATH}`);
  console.log(`  entries total ${ledger.entries.length} · unflushed ${pending.length}`);

  if (!pending.length) {
    console.log('\nNothing pending. The board owes nothing from a dead budget.');
    return;
  }

  // ── 1. Is the budget actually back? One cheap call, and the queue is not
  //       touched if it is not. Probing first means a dead budget costs 1 call
  //       instead of dying halfway through the flush and re-fragmenting it.
  try {
    await boardGroups(MONDAY_BOARDS.tasks);
    console.log('  budget probe: OK\n');
  } catch (e) {
    if (e instanceof DailyLimitExceeded) {
      console.log('\nBUDGET STILL EXHAUSTED — nothing written, ledger untouched.');
      console.log(String(e.message).split('\n').slice(0, 4).join('\n'));
      console.log(`\n${pending.length} row(s) still owed. Re-run after the reset.`);
      process.exitCode = 3;
      return;
    }
    throw e;
  }

  // ── 2. Re-verify every entry against the CURRENT repo and plan ───────────────
  const ready: typeof pending = [];
  const refused: { name: string; why: string[] }[] = [];
  for (const e of pending) {
    const bad = revalidate(e);
    if (bad.length) refused.push({ name: e.row.name, why: bad });
    else ready.push(e);
  }

  if (refused.length) {
    console.log(`REFUSED — ${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} no longer verify:`);
    for (const r of refused) {
      console.log(`  ✗ ${r.name.slice(0, 70)}`);
      for (const w of r.why) console.log(`      ${w}`);
    }
    console.log('  (left in the ledger — fix the cause, do not delete the entry)\n');
  }

  if (!ready.length) {
    console.log('Nothing is writable. Ledger unchanged.');
    process.exitCode = refused.length ? 4 : 0;
    return;
  }

  // ── 3. Write ────────────────────────────────────────────────────────────────
  let written = 0;
  const skipped: string[] = [];
  let spWritten = 0;

  for (const entry of ready) {
    const { row } = entry;
    const itemName = taskItemName({ name: row.name });
    const plan = PLAN_TASKS.find((t) => t.name === row.name)!; // revalidate proved it exists

    let ids: string[];
    try {
      ids = await findItemIdsByExactName(MONDAY_BOARDS.tasks, itemName);
    } catch (e) {
      if (e instanceof DailyLimitExceeded) {
        console.log(`\nBUDGET DIED MID-FLUSH after ${written} row(s). The rest stay in the ledger.`);
        process.exitCode = 3;
        break;
      }
      throw e;
    }

    if (ids.length === 0) {
      skipped.push(`NOT ON BOARD (a full apply must create it first): ${itemName.slice(0, 64)}`);
      continue;
    }
    if (ids.length > 1) {
      skipped.push(`AMBIGUOUS — ${ids.length} rows share this name, fix the duplicate first: ${itemName.slice(0, 60)}`);
      continue;
    }

    const vals = correctionValues(row, plan.sp);
    const label = row.status === 'Done' ? `Done · ${plan.sp} SP · ${row.completed}` : row.status;
    console.log(`  ${ids[0]} → ${label}  ${row.name.slice(0, 48)}`);

    if (APPLY) {
      try {
        await setColumns(MONDAY_BOARDS.tasks, ids[0]!, vals);
        await postUpdate(ids[0]!, updateBody(row) + flushFootnote(entry, NOW));
      } catch (e) {
        if (e instanceof DailyLimitExceeded) {
          console.log(`\nBUDGET DIED MID-FLUSH after ${written} row(s). The rest stay in the ledger.`);
          process.exitCode = 3;
          break;
        }
        throw e;
      }
      // Marked one at a time so a mid-flush death leaves an accurate ledger
      // rather than a batch that claims more than it wrote.
      markFlushed(row.name, `flushed ${NOW} (approval ${entry.approvalHash})`, NOW);
      written += 1;
      if (row.status === 'Done') spWritten += plan.sp;
    }
  }

  if (skipped.length) {
    console.log('\n  skipped:');
    for (const s of skipped) console.log(`    - ${s}`);
  }

  console.log(
    APPLY
      ? `\n[${tag}] ${written} row(s) written · ${spWritten} SP · ${refused.length} refused · ${skipped.length} skipped`
      : `\n[${tag}] would write ${ready.length} row(s) · ${refused.length} refused · nothing written`,
  );

  if (APPLY) {
    fs.writeFileSync(
      `${SKILL_DIR}/flush-result.json`,
      JSON.stringify({ at: NOW, written, spWritten, refused, skipped }, null, 2),
      'utf8',
    );
    console.log('Now VERIFY by re-reading — a write log is not a board state:');
    console.log('  node --import tsx .claude/skills/monday-board-sync/scripts/verify-one.mts <itemId>');
  }
});
