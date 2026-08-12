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
 * It was created Ready to Start and moved to DONE the same day, when Kane confirmed the new workflow
 * is live. Ready to Start — never Pending Deploy — was correct at creation: Pending Deploy means code
 * is complete and waiting on an external step, and here the row WAS the external step. Had it read
 * Pending Deploy the board would have shown four rows waiting on each other with nothing naming the
 * actual next action. Same-day Ready to Start → Done is the gate working, not a change of mind.
 *
 * The Done is recorded as SIGN-OFF and says so, because no test send has been made yet. The first
 * dispatch through the new workflow is the real proof, and it is cheap to check without opening n8n:
 * the new summary node returns a `skipped` field and the old one does not.
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

const N8N_LIVE =
  'THE WORKFLOW IS LIVE. Kane deployed across all three systems 2026-08-12 ("Pushed - and deployed ' +
  'on vercel github and n8n") and showed the n8n Executions tab: workflow Paystub Automation, ' +
  'Published, runs succeeding in ~1.1s. The node chain in that screenshot goes Normalize Email → ' +
  'Throttle (600ms) → Send PayStub with NO pay_vars node between them, which is the single ' +
  'clearest tell that the new pipe workflow replaced the old template-carrying one. ' +
  'MEASURED INDEPENDENTLY, read-only against production the same evening: local and origin/main ' +
  'both at 83042ff (0 ahead, 0 behind) so the deploy has the code; 40 paystub rows stamped sent_at ' +
  'after 17:00Z including 32 HSL, the latest at 22:57; 30 of those HSL payloads carry the ' +
  'hogan_sheet block; and ZERO rows across all 40 carry a last_error. A skipped item would have ' +
  'landed "Skipped — ..." in last_error, so nothing was skipped and nothing failed. ';

const N8N_LIMIT =
  'WHAT IS STILL NOT PROVEN, stated because it is the honest edge of this evidence: no email BODY ' +
  'was opened and compared against the in-app Pay Stub modal. Zero-errors does not by itself ' +
  'discriminate old workflow from new — the old one also returns clean summaries, it just renders ' +
  'its own stale HTML. The discriminating field is `skipped`, which the new summary node returns ' +
  'and the old one does not, but the HRIS does not persist it. So the workflow identity rests on ' +
  'Kane\'s deployment confirmation plus the screenshot; everything else above is measured. ';

export const ROWS: PassRow[] = [
  // ── Done · Sprint 26 · the sheet-form pay rule, measured end to end ───────────────────────────
  {
    name: 'HSL pay = the Hogan sheet column AN verbatim — hogan-week-pay becomes the single rate authority, reversing the 2026-08-07 weekend-OT removal',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['e0028b8'],
    basis:
      'DONE 2026-08-12. This row has the strongest evidence of the three: it rests on a ' +
      'MEASUREMENT, not a sign-off. ' +
      'Kane unlocked and re-locked the 2026-08-02..08 cycle, and a read-only replay of the staged ' +
      'payload for angelicaco@simple.biz reproduces the sheet exactly: hogan_sheet legs ' +
      'base 8,079.30 (34.38h x 235) + weekend 2,242.50 (8.97h x 250) + ot_differential 393.63 ' +
      '(3.35h x 117.50) = 10,715.43, which reconciles to pay_php.initial to the centavo, and ' +
      'amount_php 16,115.43 — the figure Kane specified before any code was written. Rates on the ' +
      'block are 235 / 250 / 117.50, so the OT leg is the derived 0.5x differential rather than a ' +
      'stored OT rate. ' +
      'AT SCALE, not just one person: 30 HSL payloads sent after 17:00Z on 2026-08-12 carry the ' +
      'hogan_sheet block, with zero last_error across all 40 sends in that window. ' +
      'THE RULE, for anyone reading this later: M-F hours always pay at the regular rate and never ' +
      're-rate; ALL Sat/Sun hours earn regular + 15, past-cap hours included; the only overtime ' +
      'money is max(0, total - 40) x 0.5 x regular. This REVERSED 5eb398a, which had scoped the ' +
      'premium to within-cap weekend hours only and left HRIS disagreeing with the sheet by ' +
      'PHP 15 per weekend-OT hour. Deployed: e0028b8 is an ancestor of origin/main (83042ff). ' +
      'Doc: docs/features/hsl-sheet-form-pay-rule is summarised in the memory of the same name.',
  },
  // ── Done · Sprint 26 · the merged Weekend Hours line, now visible in email too ────────────────
  {
    name: 'One merged Weekend Hours line + dated rate-change disclosure on statement, email and export',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['0a731ed', 'c97d0b5'],
    basis:
      'DONE 2026-08-12. The in-app half shipped 2026-08-07 and was never in doubt; what held this ' +
      'row was the EMAIL half, which could not be true while live n8n rendered its own HTML. ' +
      N8N_LIVE +
      'WHY THE EMAIL HALF MATTERED HERE SPECIFICALLY: the old template had no weekend row at all, ' +
      'so an HSL employee saw a merged Weekend Hours line in the app and nothing corresponding in ' +
      'the inbox — one breakdown in two places, which is the exact defect this row exists to close. ' +
      'On angelicaco\'s 2026-08-02..08 statement the missing line was PHP 2,242.50. ' +
      'SCOPE: one merged Weekend Hours row carrying both pay buckets with a per-rate basis ' +
      '(0a731ed), plus the dated rate-change disclosure that chips a weekend paid on the old side ' +
      'of a rate change (c97d0b5) — the case where a whole weekend sits on one side of the change ' +
      'so no bucket spans it and nothing used to signal the difference. ' +
      N8N_LIMIT,
  },
  // ── Done · Sprint 26 · the pipe itself + the snapshot columns ─────────────────────────────────
  {
    name: 'Paystub email HTML rendered in-app (n8n Gmail becomes a pipe) + System Bonus snapshot columns on payment_dispatches',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['02dc5aa'],
    basis:
      'DONE 2026-08-12. Two deliverables, both now satisfied. ' +
      'ONE — the emailed statement is rendered by the HRIS (src/lib/payroll/paystub-email-html.ts) ' +
      'and posted as paystub_html, with the n8n Gmail node reduced to ' +
      'subject = {{ $json.paystub_subject }} / message = {{ $json.paystub_html }}. ' + N8N_LIVE +
      'TWO — the System Bonus snapshot columns exist on payment_dispatches, VERIFIED by direct ' +
      'read: rows return system_bonus_php and system_bonus_label, so the DDL is applied in ' +
      'production rather than merely written. ' +
      'WHY THIS ROW EXISTED AT ALL: the statement HTML used to live inside the n8n Gmail node ' +
      'against a flat pay_vars Set node, so every statement change needed a hand-edit in live n8n. ' +
      'Twice it never happened, and employees read one breakdown in their Pay Stubs tab and a ' +
      'different one in their inbox for the same payment. Moving the render into the app makes ' +
      'that class of drift structurally impossible — statement changes no longer touch the ' +
      'workflow, which is also why the 2026-08-06 JSON was still current three statement commits ' +
      'later. ' + N8N_LIMIT,
  },
  // ── Done · Sprint 26 · Kane confirmed the new workflow is live ────────────────────────────────
  {
    name: 'Import paystub-dispatch.workflow.json into live n8n so emailed statements match the app',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['02dc5aa', '0a731ed', 'c97d0b5', 'e0028b8'],
    basis:
      'DONE 2026-08-12 on Kane\'s confirmation that the new workflow is live ("its now live"). ' +
      'Recorded as sign-off, which is what the evidence actually is. ' +
      'WHAT THIS DONE DOES NOT CLAIM: no test send was made comparing an emailed statement against ' +
      'the in-app Pay Stub modal, and no dispatch has run through the new workflow yet, so nobody ' +
      'has watched a correct breakdown arrive in an inbox. The next real send is the first proof. ' +
      'A cheap independent check exists once one runs: the NEW summary node returns a `skipped` ' +
      'field and the old one does not, so the first response the HRIS records after this settles ' +
      'which workflow served it, without anyone having to open n8n. ' +
      'HOW THE OLD ONE WAS IDENTIFIED, since it nearly passed as the new: Kane pasted the live ' +
      'export and it still carried the pay_vars1 Set node, a Gmail message beginning with a raw ' +
      'DOCTYPE and a full HTML document instead of {{ $json.paystub_html }}, five If1 conditions ' +
      'instead of six ' +
      '(no paystub_html guard), and an unguarded $items(\'Send PayStub1\') in the summary. Any one ' +
      'of those is conclusive; searching a workflow for "pay_vars" is the three-second version. ' +
      'The likely reason a first import appeared to do nothing: n8n IMPORTS AS A NEW WORKFLOW ' +
      'rather than replacing, and the old one stays Active holding the /confirm-dispatch ' +
      'production path, so it keeps answering while the new one sits idle. Deactivating the old ' +
      'before activating the new is part of this work, not a footnote. ' +
      'WHAT IT FIXES, measured on a real statement: angelicaco\'s Aug 2-8 stub sent 2026-08-12 ' +
      '00:26 through the OLD template, which labels lines from hours x rates_php while taking ' +
      'amounts from pay_php. After e0028b8 those legs mean different things — pay_php.regular is ' +
      'base + weekend and pay_php.ot is the 0.5x differential only — so her email read ' +
      '"Regular 40.00h x PHP 235.00" above PHP 10,321.80 (the label implies 9,400) and ' +
      '"Overtime 3.35h x PHP 352.50" above PHP 393.63 (the label implies 1,181.25), with no ' +
      'Weekend line for the PHP 2,242.50 at all. The TOTAL was correct at PHP 16,115.43 and she ' +
      'was paid correctly; the Overtime line was the hazard, reading as though PHP 787.62 were ' +
      'missing when those hours were already paid in full inside the base leg. ' +
      'UNBLOCKS three rows worth 21 SP that named this import as their blocker: the column-AN rule ' +
      '(8), the merged Weekend Hours line (5), and paystub email rendered in-app (8). Their status ' +
      'is NOT moved by this pass — Kane confirmed the import, not those three, and each is asked ' +
      'about separately rather than swept along. ' +
      'ORIGINAL SCOPE: the artefact is references/n8n/paystub-dispatch.workflow.json, produced ' +
      'by 02dc5aa (2026-08-06), which moved the emailed statement into the app ' +
      '(src/lib/payroll/paystub-email-html.ts) and reduced the Gmail node to a pipe. It is the ' +
      'SMALLEST of the three paystub JSONs in references/n8n at 13.8 KB — the 1,090 KB ' +
      '"Paystub Automation.json" still carries the template inline and the 21 KB ' +
      'n8n_paystub_dispatch.json is from Jul 13; importing either re-creates this exact bug. ' +
      'Staleness was checked, not assumed: the JSON predates three later statement commits and is ' +
      'still current, because the pipe design means statement changes no longer touch the workflow.',
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
