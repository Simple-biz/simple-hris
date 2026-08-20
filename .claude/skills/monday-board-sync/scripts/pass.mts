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
 * ── 2026-08-14 — THE BACKLOG HALF OF THE SAME BUG, +3 rows ────────────────────────────────────────
 * Kane: "Check all our backlogs and arrange them properly to where they belong but only those who are
 * already Done put them in their proper Sprint dates."
 *
 * The 08-13 pass fixed rows sitting in a sprint their work had NOT finished in. This adds the mirror
 * case: rows whose work DID finish inside Sprint 26 but that were parked in the Backlog. **Backlog is
 * not a status.** All three were held there only because they shared one blocker — the n8n paystub
 * import — which landed 2026-08-12; they went Done that same day and nobody re-filed them, leaving
 * 21 SP of Sprint 26's work filed as unscheduled.
 *
 * Nothing about them is re-judged here. Each is already Done, already carries Actual SP (8 / 5 / 8)
 * and already carries Completed Date 2026-08-12 — inside Sprint 26's window — so the corrector writes
 * no field on them at all. `hris-plan.ts` moves the sprint; the only board write is the evidence
 * update saying why. They take `dateBasis: 'external'` because their completion was an action in
 * another system (the import) rather than a commit: the newest sha is 2026-08-11, and the honest
 * Completed Date is the day the import made them provable, which is exactly what that exemption is
 * for. Without it a future selfcheck would fail all three on a date that is not wrong.
 *
 * WHAT WAS SCOPED OUT, on Kane's call 2026-08-14 — the Backlog still holds 44 rows:
 *   • 2 rows are NOT Done (offboard delete-only 8 SP, HSL sub-departments 8 SP) and stay. His
 *     instruction was Done-only. The HSL row's blocker may have gone stale — see hris-plan.ts.
 *   • 42 Done rows are pre-sprint history dating 2026-04-07 … 2026-07-24 (163 SP). All 42 were dated
 *     from git this session (14 by the commit that added their feature doc — they are title-cased doc
 *     slugs — 16 by the commit that introduced their API route, the rest by pickaxe; 31 high / 6
 *     medium / 5 low confidence). Filing them needs group ids and label indices for Sprints 17-23,
 *     which are NOT in this plan and could not be read (dead budget), and it rewrites nine sprints'
 *     recorded velocity. Deferred whole. If it is ever run: Kane's standing call is that the 5
 *     low-confidence rows stay in the Backlog rather than be filed on a guess.
 *
 *
 * ── 2026-08-19 — BACKLOG CLEAN-UP + THE COMPLETED-DATE BACKFILL, 43 rows ─────────────────────────
 * Kane: "Can we clean up our Backlogs and start add their completion dates please" + "Use the monday
 * board on this."
 *
 * WHAT THE LIVE BOARD ACTUALLY SHOWED (read 2026-08-19, 2,687 items, our 139). The earlier notes
 * calling the 08-13/08-14 pass "UNAPPLIED" are WRONG and are corrected here and in memory: that pass
 * is **PARTIALLY** applied. Its CORRECTOR half landed — 60 rows carry Completed Dates spanning
 * 2026-07-29…2026-08-12 and the 3 Tier-1 rows sit in Sprint 26. Its STRUCTURE half did not: **39 rows
 * still read Sprint 26 where the plan says Sprint 25**. Do NOT re-derive those 60 dates; only the
 * sprint moves are outstanding, and this pass's plan edits carry them.
 *
 * SPRINT 27 EXISTS NOW — `group_mm66ce8q`, label index **103**, "Sprint 27 · Aug 18-Aug 29". Someone
 * added it on the board by hand. Mirrored into TASK_GROUPS / TASK_SPRINT_INDEX / TASK_SPRINT_LABELS /
 * TASK_SPRINT_WINDOWS. Mirroring the WINDOW is the load-bearing half: it re-bounds Sprint 26's
 * attribution to Aug 4-17, which is what finally gives Aug 16-17 a sprint instead of nothing.
 *
 * SPRINTS 19-23 MIRRORED, which is what the 08-14 pass was blocked on. The label indices are the
 * board's own and are NOT sequential — S22 is 3 and S23 is 4 while S19-S21 run 10-12. Never guess one.
 *
 * "FOR RE-SCOPING" — a group that did not exist before, holding 3 of our rows someone hand-triaged
 * there. `sync.ts` reconciles group-to-label, so the next full apply would have dragged all three
 * back out and silently erased the triage. Kane's call 2026-08-19: **protect the group.** PlanTask
 * gained `groupPinned`, `sync.ts` skips the move for a pinned row and reports it as
 * `tasksGroupPinned` rather than suppressing it silently. The LABEL stays reconciler-owned.
 *
 * HOW EVERY DATE WAS DERIVED — and the two traps that bit on the way.
 *   1. `--diff-filter=A` WITHOUT `--follow` is a trap the memory already recorded and this session
 *      re-hit: `4b323de` (05-27) is a docs REORGANISATION, so five features looked like they shipped
 *      that day. With `--follow` the answers move to 2026-04-16 / 2026-05-03 / 2026-05-07 —
 *      reproducing the exact dates memory had recorded, which is an independent cross-check.
 *   2. An over-broad name fragment silently matched TWO plan rows: "Webhooks admin" hit both the
 *      bank-info-notify row and the sample-payloads row, and would have dated the former three weeks
 *      late off the latter's commit. The generator refuses any fragment matching != 1 row.
 *   Confidence rule stated up front: HIGH = code artefact and doc agree on the SPRINT; MED = one
 *   signal only; anything whose signals disagree on the sprint is NOT written.
 *
 * WHAT THIS PASS WRITES. 43 Completed Dates, every one verified equal to its last sha's commit date
 * by `selfcheck()` and inside its sprint's attribution window. **No status moves, no Actual SP
 * recomputed** — all 43 rows were already Done and keep their score. Plus the 20 sprint moves out of
 * Backlog and the 39 pending S26 -> S25 moves the plan already carried.
 *
 * WHAT IS DELIBERATELY LEFT — 34 rows still undated, named so the next pass need not rediscover them.
 *   • Kane's scope call 2026-08-19 was **HIGH only** for Backlog FILING, so 24 rows stay in Backlog:
 *     9 MED (dates derived, held), 1 CONFLICT ("Bonus Calculator" — code 2026-05-05 in S19 vs doc
 *     2026-04-16 in S18, the sprints disagree so it is not written), 11 with no defining artefact at
 *     all (Mesa, Mobile responsiveness pass, per-tab ABAC, USD-PHP value-lock, Rate change history,
 *     Payroll performance indexes, Orphanage budget requests, Employee KPI results view, Applied-bonus
 *     tracking, Admin search bar, Per-tab edit permission), plus the 3 not-Done rows.
 *   • 5 Sprint 24 rows have no derivable artefact: Re-hires landing invisible, PAB payout-week gate,
 *     Time-adjustment segments, Master-list sync race, Collapsible sidebar redesign.
 *   • 4 Sprint 25 rows are a BOUNDARY finding worth its own look: Onboarding name split, Remove
 *     employee-facing PAB disputes, Weekly 100+300 ledger deposits, Profile name-parts editor. Every
 *     one dates to **2026-07-20**, a Sun/Mon GAP day that belongs to Sprint 24 by Kane's ruling — yet
 *     the board files them in Sprint 25. So either the date or the filing is wrong, exactly like the
 *     39. `selfcheck()` would REFUSE them, which is the guard working; they need a ruling, not a nudge.
 *
 * COST. FULL path — structure changed, so `--only-new` is WRONG. ~200 reconciler calls + 43
 * corrections + 43 evidence updates + the verify read.
  *
 * ── 2026-08-19, PASS 2 — CREDIT EVERY REMAINING ROW TO THE SPRINT IT FINISHED IN, 31 rows ────────
 * Kane, after pass 1 landed: "Credit it to the respective Sprints that it was actually completed that
 * means to fill the completed dates as well." That widened the HIGH-only scope of pass 1 to ALL of the
 * 30 rows it had deliberately held, and it RESOLVED the boundary question pass 1 could not settle:
 * the date wins and the filing follows it.
 *
 * PASS 1 RESULT, for the record: 139 patched · 59 moved (39 S26 -> S25 + 20 out of Backlog) · 43
 * Completed Dates written and verified · 0 created · 0 warnings · rollup unchanged at 1569/874. The
 * `groupPinned` protection worked on its first run — `tasksGroupPinned: 3`, so the three hand-triaged
 * "For Re-scoping" rows were NOT dragged out.
 *
 * WHAT PASS 2 ADDS.
 *   • 21 Done Backlog rows dated and filed into S17-S24. Backlog drops 24 -> 3.
 *   • 5 RE-ATTRIBUTIONS, the same bug class as the 39: "Collapsible sidebar shell redesign" was filed
 *     S24 but its one commit is 2026-07-02 (S23); the four name-split / ledger-deposit / PAB-dispute
 *     rows were filed S25 but all four land on 2026-07-20 — a Sun/Mon GAP day, which belongs to the
 *     sprint that CLOSED (S24) by the 2026-08-13 ruling. selfcheck() would have REFUSED them where
 *     they sat, which is how they were found.
 *   • 4 S24 rows dated in place.
 *   • The PHANTOM Actual SP cleared — see below.
 *
 * THREE JUDGMENTS WORTH RE-READING BEFORE ANYONE CHANGES THEM.
 *   1. "Bonus Calculator" was a real conflict in pass 1 — code 2026-05-05 (S19) vs doc 2026-04-16
 *      (S18). RESOLVED, not split: `bonus-calculator.md` was ADDED by `091cc0a`, a commit titled
 *      "PAB Orphanage Calculator" that carried pab-disputes routes and Hogan seed SQL. The doc there
 *      is a PLANNING doc that predates the feature, so it corroborates nothing and the code date wins.
 *   2. "Mobile responsiveness pass (all dashboards)" is the ONE row dated off commit MESSAGES, against
 *      this skill's own rule. It is a cross-cutting CSS pass with no artefact to point at, and four
 *      commits say so explicitly ("Mobile Responsiveness" x2 04-24, "System Improvements - Mobile CSS"
 *      04-25, "Admin Dashboard - Mobile Responsiveness" 05-06). Flagged so nobody reads it as ordinary.
 *   3. "Google Sheet sync crons" carried **Actual SP 5 while sitting at Ready to Start** — the
 *      invariant `verify.mts` had been failing on since before any of this. The plan said
 *      `done: true` while the board said Ready to Start: a real contradiction, because `sync.ts`
 *      writes Status only at CREATE, so a later hand-change to Ready to Start left the score stranded.
 *      Resolved in the direction that REMOVES an unproven claim — the plan's stale `done` was flipped
 *      to false so the two agree, and the corrector clears the phantom score. Estimated SP is a
 *      forecast and may sit on an open row; Actual SP is a record and may not. The row takes NO
 *      Completed Date because it is not shipped.
 *
 * S17 AND S18 were both mirrored even though only S17 receives a row: `taskSprintAttribution()` ends a
 * sprint the day before the next one STARTS, so omitting S18 would have let S17 absorb Apr 12-27 and
 * silently accept a date belonging to a sprint the plan could not name.
 *
 * STILL UNDATED AFTER THIS PASS: nothing that is Done. The only undated rows left are the 3 that are
 * not shipped — Google Sheet sync crons (Ready to Start) and the two Pending Deploy rows parked in
 * "For Re-scoping". A date on any of those would be an invented record.
 *
 * ── 2026-08-19, PASS 3 — THE SPRINT 27 PULL, 6 rows ─────────────────────────────────────────────
 * Kane: "any backlog or any future task that we may be possible to achieve you can mark the others as
 * ready to start as long as they are achievable within that period or any task from Sprint 26 that
 * were not achieved there just move it to this period." Folded into pass 2 rather than run separately,
 * on his call — both need a FULL reconcile and one apply costs ~200 calls instead of ~400.
 *
 * THIS PASS MOVES NO STATUS AND WRITES NO DATE. Every one of the 6 rows is open, so the entire board
 * change is the Sprint label + group move that `hris-plan.ts` carries, plus an evidence update saying
 * why the row is now in Sprint 27. They are in ROWS for that update and for one correction — see (3).
 *
 * "ANY TASK FROM SPRINT 26 THAT WAS NOT ACHIEVED" — there are none. All 23 Sprint 26 rows are Done and
 * dated inside Aug 4-15. Recorded because the instruction implies a rollover backlog that does not
 * exist, and the next reader should not go looking for it. Sprint 26 closed clean at 23/23, 100 SP.
 *
 * WHAT WAS **NOT** PULLED, deliberately: the 21 Done rows physically sitting in the Backlog GROUP.
 * "Move the backlog to Sprint 27" reads as covering them, and it must not — they are Apr-Jul history
 * worth 85 SP, and crediting them to Aug 18-29 would be the exact falsehood this skill exists to stop.
 * `selfcheck()` would refuse their dates anyway. Pass 2 re-files them into S17-S24 where they belong;
 * after both passes the Backlog GROUP holds 0 of our rows and Sprint 27 holds 6.
 *
 * "MARK THE OTHERS AS READY TO START" is applied to the rows it fits and NOT to the two it does not.
 * Four rows already read Ready to Start and keep it. The two offboarding/HSL rows read **Pending
 * Deploy**, which is AHEAD of Ready to Start: their code is on `origin/main` and only the prod
 * click-through is missing. Writing Ready to Start on them would move a row BACKWARDS and discard a
 * true status to satisfy the letter of an instruction — scheduling a row is not a statement about how
 * far along it is. Both keep their blocker. Flagged for Kane at the gate rather than done quietly.
 *
 * THREE THINGS THE SPRINT SHOULD KNOW BEFORE IT STARTS — each row's scope moved under it:
 *   1. "Google Sheet sync crons" has SHRUNK: 28cb65d (2026-08-07) retired the Google Sheet as an
 *      offboarding source outright, so a quarter of the row's title no longer describes live work.
 *      Re-scope before estimating against the old 5 SP.
 *   2. "HSL rate-history stale underpay" has a MOVED root cause: 273319a (2026-08-18) removed the
 *      snap-to-Sunday that c39fad3 introduced. The ≈₱1.06M / 121-under figure was derived under the
 *      old rule and must be re-derived before anyone pays against it.
 *   3. "Google Sheet sync crons" carried a phantom **Actual SP 5 while reading Ready to Start** — the
 *      invariant `verify.mts` sweeps for. Pass 2's header claimed this was cleared, but the row was
 *      never added to ROWS, so nothing would have cleared it; `sync.ts` cannot, because Actual SP is
 *      corrector-owned. Adding the row here for its Sprint 27 update is what actually closes it:
 *      `correctionValues()` writes `''` to Actual SP on any non-Done row. Found by reading the write
 *      path rather than the claim — the pass header is a claim like any other.
 *
 * THE PINS RELEASED. All three "For Re-scoping" rows were unpinned, so the reconciler moves them into
 * the Sprint 27 group. That reverses Kane's own 2026-08-19 morning ruling ("protect the group"), which
 * is why it was put to him explicitly rather than inferred: he answered by scoping the pull to "any
 * backlog or any future task that we may be possible to achieve", and all three are achievable inside
 * Aug 18-29. `groupPinned` stays in the codebase with zero users — the group still exists on the
 * board, so the next hand-triaged row needs it.
 *
 * COST. FULL path, shared with pass 2 — structure changed on 26 rows across both, so `--only-new` is
 * WRONG. ~200 reconciler calls + 36 corrections + 36 evidence updates + the verify read.
 *
  * ── APPROVAL ──────────────────────────────────────────────────────────────────────────────────────
 * Kane approved the 57-row re-attribution on 2026-08-13 ("Approve all") after reviewing it in full,
 * plus three rulings the same day: gap-day rows → Sprint 25; the group move belongs in `sync.ts`; the
 * Backlog rows out of scope. The budget then refused even a 1-call `boardGroups` on 08-13 AND again on
 * 08-14, so no `proposal.json` hash was ever minted to bind it to.
 *
 * On 2026-08-14 he approved that same set PLUS the three Backlog rows above, after a review of all 47
 * Backlog rows. That is why PASS_DATE moved to 08-14: the content changed and the approval is a new
 * one. This is NOT bumping the date to clear a hash mismatch — that remains forbidden, because a
 * mismatch on unchanged content means the board moved under you and the guard is working.
 *
 * WHAT THE APPROVAL COVERS — and nothing beyond it:
 *   • 20 rows confirmed in Sprint 26, 37 re-attributed to Sprint 25 (the exact set in ROWS below)
 *   • 3 rows re-filed Backlog → Sprint 26, unchanged in every other respect
 *   • a Completed Date on all 60, each equal to its last sha's commit date bar the 3 marked external
 *   • the group moves those 40 rows imply
 *   • NO row created, NO status changed, NO Actual SP recomputed
 *
 * So a later session may run `review.mts` and apply with the hash it mints WITHOUT re-asking — but
 * only if the proposal matches that shape. If the review turns up rows to CREATE, orphans, an
 * ambiguous duplicate name, or any status transition, that part is **not** approved: show Kane. An
 * "Approve all" is consent to a reviewed proposal, not standing consent to whatever the board holds
 * tomorrow.
 */
import { execFileSync } from 'node:child_process';
import { PLAN_TASKS, REPO_ROOT, TASK_SPRINT_LABELS, taskSprintAttribution } from './monday.mts';
import type { TaskStatus } from './monday.mts';

export const PASS_DATE = '2026-08-19';
export const AUDIT_RANGE = '0f2d75e..HEAD';
export const AUDIT_COMMITS = 884;
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
  {
    name: "USD⇄PHP conversion with cycle value-lock",
    status: 'Done',
    completed: '2026-04-08',
    shas: ['1a92511'],
    basis:
      "Completed 2026-04-08; Sprint 17. DATE BASIS (MED confidence): last implementing commit 1a92511 (2026-04-08) — fx/usd-php.ts + payroll/money-php.ts. Earliest post-reinit FX work; the cycle value-lock has no separate artefact. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Dashboard-only roles + per-tab ABAC + auto-provision on assign",
    status: 'Done',
    completed: '2026-04-30',
    shas: ['3fc0dc6', 'ea44b8c'],
    basis:
      "Completed 2026-04-30; Sprint 19. DATE BASIS (MED confidence): last implementing commit ea44b8c (2026-04-30) — rbac/ViewSwitcher.tsx + rbac/views.ts 04-16, then rbac/accounting-tabs.ts 04-30. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Delete Authorization",
    status: 'Done',
    completed: '2026-05-03',
    shas: ['f548a15'],
    basis:
      "Completed 2026-05-03; Sprint 19. DATE BASIS (MED confidence): last implementing commit f548a15 (2026-05-03) — f548a15 carried the delete-authorization doc (via --follow, NOT the 4b323de docs move). No distinct code artefact. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Bonus Calculator",
    status: 'Done',
    completed: '2026-05-05',
    shas: ['20c70dc'],
    basis:
      "Completed 2026-05-05; Sprint 19. DATE BASIS (MED confidence): last implementing commit 20c70dc (2026-05-05) — HslBonusCalculator.tsx + hsl-bonus routes + hsl-bonus/schema.ts. RESOLVES the doc conflict: bonus-calculator.md was ADDED by 091cc0a (2026-04-16) as a PLANNING doc inside a commit titled \"PAB Orphanage Calculator\", so the doc predates the feature and the code date is the honest one. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Mobile responsiveness pass (all dashboards)",
    status: 'Done',
    completed: '2026-05-06',
    shas: ['142473b', 'f1a75ae', '714d136', '89aa317'],
    basis:
      "Completed 2026-05-06; Sprint 19. DATE BASIS (MED confidence): last implementing commit 89aa317 (2026-05-06) — a cross-cutting CSS pass with NO single artefact, so uniquely here the commit MESSAGES are the evidence: \"Mobile Responsiveness\" 04-24 x2, \"System Improvements - Mobile CSS\" 04-25, then \"Admin Dashboard - Mobile Responsiveness\" 05-06 completing the last dashboard. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "CSV imports admin tab — split of legacy Csv Imports",
    status: 'Done',
    completed: '2026-05-07',
    shas: ['2b8fa40'],
    basis:
      "Completed 2026-05-07; Sprint 19. DATE BASIS (HIGH confidence): last implementing commit 2b8fa40 (2026-05-07) — 2b8fa40 added AdminCsvImports.tsx AND (via --follow) the csv-imports doc — code and doc agree on the same commit. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Orphanage budget requests + accounting approval",
    status: 'Done',
    completed: '2026-05-09',
    shas: ['f27d377', '6af31d9'],
    basis:
      "Completed 2026-05-09; Sprint 19. DATE BASIS (HIGH confidence): last implementing commit 6af31d9 (2026-05-09) — OrphanageBudgetForm.tsx 05-07, then orphanage-budget-requests routes + the /decide approval route + OrphanageBudgetHistory + supabase lib. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Rate change history + manager rate views",
    status: 'Done',
    completed: '2026-05-15',
    shas: ['7656e18', '58587aa'],
    basis:
      "Completed 2026-05-15; Sprint 20. DATE BASIS (HIGH confidence): last implementing commit 58587aa (2026-05-15) — hr/department-rates route 05-08, then employee-rate-history routes 05-15. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Payroll performance indexes + anti-lag pass",
    status: 'Done',
    completed: '2026-05-20',
    shas: ['9614bef'],
    basis:
      "Completed 2026-05-20; Sprint 20. DATE BASIS (HIGH confidence): last implementing commit 9614bef (2026-05-20) — references/sql/alter/add_payroll_performance_indexes.sql. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Mesa",
    status: 'Done',
    completed: '2026-06-02',
    shas: ['666ca74', 'bfcea8e', 'efbe777'],
    basis:
      "Completed 2026-06-02; Sprint 21. DATE BASIS (MED confidence): last implementing commit efbe777 (2026-06-02) — toggle-mesa-member 05-13, EmployeeMesa/HrMesa 05-14/15, mesa-requests + AccountingMesa 06-01, then the dispatch route 06-02. BROAD cluster — MESA ledger and per-stint accounts are separate S24 rows. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Urgent Payments",
    status: 'Done',
    completed: '2026-06-05',
    shas: ['1f41c15'],
    basis:
      "Completed 2026-06-05; Sprint 21. DATE BASIS (MED confidence): last implementing commit 1f41c15 (2026-06-05) — the urgent-payments doc (--follow). Distinct from the two later S25 urgent rows. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Payroll Wizard Final Pay",
    status: 'Done',
    completed: '2026-06-10',
    shas: ['1ebf6b3'],
    basis:
      "Completed 2026-06-10; Sprint 22. DATE BASIS (MED confidence): last implementing commit 1ebf6b3 (2026-06-10) — the payroll-wizard-final-pay doc (--follow). SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Per-tab edit permission enforced on all write APIs (block view-only writes)",
    status: 'Done',
    completed: '2026-06-11',
    shas: ['20c8024'],
    basis:
      "Completed 2026-06-11; Sprint 22. DATE BASIS (HIGH confidence): last implementing commit 20c8024 (2026-06-11) — rbac/ReadOnlyTab.tsx + rbac/view-tabs.ts + useFeaturePermissions.ts — one commit. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Bonus Catalog CRUD + formula engine — split of legacy 8-pt item",
    status: 'Done',
    completed: '2026-06-11',
    shas: ['783fecf'],
    basis:
      "Completed 2026-06-11; Sprint 22. DATE BASIS (MED confidence): last implementing commit 783fecf (2026-06-11) — the bonus-catalog doc. SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Employee KPI results view",
    status: 'Done',
    completed: '2026-06-16',
    shas: ['c6dc7d3'],
    basis:
      "Completed 2026-06-16; Sprint 22. DATE BASIS (HIGH confidence): last implementing commit c6dc7d3 (2026-06-16) — kpi-results route + EmployeeKpiResults.tsx + supabase/employee-kpi-results.ts — one commit. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Admin search bar + pages registry",
    status: 'Done',
    completed: '2026-06-17',
    shas: ['69c2c18'],
    basis:
      "Completed 2026-06-17; Sprint 22. DATE BASIS (HIGH confidence): last implementing commit 69c2c18 (2026-06-17) — AdminPages.tsx + usePagesVisibility.ts + pages/visibility.ts — one commit. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Onboarding Pay Plans",
    status: 'Done',
    completed: '2026-06-19',
    shas: ['cb67856'],
    basis:
      "Completed 2026-06-19; Sprint 22. DATE BASIS (MED confidence): last implementing commit cb67856 (2026-06-19) — the onboarding-pay-plans doc, shared commit with gmail-surname. SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Route Authorization",
    status: 'Done',
    completed: '2026-06-23',
    shas: ['07e4b9f'],
    basis:
      "Completed 2026-06-23; Sprint 23. DATE BASIS (MED confidence): last implementing commit 07e4b9f (2026-06-23) — the route-authorization doc. SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Applied-bonus tracking + cadence + manager history — split",
    status: 'Done',
    completed: '2026-07-07',
    shas: ['04541bc'],
    basis:
      "Completed 2026-07-07; Sprint 24. DATE BASIS (MED confidence): last implementing commit 04541bc (2026-07-07) — src/lib/payroll/bonus-cadence.ts. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "New Hire Checklist",
    status: 'Done',
    completed: '2026-07-10',
    shas: ['b504a17'],
    basis:
      "Completed 2026-07-10; Sprint 24. DATE BASIS (MED confidence): last implementing commit b504a17 (2026-07-10) — the new-hire-checklist doc; the code cluster spans 07-02..07-31 so the doc is the tightest marker. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 5 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Presence heartbeat + last-seen",
    status: 'Done',
    completed: '2026-07-10',
    shas: ['04541bc', '164732e'],
    basis:
      "Completed 2026-07-10; Sprint 24. DATE BASIS (MED confidence): last implementing commit 164732e (2026-07-10) — presence/GlobalPingListener.tsx + presence/page-label.ts 07-07, then the presence/active route 07-10. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Collapsible sidebar shell redesign",
    status: 'Done',
    completed: '2026-07-02',
    shas: ['d842f85'],
    basis:
      "Completed 2026-07-02; Sprint 23. DATE BASIS (HIGH confidence): last implementing commit d842f85 (2026-07-02) — CollapsibleSidebarShell.tsx + SidebarBrandMark.tsx + SidebarCollapseToggle.tsx + useSidebarCollapsed.ts — one commit. Was filed S24; 07-02 is Sprint 23. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Onboarding name split → structured first/last/extension columns",
    status: 'Done',
    completed: '2026-07-20',
    shas: ['602b004'],
    basis:
      "Completed 2026-07-20; Sprint 24. DATE BASIS (HIGH confidence): last implementing commit 602b004 (2026-07-20) — src/lib/name/name-parts.ts + its test. Was filed S25; 2026-07-20 is a Sun/Mon GAP day, which belongs to the sprint that CLOSED (S24) per the 2026-08-13 ruling. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Profile name-parts editor (First/Middle/Last/Ext/Nickname)",
    status: 'Done',
    completed: '2026-07-20',
    shas: ['602b004'],
    basis:
      "Completed 2026-07-20; Sprint 24. DATE BASIS (HIGH confidence): last implementing commit 602b004 (2026-07-20) — same name-parts.ts commit — the editor is the UI half of the split. Was filed S25; 07-20 is S24 by the gap-day rule. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Weekly 100+300 ledger deposits on upload + opt-in date derivation",
    status: 'Done',
    completed: '2026-07-20',
    shas: ['4be8cab'],
    basis:
      "Completed 2026-07-20; Sprint 24. DATE BASIS (HIGH confidence): last implementing commit 4be8cab (2026-07-20) — src/lib/mesa/record-weekly-contributions.ts. Was filed S25; 07-20 is S24 by the gap-day rule. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Remove employee-facing PAB disputes (keep manager calendar + API)",
    status: 'Done',
    completed: '2026-07-20',
    shas: ['c0ef4fb'],
    basis:
      "Completed 2026-07-20; Sprint 24. DATE BASIS (HIGH confidence): last implementing commit c0ef4fb (2026-07-20) — last commit touching employee/MyDisputes.tsx — the component still EXISTS, so the removal was an entry-point unwiring, not a file delete. Was filed S25; 07-20 is S24 by the gap-day rule. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 2 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Time-adjustment segments: require missed time-in/out (additive)",
    status: 'Done',
    completed: '2026-07-17',
    shas: ['c320fd1'],
    basis:
      "Completed 2026-07-17; Sprint 24. DATE BASIS (MED confidence): last implementing commit c320fd1 (2026-07-17) — pickaxe on time_in across supabase/time-adjustments.ts + the time-adjustments routes, only in-window hit. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "PAB payout-week gate + neutral mid-period Additions pill",
    status: 'Done',
    completed: '2026-07-17',
    shas: ['c320fd1'],
    basis:
      "Completed 2026-07-17; Sprint 24. DATE BASIS (MED confidence): last implementing commit c320fd1 (2026-07-17) — pickaxe on the payout-week concept across src/app, only in-window hit. SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Re-hires landing invisible (offboard-row reuse) — fixes",
    status: 'Done',
    completed: '2026-07-17',
    shas: ['c320fd1'],
    basis:
      "Completed 2026-07-17; Sprint 24. DATE BASIS (MED confidence): last implementing commit c320fd1 (2026-07-17) — last in-window commit changing off_board handling. SINGLE SIGNAL. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },
  {
    name: "Master-list sync race + orphaned-upload guard",
    status: 'Done',
    completed: '2026-07-18',
    shas: ['74a4146', 'c0dc608'],
    basis:
      "Completed 2026-07-18; Sprint 24. DATE BASIS (MED confidence): last implementing commit c0dc608 (2026-07-18) — last in-window commits touching the orphaned-upload path. Memory notes no hard lock exists, so this row is the guard, not a lock. Credited to the sprint the work actually finished in (Kane 2026-08-19). The row was already Done and keeps its 3 SP; no status moved and no Actual SP was recomputed.",
  },

  // ── PASS 3 — the Sprint 27 pull (Aug 18-29) ────────────────────────────────────────────────────
  // Six OPEN rows. Each carries its true current status unchanged, no Completed Date, and its
  // blockers. They are here for the evidence update that records the sprint move — and, for the
  // first one, to clear a phantom Actual SP that only the corrector can reach.
  {
    name: "Google Sheet sync crons (master / rates / HSL / offboarded) — split of legacy Csv Imports",
    status: 'Ready to Start',
    shas: ['d96e77d', '28cb65d'],
    basis:
      "Pulled Backlog → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction to schedule any backlog work achievable in the period. NOT shipped, so no Completed Date and no Actual SP — and this pass CLEARS the phantom Actual SP 5 the row was carrying while reading Ready to Start, which is the invariant verify.mts sweeps for. RE-SCOPE BEFORE ESTIMATING: 28cb65d (2026-08-07) retired the Google Sheet as an offboarding source outright, so the 'offboarded' quarter of this row no longer describes live work and the 5 SP predates that.",
    blockers: ['Re-scope: the offboarded-sheet source was retired by 28cb65d, so part of the original scope no longer exists'],
  },
  {
    name: "Run outstanding Supabase migrations + re-import n8n workflows (12+ pending SQL files)",
    status: 'Ready to Start',
    shas: ['b2ef23f', 'eff111d', '70f9678'],
    basis:
      "Pulled Sprint 25 → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction, and unpinned out of 'For Re-scoping'. Critical: this row is what makes other shipped code actually live — several features are code-complete and functionally dead until their migration runs. Note b2ef23f ('stop claiming applied migrations are pending') — the pending LIST must be re-derived with audit-pending-migrations.mts before the work starts, because migration-pending claims in this repo are folklore more often than not. Not shipped: no Completed Date, no Actual SP.",
    blockers: [
      'The pending set must be re-derived (audit-pending-migrations.mts) — do not trust the "12+" in the title',
      'Kane cannot paste SQL into Supabase: each change ships as a Node script behind an --apply gate',
    ],
  },
  {
    name: "Offboarding is delete-only: suspend is its own path, suspended-person offboards escalate to delete, and leavers get a correct final check",
    status: 'Pending Deploy',
    shas: ['3502e93', 'd259040', '8497699'],
    basis:
      "Pulled Backlog → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction, and unpinned out of 'For Re-scoping'. Status is UNCHANGED at Pending Deploy and was deliberately NOT written down to Ready to Start: the code is on origin/main (3502e93 2026-08-07, d259040 + 8497699 2026-08-10) and only the prod click-through is missing, so Ready to Start would move the row backwards. Scheduling a row is not a claim about how far along it is. 8 SP is a legal task score — the next Fibonacci step is 13 — so this needs no decomposition.",
    blockers: ['Nobody has confirmed the delete-only routing and the suspend path in production — that click-through is the only thing between this and Done'],
  },
  {
    name: "One HSL department + required sub-department that sets the base rate, wired through the Payment Catalog",
    status: 'Pending Deploy',
    shas: ['5cb9bc6', 'f14f5b3', 'da24ffb', '4a15db2'],
    basis:
      "Pulled Backlog → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction, and unpinned out of 'For Re-scoping'. Status UNCHANGED at Pending Deploy for the same reason as the offboarding row. The blocker recorded on 2026-08-14 — zero hsl:* rate rows, which made the feature pay nobody differently — has since been worked: 5cb9bc6 bulk-assigned sub-departments, f14f5b3 set a base rate per sub-team and released the HARD HOLD, da24ffb deleted the parent base row, 4a15db2 merged the GML roster. That is evidence the blocker MAY be closed, not proof, and a row is never promoted because its blocker looks stale. 8 SP is a legal task score.",
    blockers: ['Confirm in prod that a sub-department assignment actually sets the base rate a person is paid on — the original blocker was that it silently did not'],
  },
  {
    name: "HSL rate-history stale underpay — arrears remediation (≈₱1.06M, 121 under / 10 over)",
    shas: ['c39fad3', '210b9ad', '273319a'],
    status: 'Ready to Start',
    basis:
      "Pulled Sprint 25 → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction — open work carried forward out of a sprint that closed 2026-08-01. THE FIGURE IS STALE: 273319a (2026-08-18) REMOVED the snap-to-Sunday that c39fad3 introduced and which memory records as the root cause, so the ≈₱1.06M / 121-under / 10-over arrears set was computed under a pricing rule that no longer exists. Re-derive against the current proration before paying anyone. Not shipped: no Completed Date, no Actual SP.",
    blockers: ['Arrears must be recomputed under the post-273319a proration rule; the recorded ₱1.06M predates it'],
  },
  {
    name: "Legacy rates-sheet cell can route null-preferred → hurupay: decision + guard",
    status: 'Ready to Start',
    shas: ['917309d', '1419a6b'],
    basis:
      "Pulled Sprint 25 → Sprint 27 (Aug 18-29) on Kane's 2026-08-19 instruction — open work carried forward out of a closed sprint. 917309d measured the blast radius read-only and 1419a6b wrote the seed script behind an --apply gate, but the gate has never been opened, so the bypass is still live: the legacy rates-sheet cell can still route a null-preferred payee to hurupay, around the WIRES lock. The row is the DECISION plus the guard, and neither has been made. Not shipped: no Completed Date, no Actual SP.",
    blockers: ['The --apply on 1419a6b is unrun and needs Kane; a SELECT backup to disk is required first (bulk UPDATE rule)'],
  },
];

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
