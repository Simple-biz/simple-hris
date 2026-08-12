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
 * ── 2026-08-12 pass, EIGHTH — the external step itself becomes a row ──────────────────────────────
 * Kane approved adding ONE row: the live n8n import of paystub-dispatch.workflow.json. This is the
 * unusual case where the work being tracked is not a commit at all — it is an action in an external
 * system — so the evidence cited is the commit that PRODUCED the artefact to import, not a commit
 * that implements the row.
 *
 * Status is Ready to Start, and that is deliberately NOT Pending Deploy. Pending Deploy means code
 * is complete and waiting on an external step; here the row IS the external step and nobody has
 * begun it. Getting this wrong in the other direction would be worse: three other rows are already
 * correctly Pending Deploy BECAUSE of this one, and if this row also read Pending Deploy the board
 * would show four rows waiting on each other with nothing identifying the actual next action.
 *
 * Why it earns its own row rather than the HRIS-15 catch-all: see the rationale comment in
 * hris-plan.ts beside the entry. Short version — that chore sits in S25, its premise is largely
 * folklore, and nobody would mark it Done for importing one specific workflow.
 *
 * NOTE ON STALENESS, checked rather than assumed: the JSON is dated 2026-08-06 (02dc5aa) while the
 * statement changed three times after it (0a731ed, c97d0b5, e0028b8). It is still current anyway,
 * and that is the entire point of the redesign — the Gmail node is now `{{ $json.paystub_html }}`,
 * a dumb pipe, so statement changes no longer touch the workflow. A pre-02dc5aa workflow is what
 * renders its own stale HTML.
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
export const AUDIT_RANGE = '02dc5aa..e0028b8';
export const AUDIT_COMMITS = 67;
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
  // ── Ready to Start · Sprint 26 · the external step, tracked as work ───────────────────────────
  {
    name: 'Import paystub-dispatch.workflow.json into live n8n so emailed statements match the app',
    status: 'Ready to Start',
    shas: ['02dc5aa', '0a731ed', 'c97d0b5', 'e0028b8'],
    basis:
      'READY TO START 2026-08-12 — this row tracks an action in an EXTERNAL system, not a commit. ' +
      'The artefact to import is references/n8n/paystub-dispatch.workflow.json, produced by ' +
      '02dc5aa (2026-08-06), which moved the emailed pay statement into the app ' +
      '(src/lib/payroll/paystub-email-html.ts) and reduced the n8n Gmail node to a pipe: ' +
      'subject = {{ $json.paystub_subject }}, message = {{ $json.paystub_html }}. The pay_vars Set ' +
      'node and the entire HTML template are deleted from it, which is why the correct file is the ' +
      'SMALLEST of the three paystub JSONs in references/n8n (13.8 KB, vs 1,090 KB for the old ' +
      '"Paystub Automation.json" that still carries the template inline, and 21 KB for ' +
      'n8n_paystub_dispatch.json from Jul 13). Importing either of the other two re-creates the ' +
      'exact regression this replaced. ' +
      'NOT Pending Deploy: that status means code is complete and waiting on an external step. Here ' +
      'the row IS the external step and it has not been begun. Three rows are already Pending ' +
      'Deploy because of this one — the column-AN rule (8 SP), the merged Weekend Hours line ' +
      '(5 SP) and paystub email rendered in-app (8 SP) — so 21 SP unblocks the moment it lands. ' +
      'WHY IT IS NOW URGENT rather than housekeeping: e0028b8 changed what the payload legs MEAN. ' +
      'pay_php.regular is now base + weekend (angelicaco 2026-08-02 week: PHP 10,321.80) and ' +
      'pay_php.ot is the derived 0.5x differential only (PHP 393.63), not hours x a stored OT rate. ' +
      'A renderer still assuming the old meanings prints line items that do not reconcile — a ' +
      '"Regular 40.00h x PHP 235" label above PHP 10,321.80, and an Overtime line whose implied ' +
      'rate is PHP 117.50 rather than PHP 352.50. The totals stay correct, so this is silent. At ' +
      'least one HSL statement has already been sent in that state (that queue row stamped sent_at ' +
      '2026-08-12 00:26 after Kane re-locked the cycle), which is the same "one breakdown in the ' +
      'app, a different one in the inbox" failure the in-app renderer was built to end. ' +
      'STALENESS CHECKED, NOT ASSUMED: the JSON predates three later statement commits (0a731ed, ' +
      'c97d0b5, e0028b8) and is still current, because the pipe design means statement changes no ' +
      'longer touch the workflow. ' +
      'DONE REQUIRES more than uploading the file: confirm the Gmail node bindings above, confirm ' +
      'the response still returns succeeded / failed / failed_emails by those exact names (the HRIS ' +
      'parses all three), and do not hand-edit the summary node\'s two guards back out — the ' +
      '.isExecuted guard on cross-node references, and skipped items counting into failed. Both ' +
      'were live bugs. Doc: docs/features/paystub-dispatch.md lines 578-611.',
    blockers: [
      'Kane imports references/n8n/paystub-dispatch.workflow.json into the live n8n instance (not the two older lookalikes)',
      'Verify Gmail node: subject = {{ $json.paystub_subject }}, message = {{ $json.paystub_html }}',
      'Verify the summary response still returns succeeded / failed / failed_emails by those exact names',
      'One test send confirming the emailed breakdown matches the in-app Pay Stub modal',
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
