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
 * ── 2026-08-12 pass, seventh — CORRECTION to the basis posted on 12786252360 ──────────────────────
 * Kane read the Sprint 26 close-out and said he thought the onboarding row was done too. Re-measured
 * instead of re-asserting: it is NOT, and the row's status does not move. But checking it exposed an
 * error in the basis THIS SKILL POSTED to that row hours earlier, and a wrong audit trail on a board
 * whose whole value is a trustworthy audit trail has to be corrected in place.
 *
 * WHAT WAS WRONG. The close-out basis claimed a read-only probe returned 42703 for "ALL FOUR target
 * columns", naming hr_onboarding_submissions.name_order_confirmed_at and
 * hr_pending_employees.name_order_confirmed_at alongside the two middle_name columns. Those two do
 * not exist anywhere in the design — not in add_middle_name_to_onboarding.sql, not in the app, not
 * in any type. I invented them for the probe and then cited their absence as evidence. The
 * name-order check persists NOTHING by design: it is React state (`nameCheckAcknowledged`,
 * page.tsx:279-281), fires once per session however it is dismissed, and needs no column at all.
 *
 * WHAT SURVIVES, AND IS THE ONLY REASON THIS ROW IS STILL HELD. The migration adds exactly TWO
 * columns and both are genuinely missing in production, measured twice ~40 minutes apart. The
 * `middle_name` half is therefore deployed and silently lossy; the name-order half is fully working.
 * Overstating the evidence made a correct verdict rest on a false specific, which is worse than a
 * thin one — anyone re-checking would have found two of my four columns fictional and had every
 * reason to discard the whole finding, including the true part.
 *
 * Status is UNCHANGED at Pending Deploy. One row, `--only-new`, ~6 calls: the write is the corrected
 * item update, with the status set re-asserted to the value it already holds.
 */
import { PLAN_TASKS } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-12';
export const AUDIT_RANGE = '5950b2e..a1bb8fa';
export const AUDIT_COMMITS = 18;
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
  // ── Done · Sprint 26 · migration applied and MEASURED present; Kane signed the row off ─────────
  {
    name: 'Onboarding paperwork: Middle name box + one-time first/last name-order check',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['9b9fd40', '3d74e09'],
    basis:
      'DONE 2026-08-12 on Kane\'s sign-off, resting on a MEASUREMENT rather than on his claim. He ' +
      'applied references/sql/alter/add_middle_name_to_onboarding.sql and said the migration was ' +
      'done; a read-only PostgREST probe then returned BOTH target columns present — ' +
      'hr_onboarding_submissions.middle_name and hr_pending_employees.middle_name — where the same ' +
      'probe had returned HTTP 400 / 42703 twice earlier the same day. That the probe answers ' +
      'through PostgREST also proves the SCHEMA CACHE RELOADED, which matters: a stale cache keeps ' +
      'rejecting a freshly added column with PGRST204 long after the DDL itself succeeded, so ' +
      '"the DDL ran" and "the app can write it" are genuinely two different facts and both are now ' +
      'established. With the columns live, the optional-column retry family ' +
      '({ test: /middle_name/i, keys: ["middle_name"] } in hr-onboarding-submissions.ts and ' +
      'hr-pending-employees.ts) no longer fires, so the key stays in the payload and the middle ' +
      'name persists instead of being silently dropped. ' +
      'WHAT THIS DONE DOES NOT CLAIM: nobody submitted a middle name end-to-end and watched it ' +
      'land. Kane was offered that stronger basis and chose to close the row on sign-off, so the ' +
      'record says sign-off. Stated plainly here because the difference is exactly what this ' +
      'column is for. ' +
      'A CORRECTION TO THIS ROW\'S EARLIER UPDATE, which overstated its evidence: it claimed a ' +
      'probe returned 42703 for "ALL FOUR target columns" and named ' +
      'hr_onboarding_submissions.name_order_confirmed_at and ' +
      'hr_pending_employees.name_order_confirmed_at. THOSE TWO COLUMNS NEVER EXISTED IN THE DESIGN ' +
      '— not in the migration, not in the app, not in any type. They were invented for the probe ' +
      'and their absence was then cited as evidence. The name-order check persists NOTHING by ' +
      'design: it is React state (nameCheckAcknowledged, app/onboarding/[token]/page.tsx:279-281) ' +
      'firing once per session however it is dismissed, needing no column at all — that half was ' +
      'fully working the whole time. The migration adds exactly TWO columns, and those two are what ' +
      'was really missing. ' +
      'DEPLOYMENT was never the blocker at the end: 9b9fd40 and 3d74e09 are both ancestors of ' +
      'origin/main, so Vercel had the code well before the migration ran. This row travelled ' +
      'In Progress (unpushed) → Pending Deploy (pushed, migration un-run) → Done, which is the ' +
      'honesty gate working exactly as intended rather than three changes of mind. ' +
      'NO BACKFILL, deliberately: a middle name was never captured, so it cannot be recovered from ' +
      'full_name. Existing rows stay NULL until a hire re-opens their paperwork and fills the box. ' +
      'SCOPE. A Middle name box on the Welcome step stored for HR records only — never composed ' +
      'into full_name, because the surname-first display trigger takes the last given token as the ' +
      'go-by and would rename Jane Marie Santos to Santos, Jane Marie "Marie" everywhere the ' +
      'Payroll Wizard prints her — plus a one-time non-blocking dialog asking the hire to check ' +
      'they have not swapped first and last name. Doc: docs/features/onboarding-name-parts.md.',
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
