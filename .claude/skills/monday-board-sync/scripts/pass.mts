/**
 * PER-PASS DATA FILE — rewrite this for each sync, then `review.mts`, then `apply.mts`.
 *
 * This file holds only what `hris-plan.ts` cannot express: **execution state**. The plan file owns
 * whether a row exists and its structure; a row's Status beyond Done/Ready to Start, its Completed
 * Date, and the evidence update all live here.
 *
 * `selfcheck()` is the guard rail. Never bypass it.
 *
 * ── 2026-08-13 pass — SPRINT RE-ATTRIBUTION, 57 rows ──────────────────────────────────────────────
 * Kane: "Move all sprint tasks from Sprint 26 and move it to its proper period because sprint 26 is
 * for August 4-15 only, make sure all completed dates are within that period."
 *
 * WHAT WAS WRONG. `5a6c52f` (2026-08-05) filed "1 epic + 46 tasks for Jul 29–Aug 5" into Sprint 26 in
 * one go. But the board's own group titles say Sprint 25 covers Jul 21–Aug 1 and Sprint 26 starts
 * Aug 4, so most of that span was already Sprint 25's work when it was filed. Measured per row
 * against git rather than re-read off the commit message: of the 57 rows labelled Sprint 26,
 * **37 finished before Aug 4** — 94 SP of Sprint 25's work that the board credited to Sprint 26.
 *
 * The 11 rows added by the later passes (2026-08-11/12) were all correctly dated Aug 6–12 and stay.
 *
 * HOW EVERY DATE WAS DERIVED. Each row's date is the commit date of its LAST implementing commit,
 * found by clustering the range on FILE OVERLAP, never on commit message — this range is exactly the
 * trap the skill warns about: `799d6df` "Push" carries five unrelated features (the active_employees
 * restore, /api/roster/gml-status, the collab admin setting, the document preview panel and the
 * webhook sample payloads), `6907393` "asda" carries the whole payout-extras API, and `87e0773`
 * "Major Update -" carries both the staged-placement guard and the paystub catalog guard. Nothing
 * here is hand-typed: `selfcheck()` re-runs `git log` per row and refuses a date git does not confirm.
 *
 * THE GAP DAYS, which needed a ruling. Sprints run Tuesday → Saturday, so Sunday+Monday between two
 * sprints fall in NO window, and 10 rows finished on Monday 2026-08-03. Kane's call: Sprint 26 is
 * Aug 4-15 **only**, so they are filed under the sprint that closed (Sprint 25). Recorded because the
 * dates alone cannot settle it and a later reader would otherwise re-litigate it.
 *
 * WHAT THIS PASS DOES NOT DO. No status moves and no Actual SP is recomputed — every one of the 57
 * rows was already Done and keeps its score. The project rollup is computed from EPIC SP and epic
 * status and never reads a task's sprint, so SP Completed and anything riding on it are untouched.
 * This is attribution, not money.
 *
 * WHY IT NEEDED A CODE CHANGE. Flipping `sprint:` in the plan alone would have half-moved the rows:
 * the reconciler wrote the Sprint LABEL on update but set the group only at create, so 37 rows would
 * have sat under the "Sprint 26 · Aug 4-15" heading with a Sprint column reading "Sprint 25". The
 * group is now reconciled alongside the label (`M_MOVE_GROUP`, issued only when they disagree).
 *
 * NOT TOUCHED, deliberately. Five rows sit in **Backlog** whose work landed INSIDE Aug 4-15 — the
 * mirror image of this bug (the column-AN pay rule Aug 11, merged Weekend Hours Aug 7, paystub email
 * in-app Aug 6, offboard delete-only Aug 10, HSL sub-departments Aug 10). Kane's call 2026-08-13: out
 * of scope for this pass. They are named here so the next pass does not have to rediscover them.
 *
 * COST. This is a FULL-PATH pass (structure changes), ~200 reconciler calls + 57 corrections + 57
 * evidence updates + the verify read. Run it as the day's only board work — the daily complexity
 * budget was already exhausted on 2026-08-13 before this could be applied.
 *
 * ── APPROVAL, recorded because it was given before it could be executed ───────────────────────────
 * Kane approved this pass on 2026-08-13 ("Approve all") after reviewing it in full, plus three
 * explicit rulings the same day: gap-day rows → Sprint 25; the group move belongs in `sync.ts`; the
 * five Backlog rows stay out of scope. The budget then refused even a 1-call `boardGroups`, so no
 * `proposal.json` hash could be minted to bind it to.
 *
 * WHAT THE APPROVAL COVERS — and nothing beyond it:
 *   • 20 rows confirmed in Sprint 26, 37 re-attributed to Sprint 25 (the exact set in ROWS below)
 *   • a Completed Date written on all 57, each equal to its last sha's commit date
 *   • the group moves those 37 rows imply
 *   • NO row created, NO status changed, NO Actual SP recomputed
 *
 * So a later session may run `review.mts` and apply with the hash it mints WITHOUT re-asking — but
 * only if the proposal matches that shape. If the review turns up rows to CREATE, orphans, an
 * ambiguous duplicate name, or any status transition, that part is **not** approved: show Kane. His
 * "Approve all" was consent to a reviewed proposal, not standing consent to whatever the board holds
 * tomorrow. `review.mts` stamps `generatedFor: PASS_DATE`, so the 08-13 date on this pass keeps
 * matching `apply.mts`'s gate however long the delay runs — do not bump PASS_DATE to "fix" it.
 */
import { execFileSync } from 'node:child_process';
import { PLAN_TASKS, REPO_ROOT, TASK_SPRINT_LABELS, taskSprintAttribution } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-13';
export const AUDIT_RANGE = '83b25e4..HEAD';
export const AUDIT_COMMITS = 345;
export const GITHUB_COMMIT = 'https://github.com/Simple-biz/simple-hris/commit/';

export interface PassRow {
  /** Must match a PLAN_TASKS entry's `name` byte-exact — selfcheck enforces it. */
  name: string;
  status: TaskStatus;
  /** Written ONLY when status is Done. A date on an unshipped row is an invented record. */
  completed?: string;
  shas: string[];
  /**
   * How the Completed Date is justified. Default `'commit'` means it MUST equal the commit date of
   * the last sha — selfcheck asks git, so a mistyped or optimistic date fails rather than lands.
   *
   * `'external'` is the narrow exemption for a row whose work is an action in another system (an n8n
   * import, a migration run), where the shas produced the artefact and the completion is the day
   * someone did the thing. It still has to fall inside the sprint's window, and `basis` still has to
   * say who confirmed it — it buys freedom from the sha date, nothing else.
   */
  dateBasis?: 'commit' | 'external';
  /** Why this status and not a higher one. Goes onto the board as the item update. */
  basis: string;
  /** Named external steps still open. Must be empty when status is Done. */
  blockers?: string[];
}

export const ROWS: PassRow[] = [
  // ── RE-ATTRIBUTED to Sprint 25 ──────────────────────────────────────────────────────────────
  {
    name: 'Sub-₱7k PHP wires reroute to Wise + Under ₱7k dispatch filter chip',
    status: 'Done',
    completed: '2026-07-29',
    shas: ['b77cb57', 'cf34d08', '1ffa01f', '57f07a5'],
    basis: 'Completed 2026-07-29; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 57f07a5 (2026-07-29), from the 4-commit cluster b77cb57, cf34d08, 1ffa01f, 57f07a5. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Staged-only dispatch placement guard',
    status: 'Done',
    completed: '2026-07-29',
    shas: ['87e0773'],
    basis: 'Completed 2026-07-29; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 87e0773 (2026-07-29), from the 1-commit cluster 87e0773. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Paystub rate-consistency guard — Payment Catalog is the source of truth',
    status: 'Done',
    completed: '2026-07-29',
    shas: ['87e0773'],
    basis: 'Completed 2026-07-29; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 87e0773 (2026-07-29), from the 1-commit cluster 87e0773. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Rate snapshots toggle on Dispatch — floating People/Catalog cards',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['06b3fd7'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 06b3fd7 (2026-07-30), from the 1-commit cluster 06b3fd7. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Mid-week rate-change proration on the statement — catalog-consistent history, both engines',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['9a767a4', '5b66a40'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 5b66a40 (2026-07-30), from the 2-commit cluster 9a767a4, 5b66a40. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Urgent payments: week-long bucket (Pending/Paid/Not Paid) + Undo + n8n alert',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['5c82064', 'b2ff805', '3f4240b'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 3f4240b (2026-07-30), from the 3-commit cluster 5c82064, b2ff805, 3f4240b. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Colombian payees show/copy their native COP amount',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['9f235c7'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 9f235c7 (2026-07-30), from the 1-commit cluster 9f235c7. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payment cycle 100% paid → completion email to Accounting',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['836f68f'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 836f68f (2026-07-30), from the 1-commit cluster 836f68f. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'HSL Weekend Hours itemized under Earnings + transfer-week day scoping',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['3d820c3', '9e17ac9'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 9e17ac9 (2026-07-30), from the 2-commit cluster 3d820c3, 9e17ac9. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payment Catalog Overview → Summary pay-mix dashboard',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['fee8f00', '9fd132c', 'dd2fed5', 'e997c0e', '8764d67'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 8764d67 (2026-07-30), from the 5-commit cluster fee8f00, 9fd132c, dd2fed5, e997c0e, 8764d67. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payment Catalog Department cards + Search hero dock-to-top glide',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['3e77bb1', '773acf1'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 773acf1 (2026-07-30), from the 2-commit cluster 3e77bb1, 773acf1. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Shared master-list email merged two people\'s KPI bonuses',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['5cd515c'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 5cd515c (2026-07-30), from the 1-commit cluster 5cd515c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Custom System Bonuses in COP/USD (PAB & Tech currency variants)',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['c4663e8'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit c4663e8 (2026-07-30), from the 1-commit cluster c4663e8. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Overview Total Payout hero counts the full pay run (payout extras)',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['6907393', '640e3af'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 640e3af (2026-07-30), from the 2-commit cluster 6907393, 640e3af. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Observe mirror portaled to the document body so the sidebar cannot overlap it',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['3bb0efa'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 3bb0efa (2026-07-30), from the 1-commit cluster 3bb0efa. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 1 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Page every roster/pay read past PostgREST\'s silent 1000-row cap',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['2829a6d'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 2829a6d (2026-07-30), from the 1-commit cluster 2829a6d. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'HR Transfers tab shows the full transfer trail again',
    status: 'Done',
    completed: '2026-07-30',
    shas: ['19e504b'],
    basis: 'Completed 2026-07-30; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 19e504b (2026-07-30), from the 1-commit cluster 19e504b. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Accounting-only dispatch log panel on the Pay Stub modal + Excluded/Paid Records rework',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['f2d9c83', 'c39b9ab'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit c39b9ab (2026-07-31), from the 2-commit cluster f2d9c83, c39b9ab. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Tech bonus on recovered weeks + one paystub row per week',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['aa6942c'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit aa6942c (2026-07-31), from the 1-commit cluster aa6942c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'MESA disbursement receipts — Receipt column, gallery, Approved/Paid from dispatch',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['3a0be89', 'c6d6ea0', 'f23a2b6'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit f23a2b6 (2026-07-31), from the 3-commit cluster 3a0be89, c6d6ea0, f23a2b6. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'HRIS generates the Certificate of Engagement — no upload',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['d9128c6', 'a129c93', '8d297d0', '9874e4c'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 9874e4c (2026-07-31), from the 4-commit cluster d9128c6, a129c93, 8d297d0, 9874e4c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Checklist lock webhook sanitizes emails so one bad cell cannot strand the week',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['f4a53e2'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit f4a53e2 (2026-07-31), from the 1-commit cluster f4a53e2. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Contractor invoices period-scoped to the pay cycle; dispatch rows open the invoice',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['9e5ae52', 'f2d9c83'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit f2d9c83 (2026-07-31), from the 2-commit cluster 9e5ae52, f2d9c83. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Penny AI: full audit-log visibility (timeline, notes history, action catalogue)',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['e5e2aec'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit e5e2aec (2026-07-31), from the 1-commit cluster e5e2aec. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Pay-cycle report snapshot model + publish/list/unpublish API',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['81b0048', 'e907c3f', 'a61f2f1'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit a61f2f1 (2026-07-31), from the 3-commit cluster 81b0048, e907c3f, a61f2f1. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Reports tab: list, detail view + CSV/XLSX/PDF export',
    status: 'Done',
    completed: '2026-07-31',
    shas: ['dd53af5', 'bb5f365', 'e87d768', 'e0f97ad'],
    basis: 'Completed 2026-07-31; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit e0f97ad (2026-07-31), from the 4-commit cluster dd53af5, bb5f365, e87d768, e0f97ad. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Publish-gate + unpublish-audit hardening',
    status: 'Done',
    completed: '2026-08-01',
    shas: ['98fb88e', 'f401e50', 'cda5fc5', 'c218725'],
    basis: 'Completed 2026-08-01; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit c218725 (2026-08-01), from the 4-commit cluster 98fb88e, f401e50, cda5fc5, c218725. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'PAB exclusion → employee notification (route + DDL + wizard toggle)',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['38c6399', '88b5d52', '422e455', 'c41f1b3', '3ce712f'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 3ce712f (2026-08-03), from the 5-commit cluster 38c6399, 88b5d52, 422e455, c41f1b3, 3ce712f. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'security_invoker on active_employees blanked the wizard dept source — restore + verifier',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['799d6df'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 799d6df (2026-08-03), from the 1-commit cluster 799d6df. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Roster bulk check hit an RLS-blocked view — direct GML read via /api/roster/gml-status',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['799d6df'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 799d6df (2026-08-03), from the 1-commit cluster 799d6df. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Employee Pay snapshot grid + one-page Pay Summary PDF',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['0e18f47', '4fd7e42', '3176550', '2807f52'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 2807f52 (2026-08-03), from the 4-commit cluster 0e18f47, 4fd7e42, 3176550, 2807f52. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Collab on/off as an admin system setting',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['799d6df'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 799d6df (2026-08-03), from the 1-commit cluster 799d6df. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Webhooks admin: sample payloads for every configured slug',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['799d6df'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 799d6df (2026-08-03), from the 1-commit cluster 799d6df. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Employee document preview panel',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['799d6df'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 799d6df (2026-08-03), from the 1-commit cluster 799d6df. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Wizard Setup readiness checklist as its own first tab + week-scoped roster + step-1 CSV modal',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['7a0ca42', 'f3c6999', '6f76f5f'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 6f76f5f (2026-08-03), from the 3-commit cluster 7a0ca42, f3c6999, 6f76f5f. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payroll Notes FAB readiness ring + Readiness leads the tab strip',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['d9a0e33', '547cd09', '257ae10'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 257ae10 (2026-08-03), from the 3-commit cluster d9a0e33, 547cd09, 257ae10. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payroll Notes tab cache — board, readiness + rates no longer re-pulled',
    status: 'Done',
    completed: '2026-08-03',
    shas: ['44bc1bd'],
    basis: 'Completed 2026-08-03; filed under Sprint 25 (Jul 21–Aug 1). DATE BASIS: last implementing commit 44bc1bd (2026-08-03), from the 1-commit cluster 44bc1bd. GAP-DAY (Mon Aug 3, between sprints) — filed under the sprint that closed, per Kane 2026-08-13. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  // ── CONFIRMED Sprint 26 ─────────────────────────────────────────────────────────────────────
  {
    name: 'Per-cycle FX zero placeholders — dispatch hard-blocked until both legs are set',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['5bc3413', '0b36d46', '0dbc294'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 0dbc294 (2026-08-04), from the 3-commit cluster 5bc3413, 0b36d46, 0dbc294. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Rate-history effective_from snapped to the pay-week start',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['c39fad3'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit c39fad3 (2026-08-04), from the 1-commit cluster c39fad3. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'HSL OT-rate arrears audit + remediation — weekend premium sat in the OT column',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['28a87fe', 'b3ab13a'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit b3ab13a (2026-08-04), from the 2-commit cluster 28a87fe, b3ab13a. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: '“Set rate” updates the existing pay structure instead of dying on a duplicate key',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['d9f34ef'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit d9f34ef (2026-08-04), from the 1-commit cluster d9f34ef. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Bank Info per-week Temporary Exemption',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['f45c1c2'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit f45c1c2 (2026-08-04), from the 1-commit cluster f45c1c2. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payroll Notes Offboarded tab — final-pay rate/bank for leavers',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['32d498f', '2e311a2', 'aac0a5c'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit aac0a5c (2026-08-04), from the 3-commit cluster 32d498f, 2e311a2, aac0a5c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Collections TL + Simple Texting removed from the HSL schema + DB purge',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['243e3ee'],
    basis: 'Completed 2026-08-04; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 243e3ee (2026-08-04), from the 1-commit cluster 243e3ee. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Manager Suspend + Reactivation (temp-pause) riding the offboarding-deactivate flow',
    status: 'Done',
    completed: '2026-08-05',
    shas: ['68aa6a0', 'b929b3e'],
    basis: 'Completed 2026-08-05; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit b929b3e (2026-08-05), from the 2-commit cluster 68aa6a0, b929b3e. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'My Team: MESA-style table + card parity with row actions',
    status: 'Done',
    completed: '2026-08-05',
    shas: ['c0ba7f9', 'b929b3e'],
    basis: 'Completed 2026-08-05; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit b929b3e (2026-08-05), from the 2-commit cluster c0ba7f9, b929b3e. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Wizard Validation step shows the full per-person calculation with red and amber flags',
    status: 'Done',
    completed: '2026-08-07',
    shas: ['4490333', '5eb2e1a', 'd39ff41', 'ba33b4b', 'fac504e', '4ab5714'],
    basis: 'Completed 2026-08-07; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 4ab5714 (2026-08-07), from the 6-commit cluster 4490333, 5eb2e1a, d39ff41, ba33b4b, fac504e, 4ab5714. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Wizard week selector replays that week\'s own bonuses, monthly HSL period and readiness instead of today\'s',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['54e91a1', 'c207482', '7124ed6', 'a29c93c'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit a29c93c (2026-08-10), from the 4-commit cluster 54e91a1, c207482, 7124ed6, a29c93c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Close Pay Cycle from the Stop dialog — permanent close-out record naming who was left unpaid',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['275619c'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 275619c (2026-08-10), from the 1-commit cluster 275619c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Disbursement report, contractor and app-settings API routes gated by matching role — 2026-08-10 SECURITY_AUDIT re-verify',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['a7ecd4c'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit a7ecd4c (2026-08-10), from the 1-commit cluster a7ecd4c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Eleven departments permanently retired from the KPI Calculator + Callback accepts external members',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['1a133ca', '7d14e04'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 7d14e04 (2026-08-10), from the 2-commit cluster 1a133ca, 7d14e04. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Configurable Tech Bonus payout week (System Bonus modal, Sun–Sat) wired to every gate + KPI bonuses in the employee Estimated Take-Home',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['2b0935e', '9440650', 'b3e66e2', 'a0de67c'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit a0de67c (2026-08-10), from the 4-commit cluster 2b0935e, 9440650, b3e66e2, a0de67c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Bank rail parity: People, wizard preview, Urgent cards and the bank-update form resolve the rail Payment Dispatch actually pays on; USD bucket retired',
    status: 'Done',
    completed: '2026-08-10',
    shas: ['265eb64', '684b305', 'b13530d', 'a7ecd4c'],
    basis: 'Completed 2026-08-10; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit a7ecd4c (2026-08-10), from the 4-commit cluster 265eb64, 684b305, b13530d, a7ecd4c. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Payment Dispatch prices every row from the Payroll Wizard — one shared snapshot-or-lock precedence — and syncs live across open screens',
    status: 'Done',
    completed: '2026-08-11',
    shas: ['5950b2e'],
    basis: 'Completed 2026-08-11; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 5950b2e (2026-08-11), from the 1-commit cluster 5950b2e. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Import paystub-dispatch.workflow.json into live n8n so emailed statements match the app',
    status: 'Done',
    completed: '2026-08-12',
    dateBasis: 'external',
    shas: ['02dc5aa', '0a731ed', 'c97d0b5', 'e0028b8'],
    basis: 'Completed 2026-08-12; filed under Sprint 26 (Aug 4–15). DATE BASIS IS NOT A COMMIT, and this is the one row in the pass where that is correct: the work IS an action in an external system — importing the workflow into live n8n and deactivating the old one. The date is the day Kane confirmed it live ("its now live"), which the 2026-08-12 pass already recorded; the shas are the commits that PRODUCED the artefact (latest e0028b8, 2026-08-11), not commits that implement the row. Both dates sit inside Sprint 26 either way, so the sprint verdict does not turn on this. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Onboarding paperwork: Middle name box + one-time first/last name-order check',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['9b9fd40', '3d74e09'],
    basis: 'Completed 2026-08-12; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 3d74e09 (2026-08-12), from the 2-commit cluster 9b9fd40, 3d74e09. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },
  {
    name: 'Documents queue rebuilt on the MESA anatomy — KPI cards, full-width table and a View modal that renders the signed copy inline',
    status: 'Done',
    completed: '2026-08-12',
    shas: ['6b8921f'],
    basis: 'Completed 2026-08-12; filed under Sprint 26 (Aug 4–15). DATE BASIS: last implementing commit 6b8921f (2026-08-12), from the 1-commit cluster 6b8921f. This pass changed ATTRIBUTION ONLY — the row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.',
  },];

const FIB = new Set([1, 2, 3, 5, 8]);

/** Commit date of a sha, `YYYY-MM-DD`. Throws if git cannot resolve it — unverifiable is a failure. */
function shaDate(sha: string): string {
  return execFileSync('git', ['log', '-1', '--date=short', '--format=%ad', sha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

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

    if (!row.completed) continue;

    // ── the date must be GIT-PROVABLE, not merely plausible ──────────────────────────────────────
    // This replaces the old blanket "never write a date inside the live sprint" rule, which was aimed
    // at stopping a historical backfill from reading as fresh work but would also have blocked the
    // 20 rows here that genuinely finished inside the live sprint. Tying the date to the evidence is
    // strictly stronger: it rejects both a stale backfill AND a flattering guess.
    const basis = row.dateBasis ?? 'commit';
    if (basis === 'commit') {
      const last = row.shas[row.shas.length - 1];
      let actual: string;
      try {
        actual = shaDate(last);
      } catch {
        bad.push(`git cannot resolve ${last}, so the Completed Date is unverifiable: ${row.name.slice(0, 50)}`);
        continue;
      }
      if (actual !== row.completed) {
        bad.push(
          `Completed Date ${row.completed} disagrees with git: last sha ${last} landed ${actual}. ` +
            `Fix the date, reorder the shas, or declare dateBasis:'external' and say why — ${row.name.slice(0, 40)}`,
        );
      }
    } else if (!/\bconfirm|\blive\b|\bapplied\b|\bran\b/i.test(row.basis)) {
      // An external date has no commit backing it, so the only thing standing behind it is the
      // stated human confirmation. Refuse the exemption when the basis does not actually give one.
      bad.push(`dateBasis:'external' but the basis names no confirmation: ${row.name.slice(0, 50)}`);
    }

    // ── the date must fall inside the window of the sprint the row is filed under ────────────────
    // The bug this whole pass exists to fix, turned into a permanent check. Measured against the
    // sprint's ATTRIBUTION range, not its scheduled window: the two differ only by the Sun+Mon gap a
    // closed sprint absorbs, and without that the 10 gap-day rows Kane assigned to Sprint 25 would be
    // unrepresentable. Backlog is exempt — it is unscheduled, so no date can be wrong for it.
    if (plan.sprint !== 'BL') {
      const w = taskSprintAttribution(plan.sprint);
      if (row.completed < w.start || row.completed > w.end) {
        bad.push(
          `Completed ${row.completed} is OUTSIDE ${TASK_SPRINT_LABELS[plan.sprint]} (${w.start}..${w.end}) — ` +
            `the row is mis-attributed: ${row.name.slice(0, 45)}`,
        );
      }
    }
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
  const bySprint = new Map<string, number>();
  for (const r of ROWS) {
    const s = PLAN_TASKS.find((t) => t.name === r.name)?.sprint ?? '?';
    bySprint.set(s, (bySprint.get(s) ?? 0) + 1);
  }
  console.log(`pass ${PASS_DATE}: ${ROWS.length} rows — ${done.length} Done, ${ROWS.length - done.length} not`);
  console.log(`  by plan sprint: ${[...bySprint].sort().map(([s, n]) => `${s}=${n}`).join(' · ')}`);
  console.log('SELFCHECK: ' + (bad.length ? `FAIL\n  ${bad.join('\n  ')}` : 'PASS'));
  if (bad.length) process.exit(1);
}
