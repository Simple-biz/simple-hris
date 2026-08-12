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
 * ── 2026-08-12 pass, sixth — CLOSE-OUT of the three open Sprint 26 rows ──────────────────────────
 * Kane asked what in Sprint 26 could move to Done with a Completed Date and an Actual SP. Sprint 26
 * holds 56 rows / 201 SP, of which exactly THREE were not Done. This pass settles all three: two go
 * Done, one advances a rung and is explicitly held short of it.
 *
 * NO new rows and NO re-scoring — every row here already exists on the board, already carries its
 * Estimated SP, and is already linked to its epic. So this runs on the LEAN path (`--only-new`,
 * which also corrects existing rows): ~12 calls instead of ~200 against the DAILY complexity budget.
 *
 * A TOOLING GAP had to be closed first, and it is why the Actual SP half of the ask could not simply
 * be executed. `sync.ts` writes Actual SP only in its CREATE payload (sync.ts:256); its update
 * payload (sync.ts:239-245) omits it, and the corrector wrote only Status + Completed Date. So on a
 * row that already existed, NOBODY wrote Actual SP — a row flipped to Done after creation kept a
 * blank one forever. apply.mts now writes it from `plan.sp` (never a number chosen at the call site)
 * on the Done path in BOTH write paths via one shared `correctionValues`, and CLEARS it on a row
 * moving off Done, since a non-Done row carrying an Actual SP is the phantom verify.mts sweeps for.
 * Actual SP stays disjoint from RECONCILER_UPDATE_COLS, so gate 4's collision guard still holds.
 *
 * WHY THE DISPATCH ROW WAS ALREADY DONE AND THE BOARD DID NOT KNOW. Commit 0cafeff flipped it to
 * done:true on Kane's prod confirmation — but `done:true` only takes effect in the reconciler's
 * CREATE payload, and that row was created by the f259f9a pass as Pending Deploy. The Done had
 * nowhere to land. That is board drift, not a fresh judgement, and it is the exact failure mode the
 * gap above produces.
 */
import { PLAN_TASKS } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-12';
export const AUDIT_RANGE = '5950b2e..ce83a73';
export const AUDIT_COMMITS = 17;
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
  // ── Done · Sprint 26 · Kane confirmed in prod; the board simply never received it ──────────────
  {
    name: 'Payment Dispatch prices every row from the Payroll Wizard — one shared snapshot-or-lock precedence — and syncs live across open screens',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['5950b2e'],
    basis:
      'DONE ON KANE\'S PROD CONFIRMATION 2026-08-12: "Confirmed payroll wizard published" — the ' +
      'Amount Source column reading "Payroll Wizard (published)" on the live screen — plus his ' +
      'sign-off to close the row. That confirmation was recorded the same day in commit 0cafeff, ' +
      'which flipped this row to done:true in hris-plan.ts. It never reached the board because ' +
      'done:true only takes effect in the reconciler\'s CREATE payload (sync.ts:256) and this row ' +
      'already existed — created as Pending Deploy by the f259f9a pass — so the Done had nowhere to ' +
      'land. This pass writes it, with the Actual SP that the corrector previously could not write ' +
      'on an existing row at all. ' +
      'Completed Date is 2026-08-12, the day it became provable, NOT 2026-08-11 when 5950b2e ' +
      'landed: dating it to the ship date would back-date a completion to before its own evidence ' +
      'existed. Kane chose this explicitly when asked. ' +
      'On origin/main — verified two ways, because the first read was ambiguous under three ' +
      'concurrent sessions in this checkout: 5950b2e is a member of `git rev-list origin/main`, AND ' +
      'the shipped content reads out of the remote tree (origin/main:src/lib/payroll/' +
      'wizard-dispatch-values.ts exists, payment-dispatch.md carries the new §4.2.2, and ' +
      'useDispatchQueue.ts carries the payment-dispatch-sync channel). NO migration and NO n8n ' +
      'import — the 21-file diff contains no .sql, no apply-*.mjs and no workflow json — so no ' +
      'external step ever stood between it and live. ' +
      'WHAT SHIPPED. Two defects, one screen. (1) The queue priced each row by a LOOSER rule than ' +
      'the paystub engine: it applied the wizard final_pay snapshot with none of the gates ' +
      'mergeSnapshotIntoStaged requires (no newer-than-lock, no itemization, on wizard-held rows, ' +
      'keyed on either email) and fell back to computeCurrentPay — which knows nothing of Adj., ' +
      'Orphanage, KPI/dept bonuses or MESA — rather than to the locked values fetched 40 lines away ' +
      'in the same function. MEASURED on the live 2026-08-02 cycle: 680 of 1,067 rows carried a ' +
      'wizard TOTAL beside a recomputed ₱0 bonus split (angelo@ ₱3,750 shown as ₱0; alisone@ ' +
      '₱7,000 as ₱0), so the export worksheet did not add up and Mark Paid froze those same wrong ' +
      'figures into payment_dispatches.system_bonus_php. Fixed by extracting the precedence into ' +
      'one pure module both engines call (wizard-dispatch-values.ts, 29 unit tests): the published ' +
      'snapshot only when it qualifies, else the LOCKED stage, else a recompute the row must ' +
      'declare. A re-lock now demotes an older snapshot, which is what makes unlock/re-lock ' +
      'authoritative over this screen. (2) Marking someone paid moved only the browser that did it ' +
      '— no subscription, no poll — so a second clerk kept a stale pending count indefinitely. Now ' +
      'Realtime Broadcast on payment-dispatch-sync plus a 15s ?signature=1 poll while visible. ' +
      'postgres_changes cannot work here (the browser is anon, the table is RLS-protected) — the ' +
      'lesson usePaymentsLive already paid for — so no publication change was needed. ' +
      'VERIFIED: scripts/verify-dispatch-carryover.mts runs the real function against live rows ' +
      '(1067/1067 wizard-priced, 0 recomputed, 0 non-reconciling), 947 tests pass, tsc clean. ' +
      'Docs: payment-dispatch.md §4.2.2 + §5.1.1, payroll-wizard-final-pay.md §5, INDEX invariant. ' +
      'ONE THING DELIBERATELY NOT COUNTED AS A BLOCKER: the 2026-08-02 cycle still wants a re-lock ' +
      '— aimei@ (locked ₱6,023.50 vs ₱6,272.06 shown) and theresaa@ (₱7,535.59 vs ₱7,017.05) were ' +
      're-priced two hours after the lock, so the queue legitimately shows the newer figure and ' +
      'FLAGS it. That is the feature behaving correctly on stale data, not a defect in it, so it ' +
      'does not hold Done. It is a cycle-data action, tracked separately.',
  },
  // ── Done · Sprint 26 · the one unprovable path was proven by a human clicking it ───────────────
  {
    name: 'Documents queue rebuilt on the MESA anatomy — KPI cards, full-width table and a View modal that renders the signed copy inline',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['6b8921f'],
    basis:
      'DONE ON KANE\'S PROD CONFIRMATION 2026-08-12: he opened Accounting → Documents → Actions → ' +
      'View in production and the signed PDF RENDERED. That click retires the sole blocker this row ' +
      'ever carried, and it was not a formality — the preview pane re-fetches the signed URL and ' +
      're-wraps the bytes as a blob: URL, which works only if Supabase Storage answers the browser ' +
      'fetch with permissive CORS. Typechecking cannot prove that; a human looking at it can, and ' +
      'did. Had it failed, the pane degrades to an error card offering "Open it in a new tab ' +
      'instead" and the headline feature would have been dead while the screen still looked fine — ' +
      'which is exactly why this row was held at Pending Deploy until now rather than assumed live. ' +
      'On origin/main: 6b8921f is a member of `git rev-list origin/main` AND the shipped content ' +
      'reads out of the remote tree (origin/main:src/components/accounting/AccountingDocuments.tsx ' +
      'carries DocumentDetailDialog, src/lib/documents/types.ts carries formatDocumentDateTime, and ' +
      'documents-tab.md carries the new "The Accounting queue (UI)" section). Kane pushed it as ' +
      'ce83a73. The 4-file diff contains no .sql, no apply-*.mjs and no workflow json, and it needs ' +
      'no migration, no n8n import, no new env var and no server change — so nothing external ever ' +
      'stood between it and live. ' +
      'SCOPE. Accounting → Documents rebuilt on the MESA anatomy (icon tile, tracked eyebrow, ' +
      'text-2xl title, lede → stats → toolbar → full-bleed table Card) recolored into the ' +
      'Accounting orange family per ui-standards §1.2/§1.3. The max-w-6xl wrapper is gone, so the ' +
      'table is full width; two columns added (Reference ID, and requested/decision now carry ' +
      'relative age plus turnaround) and the min-width went 880px → 1080px. Five KPI cards ' +
      '(Total / Awaiting signature / Signed and returned / Rejected / Avg. turnaround) computed ' +
      'from the rows already in state, no extra fetch; turnaround only counts rows carrying both ' +
      'stamps in order, so a missing or inverted pair is dropped rather than averaged as zero. A ' +
      'search box joined the existing status pills, which are unchanged. New Actions → View modal: ' +
      'both PDFs inline, both timestamps to the minute in Manila (new formatDocumentDateTime — the ' +
      'same clock the certification page prints, so the screen and the PDF cannot disagree), ' +
      'signer name/title/account, Reference ID, stored bucket paths, employee note, rejection ' +
      'reason. ' +
      'THREE THINGS IN IT ARE LOAD-BEARING and will look like bugs to anyone who "simplifies" them. ' +
      '(1) It defaults to the SIGNED copy. A COE\'s stored original.pdf is a watermarked UNSIGNED ' +
      'DRAFT and the certificate is re-rendered from live data at signing time, so the original is ' +
      'not the document that was signed; the other pane is labelled "As submitted" / "Generated ' +
      'draft" and carries an amber caveat banner. (2) The blob: re-wrap above is not incidental — ' +
      'signedUrlForDocumentFile mints the signed copy with a download option, i.e. ' +
      'Content-Disposition: attachment, which an iframe downloads instead of painting. Kane ' +
      'declined a server-side disposition=inline param, so the client-side wrap is the sanctioned ' +
      'fix and the shared employee route stays untouched; the object URL is revoked on close and ' +
      'on pane switch. (3) View needs `view`; Approve / Reject / Delete only render with `edit` and ' +
      'hand off to the existing confirm dialogs, so no decision is ever taken inside the modal. ' +
      'VERIFIED: tsc --noEmit clean (the only errors are pre-existing stale .next/types entries for ' +
      'the retired Pay Cycle Reports routes). next build deliberately NOT run — a dev server was ' +
      'live on :3000 and they share .next/. No tests were added; the surface has none. ' +
      'Docs: documents-tab.md gains "The Accounting queue (UI)", INDEX row picks up the memory ' +
      'entry documents-tab-queue-ui.',
  },
  // ── Pending Deploy · Sprint 26 · pushed since the last pass, but the migration is STILL un-run ──
  {
    name: 'Onboarding paperwork: Middle name box + one-time first/last name-order check',
    status: 'Pending Deploy',
    shas: ['9b9fd40', '3d74e09'],
    basis:
      'ADVANCES In Progress → Pending Deploy, and STOPS there. The code is no longer unpushed: ' +
      '9b9fd40 and 3d74e09 are both ancestors of origin/main now (they were not when the previous ' +
      'pass logged this row In Progress), so Vercel has deployed the form. ' +
      'IT IS NOT DONE, AND THE REASON WAS RE-MEASURED TODAY RATHER THAN QUOTED FROM THE LAST PASS ' +
      '— a "pending migration" claim in this repo is a claim, never a fact, and several have turned ' +
      'out stale. A read-only PostgREST probe on 2026-08-12 returned 42703 column-does-not-exist ' +
      'for ALL FOUR target columns: hr_onboarding_submissions.middle_name, ' +
      'hr_pending_employees.middle_name, hr_onboarding_submissions.name_order_confirmed_at and ' +
      'hr_pending_employees.name_order_confirmed_at. So the feature is deployed and FUNCTIONALLY ' +
      'DEAD in its headline half: a hire who types a middle name has it silently stripped by the ' +
      'optional-column retry — the form still saves, the middle name does not, and nothing tells ' +
      'anyone. That is worse than a visible failure, which is why this cannot be rounded up. ' +
      'SCOPE. A Middle name box on the Welcome step stored for HR records only — never composed ' +
      'into full_name, because the display trigger takes the last given token as the go-by and ' +
      'would rename Jane Marie Santos to Santos, Jane Marie "Marie" everywhere the Payroll Wizard ' +
      'prints her — plus a one-time non-blocking dialog on the way out of that step asking the hire ' +
      'to check they have not swapped first and last name. Doc: ' +
      'docs/features/onboarding-name-parts.md.',
    blockers: [
      'references/sql/alter/add_middle_name_to_onboarding.sql is NOT applied — re-measured in production 2026-08-12, all four columns return 42703 column-does-not-exist',
      'DATABASE_URL is unset in .env.local, so scripts/apply-middle-name-columns.mjs cannot run until Kane supplies it',
      'nobody has clicked through the Welcome step in production',
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
