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
 * ── 2026-08-11 pass ──────────────────────────────────────────────────────────────────────────────
 * Audited 5a6c52f..488cf44 (Aug 5–11 2026, 78 commits) clustered by file overlap. Every SHA below
 * is an ancestor of origin/main (`git merge-base --is-ancestor <sha> origin/main` exits 0; local
 * main == origin/main == 488cf44, so nothing in this range is unpushed).
 *
 * The seven Done rows rest on Kane's explicit confirmation of 2026-08-11 that they work in
 * production. That is stated as the basis on each row's board update rather than implying a
 * verification artifact that does not exist — his click-through IS the evidence the gate asks for,
 * and the board should say so plainly.
 *
 * The five Pending Deploy rows are NOT a matter of confirmation. Each has a named external step
 * nobody has run, so no assertion can make them Done.
 */
import { PLAN_TASKS } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-11';
export const AUDIT_RANGE = '5a6c52f..488cf44';
export const GITHUB_COMMIT = 'https://github.com/Simple-biz/simple-hris/commit/';

/** Kane's confirmation is the proof of prod click-through. Recorded verbatim on every Done row. */
const KANE_CONFIRMED =
  'Marked Done on Kane\'s explicit confirmation of 2026-08-11 that this works in production. ' +
  'The commits below are all ancestors of origin/main; the prod click-through is his sign-off, ' +
  'not an automated check.';

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
  // ── Done · Sprint 26 · completed 2026-08-11 ────────────────────────────────────────────────────
  {
    name: 'Wizard Validation step shows the full per-person calculation with red and amber flags',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['4490333', '83ef2e9', 'b3adf4c', '851a0ab', '1452b53', 'd39ff41', 'ba33b4b', '0b66a8e', '993dfb4', '5eb2e1a', 'fac504e', '237696c', '4ab5714'],
    basis: KANE_CONFIRMED,
  },
  {
    name: 'Close Pay Cycle from the Stop dialog — permanent close-out record naming who was left unpaid',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['275619c'],
    basis: `${KANE_CONFIRMED} No migration and no n8n import were ever required for this one — the close-out record is a separate artifact and the publish gate was left untouched.`,
  },
  {
    name: 'Configurable Tech Bonus payout week (System Bonus modal, Sun–Sat) wired to every gate + KPI bonuses in the employee Estimated Take-Home',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['2b0935e', '9440650', '9c6a97d', 'b3e66e2', '97e9c9b', '25c435c', 'a0de67c'],
    basis: `${KANE_CONFIRMED} Every eligibility gate resolves through resolveIsTechBonusWeek rather than the raw week flag.`,
  },
  {
    name: "Wizard week selector replays that week's own bonuses, monthly HSL period and readiness instead of today's",
    status: 'Done',
    completed: PASS_DATE,
    shas: ['54e91a1', 'c207482', '7124ed6', 'a29c93c'],
    basis: `${KANE_CONFIRMED} Known limitation left open by design and NOT claimed here: replayed bonus AMOUNTS and department eligibility still resolve from today's catalog.`,
  },
  {
    name: 'Bank rail parity: People, wizard preview, Urgent cards and the bank-update form resolve the rail Payment Dispatch actually pays on; USD bucket retired',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['265eb64', '684b305', 'b13530d', 'a7ecd4c'],
    basis: `${KANE_CONFIRMED} The parity guard script must keep returning zero for every bucket; a non-zero result is a regression, not a new finding.`,
  },
  {
    name: 'Disbursement report, contractor and app-settings API routes gated by matching role — 2026-08-10 SECURITY_AUDIT re-verify',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['a7ecd4c'],
    basis: `${KANE_CONFIRMED} Carried in a commit titled "Callback", which is unrelated to the change — the cluster was established by diffing the file list, not the message.`,
  },
  {
    name: 'Eleven departments permanently retired from the KPI Calculator + Callback accepts external members',
    status: 'Done',
    completed: PASS_DATE,
    shas: ['1a133ca', '7d14e04'],
    basis: `${KANE_CONFIRMED} A wizard payable-KPI regression introduced here was fixed by 54e91a1 in the same range.`,
  },

  // ── Pending Deploy · Backlog · blocked on a step nobody has run ────────────────────────────────
  {
    name: 'HSL pay = the Hogan sheet column AN verbatim — hogan-week-pay becomes the single rate authority, reversing the 2026-08-07 weekend-OT removal',
    status: 'Pending Deploy',
    shas: ['5eb398a', '362b41c', 'e0028b8'],
    basis:
      'On origin/main but NOT Done: staged rows do not reprice on deploy, so until the 2026-08-02→08-08 cycle is unlocked and re-locked the wizard still pays the old figure. ' +
      'The 2026-08-07 removal of the weekend-OT rate (5eb398a) was REVERSED by e0028b8 — this row describes the current rule only.',
    blockers: [
      'Kane must unlock + re-lock the 2026-08-02→08-08 pay cycle so staged rows restage at the sheet figure',
      'references/n8n/paystub-dispatch.workflow.json not imported, so the emailed statement still renders from stale n8n HTML',
    ],
  },
  {
    name: 'One merged Weekend Hours line + dated rate-change disclosure on statement, email and export',
    status: 'Pending Deploy',
    shas: ['0a731ed', 'c97d0b5'],
    basis:
      'Statement and CSV export are live; the emailed stub is not, because it renders from an n8n workflow that has not been imported. Two of three surfaces shipped is not Done. ' +
      'The disclosure chip exists because a weekend priced below regular+15 is a DATED RATE CHANGE, not a math error.',
    blockers: ['references/n8n/paystub-dispatch.workflow.json not imported into live n8n'],
  },
  {
    name: 'Paystub email HTML rendered in-app (n8n Gmail becomes a pipe) + System Bonus snapshot columns on payment_dispatches',
    status: 'Pending Deploy',
    shas: ['02dc5aa'],
    basis:
      'The in-app renderer exists but live n8n still builds its own HTML, so the emailed stub can still contradict the in-app one for the same payment — the failure that already reached employees twice. ' +
      'Carried in a commit titled "Massiv Update" alongside two unrelated changes.',
    blockers: [
      'references/n8n/paystub-dispatch.workflow.json must be imported so the Gmail node becomes a pipe fed by paystub_html',
    ],
  },
  {
    name: 'Offboarding is delete-only: suspend is its own path, suspended-person offboards escalate to delete, and leavers get a correct final check',
    status: 'Pending Deploy',
    shas: ['3502e93', '28cb65d', '0b66a8e', '2020a74', '5379204', 'ad60b94', 'ccc74c2', 'd259040', '8497699'],
    basis:
      'Code complete on origin/main, but two prod-side steps are open, and the manager reactivate webhook still points at the wrong URL until the seed is re-run.',
    blockers: [
      'references/sql/seed/seed_webhooks_config.sql not re-run in prod (manager_reactivate URL)',
      'live n8n offboarding-deactivate workflow must branch on the temp-pause envelope (deletion_mode "none")',
    ],
  },
  {
    name: 'One HSL department + required sub-department that sets the base rate, wired through the Payment Catalog',
    status: 'Pending Deploy',
    shas: ['882542e', '02dc5aa', 'e70757d', '06bad5e', '7b46843', 'b96897a', '289ab7e', 'e170147', '83ecb2f'],
    basis:
      'The pay-affecting half is functionally dead: ZERO hsl:* rate rows exist, so all 12 sub-teams fall back to the parent rate and nobody is paid differently. This is the clearest not-Done row in the pass.',
    blockers: [
      'no hsl:* rate rows in payment_catalog_pay_structures — every sub-team falls back to the parent rate',
      '528 of ~598 active HSL people still have no sub-department assigned',
      'the Saturday cutover has not been run',
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
    `**${row.status}** — board sync pass ${PASS_DATE} (audit range ${AUDIT_RANGE}, 78 commits).`,
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
