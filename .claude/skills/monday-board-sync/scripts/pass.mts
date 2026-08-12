/**
 * PER-PASS DATA FILE — rewrite this for each sync, then `review.mts`, then `apply.mts`.
 *
 * This file holds only what `hris-plan.ts` cannot express: **execution state**. The plan file owns
 * whether a row exists and its structure; a row's Status beyond Done/Ready to Start, its Completed
 * Date, and the evidence update all live here.
 *
 * `selfcheck()` is the guard rail. It refuses a non-Fibonacci score, a task over the 8-SP cap, an
 * angle bracket in a name, a name that is not in PLAN_TASKS byte-exact, a Completed Date on a row
 * that is not Done, and a Done row with no stated basis. Never bypass it.
 *
 * ── 2026-08-12 pass ──────────────────────────────────────────────────────────────────────────────
 * Audited 0cda107..3d74e09 (Aug 12 2026, 3 commits) clustered by file overlap. ONE row.
 *
 * Nothing here is Done, and no confirmation could make it so: `git merge-base --is-ancestor` fails
 * for every sha because local main is 7 commits ahead of origin/main. Unpushed is In Progress —
 * Vercel deploys origin/main, so code that never left this machine cannot be live.
 *
 * The third commit in the range (e96e499, dispatch auto-seed + Stop download review findings) is a
 * SEPARATE cluster by file overlap — zero file overlap with the onboarding work — and is deliberately
 * NOT logged here. Kane asked for the onboarding change; inventing a second row he did not ask for
 * would be exactly the silent scope-widening this skill's review step exists to prevent.
 */
import { PLAN_TASKS } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-12';
export const AUDIT_RANGE = '0cda107..3d74e09';
export const AUDIT_COMMITS = 3;
export const GITHUB_COMMIT = 'https://github.com/Simple-biz/simple-hris/commit/';

export interface PassRow {
  /** Must match a PLAN_TASKS entry's `name` byte-exact — selfcheck enforces it. */
  name: string;
  status: TaskStatus;
  /** Written ONLY when status is Done. A date on an unshipped row is an invented record. */
  completed?: string;
  shas: string[];
  /** Why this status and not a higher one. Goes onto the board as the item update. */
  basis: string;
  /** Named external steps still open. Must be empty when status is Done. */
  blockers?: string[];
}

export const ROWS: PassRow[] = [
  // ── In Progress · Sprint 26 · unpushed, so it cannot be higher than this ───────────────────────
  {
    name: 'Onboarding paperwork: Middle name box + one-time first/last name-order check',
    status: 'In Progress',
    shas: ['9b9fd40', '3d74e09'],
    basis:
      'Committed to local main only — NOT an ancestor of origin/main (local main is 7 ahead), so ' +
      'Vercel has not deployed it and no hire or HR user can reach it yet. In Progress is the ' +
      'ceiling until it is pushed; it would then be Pending Deploy, not Done, because the ' +
      'middle_name column does not exist in production. That was MEASURED on 2026-08-12, not ' +
      'assumed: both hr_onboarding_submissions.middle_name and hr_pending_employees.middle_name ' +
      'both returned a column-does-not-exist error. Until the migration runs, a hire typing one has ' +
      'it silently stripped by the optional-column retry — the form still saves, the middle name ' +
      'does not. Scope: a Middle name box on the Welcome step stored for HR records only (never ' +
      'composed into full_name, because the display trigger takes the last given token as the go-by ' +
      'and would rename Jane Marie Santos to Santos, Jane Marie “Marie” everywhere the Payroll ' +
      'Wizard prints her), plus a one-time non-blocking dialog on the way out of that step asking ' +
      'the hire to check they have not swapped first and last name. Doc: ' +
      'docs/features/onboarding-name-parts.md.',
    blockers: [
      'not pushed — 9b9fd40 and 3d74e09 are not ancestors of origin/main, so nothing is deployed',
      'references/sql/alter/add_middle_name_to_onboarding.sql not applied (measured absent in prod 2026-08-12); needs DATABASE_URL in .env.local, which is currently unset, then node scripts/apply-middle-name-columns.mjs',
      'nobody has clicked through it in production',
    ],
  },
];

const FIB = new Set([1, 2, 3, 5, 8]);

export function selfcheck(): string[] {
  const bad: string[] = [];
  const planByName = new Map(PLAN_TASKS.map((t) => [t.name, t]));
  const seen = new Set<string>();

  for (const row of ROWS) {
    if (seen.has(row.name)) bad.push(`duplicate pass row: ${row.name.slice(0, 60)}`);
    seen.add(row.name);

    if (/[<>]/.test(row.name)) {
      bad.push(`angle brackets in name (Monday strips tags on create): ${row.name.slice(0, 60)}`);
    }

    const plan = planByName.get(row.name);
    if (!plan) {
      // The reconciler matches by exact name, so a near-miss here becomes a permanent duplicate row.
      bad.push(`no PLAN_TASKS entry matches byte-exact — would target the wrong row or none: ${row.name.slice(0, 70)}`);
      continue;
    }
    if (!FIB.has(plan.sp)) bad.push(`non-Fibonacci ${plan.sp} SP: ${row.name.slice(0, 55)}`);
    if (plan.sp > 8) bad.push(`over the 8-SP cap (${plan.sp}) — that is an epic, not a task: ${row.name.slice(0, 55)}`);

    if (row.status === 'Done') {
      if (!row.completed) bad.push(`Done with no Completed Date: ${row.name.slice(0, 55)}`);
      if (row.blockers?.length) {
        bad.push(`Done while carrying ${row.blockers.length} open blocker(s): ${row.name.slice(0, 55)}`);
      }
      if (!plan.done) {
        bad.push(`pass says Done but PLAN_TASKS has done:false, so creation would write Ready to Start and no Actual SP: ${row.name.slice(0, 55)}`);
      }
    } else {
      if (row.completed) {
        bad.push(`Completed Date on a ${row.status} row is an invented record: ${row.name.slice(0, 55)}`);
      }
      if (plan.done) {
        bad.push(`pass says ${row.status} but PLAN_TASKS has done:true, which would write Done + an Actual SP on create: ${row.name.slice(0, 55)}`);
      }
    }
    if (!row.basis.trim()) bad.push(`no stated basis: ${row.name.slice(0, 55)}`);
    if (!row.shas.length) bad.push(`no commit evidence: ${row.name.slice(0, 55)}`);
  }
  return bad;
}

/** The board update body for a row — the audit trail that lets anyone reconstruct the claim later. */
export function updateBody(row: PassRow): string {
  const lines = [
    `**${row.status}** — board sync pass ${PASS_DATE} (audit range ${AUDIT_RANGE}, ${AUDIT_COMMITS} commits).`,
    '',
    row.basis,
    '',
    `Evidence: ${row.shas.join(', ')}`,
    `Latest: ${GITHUB_COMMIT}${row.shas[row.shas.length - 1]}`,
  ];
  if (row.completed) lines.push(`Completed Date: ${row.completed}`);
  if (row.blockers?.length) {
    lines.push('', 'Open before this can be Done:', ...row.blockers.map((b) => `- ${b}`));
  }
  return lines.join('\n');
}

if (import.meta.filename === process.argv[1]) {
  const bad = selfcheck();
  const done = ROWS.filter((r) => r.status === 'Done');
  console.log(`pass ${PASS_DATE}: ${ROWS.length} rows — ${done.length} Done, ${ROWS.length - done.length} not`);
  console.log('SELFCHECK: ' + (bad.length ? `FAIL\n  ${bad.join('\n  ')}` : 'PASS'));
  if (bad.length) process.exit(1);
}
