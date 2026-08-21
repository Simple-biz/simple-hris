/**
 * The pending-SP ledger — what to do when the Monday budget dies mid-pass.
 *
 * WHY THIS EXISTS. The account's API budget is a UTC-day bucket, and a full pass
 * (~200 calls) can exhaust it. Measured 2026-08-20: `apply.mts` finished its
 * writes and `verify.mts` then died instantly on DAILY_LIMIT_EXCEEDED. That was
 * the lucky ordering. The unlucky one is the budget dying *between* corrections,
 * which silently drops the tail of the pass — the rows never get written, the run
 * looks like it ended, and the SP is simply lost until someone re-derives the
 * whole pass from git.
 *
 * So: unwritten corrections are PERSISTED instead of lost, and flushed later on
 * Kane's word.
 *
 * ── The invariant that makes a deferred write safe ──────────────────────────────
 *
 * A queued entry carries the approval hash it was born under. Flushing an entry
 * with a hash COMPLETES AN ALREADY-APPROVED WRITE that the budget interrupted —
 * it does not invent a new one. That is the whole reason a one-command flush is
 * legitimate rather than a way around the approval gate.
 *
 * An entry with NO hash (queued from work that never got as far as a proposal) is
 * held back at flush time and reported, never written. `flush-pending.mts` refuses
 * it and points at `review.mts`.
 *
 * ── What a delay can invalidate, and is therefore re-checked at flush ──────────
 *
 * `apply.mts` refuses a proposal minted for a different pass date, and that gate
 * is CORRECT and stays. A flush does not bypass it — it re-verifies from scratch:
 *
 *   1. the plan still declares the row, byte-exact (a rename orphans it)
 *   2. the plan's SP still matches what was queued (a re-score makes it stale)
 *   3. Fibonacci, and the 8-SP task cap
 *   4. Done still means: a Completed Date, and zero open blockers
 *   5. the Completed Date STILL equals the last sha's commit date — git is asked
 *      again, so a rebase or amend between queue and flush fails the row rather
 *      than writing a date that no longer matches history
 *   6. every sha still resolves AND is still an ancestor of origin/main
 *
 * Point 5 is the one that matters most. A Completed Date is a claim about when
 * work became provable; a queued date that no longer matches its commit is
 * exactly the "flattering guess" selfcheck exists to refuse, and time is what
 * makes it possible.
 *
 * NOTE the Completed Date is NEVER moved to the flush day. The work finished when
 * it finished; the flush is just when the board caught up. The delay is recorded
 * in the evidence update instead, so the trail shows it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL_DIR, REPO_ROOT, PLAN_TASKS } from './monday.mts';
import type { PassRow } from './pass.mts';

export const PENDING_PATH = path.join(SKILL_DIR, 'pending-sp.json');

/** Kept in git, unlike proposal.json — this is a durable claim about unwritten
 *  work, not per-run scratch. A lost ledger is lost SP; and the shared checkout
 *  means another session must be able to see what is owed. */
export interface PendingEntry {
  /** When it was queued (ISO). The flush reports the delay from this. */
  queuedAt: string;
  /** The pass date it was approved under. */
  passDate: string;
  /** Approval hash it was born under. NULL = never approved ⇒ flush REFUSES it. */
  approvalHash: string | null;
  inputsHash: string | null;
  /** Why it could not be written, e.g. `DAILY_LIMIT_EXCEEDED`. */
  reason: string;
  /** The correction itself, exactly as the corrector would have written it. */
  row: PassRow;
  /** plan.sp at queue time. A later re-score must invalidate the entry. */
  planSp: number;
  flushedAt?: string | null;
  flushNote?: string | null;
}

export interface PendingLedger {
  version: 1;
  entries: PendingEntry[];
}

const EMPTY: PendingLedger = { version: 1, entries: [] };

export function loadPending(): PendingLedger {
  if (!fs.existsSync(PENDING_PATH)) return { ...EMPTY, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')) as PendingLedger;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('unrecognised pending-sp.json shape');
    }
    return parsed;
  } catch (e) {
    // Never silently start a fresh ledger — that would drop owed SP on the floor.
    throw new Error(`pending-sp.json is unreadable, refusing to overwrite it: ${String(e)}`);
  }
}

export function savePending(ledger: PendingLedger): void {
  fs.writeFileSync(PENDING_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export const unflushed = (l: PendingLedger) => l.entries.filter((e) => !e.flushedAt);

/**
 * Queue rows that could not be written. Supersedes an existing UNFLUSHED entry
 * for the same row (a later status is the truer one) but never rewrites a flushed
 * entry — that is history.
 */
export function queuePendingRows(
  rows: PassRow[],
  meta: { passDate: string; approvalHash: string | null; inputsHash: string | null; reason: string; now: string },
): { queued: number; superseded: number } {
  const ledger = loadPending();
  let superseded = 0;

  for (const row of rows) {
    const planSp = PLAN_TASKS.find((t) => t.name === row.name)?.sp ?? -1;
    const existing = ledger.entries.findIndex((e) => !e.flushedAt && e.row.name === row.name);
    const entry: PendingEntry = {
      queuedAt: meta.now,
      passDate: meta.passDate,
      approvalHash: meta.approvalHash,
      inputsHash: meta.inputsHash,
      reason: meta.reason,
      row,
      planSp,
      flushedAt: null,
      flushNote: null,
    };
    if (existing >= 0) {
      ledger.entries[existing] = entry;
      superseded += 1;
    } else {
      ledger.entries.push(entry);
    }
  }

  savePending(ledger);
  return { queued: rows.length, superseded };
}

export function markFlushed(name: string, note: string, now: string): void {
  const ledger = loadPending();
  const e = ledger.entries.find((x) => !x.flushedAt && x.row.name === name);
  if (!e) return;
  e.flushedAt = now;
  e.flushNote = note;
  savePending(ledger);
}

/** Commit date of a sha, `YYYY-MM-DD`. Throws when git cannot resolve it. */
function shaDate(sha: string): string {
  return execFileSync('git', ['log', '-1', '--date=short', '--format=%ad', sha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

function isAncestorOfOriginMain(sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const FIB = new Set([1, 2, 3, 5, 8]);

/**
 * Re-verify one queued entry against the CURRENT repo and plan. Returns the
 * reasons it must not be written; empty means it is still true.
 */
export function revalidate(entry: PendingEntry): string[] {
  const bad: string[] = [];
  const { row } = entry;

  if (!entry.approvalHash) {
    bad.push('never approved — queued without an approval hash; run review.mts and get it approved');
  }

  const plan = PLAN_TASKS.find((t) => t.name === row.name);
  if (!plan) {
    bad.push(`plan no longer declares this row byte-exact (renamed? deleted?): ${row.name.slice(0, 60)}`);
    return bad; // nothing below is meaningful without a plan entry
  }
  if (plan.sp !== entry.planSp) {
    bad.push(`re-scored since queueing (queued ${entry.planSp} SP, plan now says ${plan.sp}) — the queued score is stale`);
  }
  if (!FIB.has(plan.sp)) bad.push(`non-Fibonacci ${plan.sp} SP`);
  if (plan.sp > 8) bad.push(`over the 8-SP task cap (${plan.sp}) — that is an epic`);

  if (row.status === 'Done') {
    if (!row.completed) bad.push('Done with no Completed Date');
    if (row.blockers?.length) bad.push(`Done while carrying ${row.blockers.length} open blocker(s)`);
    if (!plan.done) bad.push('pass says Done but the plan says done:false — the two must agree');
  }

  for (const sha of row.shas) {
    let resolved: string;
    try {
      resolved = shaDate(sha);
    } catch {
      bad.push(`git can no longer resolve sha ${sha} — unverifiable is a failure, not a pass`);
      continue;
    }
    if (!isAncestorOfOriginMain(sha)) {
      bad.push(`${sha} is no longer an ancestor of origin/main — it cannot have deployed`);
    }
    // Only the LAST sha dates the row.
    if (sha === row.shas[row.shas.length - 1] && row.status === 'Done' && row.dateBasis !== 'external') {
      if (row.completed && row.completed !== resolved) {
        bad.push(
          `Completed Date ${row.completed} no longer matches the last sha's commit date ${resolved} ` +
            `(rebase or amend since queueing?) — refusing to write a date that contradicts history`,
        );
      }
    }
  }

  return bad;
}

/** Whole days between queueing and now, for the evidence update. */
export function delayDays(queuedAt: string, now: string): number {
  const a = Date.parse(queuedAt);
  const b = Date.parse(now);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * The line appended to a flushed row's evidence update. The delay is recorded
 * rather than hidden: anyone reading the row later can see the board caught up
 * after the fact, and that the Completed Date is the work's date, not the
 * flush's.
 */
export function flushFootnote(entry: PendingEntry, now: string): string {
  const days = delayDays(entry.queuedAt, now);
  const when = days === 0 ? 'the same day' : days === 1 ? '1 day later' : `${days} days later`;
  return [
    '',
    `_Queued ${entry.queuedAt.slice(0, 10)} because ${entry.reason}, written ${when} on Kane's push.`,
    `Approved as ${entry.approvalHash} for pass ${entry.passDate}; re-verified against git at flush time.`,
    'The Completed Date is when the work became provable, NOT when the board caught up._',
  ].join('\n');
}
