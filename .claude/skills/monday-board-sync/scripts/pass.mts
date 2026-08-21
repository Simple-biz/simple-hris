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
 *
 * ── 2026-08-20, PASS 6 — THE FOUR THINGS YESTERDAY'S LOG MISSED ────────────────────
 * Kane: "Every single success yesterday that wasnt added to the monday board let us push to monday."
 *
 * ROWS rewritten again (per-pass file). Pass 5's 29 rows applied at 09:05 under hash ddfcf89d9558.
 *
 * HOW THE GAP WAS FOUND. Every 2026-08-19 commit was listed, clustered on FILE OVERLAP, and matched
 * against the 170 plan rows. 22 commits; pass 5 covered the headline features. Four clusters had no
 * row, and the two Penny ones are the interesting case: the bundled HRIS-09 row is titled "Haiku,
 * self-only tools, 10 prompts per Manila day, with guides and rendered Markdown" — it describes the
 * CHAT and says nothing about a proactive greeting or about pay-status correctness. Reading the row
 * TITLE against the diff, rather than assuming a feature-shaped row absorbs everything that touched
 * the same component, is what surfaced them. Six of the day's commits were greeting behaviour.
 *
 * STATUSES, and why two are NOT Done. All eleven commits are on origin/main, but pushed is Pending
 * Deploy — Vercel having deployed is not anyone having looked. The greeting and the pay-status fix are
 * user-facing behaviour nobody has confirmed in production, so they carry blockers and wait.
 *
 * The two Chore rows ARE Done, on different evidence in each case:
 *   • The board-sync hardening is proven by USE: the inputsHash gate fired on its first real write
 *     today ("approval accepted: 98579ab77d67 (source verified: 7eb9bf9db186)") and the SPRINT MOVES
 *     section rendered in the review Kane approved. It runs from the repo, not from Vercel, so the
 *     environment it must work in is the one it already worked in. dateBasis 'external' because the
 *     proof is that run, not the commit — the code landed 08-19 and became provable 08-20, and the
 *     standing rule is that the Completed Date is the day it became PROVABLE.
 *   • The docs back-fill is Done on the commit itself: documentation is complete when it is written,
 *     and its last sha 0d47dbb0 lands 2026-08-19, inside Sprint 27's attribution window.
 *
 * A JUDGEMENT CALL, flagged rather than buried: logging a DOCS-only commit as a board row cuts against
 * this skill's own warning that a docs commit is not a shipped feature (488cf44 "HSL Weekend Hours
 * Fix" carried no code and must never have been credited as one). The distinction drawn here is
 * INTENT: 488cf44 was a commit whose MESSAGE claimed a feature it did not contain, whereas
 * 1504cc58 + 0d47dbb0 are a deliberate two-commit documentation sweep across twelve governing docs,
 * and the governing docs are what the hardening and blueprint skills read at step 1. If Kane would
 * rather the board carry only product rows, this is the one to cut.
 *
 * COST. `--only-new` — 4 rows, ~6 calls. No epic relation until the next full reconcile.
 *
 *
 * ── 2026-08-21, PASS 7 — YESTERDAY WAS 08-20, AND SEVEN ROWS CLOSE ON KANE'S CONFIRMATION ───
 * Kane, across four messages: "Any task accomplished yesterday should be added into the board with
 * their respective SP." / "Lets mark Penny tasks as done both of them they are already deployed." /
 * "Offboarding Delete and Suspend is also accomplished, HSL Subdepartments are already deployed I
 * think most of these are done. HSL Rate history stale underpay has been tackled last week already
 * and we wouldnt run payroll with it being stuck." / "KPI Scored notification is fixed already,
 * Notification for console.warning please check if thats done as well. I think there are no more PAB
 * Disputes just time adjustments and forgiveness."
 *
 * THE WINDOW WAS WRONG IN PASS 6. It ran at 07:36 on 2026-08-21 and read "yesterday" as 08-19; it was
 * already 08-21. Pass 6's four rows were genuine 08-19 gaps and stand, but 08-20 had never been logged
 * at all. `date` is one call and a relative word is not self-evidently resolved.
 *
 * SEVEN ROWS GO DONE. Three rest on Kane's confirmation alone, which the gate accepts when it is asked
 * for and RECORDED; four have independent evidence, which is better and is used in preference:
 *   • Employee Penny AI — penny_employee_usage holds 25 prompts from 10 DISTINCT employees, every row
 *     self-only (subject_email == session_email, elevated false: the designed invariant holding in
 *     production), tools spanning get_my_pay, get_my_bonus_status, get_company_benefits and five more.
 *   • Time adjustments two sign-offs — audit_log shows time_adjustment.manager_approved AND
 *     time_adjustment.second_approved on 2026-08-20T17:52Z, and a real request carries
 *     second_approver_email=aliviah@simple.biz with second_decision=approved. The flow has RUN.
 *   • Penny pay-status — his confirmation PLUS get_my_pay / get_my_pay_schedule appearing in
 *     tools_used, so the corrected path executed in production.
 *   • The @-encoding fix — verified by probing all 8 second-approver columns and penny_employee_usage
 *     WITHOUT head:true, with a negative control that correctly returned PGRST205/42703.
 *
 * TWO PLACES WHERE THE DATA DISAGREES WITH THE INSTRUCTION, recorded rather than smoothed over:
 *
 * 1. "KPI Scored notification is fixed already" — the CODE is written and complete (b831699d), but
 *    `git merge-base --is-ancestor b831699d origin/main` FAILS: origin/main is still a21a51b6
 *    (2026-08-20 13:01). Committed locally is **In Progress** by the gate's own table, so Vercel
 *    cannot have it and nobody can have clicked it. All three hardening rows are therefore held at In
 *    Progress, not Done. This is the least popular call in the pass and it is the whole point of the
 *    gate: "it obviously works" is the rationalisation the table names. One `git push` moves all three
 *    to Pending Deploy, and Kane's click-through moves them to Done.
 *
 * 2. "I think there are no more PAB Disputes just time adjustments and forgiveness" — audit_log says
 *    otherwise: 89 pab_dispute* rows, **34 of them in August 2026**, most recent
 *    2026-08-19T20:02Z (pab_dispute.approved), across submitted 8 / approved 37 / denied 2 / revoked 2
 *    / admin_deleted 7 / orphanage_manager_created 33. What was retired is the EMPLOYEE-facing ability
 *    to file and view one ([[employee-pab-dispute-removed]]); the manager and Accounting paths are
 *    live and in use. Also worth separating: that observation is about DISPUTES, while the open row is
 *    about EXCLUSIONS — a different action, the one that zeroes a person's PAB for a month, and still
 *    the one with no audit trail.
 *
 * THE ARREARS ROW IS DONE ON KANE'S CALL, WITH ITS LIMIT NAMED. "We wouldnt run payroll with it being
 * stuck" is true of the PRICING and independently corroborated — the 2026-07-29 fix-forward corrected
 * 64 people and took divergences 94 → 5 adjudicated holds. It is NOT evidence about the ≈₱1.06M of
 * arrears on already-PAID cycles, and memory records that paid stubs are FROZEN by design so a history
 * fix cannot re-price them. So the go-forward half is proven, the reimbursement half is asserted. If
 * the back-payment never happened it needs its own row; the basis says so rather than implying it was
 * covered.
 *
 * THE DELETION CRON IS SPLIT ACROSS TWO ROWS on purpose. f0eadd18 added a 572-line report and no code.
 * The accomplished task is the MEASUREMENT (77 due, 22 colliding with current staff, oldest queued
 * 2026-07-24) — Done. The DANGER is untouched and stays open and Critical: the route trusts
 * scheduled_deletion_at alone and never re-checks the live roster at fire time. The pre-flight also
 * caught its own first answer being wrong — an unpaged active_employees read returned exactly 1000
 * rows (PostgREST's silent cap, which is in this project's own rules) and hid marka@, joyq@ and niczm@,
 * understating 22 as 19. A truncated read made a deletion risk look smaller than it was.
 *
 * COST. `--only-new` — 5 creates + 10 corrections, ~17 calls. No epic relation until a full reconcile.
 *
 *
 * ── 2026-08-21, PASS 8 — THE PUSH LANDED: In Progress → Pending Deploy on three rows ──────
 * Kane: "how do we close this I already pushed it."
 *
 * VERIFIED, not taken on trust: `git fetch` then `merge-base --is-ancestor` — origin/main is now
 * `bbf55811` and b831699d IS an ancestor. The reason these three sat at In Progress is gone, so they
 * advance exactly one step. They do NOT go Done, and the distinction matters:
 *
 *   LOGIC proven      — 25/25 tests pass across kpi-scored.test.ts and notify-failure-audit.test.ts,
 *                       including "floor keys on period_END so a CURRENT monthly period is not
 *                       silenced" and "floor does NOT touch the amount-diff rule".
 *   DEPLOYMENT proven — the commit is on origin/main, which Vercel deploys.
 *   PRODUCTION USE    — ABSENT. Measured directly: kpi.scored notifications 0,
 *                       audit_log notification.insert_failed 0, audit_log pab_exclusion.added /
 *                       .removed 0, pab.excluded / pab.restored notifications 0. Nothing has
 *                       triggered any of the three paths since the deploy. Zero rows is absence of
 *                       evidence, not evidence of absence — and it is certainly not proof of working.
 *
 * HOW EACH ONE ACTUALLY CLOSES, because "wait and see" is not a plan:
 *   • PAB exclusions audit — ONE toggle closes it, and closes more than itself. Excluding a person
 *     then restoring them writes pab_exclusion.added + pab_exclusion.removed to audit_log AND fires
 *     pab.excluded + pab.restored notifications, which have never once inserted (0 rows against 3,694
 *     for payroll.available). So a single 30-second action proves the audit trail AND proves the
 *     2026-08-20 type-CHECK fix end to end.
 *   • kpi.scored floor — Mark Ready (or re-save) any CURRENT dept-week, i.e. period_end on or after
 *     the just-completed Sun–Sat week. Two things must then hold: that week's employees get notified,
 *     and NO notification appears for any of the 181 older 'ready' dept-weeks going back to
 *     2026-03-01. The second half is the actual assertion of this row and it is checkable by query.
 *   • Notify-failure observability — CANNOT be positively proven in production without deliberately
 *     breaking a notification, and manufacturing an outage to earn a Done is not a reasonable trade.
 *     Its evidence is therefore: all four call sites verified wired to notify-failure-audit
 *     (bonus-catalog-applied, hsl-bonus/entries, hsl-bonus/period-status, pab-exclusions), 25 passing
 *     tests including "the action string is stable — audit readers filter on it", and Kane's sign-off
 *     on that as sufficient. This row is the one place where waiting for evidence means waiting for a
 *     bug, and it should be closed on review rather than left open forever.
 *
 * COST. `--only-new` — 3 corrections, no creates, ~6 calls.
 *
 *
 * ── 2026-08-21, PASS 9 — THE TEST CLOSED TWO ROWS AND DISPROVED THE THIRD ──────────────
 * Kane ran the tests: "1. Its closed now / 2. We have been using this for 3 weeks close this /
 * 3. Closed as well put them on board already with the evidence as Committed."
 *
 * TWO CLOSE. ONE DOES NOT, AND THE MEASUREMENT IS WHY — the PAB row Kane reported as closed is the
 * one his own test proved is NOT working. Reporting it Done would have been the exact failure this
 * skill exists to prevent, so it stays Pending Deploy with the finding recorded.
 *
 * WHAT THE PAB TEST ACTUALLY PROVED, which is a real and separate win: `pab.excluded` INSERTED and
 * RENDERED. employee_notifications now holds 1 row of type pab.excluded — kaner@simple.biz,
 * 2026-08-21T12:28:22Z, "Excluded from Perfect Attendance Bonus" — and Kane's screenshot shows it in
 * the employee bell. That type had NEVER inserted once (0 rows against 3,694 for payroll.available),
 * so this is end-to-end proof of the 2026-08-20 type-CHECK fix, from DDL through insert to render.
 *
 * WHAT IT DISPROVED: audit_log holds **0** rows for pab_exclusion.added or pab_exclusion.removed. The
 * audit trail did not write. This is not ambiguous, and the code says why it cannot be dismissed as a
 * skipped branch: the notification (route.ts:76) and the audit write (route.ts:143) are gated on the
 * SAME `if (changed)`. The notification fired, so `changed` was true, so insertAuditLog WAS called.
 *
 * TWO CANDIDATE CAUSES, and the data cannot yet separate them:
 *   (a) DEPLOY LAG — the notification path is OLD code; b831699d only added +38 lines to this route.
 *       So a pre-b831699d build fires the notification and writes no audit row, which is exactly what
 *       we observe. The push landed ~11:51Z and the click was 12:28Z, which makes lag less likely but
 *       not impossible.
 *   (b) SILENT FAILURE — insertAuditLog returns `{ error }` rather than throwing, and the PAB call
 *       site does `await insertAuditLog({...})` and IGNORES the result. So a rejected insert leaves no
 *       trace whatsoever. That is the same silent-swallow pattern as the sibling row is meant to fix,
 *       reproduced INSIDE the fix. Worth closing on its own merits regardless of today's cause.
 *   RULED OUT: a CHECK on audit_log.action. It holds 177 distinct action values across 43 prefixes, so
 *   it is free text and cannot be rejecting a new string the way employee_notifications.type did.
 *
 * HOW TO SETTLE IT, and Kane needs to do it anyway: he excluded HIMSELF and never restored —
 * pab.restored is 0 rows, so kaner@simple.biz is currently excluded from August 2026 PAB. Clicking
 * restore both fixes that and settles the diagnosis: an audit row appearing means (a), still nothing
 * means (b).
 *
 * THE KPI FLOOR ROW CLOSES ON KANE'S CALL, WITH ITS EVIDENCE STATED HONESTLY. "We have been using this
 * for 3 weeks" is true of the KPI Calculator; the FLOOR shipped 2026-08-20. It has no production
 * observation and cannot have any: hsl_bonus_period_status shows **0 rows touched since 2026-08-20**
 * and audit_log **0 bonus/kpi actions** in that window, so nothing has scored a dept-week since the
 * fix landed. kpi.scored is still 0 rows for that reason and NOT because the floor is broken — which
 * also means 0 floor violations is not a passing test, it is an empty one. What IS proven is the
 * logic: 25/25 tests pass including "floor keys on period_END so a CURRENT monthly period is not
 * silenced" and "floor does NOT touch the amount-diff rule".
 *
 * THE OBSERVABILITY ROW CLOSES ON SIGN-OFF, as agreed — it writes only when a notification FAILS, so
 * the only production test is to break one. audit_log holds 0 notification.insert_failed rows, which
 * is the DESIRED state and unprovable either way.
 *
 * COST. `--only-new` — 3 corrections, ~6 calls.
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

export const PASS_DATE = '2026-08-21';
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
  {
    name: "KPI scored notification fires on months-old weeks — floor it to the current period",
    status: 'Done',
    completed: '2026-08-21',
    dateBasis: 'external',
    shas: ['31b11050', 'b831699d'],
    basis:
      "Done 2026-08-21; Sprint 27. Kane 2026-08-21: \"We have been using this for 3 weeks close this\" — recorded as the basis. EVIDENCE, stated exactly: the LOGIC is proven (25/25 tests pass across kpi-scored.test.ts, including 'floor keys on period_END so a CURRENT monthly period is not silenced' — which matters because the live table holds three period grains and a period_START floor would have silenced a current monthly period) and the DEPLOYMENT is proven (b831699d is an ancestor of origin/main, verified with merge-base). PRODUCTION OBSERVATION IS ABSENT AND CANNOT YET EXIST: hsl_bonus_period_status shows 0 rows touched since 2026-08-20 and audit_log 0 bonus/kpi actions in that window, so nothing has scored a dept-week since the fix landed. employee_notifications kpi.scored is still 0 rows for that reason, not because the floor failed — so '0 floor violations' is an EMPTY test, not a passing one, and is not offered as proof. The 3 weeks of use Kane refers to is the KPI Calculator; the floor itself shipped 2026-08-20. THE ASSERTION STILL TO WATCH: 158 of the 181 'ready' dept-weeks sit below the 2026-08-09 floor, so the first time anyone re-saves an old week, no notification should fire. DATE BASIS external — closed on Kane's call, not on a commit.",
  },
  {
    name: "Notification insert failures are swallowed into console.warn — make them observable",
    status: 'Done',
    completed: '2026-08-21',
    dateBasis: 'external',
    shas: ['31b11050', 'b831699d'],
    basis:
      "Done 2026-08-21; Sprint 27. Kane 2026-08-21: \"Closed as well put them on board already with the evidence as Committed\" — recorded as the basis, and closing on review is the RIGHT call here rather than a concession: this code writes an audit row only when a notification FAILS, so the only production test is to deliberately break a notification, and manufacturing an outage to earn a Done is not a reasonable trade. THE EVIDENCE IS THEREFORE REVIEW PLUS TESTS, and it is real: all FOUR call sites that previously swallowed a failed notification are verified wired to src/lib/notifications/notify-failure-audit.ts — checked individually in bonus-catalog-applied, hsl-bonus/entries, hsl-bonus/period-status and pab-exclusions; the console.warn lines still present in pab-exclusions cover DIFFERENT conditions (unsafe email characters, a failed active_employees lookup, no roster match) and not the notification insert; 25/25 tests pass including 'the action string is stable — audit readers filter on it'; and the action string cannot be silently rejected, because audit_log.action holds 177 distinct values across 43 prefixes and is therefore free text rather than CHECK-constrained — which had to be confirmed, since a constrained action column would have made this fix dead on arrival in exactly the way it was built to catch. audit_log currently holds 0 notification.insert_failed rows, which is the desired state. DATE BASIS external — sign-off, not a commit. ONE FOLLOW-UP THIS ROW DOES NOT COVER: insertAuditLog returns { error } and the pab-exclusions call site ignores it, so an audit write that fails is itself silent.",
  },
  {
    name: "PAB exclusions leave no audit trail while PAB disputes are fully audited",
    status: 'Pending Deploy',
    shas: ['4afac832', 'b831699d'],
    basis:
      "Pending Deploy — NOT Done, and Kane's own test on 2026-08-21 is why. He reported this closed; the measurement disagrees, so it is recorded rather than accepted. WHAT THE TEST PROVED, which is a real and separate win: pab.excluded INSERTED and RENDERED — employee_notifications now holds 1 row (kaner@simple.biz, 2026-08-21T12:28:22Z, 'Excluded from Perfect Attendance Bonus') and it appears in the employee bell, for a type that had NEVER inserted once. That is end-to-end proof of the 2026-08-20 type-CHECK fix, from DDL through insert to render. WHAT IT DISPROVED: audit_log holds 0 rows for pab_exclusion.added and 0 for pab_exclusion.removed — the audit trail did not write, which is the whole content of this row. It cannot be dismissed as a skipped branch: the notification (route.ts:76) and the audit write (route.ts:143) are gated on the SAME if (changed), and the notification fired, so changed was true and insertAuditLog WAS called. TWO CANDIDATE CAUSES the data cannot yet separate: (a) DEPLOY LAG — the notification path is OLD code, b831699d added only +38 lines here, so a pre-b831699d build produces exactly this signature; the push landed ~11:51Z against a 12:28Z click, which makes lag less likely but not impossible. (b) SILENT FAILURE — insertAuditLog returns { error } and this call site ignores it, so a rejected insert leaves no trace at all: the same silent-swallow pattern as the sibling row, reproduced inside the fix. RULED OUT: a CHECK on audit_log.action, which holds 177 distinct values across 43 prefixes and is free text. TO SETTLE IT, and Kane must do this anyway: pab.restored is 0 rows, so kaner@simple.biz is CURRENTLY EXCLUDED from August 2026 PAB. Clicking restore fixes that and decides the diagnosis — an audit row appearing means (a), still nothing means (b).",
    blockers: ["MEASURED FAILING: 0 audit_log rows for pab_exclusion.added/.removed after a real exclusion", "Kane is currently excluded from August 2026 PAB - clicking restore fixes that AND settles the diagnosis", "If restoring still writes no audit row, insertAuditLog is failing silently at this call site"],
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
