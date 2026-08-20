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
 *
 * ── 2026-08-20, PASS 4 — CLOSE THE MIGRATIONS ROW, AND THE THREE THINGS MEASURING IT FOUND ──
 * Kane: "go", after being shown the three findings below.
 *
 * ROWS WAS REWRITTEN, not appended to. pass.mts is a PER-PASS data file, and the 30 rows of pass 2/3
 * are applied and verified. Keeping them would re-post 30 evidence updates stamped "board sync pass
 * 2026-08-20" onto rows that completed in April-July — a false claim in the audit trail, for zero
 * board change. Their basis text lives in git history, the feature doc and memory.
 *
 * WHAT CLOSED, and the one soft spot in its evidence.
 * "Run outstanding Supabase migrations + re-import n8n workflows (12+ pending SQL files)" -> Done.
 *   - SQL: measured, not assumed. audit-pending-migrations.mts returned APPLIED 21 / NOT APPLIED 1 /
 *     INCONCLUSIVE 3. "12+ pending" was ONE. That one was restore_active_employees_definer; Kane ran
 *     it and it verified three ways (pg_class.reloptions reads security_invoker=false, anon on
 *     active_employees went 0 -> 1307 matching service-role, verify-active-employees-roster.mjs
 *     passed with both leak views still closed to anon).
 *   - The 3 INCONCLUSIVE rows were CHECK constraints PostgREST cannot read. Kane pasted
 *     pg_get_constraintdef: people.banking.overridden present; pab.excluded / pab.restored ABSENT,
 *     and so was kpi.scored, which nobody had asked about. He then applied the 08-17 superset file
 *     and reported "Success. No rows returned".
 *   - n8n: all ten workflows settled on Kane's confirmation — eight done, bank-info-missing-notify
 *     working, hubstaff-weekly-auto-sync DEPRECATED (so there is now NO scheduler for the weekly
 *     Hubstaff pull; it is a manual button press).
 *   - SOFT SPOT, recorded rather than glossed: the independent pg_constraint RE-read after the write
 *     was NOT obtained. The evidence for that final DDL is Kane's report that it succeeded. That is
 *     admissible — his confirmation counts and is named here as the basis rather than assumed — but
 *     it is weaker than the three-way proof the definer fix got. dateBasis 'external' for exactly
 *     that reason: the completion is an action in another system, not a commit.
 *
 * TITLE NOT CORRECTED, deliberately. The parenthetical is provably wrong, and fixing it would ORPHAN
 * the row: item names are set at CREATE only, so a rename mints a duplicate and abandons the old row
 * with its execution state. The correction goes in the evidence update instead.
 *
 * THE THREE NEW ROWS came out of measurement, not planning — which is the part worth keeping:
 *   1. kpi.scored FIRES ON MONTHS-OLD WEEKS. hsl_bonus_period_status holds 181 dept-weeks at 'ready'
 *      spanning 2026-03-01..2026-08-09, all with ZERO kpi.scored rows. The de-dupe key is the AMOUNT,
 *      so with no prior notification every one reads as owed. Before the CHECK fix the insert threw
 *      and nothing happened; now it succeeds — so a routine bonus edit on a March week notifies
 *      employees about a five-month-old result. Floor the notifier by period.
 *   2. NOTIFICATION FAILURES ARE SWALLOWED. Three notifyKpiScored call sites console.warn ("a notify
 *      failure never fails the submission") and the PAB route console.errors and returns
 *      notified:false. That is WHY two dead features went unnoticed — 17 days for PAB, 3 for KPI.
 *      A console line in a serverless function is not observability.
 *   3. PAB EXCLUSIONS ARE UNAUDITED. audit_log has 41,103 rows and audits PAB *disputes*
 *      (pab_dispute.approved, seen 2026-08-19) but ZERO rows match an exclusion change, while 107
 *      person-month exclusions are on record. So the action that zeroes an attendance bonus leaves no
 *      trace of who or when, and the set of people OWED a pab.excluded notification is NOT
 *      reconstructible — stated as a limit, not worked around.
 *
 * COST. --only-new is CORRECT here: this pass only ADDS rows and corrects them, 6 calls instead of
 * ~200. The tradeoff is real and accepted — it writes NO epic relation, so the three new rows are
 * correctly grouped/typed/scored/statused but unlinked from HRIS-06 / HRIS-15 / HRIS-02b until the
 * next full reconcile adopts them by name.
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

export const PASS_DATE = '2026-08-20';
export const AUDIT_RANGE = '9fe6504c..HEAD';
export const AUDIT_COMMITS = 83;
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
  // ── the 22 rows Kane confirmed live in production 2026-08-20 ─────────────────────────────────
  // ONE basis covers all of them and is stated on each: asked explicitly whether the week's shipped
  // work had been used in prod, he answered that it had. That confirmation IS the evidence the
  // honesty gate asks for, and it is recorded rather than assumed. Everything here is also an
  // ancestor of origin/main (ca8721dc) and carries no .sql, no apply-*.mjs and no workflow json, so
  // no external step ever stood between any of them and live.
  {
    name: 'Employee payroll-processing bar sweeps one direction, driven by CSS',
    status: 'Done',
    completed: '2026-08-13',
    shas: ['2086cd06', '8c78f91c'],
    basis:
      'Done 2026-08-13; Sprint 26. The processing bar animated in both directions and was driven by Framer Motion; it now sweeps one way from a CSS keyframe. Kane confirmed 2026-08-20 he has used this in production. On origin/main, three files, no external step.',
  },
  {
    name: 'HSL Lead Nurture sub-team retired — Simple Texting is the only placement-only team',
    status: 'Done',
    completed: '2026-08-13',
    shas: ['6835f4b2', 'b05a4301'],
    basis:
      'Done 2026-08-13; Sprint 26. Retirement follows the documented ordering — code first, rate row second — so 6835f4b2 removed the sub-team from hsl-subdept.ts and the schema with tests, and b05a4301 deleted the now-orphaned rate row under a separate explicit approval with a SELECT backup written to disk first (backup_hsl_pay_structures_2026-08-13T14-07-03-564Z.json, in the diff). Simple Texting is now the only placement-only sub-team. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'HSL sub-departments bulk-assigned from the KPI Role column (482 people) plus the EGS, Mail Sorting and Executive Assistants rosters',
    status: 'Done',
    completed: '2026-08-14',
    shas: ['0f2bbd9e', '5cb9bc6e', 'e3da4a17', '6e2d255e'],
    basis:
      "Done 2026-08-14; Sprint 26. 482 people re-keyed from the KPI Role column by bulk-assign-hsl-subdepartments.mts, with Executive Guest Services, Hearing Prep Team - Mail Sorting and Executive Assistants seeded, and both Guard-8 divergence reports closed by hand (valeriec@ to HSL, chariso@ to Client VA). Every step wrote a SELECT backup first — four backup JSONs and a plan CSV are in the diff. DELIBERATELY NOT the same row as the 8-SP \"One HSL department + required sub-department\" model row: that one is the dept/sub-dept model and its Payment Catalog wiring, this one is the data migration that populated it, and f14f5b35 / da24ffb6 / e68195d7 (per-sub-team base rates, parent-row annihilation, the picker fix) belong to that row rather than this one. Kane confirmed 2026-08-20 he has used this in production.",
  },
  {
    name: 'Employee department directory with SP rankings and per-team policies',
    status: 'Done',
    completed: '2026-08-14',
    shas: ['473f86d4'],
    basis:
      'Done 2026-08-14; Sprint 26. A new team tab named after the employee\'s own department, a /api/team-rankings route, a tested rankings reader and a tested per-team policies module. Ranking is a TIER flag and never shows pesos; the policies drive no logic. Nine files, 2,184 lines. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Reopen a closed pay cycle, and fire the completion confetti on a clean close',
    status: 'Done',
    completed: '2026-08-14',
    shas: ['1ac87fa6', 'c35d6da8', '3a50322f'],
    basis:
      'Done 2026-08-14; Sprint 26. Reopen is not the inverse of close: it burns the claim, archives the record under a prefix the close-out scan deliberately does not see, and suppresses the re-fire. Alongside it the completion confetti gained its second trigger, and 3a50322f settled the rule that a close still owing people celebrates anyway — closed is closed. Two API routes, a store, a trigger module and its tests. 0e402a0d is EXCLUDED from the shas: it carries only .claude/settings.json and one cycle_complete_claim backup JSON produced by exercising this, so it is an artefact of the work rather than part of it. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Payroll Wizard Processing Tutorial Mode — chat-head guide, Sun–Sat processing narrative and rings on the real controls',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['afc5128f', '97668362', '17339b8a', '97c3d235', '012e619a'],
    basis:
      'Done 2026-08-17; Sprint 26 (Aug 17 is a gap day, which the closed sprint absorbs). Five commits: the tutorial subsystem and Sun–Sat processing narrative with tested guide and narrative modules plus a new audit-week route (afc5128f), the panel-and-modal shell replaced by a chat head (97668362), that head restyled to the wizard indigo (17339b8a), moved off the Payroll Notes readiness FAB it was covering (97c3d235), and finally pointed at the REAL controls — FX boxes, HSL columns, PAB month (012e619a). Scored 8 on Kane\'s big-ticket ruling and kept as a task row linked to HRIS-02a. The invariant that keeps it safe: the guide NEVER gates a control and the narrative is render-only, so the whole thing is removable via the [WIZARD-TUTORIAL] markers. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'KPI Calculator scoring autosaves — the Save button is gone',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['de28167b'],
    basis:
      'Done 2026-08-17; Sprint 26. The Save button is removed and scoring persists as it is entered, gated by kpiAutosaveGate: never persist a load-seeded value and never persist a just-failed one, or a calculator that failed to load would silently overwrite real scores with blanks. Applied across both DeptBonusCalculator and HslBonusCalculator; SUBMISSION stays manual. New tested module, eight files, 867 lines. Known open thread carried forward rather than hidden: the executive_assistants case still lacks a test. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Tech Bonus week picker becomes a calendar behind a Change week toggle, and the picked week fires that week everywhere',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['08e7fcba', 'ff772591', '836e3d7c', '8f92a283'],
    basis:
      'Done 2026-08-17; Sprint 26. The picker became a calendar (08e7fcba), was reduced to a plain small one and shed a phantom salary badge (ff772591), had the picked week pinned end-to-end so it fires THAT week at every gate rather than today\'s (836e3d7c), then retracted behind a Change week toggle (8f92a283). The pinning is the load-bearing part and follows the standing rule that every gate resolves through resolveIsTechBonusWeek and never the raw flag. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Wizard step-2 conversion rates become cards with flag pairs; Additions declutter behind info icons',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['04142ef7', 'bbae3b19', 'ca4cf533'],
    basis:
      'Done 2026-08-17; Sprint 26. Step-2 conversion rates became cards with the reference detail behind info icons (04142ef7, which also added a Base UI popover to components/ui and one index.css rule), then gained flag pairs (bbae3b19); the Additions step retired its trashcan and moved two texts behind info icons (ca4cf533). Presentation only — no rate, gate or total changed. The COP card stays teal, never amber, because amber means warning on these cards. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Notification chimes are view-scoped so HR no longer hears money',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['4e8309af'],
    basis:
      'Done 2026-08-17; Sprint 26. The chime had a single unscoped mount, so an HR user heard payroll money land. Every mount now passes a view and the pairing is tested (notification-views.test.ts), with a 100-line doc added. THE COMMIT MESSAGE IS THE WHOLE STORY OF WHY THIS ROW DID NOT EXIST UNTIL TODAY: it is literally "Push". Clustering this range by message rather than by file overlap would have missed the feature entirely. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Salary “Ready to View” card discloses that bonuses are not in yet',
    status: 'Done',
    completed: '2026-08-17',
    shas: ['6c494769'],
    basis:
      'Done 2026-08-17; Sprint 26. Seventeen lines on one card so an employee opening "Ready to View" is told the figure does not yet include bonuses, rather than reading a total that later moves. Scored 1 — the floor — because it is copy on an existing surface, but it is a real change to what an employee is told about their pay. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Mid-week rate-change effective dates are real — snap-to-Sunday removed, changed weeks price 2dp legs, HSL transition OT counts every hour',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['273319a7'],
    basis:
      'Done 2026-08-18; Sprint 27. A payroll RULING rather than a UI change, scored 8 on Kane\'s big-ticket rule and linked to HRIS-02b. Snap-to-Sunday was the root cause of the mid-week underpay and is deleted; a week containing a rate change now prices two legs at 2dp; and OT across an HSL transition counts EVERY hour rather than only the post-transition ones. 16 files including audit-midweek-effective-date-underpay.mts and fix-midweek-transfer-effective-dates.mts, both run. THIS REVERSES A ROW THIS BOARD ALREADY MARKED DONE: "Rate-history effective_from snapped to the pay-week start" (c39fad3b, 3 SP, Done 2026-08-04) introduced exactly the snap this deletes. That row keeps its SP because it was real, shipped work, but it no longer describes how the system behaves and has been given its own superseding update. Kane confirmed 2026-08-20 he has used this in production; re-lock after deploy.',
  },
  {
    name: 'Payroll Readiness recent-changes activity feed, and KPI rows show who submitted and when',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['a44098be'],
    basis:
      'Done 2026-08-18; Sprint 27. An activity feed at the bottom of each pane plus submitted-by and when on KPI rows. Deliberately narrow: audited SAVES only and never presence, and templates never print details. Where a KPI submitter is unknown it falls back to locked_by with NO timestamp rather than inventing one. Seven files, new tested module. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Payroll Notes Offboarded pane cached and live with filters, a per-pane data-pull stamp and a Realtime signal dot',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['ce4e5e22', 'ce4ead97'],
    basis:
      'Done 2026-08-18; Sprint 27. The Offboarded pane became cached+live with search and a dept filter, every pane now stamps its own "Last data pull", and the Rates tab was removed (ce4e5e22); then each freshness line gained a Realtime signal dot — emerald for a live subscription at ~1s, amber for the ~30s poll — with an honest pre-subscribe default rather than an optimistic green (ce4ead97). Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Wizard Reports and Overview CSV itemize bonuses and adjustments end-to-end',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['89c7aa5c'],
    basis:
      'Done 2026-08-18; Sprint 27. Bonuses and adjustments are itemized through the shared report-rows builder, so the wizard Reports table, the PDF and the Overview CSV agree line for line — held by an identity test rather than by three parallel implementations. A payout-extras fetch failure now ABORTS the export instead of quietly producing a short one, which is the part that matters: a silently incomplete payroll export is worse than no export. Nine files, one new route. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Overview Tech Eligible badge uses the wizard’s own 30-day pay gate',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['42137521', 'c4f160b5'],
    basis:
      'Done 2026-08-18; Sprint 27. The badge computed its own eligibility and could therefore disagree with the wizard that actually pays. Both now call the SAME shared predicate, anchored on the cycle week start rather than on today. c4f160b5 is the INDEX.md row mapping the memory entry to the Accounting surface — a one-character diff, included because it is what makes the rule findable next time. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Orphanage OT prices at the full 1.5× rate, never the 0.5× differential',
    status: 'Done',
    completed: '2026-08-18',
    shas: ['41a21ae1'],
    basis:
      'Done 2026-08-18; Sprint 27. Seventeen lines, and money: orphanage OT was pricing at the 0.5× weekly differential that the HSL sheet-form rule uses, instead of the full 1.5×. The two rules genuinely differ — weekly HSL OT is a derived 0.5×, orphanage OT is a full 1.5× — and the code had collapsed them into one. Scored 2 rather than 1 because the diff size understates it: this is an underpay class, not a cosmetic fix. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'People → Bank changes band: send-from and payable-per-rail cards, per-rail counts, dept filter, no bank names',
    status: 'Done',
    completed: '2026-08-19',
    shas: ['2c4df1fc', 'bac166f1', '633104d2'],
    basis:
      'Done 2026-08-19; Sprint 27. Opened with send-from and receiving-bank KPI cards (2c4df1fc), widened to per-rail counts, a rail split and a dept filter that scopes the whole band (bac166f1), then settled as TWO RAIL-shaped cards with no bank names anywhere (633104d2) — the final rule, and the one the row describes. Roster-scoped rather than feed-scoped; HiGlobe reads as wallet and Wise as bank; Wepay is dropped by rule. Twelve files, a tested bank-mix module. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Gift Tracker tenure-gift roster export (CSV/XLSX/PDF) at master-list grain',
    status: 'Done',
    completed: '2026-08-19',
    shas: ['0d1d3960'],
    basis:
      'Done 2026-08-19; Sprint 27. A three-format export built at MASTER-LIST grain, which is the whole design: people who never submitted a shipping address are the POINT of the report, not an omission from it, so the roster leads and submissions join onto it. Off-roster submitters are appended and flagged rather than dropped. No price and no payment appears anywhere — the gift feature is info-only. Seven files, 1,714 lines, new tested module. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'HSL KPI roster merged with the Global Master List — a placement alone reaches the Wizard rail',
    status: 'Done',
    completed: '2026-08-19',
    shas: ['91056fa5', '54d8a197', '01c97f6d', '4a15db2c'],
    basis:
      'Done 2026-08-19; Sprint 27. The Global Master List is merged into the team-members roster, so a placement alone now reaches the Wizard rail; the plain-name fallback was deliberately DROPPED, which is what strands cjm@, jamec@ and ellyt@ until they are placed properly. Ten files, a tested pure merge function and a live read-only verifier. A DATE TRAP WORTH RECORDING: the branch commits are authored AND committed 2026-08-03, but the work did not land until the 4a15db2c merge on 2026-08-19. The merge sha is therefore listed LAST on purpose — selfcheck() derives the Completed Date from the final sha, so ending on 01c97f6d would have dated this Aug 3 and filed a fortnight of unmerged work into Sprint 25. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'p-0 dialogs get a dvh height cap so a modal footer can never go unreachable',
    status: 'Done',
    completed: '2026-08-19',
    shas: ['531613f9'],
    basis:
      'Done 2026-08-19; Sprint 27. The milestone modal did not fit small viewports and its footer was unreachable. Root cause is general, not local: the base DialogContent has NO height cap at all, so any p-0 dialog must add gap-0 plus a dvh cap itself. Scored 2 rather than 1 for that reason — the finding applies to every p-0 dialog in the app, and is now written down. Kane confirmed 2026-08-20 he has used this in production.',
  },
  {
    name: 'Payment Catalog Bonus Library cards get an Edit button',
    status: 'Done',
    completed: '2026-08-19',
    shas: ['94531923'],
    basis:
      'Done 2026-08-19; Sprint 27. An Edit button on the Bonus Library cards, so a bonus can be corrected in place instead of deleted and re-added. Two files, 59 lines. Kane confirmed 2026-08-20 he has used this in production.',
  },

  // ── the 3 rows that CANNOT be Done, measured against the live database 2026-08-20 ────────────
  // Kane's confirmation covers the 22 above and was asked for row by row; it is deliberately NOT
  // applied to these three, because no assertion can create a table or a column. Each carries the
  // measurement that settles it, so none of this rests on a doc or a memory line saying PENDING —
  // five such claims in this repo have turned out stale.
  {
    name: 'kpi.scored employee notification — toast plus live update the moment a dept-week is scored',
    status: 'Pending Deploy',
    shas: ['31b11050'],
    basis:
      'Pending Deploy, NOT Done; Sprint 26. Fifteen files, an employee toast, a live update on scoring, and its own DDL adding the kpi.scored notification type. The type CHECK was rejecting every insert until the superset file was applied on 2026-08-20, and all four call sites swallow a failed notify into console.warn, so the failure was invisible for three days. MEASURED THIS MORNING, after that DDL landed: employee_notifications still holds ZERO kpi.scored rows, against 3,694 payroll.available. The insert can now succeed but nothing has ever been delivered, so nobody has seen this feature work — which is precisely the gap between Pending Deploy and Done. Two follow-up rows are already open against it (the months-old-week floor, and making swallowed notify failures observable).',
    blockers: [
      'No kpi.scored notification has ever been delivered — score a dept-week and confirm the employee receives it',
      'Fix the period floor first: 181 ready dept-weeks back to 2026-03-01 currently read as owed a notification',
    ],
  },
  {
    name: 'Employee Penny AI on the Overview — Haiku, self-only tools, 10 prompts per Manila day, with guides and rendered Markdown',
    status: 'Pending Deploy',
    shas: ['70f96781', '1aa281ab', '39fe7255', '9d40a096', 'efec41aa', 'b1b893d0', 'f4abd38c', 'ea348fda', '7d7688cc'],
    basis:
      'Pending Deploy, NOT Done; Sprint 27; scored 8 on Kane\'s big-ticket rule. Nine code commits plus the asset commit e8ef4ff2: the Overview bubble on Haiku with tools that take no email argument (70f96781), Markdown actually rendered rather than printed raw (1aa281ab), self-service guides for COE, pay stubs and filing leave (39fe7255), a fix so employees are no longer told old PAID weeks are "pending" (9d40a096), a 5s greeting (efec41aa) whose timer would never have fired (b1b893d0), a bigger bubble minus the PAB verdict (f4abd38c), and five rotating greeting chips (ea348fda, 7d7688cc). MEASURED 2026-08-20: the table penny_employee_usage DOES NOT EXIST in production. PGRST205, byte-identical in shape to what a control table named definitely_not_a_table_xyz returns, so this is a real absence and not a permissions artefact. The row COUNT is the quota and the check fails closed, so the feature cannot serve a single prompt. The volume of polish on top of it is exactly why this needed measuring rather than assuming: it looks finished.',
    blockers: [
      'Run references/sql/create/2026-08-19_penny_employee_usage.sql (or node scripts/apply-penny-employee-usage.mjs --apply) — the table is absent, so the quota gate fails closed and Penny answers nobody',
    ],
  },
  {
    name: 'Time adjustments need two sign-offs — the manager names a second approver per request',
    status: 'Pending Deploy',
    shas: ['eff111db'],
    basis:
      'Pending Deploy, NOT Done; Sprint 27. Dual sign-off that can land in either order, with the manager naming a second approver per request — naming someone grants access to THAT row only and is additive to the department check, never a replacement. Thirteen files, 1,542 lines, two new routes. MEASURED 2026-08-20: all four of second_approver_email, second_approver_assigned_by, second_decision and manager_decision are ABSENT from time_adjustment_requests (the table holds 4 rows: 1 approved, 3 manager_denied). The migration has not run, so the feature is code-complete and functionally dead — the canonical case the honesty gate exists for.',
    blockers: [
      'Run references/sql/alter/2026-08-19_time_adjustment_second_approver.sql (or node scripts/apply-time-adjustment-second-approver.mjs --apply) — all four columns are absent',
    ],
  },

  // ── Backlog · Unscheduled — three rows opened by MEASUREMENT today, not by a doc claim ───────
  {
    name: 'audit-pending-migrations reports a MISSING table as APPLIED — head:true returns no error',
    status: 'Ready to Start',
    shas: ['b2ef23fd', 'f18c8123'],
    basis:
      'Backlog, CRITICAL, opened 2026-08-20 by measurement. scripts/audit-pending-migrations.mts is the tool this project uses to replace "PENDING" folklore with an observation, and for TABLES it returns the wrong answer. probeTable() does select(\'*\', {head:true, count:\'exact\'}) and then treats a falsy error as APPLIED — but PostgREST returns NO ERROR AT ALL for a table that does not exist under head:true, just count:null. Proven twice today: penny_employee_usage (genuinely absent) and a control table named definitely_not_a_table_xyz both come back clean, while the positive control employee_notifications returns count=181799 — which is why this never surfaced. probeColumn() fails differently: a missing column errors with code:undefined and an empty message, so it matches neither the 42703 branch nor the regex nor the PGRST205 branch, and lands INCONCLUSIVE instead of NOT APPLIED. CONSEQUENCE, stated plainly: any table-creating migration that never ran was counted APPLIED, and the Sprint 27 row "Run outstanding Supabase migrations..." was closed Done on 2026-08-20 on the strength of that audit\'s APPLIED 21 / NOT APPLIED 1 / INCONCLUSIVE 3. The fix is to drop head:true for existence probes (a plain .limit(1) DOES error correctly) and to treat an empty-code error as NOT APPLIED rather than INCONCLUSIVE. Not fixed in this pass on purpose: it is a non-trivial correctness edit to existing code and belongs behind the hardening skill.',
    blockers: ['Re-run the auditor after the fix and re-adjudicate the Sprint 27 migrations row against the corrected verdicts'],
  },
  {
    name: 'Lawang rate shadow: hours ride lawangc@ on a stale 175 employee-scope override',
    status: 'Ready to Start',
    shas: ['4447e404'],
    basis:
      'Backlog, opened 2026-08-20. Hours ride lawangc@ against a stale employee-scope override of 175 while the real identity sits on a separate row, so the wrong rate prices the work. scripts/fix-lawang-rate-shadow.mts exists and has NEVER been run. WHERE IT WAS HIDING: it was committed inside 4447e404, whose entire commit message is "ss" — the second of four misleading messages in this range, and the reason this never reached the board. Blocked on Kane, by project rule: it is a bulk UPDATE, so it needs a SELECT backup written to disk first and an explicit --apply.',
    blockers: ['Kane to approve and run scripts/fix-lawang-rate-shadow.mts --apply, SELECT backup first'],
  },
  {
    name: 'Five employees still hold a rate override keyed to the retired bare hsl department',
    status: 'Ready to Start',
    shas: ['da24ffb6', '4a15db2c'],
    basis:
      'Backlog, opened 2026-08-20 by measurement. payment_catalog_pay_structures holds five live rows with scope=\'employee\' and department_key=\'hsl\' — glendac@, domv@, beao@, joee@ and jesr@ — all stamped created_by "rate-divergence fix 2026-07-29", at 265/397.50 and 225/337.50. WHAT WAS CHECKED AND CLEARED: no DEPARTMENT-scope bare-hsl row exists, so the parent-department cutover claim (parent base row DELETED) holds and is NOT contradicted. The finding is narrower and still real: bare "HSL" is no longer a placeable department, yet five people carry a personal override keyed to it, and nothing re-derives those rows. That is the same shape as the Lawang rate shadow — a stale employee-scope override outranking the correct sub-team rate — which is why it is worth a row rather than a note.',
    blockers: ['Decide per person: re-key to the correct hsl:* sub-team, or delete the override and let the sub-team base rate apply'],
  },

  // ── one already-Done row that needs a correction posted, not a status change ─────────────────
  // Kane's call 2026-08-20, asked explicitly: leave it Done with its 3 SP, and post a superseding
  // update. It keeps its SP because it was real work that shipped and was correct when it shipped;
  // it gets the update because the board should not silently assert a rule that has been deleted.
  // The name cannot be fixed — item names are set at CREATE only, so a rename orphans the row and
  // mints a duplicate.
  {
    name: 'Rate-history effective_from snapped to the pay-week start',
    status: 'Done',
    completed: '2026-08-04',
    shas: ['c39fad3b'],
    basis:
      'SUPERSEDED 2026-08-18 — this row stays Done and keeps its 3 SP, but it no longer describes how the system behaves. The snap-to-Sunday it shipped was later identified as the ROOT CAUSE of a mid-week underpay and was REMOVED by 273319a7 ("Mid-week rate-change effective dates are real"), which now prices a changed week as two 2dp legs from the real effective date. Read the Sprint 27 row for the current rule; read this one only as history. Nothing about the original work was wrong at the time: mid-week effective dates were producing inconsistent history and snapping them was a defensible fix, which is why the SP is not clawed back. The status and date are unchanged — only this update is new.',
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
