/**
 * ONE-SHOT runner for a pass Kane has ALREADY approved but that the API budget refused.
 *
 *   node --import tsx .claude/skills/monday-board-sync/scripts/run-approved-pass.mts          # probe only
 *   node --import tsx .claude/skills/monday-board-sync/scripts/run-approved-pass.mts --apply  # probe → review → assert → apply → verify
 *
 * WHY THIS EXISTS. The 2026-08-13 Sprint 26 re-attribution was reviewed in full, approved by Kane
 * ("Approve all"), and then could not be written because `DAILY_LIMIT_EXCEEDED` refused even a
 * one-call query. The approval is real but there was no `proposal.json` hash to bind it to, so the
 * scope Kane agreed to is asserted MECHANICALLY here instead of re-eyeballed later. See the APPROVAL
 * block in `pass.mts`.
 *
 * IT IS NOT A POLLER. One attempt per invocation. The probe is a single `boardGroups` call — the
 * cheapest thing on the board — so a failed attempt costs ~1 call and exits non-zero. Never loop this
 * on a timer: the budget is the scarce resource and a poller spends it on nothing.
 *
 * IT FAILS CLOSED. Every deviation from the approved shape aborts BEFORE the writer runs. A pass that
 * would create a row, flip a status, or overwrite an existing Actual SP is outside what Kane approved,
 * and this refuses it rather than deciding on his behalf.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { DailyLimitExceeded, MONDAY_BOARDS, PROPOSAL_PATH, REPO_ROOT, boardGroups } from './monday.mts';
import { PASS_DATE, ROWS, selfcheck } from './pass.mts';

const APPLY = process.argv.includes('--apply');
const SCRIPTS = '.claude/skills/monday-board-sync/scripts';

/**
 * What Kane approved, as assertions. Change these only with a NEW approval.
 *
 * 2026-08-13: the 57-row Sprint 26 → Sprint 25 re-attribution ("Approve all").
 * 2026-08-14: that same set PLUS 3 rows re-filed Backlog → Sprint 26, after a review of all 47
 * Backlog rows. 42 further Backlog rows were dated but deliberately scoped OUT — see pass.mts.
 * 2026-08-19: the Backlog clean-up + Completed-Date backfill — 43 dates, 20 rows filed Backlog →
 * S19-S23, and the 39 S26 → S25 moves the 08-14 pass never wrote. Kane approved proposal
 * `3578fe5c294f` after three scope rulings the same day: protect the "For Re-scoping" group, file
 * HIGH-confidence Backlog rows ONLY, and include the 32 already-filed S24/S25 rows in the backfill.
 *
 * The 08-14 numbers below were REPLACED, not relaxed: leaving them would have failed closed on a
 * 43-correction proposal, which is the gate doing its job. A new approval earns new constants; a
 * mismatch against an UNCHANGED approval still means the board moved under you.
 */
const APPROVED = {
  passDate: '2026-08-19',
  // PASS 2, same day: Kane widened the scope to every remaining Done row — "Credit it to the
  // respective Sprints that it was actually completed that means to fill the completed dates as well."
  corrections: 30,
  epicsToCreate: 0,
  tasksToCreate: 0,
  orphans: 0,
  /**
   * TRUE: all 30 rows are already Done and stay Done. The phantom Actual SP clear on "Google Sheet
   * sync crons" was HELD OUT of this pass — it is a re-score, which trips the Actual-SP gate below and
   * needs its own approval rather than a widened gate. See pass.mts.
   */
  everyRowDone: true,
} as const;

const run = (args: string[]) =>
  execFileSync('node', ['--import', 'tsx', ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });

// ── gate 0: the pass must still be internally consistent ─────────────────────────────────────────
const bad = selfcheck();
if (bad.length) {
  console.error(`selfcheck FAILED — refusing to touch the board:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
if (PASS_DATE !== APPROVED.passDate) {
  console.error(
    `pass is dated ${PASS_DATE} but the recorded approval covers ${APPROVED.passDate}. ` +
      `A different pass date means different content — get a fresh approval instead of editing this.`,
  );
  process.exit(1);
}
console.log(`selfcheck PASS · ${ROWS.length} rows · pass ${PASS_DATE} · approval on record`);

// ── gate 1: is there any budget at all? one call, the cheapest on the board ───────────────────────
console.log('\nprobing the budget (1 call)…');
try {
  const groups = await boardGroups(MONDAY_BOARDS.tasks);
  console.log(`  budget OK — read ${groups.length} groups on Sprint Tasks`);
} catch (e) {
  if (e instanceof DailyLimitExceeded) {
    console.error(`\nSTILL EXHAUSTED — nothing was written.\n${e.message}`);
    console.error('\nRe-run this script later. Cost of a failed attempt: ~1 call.');
    process.exit(2);
  }
  throw e;
}

if (!APPLY) {
  console.log('\nBudget is available. Re-run with --apply to review → assert → apply → verify.');
  process.exit(0);
}

// ── gate 2: mint the proposal, then check it is the one that was approved ─────────────────────────
console.log('\nreview.mts — reading the board and minting the proposal…');
const reviewOut = run([`${SCRIPTS}/review.mts`]);
console.log(reviewOut.split('\n').slice(-14).join('\n'));

const stored = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf8')) as {
  hash: string;
  generatedFor: string;
  proposal: {
    passDate: string;
    epicsToCreate: string[];
    tasksToCreate: unknown[];
    corrections: { item: string; to: { status: string; actualSp: string }; changes: string[] }[];
    orphans: unknown[];
  };
};
const p = stored.proposal;
const deviations: string[] = [];

if (p.passDate !== APPROVED.passDate) deviations.push(`passDate ${p.passDate} ≠ approved ${APPROVED.passDate}`);
if (p.epicsToCreate.length !== APPROVED.epicsToCreate) {
  deviations.push(`would create ${p.epicsToCreate.length} epic(s): ${p.epicsToCreate.join(', ')} — not approved`);
}
if (p.tasksToCreate.length !== APPROVED.tasksToCreate) {
  deviations.push(`would create ${p.tasksToCreate.length} task row(s) — not approved (this pass re-files existing rows)`);
}
if (p.corrections.length !== APPROVED.corrections) {
  deviations.push(`${p.corrections.length} corrections, approved ${APPROVED.corrections}`);
}
if (p.orphans.length !== APPROVED.orphans) {
  deviations.push(`${p.orphans.length} orphan row(s) on the board — surface these to Kane, do not sweep them along`);
}
for (const c of p.corrections) {
  if (APPROVED.everyRowDone && c.to.status !== 'Done') {
    deviations.push(`status ${c.to.status} on ${c.item.slice(0, 60)} — a status transition is outside this approval`);
  }
  const statusChange = c.changes.find((ch) => ch.startsWith('Status '));
  if (statusChange) deviations.push(`${statusChange} on ${c.item.slice(0, 55)} — outside this approval`);
  // Filling a BLANK Actual SP is the corrector doing its job; overwriting a different existing value
  // is a re-score, which Kane did not approve.
  const spChange = c.changes.find((ch) => ch.startsWith('Actual SP '));
  if (spChange && !/Actual SP \(blank\) →/.test(spChange)) {
    deviations.push(`${spChange} on ${c.item.slice(0, 50)} — overwrites an existing score, not approved`);
  }
}

if (deviations.length) {
  console.error(
    `\nPROPOSAL DEVIATES FROM THE APPROVED SCOPE — nothing written:\n  ${deviations.join('\n  ')}\n\n` +
      `Kane's "Approve all" covered a reviewed proposal, not whatever the board holds now. ` +
      `Show him ${PROPOSAL_PATH} and get approval for the new hash ${stored.hash}.`,
  );
  process.exit(3);
}
const spFills = p.corrections.filter((c) => c.changes.some((ch) => ch.startsWith('Actual SP '))).length;
const dateWrites = p.corrections.filter((c) => c.changes.some((ch) => ch.startsWith('Completed Date '))).length;
console.log(
  `\nproposal MATCHES the approved scope — hash ${stored.hash}\n` +
    `  ${p.corrections.length} corrections · ${dateWrites} Completed Dates written · ${spFills} blank Actual SP filled\n` +
    `  0 rows created · 0 status transitions · 0 orphans`,
);

// ── gate 3: apply, then verify by re-reading ──────────────────────────────────────────────────────
console.log('\napply.mts --apply — FULL path (structure changed, so --only-new would be wrong)…');
console.log(run([`${SCRIPTS}/apply.mts`, '--apply', '--approve', stored.hash]));

console.log('\nverify.mts — re-reading the board (never trust the write log)…');
console.log(run([`${SCRIPTS}/verify.mts`]));

console.log('\nDONE. Update docs/features/monday-board-sync.md and the monday-hris-board-sync memory.');
