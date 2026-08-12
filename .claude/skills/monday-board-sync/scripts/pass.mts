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
 * ── 2026-08-12 pass, fifth row ────────────────────────────────────────────────────────────────────
 * Kane asked for the Accounting → Documents rebuild to go on the board. ONE commit, 6b8921f, one
 * cluster by file overlap (AccountingDocuments.tsx + the types module it pulls its formatters from
 * + that surface's own feature doc). The two commits around it are not ours to log: 3da807d is a
 * cleanup that predates the ask, and ce83a73 "PUSH" carries only .claude/settings.json and two
 * .tsbuildinfo files — no code, so no row.
 *
 * Pending Deploy, not Done. It IS on origin/main and needs no external step, so the only thing
 * between it and Done is a human opening the modal in production. I said plainly at hand-off that I
 * had not exercised the blob-preview path in a browser, and an assertion that it "obviously works"
 * is exactly the rationalization the honesty gate names. If Kane clicks it through, say so and it
 * moves — that confirmation becomes the recorded basis.
 *
 * EARLIER PASSES THIS DAY, already applied and deliberately not re-sent: the onboarding paperwork
 * row (In Progress, unpushed at the time) and the Payment Dispatch wizard-values row (Done on
 * Kane's prod confirmation). Re-listing an applied row here would rewrite its item update for no
 * reason; the plan file still carries both, which is what the reconciler needs.
 */
import { PLAN_TASKS } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-12';
export const AUDIT_RANGE = '3da807d..ce83a73';
export const AUDIT_COMMITS = 2;
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
  // ── Pending Deploy · Sprint 26 · on origin/main, no external step, nobody has clicked it ───────
  {
    name: 'Documents queue rebuilt on the MESA anatomy — KPI cards, full-width table and a View modal that renders the signed copy inline',
    status: 'Pending Deploy',
    shas: ['6b8921f'],
    basis:
      'On origin/main — verified two ways, because three sessions share this checkout and a single ' +
      'ancestor read has been ambiguous here before: 6b8921f is a member of `git rev-list ' +
      'origin/main`, AND the shipped content reads out of the remote tree (origin/main:src/' +
      'components/accounting/AccountingDocuments.tsx carries DocumentDetailDialog, ' +
      'src/lib/documents/types.ts carries formatDocumentDateTime, and documents-tab.md carries the ' +
      'new "The Accounting queue (UI)" section). Kane pushed it as ce83a73. NO external step stands ' +
      'between it and live: the 4-file diff contains no .sql, no apply-*.mjs and no workflow json, ' +
      'and it needs no migration, no n8n import, no new env var and no server change at all. ' +
      'Pending Deploy purely because NOBODY HAS CLICKED IT THROUGH IN PRODUCTION — and that is not ' +
      'a formality on this one. The modal renders the PDF by re-fetching the signed URL and ' +
      're-wrapping the bytes as a blob: URL, which is the one path typechecking cannot prove: it ' +
      'depends on Supabase Storage answering the browser fetch with permissive CORS. If it does ' +
      'not, the pane degrades to an error card offering "Open it in a new tab instead" rather than ' +
      'breaking the screen, but the headline feature would be dead. I said at hand-off that I had ' +
      'not exercised it in a browser; one look at a signed row settles it. ' +
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
      'Docs: documents-tab.md gains "The Accounting queue (UI)", INDEX row picks up the new memory ' +
      'entry documents-tab-queue-ui.',
    blockers: [
      'nobody has opened the View modal in production — the blob: PDF preview depends on Supabase Storage answering the browser fetch with permissive CORS, which typechecking cannot prove',
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
