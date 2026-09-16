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
 *
 * ── 2026-08-21, PASS 10 — RETRACTION: THE PAB AUDIT TRAIL WORKS, MY PROBE WAS BROKEN ──────
 * Kane: "whats next for closing?"
 *
 * PASS 9 RECORDED A FALSE FINDING AND THIS CORRECTS IT. Pass 9 held this row at Pending Deploy and
 * stated that audit_log contained zero pab_exclusion.* rows, i.e. that the audit trail had not
 * written. That was WRONG, and the fault was in the verification, not the feature.
 *
 * THE VERIFICATION QUERY SELECTED A COLUMN THAT DOES NOT EXIST:
 *     .select('action, created_at, actor_email, details')   ->  42703 column audit_log.actor_email
 *                                                               does not exist
 * PostgREST returned an error and `data` came back NULL; the probe did `(al ?? []).length` without
 * ever checking `error`, printed 0, and 0 was read as "no rows exist". Re-run without that column and
 * the row is there: pab_exclusion.added at 2026-08-21T12:28:23 with details
 * {month: '2026-08', employee: 'kaner@simple.biz', excluded: true, notified: true, was_excluded: ...}.
 *
 * SO THE FEATURE IS PROVEN END TO END, and better than the earlier reading suggested: one click wrote
 * the notification (12:28:22) AND the audit row (12:28:23), one second apart, with `notified: true`
 * captured in the audit details — which is the audit trail recording that the notification succeeded.
 *
 * THIS IS THE THIRD TIME THIS EXACT CLASS HAS BITTEN IN A WEEK, and the pattern is worth naming
 * because knowing about it did not prevent it:
 *   • `security_invoker` on a view — an RLS-blocked filter returns an empty 200, not an error.
 *   • `head: true` on a missing table — no error, count null, so a MISSING table reads as APPLIED.
 *   • this one — a bad column name errors, `data` is NULL, and `(data ?? [])` converts an ERROR into
 *     an empty result.
 * The rule that would have caught all three: **an empty result and a failed query are different
 * facts, so check `error` before believing a count of zero** — and use a negative control, which is
 * exactly what caught the head:true bug and what this probe lacked.
 *
 * NOT CHANGED BY THIS: Kane is still excluded from August 2026 PAB. pab.restored is 0 rows and
 * app_settings.pab_period_exclusions still lists him under 2026-08. That is a live data state, not a
 * row status, and it needs a click regardless of what the board says.
 *
 * STILL OPEN AND UNCOVERED, carried forward rather than folded in: insertAuditLog returns { error }
 * and the pab-exclusions call site ignores it. Today that hid nothing because the write SUCCEEDED, but
 * it is the same silent-swallow shape the sibling row just closed, and it is one line to fix.
 *
 * COST. `--only-new` — 1 correction, ~4 calls.
 *
 *
 * ── 2026-08-21, PASS 11 — THE TWO ITEMS LEFT ON THE TABLE, AND A FULL RECONCILE ──────────
 * Kane: "SO update the board."
 *
 * FULL PATH THIS TIME, not `--only-new`, for two reasons that both matter:
 *   1. This pass MOVES a row between sprints (Backlog → Sprint 27), and `--only-new` skips the
 *      reconciler entirely, so it cannot write a Sprint label or a group move. Using it here would
 *      have silently half-applied the pass.
 *   2. It pays off accumulated relation debt. Six consecutive `--only-new` passes created rows with
 *      NO epic relation — correctly grouped, typed, scored and statused, but unlinked from their
 *      epics. A full reconcile adopts every one of them by name and repairs the relation graph.
 *
 * ROW 1 — AUDIT WRITES FAIL SILENTLY, and the number is measured rather than impressionistic.
 * `insertAuditLog` returns `{ error }`; **197 of its 201 call sites discard it**, and the helper
 * itself neither logs nor throws. Only four sites capture the result: app/api/audit-log/route.ts,
 * payment-dispatches/undo (twice) and notify-failure-audit.ts. So the table this product treats as
 * its trail of record can fail to record, everywhere, with no signal.
 *
 * The scope call, stated because it is the difference between 3 SP and 13: the fix is CENTRAL — make
 * the helper surface its own failure — not 197 call-site edits. Editing 197 sites would be churn with
 * a worse outcome, because the next new call site would reintroduce the gap.
 *
 * Worth recording that notify-failure-audit.ts is one of the FOUR that checks. The fix for silent
 * notification failures does not itself fail silently, which is the right instinct applied in one
 * place and missing in 197 others.
 *
 * AND THIS IS THE BUG THAT FOOLED ME. On 2026-08-21 I read 0 pab_exclusion rows as "the audit write
 * failed", when the write had SUCCEEDED and my query was broken (a phantom column → 42703 → data
 * NULL → a zero). Had the write genuinely failed, nothing in the system would have distinguished the
 * two cases. That is not a coincidence, it is the same missing signal seen from the other side.
 *
 * ROW 2 — THE head:true TOOLING BUG COMES OUT OF THE BACKLOG. `probeTable()` in
 * audit-pending-migrations.mts uses `head: true`, which returns no error and `count: null` for a
 * MISSING table — so a table that was never created reads as APPLIED. It is Critical and it sat in
 * the Backlog while a Sprint 27 row was closed Done on that tool's verdict. Pulled into the sprint
 * because a measurement tool that can report a missing table as present undermines every migration
 * claim made with it, including ones already acted on.
 *
 * The verdict it produced was re-checked rather than assumed: all nine tables the audit probes were
 * re-read WITHOUT head:true and with a negative control that correctly returned PGRST205. All nine
 * genuinely exist, so "0 pending migrations" STANDS. The tool is wrong; that particular answer was
 * not. Both facts are recorded because either one alone is misleading.
 *
 * COST. FULL reconcile — ~200 calls + 2 corrections + 2 evidence updates + the verify read.
 *
 *
 * ── 2026-08-25, PASS 13b — KANE CONFIRMED, TWELVE CLOSE, ONE IS REFUSED ON A MEASUREMENT ──
 * Kane: "All of those are deployed already Ive tested them." then "mark them as done please also
 * add their priority levels."
 *
 * THAT CONFIRMATION IS THE EVIDENCE, and it is recorded as such on every row rather than assumed:
 * each closing basis quotes it verbatim. This is exactly what the skill's honesty gate asks for —
 * "Deployed and clicked through in prod / Kane says so / record that as the basis" — and it is why
 * the pass ASKED which ones instead of guessing.
 *
 * ONE ROW IS HELD ANYWAY, AGAINST AN EXPLICIT "all of those". `1f94ff70` (the dispatch export fix)
 * is NOT an ancestor of origin/main — re-fetched AFTER that message to be sure. Vercel deploys
 * origin/main, so the commit is not in production no matter what the working tree shows. A blanket
 * confirmation cannot push a commit, and marking it Done would put a claim on the board that one
 * command disproves. It stays In Progress and advances the moment it is pushed.
 *
 * ONE BLOCKER WAS CLOSED BY MEASUREMENT RATHER THAN BY THE CONFIRMATION. The Kolan rename was held
 * on an un-run payout_brand migration, and an assertion cannot run a migration — so it was PROBED
 * read-only instead: `hr_onboarding_submissions.payout_brand` returns rows, and a negative control
 * on the same table returns `42703 column does not exist`, which is what proves the probe can detect
 * an absent column at all. It HAS been run. Probing without `head: true` and carrying a negative
 * control is the rule three separate incidents in this repo were needed to learn.
 *
 * TWO EXTERNAL STEPS ARE SPLIT INTO THEIR OWN ROWS rather than either blocking a shipped feature or
 * vanishing with it. Both parent rows explicitly did not claim them:
 *   • the n8n orientation Filter node, never imported — the SECOND layer; the sender gate is the fix
 *     and Kane tested it, so the gate row closes and the import gets its own 1-SP chore row.
 *   • the 9 drifted master-sheet department cells — the code fix stops NEW drift and repairs none of
 *     the old, so the data repair gets its own 3-SP row, ordered (flip the cell, re-stamp, THEN sync)
 *     because syncing first would mint 9 duplicates in pre-transfer departments.
 * Closing a row whose stated claim is met, while carrying the genuinely-open remainder forward under
 * its own name, is the alternative to the two bad options: a false Done, or a real fix held hostage.
 *
 * PRIORITY LEVELS, as asked — and the plan could not express them. The board's Priority column
 * carries FOUR labels (Critical 0 / High 1 / Medium 2 / Low 3) but `TaskPriority` modelled only
 * Critical and High, so every row scored below High was silently unlabelled. The type and
 * TASK_PRIORITY_INDEX are extended to all four. That is an ADDITION to what the reconciler can
 * write, never a loosening of a guard. Assigned: High to the money, disclosure and live-incident
 * rows (the payment rail, the masked-account export, the orientation-email incident, the KPI hang,
 * Attestation, the paystub transfer label, sheet_synced, the dispatch exports, the sheet repair);
 * Medium to the reporting and label surfaces; Low to the wizard step rail.
 *
 * ONE PRIORITY CANNOT LAND THIS PASS, and saying so beats a silent no-op: Priority is a
 * RECONCILER-owned column, and `--only-new` writes it at CREATE only. The twelve new rows get theirs.
 * The Kolan rename already exists on the board, so its Medium sits in the plan and lands on the next
 * FULL reconcile — the same run that pays off this pass's epic-relation debt.
 *

 * ── 2026-08-25, PASS 13 — TWELVE UNDECLARED FEATURES, AND ONE STATUS THAT DECAYED ────────
 * Kane: "Update our Monday Board if we have fixed anything and make sure we have completion dates."
 *
 * THE COMPLETION-DATE HALF IS ALREADY TRUE, and it was measured before anything was written rather
 * than asserted. `verify.mts` re-read the board at the top of this pass: **Done rows with no
 * Completed Date: 0**, across all 188 of our rows, plus 0 over the 8-SP cap, 0 open rows with a
 * blank Estimated SP, 0 unshipped rows carrying a phantom Actual SP, and the rollup and relation
 * both exact (1569 / 874 / 188 of 188). The 74-row backfill that used to sit in Known Drift stays
 * closed. It also confirmed all 8 rows from the 08-24 pass landed with the statuses they claimed.
 *
 * SO NOTHING IS MISSING A DATE. What is missing is that **twelve features had no board row at all**,
 * and none of the thirteen rows here can carry a date yet, which is the honest answer to the second
 * half of the ask rather than a dodge: a Completed Date accompanies Done, and Done needs someone to
 * have looked in production. Eleven of the twelve are on origin/main and are Pending Deploy; one is
 * committed locally only and is In Progress. **Which of them Kane has actually clicked through is
 * the one thing this pass cannot derive from git, and it is the question put to him with the review.**
 *
 * THE MESSAGE-VERSUS-CONTENT TRAP FIRED TWICE IN TWENTY COMMITS, which is why the range was
 * clustered on file overlap and not read off the subject lines:
 *   • `7b9fe312` is titled **ATTESTATION** and contains **no attestation code whatsoever**. By file
 *     overlap it is the Payroll Wizard step-rail progress line (step-load-prediction.ts + 12 tests +
 *     250 lines of wizard). It also carried five `.tmp-vfy-*.mjs` probes and two report JSONs into
 *     the tree as working residue — noise, given no row, but now committed.
 *   • `681662f7` is the commit that ACTUALLY changes Attestation (Referral Leads + SSA.Gov on top of
 *     the case tier). A message-clustered pass would have merged these two and described neither.
 *   • `667dfe9d` is titled **"Fix"** and is the sheet_synced false-success repair — 197 of 200
 *     applied transfers claiming a Google-Sheet write that never happened.
 *
 * THE FOUR-COMMIT AND THREE-COMMIT CLUSTERS, both collapsed to one row for the same reason: four
 * commits touching nothing but Overview.tsx on one day are one screen built and finished, and
 * 06f7f669 / d08a9948 / d24b49a8 are one Orientation panel built, documented, then lifted into its
 * own tab. Neither is three or four rows.
 *
 * ONE ROW LANDED IN THE GAP BETWEEN THE LAST PASS'S REVIEW AND ITS APPLY. `59dc91af` (the wallet-rail
 * mirror and lock) was committed after `review.mts` minted the 08-24 proposal at 10:23 and before
 * `apply.mts` ran at 10:49, so the previous pass could not have seen it. Worth naming as a recurring
 * shape rather than a one-off: the audit range ends at the review, not at the apply.
 *
 * THE ONE STATUS THAT MOVED WITHOUT NEW CODE. The Kolan rename was filed In Progress on 08-24 because
 * `2951167a` was not an ancestor of origin/main. Re-checked after a fetch, it now is, so it advances
 * to Pending Deploy — one step, not two. Its payout_brand migration is still un-run, so it remains
 * exactly the class of feature that is code-complete and functionally dead until someone runs the
 * thing, and no push can close it.
 *
 * ONLY ONE EXTERNAL BLOCKER IS NEW IN THE WHOLE RANGE, which is unusually clean: the n8n Filter node
 * `references/n8n/orientation-email-leadgen-only.json` is un-imported. It is a deliberate SECOND
 * layer — the server-side gate works without it — so that row is not dead the way the tickets row is.
 * No new `.sql` and no new apply script appear anywhere in the twenty commits. What IS un-run is a
 * DATA repair: `scripts/fix-sheet-dept-drift.mts` is dry-run by default, and the backup file in the
 * commit proves nothing because it is written on dry runs too, so the 9 drifted sheet cells stand.
 *
 * COST AND PATH. `--only-new`: no new epic, no re-scored row and no sprint move, which is exactly the
 * sanctioned case for the lean path. ~13 lookups + 12 creates + 1 correction + 13 updates plus the
 * three label gates, ≈45 calls, against a full reconcile's ~200 on a 200-row plan. The trade is
 * stated rather than hidden: **the 12 new rows land with no epic relation**, so `verify.mts` will
 * read 188 of 200 on the relation invariant until a full reconcile adopts them by name.
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

export const PASS_DATE = '2026-09-16';
export const AUDIT_RANGE = '9803bba6..1f7e2078 (Sep 13 - Sep 16)';
export const AUDIT_COMMITS = 63;
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
  // ── PASS 28 · 2026-09-16 · "All withheld SP please push them to monday" ────────────────────────
  //
  // WITHHELD WAS MEASURED IN ALL THREE WAITING ROOMS, the way pass 24 established:
  //   · pending-sp.json ......... 42 entries, 0 unflushed — the ledger owes NOTHING.
  //   · a staged, unapplied pass . pass 27 APPLIED and VERIFIED 2026-09-13 — owes nothing.
  //   · commits with no row ...... 63 commits, 9803bba6..1f7e2078 — THIS PASS. All the withheld SP
  //     is here, in the third room.
  //
  // CLUSTERED BY FILE OVERLAP, NEVER BY COMMIT MESSAGE, and this range is exactly why: `1d418b4a`
  // ("S") carries 37 files and two unrelated features, `f2b797e0` ("Paystub") carries the Offboarded
  // fixer override AND the leaver-department rule, `e5411cbf` ("Manager Dashboard") carries the QC
  // officers module and nothing about the manager dashboard, `9c674472` ("c") and `40d0bc1c` ("tt")
  // carry an audio asset and a build artefact respectively. `40d0bc1c` is pure noise and gets NO row.
  //
  // SPRINT 29's WINDOW WAS RE-MIRRORED, and it moves ten rows. The live group title read
  // "Sprint 29 · Sep 15-Sep 25" on 2026-09-16; pass 27 recorded "Sep 14-Sep 25". The BOARD owns that
  // range, so hris-plan.ts now says Sep 15 — which re-bounds S28's attribution to Sep 1-14 and files
  // Sun Sep 13 + Mon Sep 14 under S28. FLAGGED FOR KANE: if the board title is the typo and Sep 14 is
  // right, ten rows move to S29 and this is a one-line change plus a re-review.
  //
  // FOUR CLAIMS WERE MEASURED READ-ONLY RATHER THAN ASSUMED, with negative controls that both
  // correctly reported MISSING, and probed with .limit(1) — never head:true:
  //   · employee_schedule_periods ................ MISSING. HSL Scheduling is code-complete and DEAD.
  //   · time_adjustment_requests.stage1_waived_reason PRESENT. The "MIGRATION PENDING" note is STALE.
  //   · paystub_issues ........................... MISSING still. The pass-27 row stays held.
  //   · Lead Gen QC restore ...................... STILL UN-RUN (192 rows both at zero).
  // Two data fixes were measured APPLIED and are the only rows this pass can close on its own
  // evidence: the catalog override now reads 280 (updated 2026-09-15T17:31Z) and the 09-10
  // adjustment's approved_hours is NULL (updated 2026-09-15T15:54Z).
  //
  // NOTHING ELSE IS DONE, AND THAT IS DELIBERATE. Kane has not been asked which of these he has
  // clicked through in production. 29 rows sit at Pending Deploy with that stated as the reason; one
  // sits at In Progress because it is UNPUSHED; one sits at Waiting for Review because it is a
  // blueprint awaiting his answers. Ask, then close them — do not blanket-apply an old confirmation.
  {
    name: 'The expanded Payment Dispatch row shows the backup account as data, not as a second card that would imply where the money goes',
    status: 'Pending Deploy',
    shas: ['d760870e'],
    basis:
      'An ancestor of origin/main, so Vercel has served it, but nobody has confirmed clicking through it. The backup is rendered as a ROW and never as a second card — a card facing forward implies routing, which is the rule [[employee-payout-card-deck]] and [[bank-preferred-is-routing-do-not-seed]] both turn on. Gated on DATA: no backup slot, no row. BACKUP is never read off `alt`.',
  },
  {
    name: 'My Team picks a department on a vertical rail that is the outer axis for all three tabs, and the selection glides instead of reappearing elsewhere',
    status: 'Pending Deploy',
    shas: ['4cf697ce', '652cccae', '7f377005', 'a42139e8'],
    basis:
      'Four commits, one surface: the rail replaces filtering everything on one page, then becomes the OUTER axis for all three My Team tabs, then the selection glides rather than reappearing elsewhere, then the tab opens on the list rather than the cards. There is deliberately NO "All" option. On origin/main, not confirmed live. OPEN and recorded rather than resolved: the rail uses a spring where ui-standards specifies an ease — that deviation is written down in ui-standards.md, not ratified.',
  },
  {
    name: 'The AI/API Team rankings render on My Team for the one person allowed to read them, as a tier and never as pesos',
    status: 'Pending Deploy',
    shas: ['7420f38b'],
    basis:
      'The rankings pane is shared with the employee team directory, and the disclosure rule from [[employee-team-directory-rankings-policies]] holds on both: a TIER is shown, never pesos, and the one-name gate stands. On origin/main, not confirmed live.',
  },
  {
    name: 'The QC period key must be a Sunday, and the boundary enforces it before the deal rather than after the write',
    status: 'Pending Deploy',
    shas: ['b5178dd1'],
    basis:
      'The real defect is that `GET /api/qc/assignments` WRITES, so a non-Sunday period key did not merely read wrong — it MINTED phantom periods. The guard now runs BEFORE the deal. The phantom periods already created were LEFT rather than swept, deliberately: deleting dealt periods is a bigger action than this row, and it is named here so the next reader does not assume they were cleaned up. On origin/main, not confirmed live.',
  },
  {
    name: 'The QC weekly deal reads the roster as of the scored week instead of as of today, so scoring a week late no longer deals it to the wrong people',
    status: 'Pending Deploy',
    shas: ['5c7fdf17'],
    basis:
      'Slots are the roster AS OF THE SCORED WEEK. Scored 5, not 3: it is a new dated module with its own test file, and it changes who gets paid for a late-scored week. On origin/main, not confirmed live.',
  },
  {
    name: 'QC officers are the QC department read from the roster rather than a role flag, and a week already dealt stays frozen',
    status: 'Pending Deploy',
    shas: ['e5411cbf', '08835b5d'],
    basis:
      'Officers are the QC DEPARTMENT, read off the roster. The code landed in `e5411cbf`, whose message says "Manager Dashboard" and which contains no manager dashboard change at all — clustered on the file list, not the subject. A DEALT WEEK IS FROZEN, which is what makes widening the read safe: it can never re-deal one. This is also why granting the `qc` role is NOT the way to give someone QC management — see [[qc-manager-role-does-not-exist]]. On origin/main, not confirmed live.',
  },
  {
    name: 'An offboarded person is scoreable for their final pay week and no others, and one dated predicate decides it instead of the active roster',
    status: 'Pending Deploy',
    shas: ['736e9652', 'fcda5aac'],
    basis:
      'Two commits closing one hole from both ends: people who have already left stop appearing in the KPI Calculator, and an offboarded person stays scoreable for their FINAL PAY WEEK and no others. The load-bearing fact is that `active_employees` CANNOT say who left — so ONE dated predicate, `hasDepartedBeforeWeek`, decides it everywhere rather than each surface inferring departure from absence. On origin/main, not confirmed live.',
  },
  {
    name: 'Active and Offboarded tiles sit in the KPI Calculator toolbar and count this week rather than the whole roster',
    status: 'Pending Deploy',
    shas: ['88227b8e', 'f763a8fd'],
    basis:
      'Added above the member table, then moved into the toolbar and re-pointed at THIS WEEK. Both tiles count `allMembers`. Scored 2 — display over an existing derivation, no money path. On origin/main, not confirmed live.',
  },
  {
    name: 'The QC Compare panel scrolls per column and yields to the department table, and an off-table refusal names the person instead of guessing why',
    status: 'Pending Deploy',
    shas: ['4b5eceb0', 'c197ddf1', '09877735', '85570090'],
    basis:
      'Four commits on one panel: it scrolls, each column scrolls on its own with a taller paste box, the department table keeps a floor, and an `off_table` refusal NAMES THE PERSON and says what to do instead of guessing at a reason. The rule underneath it is that a first pass is NOT payable. On origin/main, not confirmed live.',
  },
  {
    name: 'The QC Compare sheet is shared per department-week through app settings, so two officers work one sheet instead of two',
    status: 'Pending Deploy',
    shas: ['c8e01d27'],
    basis:
      'Shared per dept-week via `app_settings`, with a new route, an audit registry entry and a test module — scored 5. The `qc` role is NOT a reader of it, which is intentional and is the kind of thing that reads as a bug later. OPEN and unresolved: the published week. On origin/main, not confirmed live.',
  },
  {
    name: 'A per-card Refresh saves pending edits where the toolbar Refresh discards them, and the Compare sheet gains Delete all',
    status: 'Pending Deploy',
    shas: ['3c909c7e'],
    basis:
      'The distinction is the whole feature: per-card Refresh SAVES pending edits, the toolbar Refresh SKIPS them, and QC mode refuses outright. On origin/main, not confirmed live.',
  },
  {
    name: 'Add N missing as externals pulls sheet and QC people off the table keyed to pay, and marks the ones it refuses as problems',
    status: 'Pending Deploy',
    shas: ['1a018ad7'],
    basis:
      'The pay key is PER SOURCE. Someone not on the GML is never silently added — the PROBLEM is surfaced instead, which is the failure-closed half of the feature and the reason it is 3 and not 2. On origin/main, not confirmed live.',
  },
  {
    name: 'A Google Sheet sync can no longer un-write an offboard — the re-activation path is removed and the roster backfilled',
    status: 'Pending Deploy',
    shas: ['ca4ce3e8'],
    basis:
      '`clearOffboarded` re-activated leavers on every sheet sync — a data-integrity defect that silently resurrected departed people. The path is REMOVED with a regression test pinning it, and the backfill was APPLIED, taking the active roster from 1,373 to 1,195. Priority Critical because it was actively corrupting the roster every sync. The data half is done; the code half is on origin/main and not confirmed live.',
  },
  {
    name: 'Scheduling moves inside the HSL department and starts saving, gated on the scheduling grant rather than team membership',
    status: 'Pending Deploy',
    shas: ['7cf94aa5'],
    basis:
      'Gated on `scheduling`, NOT `team` — the distinction matters because the two grants do not overlap. HELD at Pending Deploy on a MEASUREMENT, not on a doc claim: `public.employee_schedule_periods` was probed read-only on 2026-09-16 with .limit(1) (never head:true, which returns no error for a missing table) against a negative control that correctly reported MISSING, and the table is ABSENT from production. The feature is code-complete and saves nothing. An assertion cannot create a table.',
    blockers: [
      'references/sql/create/2026-09-14_employee_schedule_periods.sql has NOT been run — measured 2026-09-16, public.employee_schedule_periods absent from production. Ship it with scripts/apply-employee-schedules-migration.mts.',
    ],
  },
  {
    name: 'The Offboarded list shows the inbox that still reaches a leaver once the work account is gone',
    status: 'Pending Deploy',
    shas: ['373f47a0'],
    basis:
      'Thirty lines against an existing list. Scored 1. On origin/main, not confirmed live.',
  },
  {
    name: 'Lead Gen’s QC first pass never reached the applied rows — the gap is measured and the restore is built behind an apply gate',
    status: 'Pending Deploy',
    shas: ['b6711973', '89f2d0e6', '8307df6e'],
    basis:
      'Lead Gen 2026-09-06 pays PHP 38,000 where QC scored PHP 124,750. Four probe scripts measured the gap and a restore was built behind an --apply gate. RE-MEASURED 2026-09-16 with the probe rather than trusted from the note: the gap is STILL OPEN — 192 people at zero on both sides, 119 matching, and the applied rows were last written by carla@ at 2026-09-15T15:16Z. The restore has not been run. This is money that has not moved, and it is an OPEN RULING for Kane, not a decision this pass makes.',
    blockers: [
      'scripts/restore-lead-gen-qc-first-pass.mts --apply has NOT been run — re-measured 2026-09-16, 192 rows still zero on both sides. Kane rules on whether a first pass is payable before it runs.',
    ],
  },
  {
    name: 'The QC start meeting and four findings it settled — no QC Manager role exists, the transferred status cannot fire, an absent officer does not block the week',
    status: 'Done',
    completed: '2026-09-14',
    shas: ['5cc6f4b3', '8733d8e1', 'a8b48cf3', '0dd5d1b4', '1a3046bb'],
    basis:
      'A Spike closes on DELIVERY plus USE, the way the 2026-09-09 security readiness Spike did — its deliverable is a record, and four measured findings are that record. Each was settled against the live system on 2026-09-14, not asserted: there is no QC Manager role to flip on (granting `qc` makes jackie@ an OFFICER and RE-DEALS the live week), the `transferred` status has never once fired and cannot be reached, an absent officer does not block the week because the manager takes over, and the Executive Assistants department is intact — three same-named departments exist and the grant sits on the wrong label. The meeting record is filed at docs/meetings/2026-09-14-carla-qc-start-and-offboarded-scoring.md. Completed Date is the commit date of the last sha and falls inside S28.',
  },
  {
    name: 'The Employee Support blueprint is posted and waiting on nine answers before any code is written',
    status: 'Waiting for Review',
    shas: ['a14c68ab'],
    basis:
      'Waiting for Review is the honest status: the blueprint is POSTED and hard-stopped for approval, Q1 to Q9 are outstanding, and NOTHING has been built. Scored 1 for the brief itself, not for the feature it proposes — that gets its own rows once Kane answers. One thing it surfaced is worth carrying regardless of the answers: the `tickets` table has NO RLS.',
    blockers: ['Q1-Q9 are unanswered. No code until Kane rules.'],
  },
  {
    name: 'Countersigned time adjustments reach Accounting on the Issues tab, and the reviewer is never the filer at any stage',
    status: 'Pending Deploy',
    shas: ['e055ac8c', 'fae0cc19'],
    basis:
      'Scored 8 and kept a TASK: two commits, 2,849 insertions, 23 files, a migration, four new modules and their tests, encoding three of Kane rulings — the review pool is the team UNION its MANAGERS, a MANAGER’s own request SKIPS stage 1 (recorded in `stage1_waived_reason` rather than silently), and stage 2 is Issues EDIT plus role, excluding jakec@/april@/lenny@. Reviewer != filer at EVERY stage. THE MIGRATION CLAIM WAS MEASURED AND IS STALE: [[time-adjustments-accounting-issues-queue]] records "MIGRATION PENDING --apply, deploy AFTER", but `time_adjustment_requests.stage1_waived_reason` was probed read-only on 2026-09-16 and is PRESENT. That note is now wrong and this row carries NO migration blocker. Measured, not assumed in either direction. On origin/main, not confirmed live.',
  },
  {
    name: 'An approved time adjustment derives its day total from one module that every overlay surface imports, instead of each surface deciding for itself',
    status: 'Pending Deploy',
    shas: ['1d418b4a'],
    basis:
      'Accounting approves or denies with NO hours, so the day total is DERIVED: a stored total wins, else segments give tracked + requested, else NOTHING — and a segment-less row is a legacy DAY TOTAL, not an empty one. Per-day tracked hours had no shared implementation (two copies already), so deriving beat writing a third. ALL SIX overlay surfaces must import the module or an approval applies nothing, which is the failure mode this row exists to prevent. Landed inside `1d418b4a`, a 37-file commit named "S" — clustered on files, not the message. On origin/main, not confirmed live.',
  },
  {
    name: 'An offboarded person’s Set rate and Set bank are a complete override, and an undated departure anchors on the pay week in view instead of relabelling',
    status: 'Pending Deploy',
    shas: ['1d418b4a', 'f2b797e0', '56823f57'],
    basis:
      'Offboarded Set rate / Set bank is a COMPLETE OVERRIDE; the dialogs show what is ON FILE; there is ONE individual structure per person; Set bank is Offboarded-only and goes through the People PATCH with the rail unlocked. The second half is the leaver-department rule: a LEAVER’s department follows the Set-rate structure even when that structure was touched after departure in a different department, the Department line RIDES THE SNAPSHOT, an undated departure anchors on the pay week in view, and a dateless structure NEVER relabels. Spread across three commits, two of them named "S" and "Paystub". On origin/main, not confirmed live.',
  },
  {
    name: 'Penny can see off-boarded people and trace a leaver and a bonus back to their sources, without ever inferring a value it cannot recover',
    status: 'Pending Deploy',
    shas: ['d69ee972'],
    basis:
      '`find_employee` now sees OFF-BOARDED people — labelled as such, active first, and PAGED, which matters because PostgREST truncates at 1000 rows. Two admin tools added: `get_offboarding_info` and `get_bonus_breakdown`. The honest limit is written into the tools rather than papered over: KPI saves are UNAUDITED, so a prior value is unrecoverable and Penny never infers one. OPEN for Kane: adrianm@ has TWO master rows and therefore two calculators, and whether to audit KPI saves at all. On origin/main, not confirmed live.',
  },
  {
    name: 'MESA Non Members Opt In takes an effective date, and the route refuses one that falls inside a closed stint',
    status: 'Pending Deploy',
    shas: ['a9d7ffa6'],
    basis:
      'No new column — `since` already stamped both sides — and the route refuses a date on or before the previous `closed_on`, so an opt-in cannot be backdated into a stint that is already closed. On origin/main, not confirmed live.',
  },
  {
    name: 'Friday is the MESA deposit date, so a member’s first charged week is the first whose Friday follows their enrollment — and no rule change rewrites a snapshotted week',
    status: 'Pending Deploy',
    shas: ['4ef7e959'],
    basis:
      'Kane’s ruling, applied at every PHP 100 and PHP 400 site through one predicate, `mesaContributesForWeek`, rather than re-derived per call site. Carries the second ruling with it: a payroll rule change NEVER rewrites a snapshotted week, because those weeks carry Payroll Notes adjustments — proved per carrier rather than asserted. TWO PRE-EXISTING GAPS were found and are NOT closed by this row: the staging API has no newest-file guard, and a past-week re-upload re-deposits by TODAY’s membership. Named here so they are not rediscovered. On origin/main, not confirmed live.',
  },
  {
    name: 'An aliased MESA member was never charged the deduction — the membership is stamped onto the rate rows and the backfill audit learns the alias map',
    status: 'Pending Deploy',
    shas: ['61fa6553', '2ed76b21'],
    basis:
      'jimg@ and dales@ were NEVER deducted across 14 pay stubs, because ledger identity is an ALIAS (jim@ / dale@) and the CSV backfill stamps `mesa_member` WITHOUT consulting the alias map. Found by probe, then half-fixed: jimg@ was repaired on 2026-09-15 and the backfill audit now knows the alias map. dales@ is STILL OPEN. The repair must NEVER go through toggle-mesa-member — it MINTS A SECOND ACCOUNT. Critical because it is PHP 900 credited-but-not-deducted per person, alongside PHP 101,600 sitting in 5 departed open accounts.',
    blockers: ['dales@ is still unflagged and still un-deducted. Same fix, not yet run.'],
  },
  {
    name: 'A stray individual catalog override paid one person PHP 279.99 an hour for eleven weeks — corrected forward-only, with the dated history row retained',
    status: 'Done',
    completed: '2026-09-15',
    shas: ['4fe7258d'],
    basis:
      'This row closes on a MEASUREMENT, not on a confirmation, because its deliverable is a database state and a script has no production surface to click through. An individual catalog override created by carla@ on 2026-06-15 outranked the 280 that was ALREADY in both the sheet and the rates, and 419.99 is simply 279.99 x 1.5 — ONE bad base value, propagated. Re-probed read-only on 2026-09-16: the catalog pay structure now reads 280, updated 2026-09-15T17:31:12Z. Corrected FORWARD-ONLY per [[payroll-rule-changes-forward-only]] — the 06-22 history row is RETAINED, about PHP 10 of arrears is accepted, and there is no back-pay. Completed Date is the commit date of the only sha, which is also the day the script ran. OPEN and not part of this row: the 2026-09-06 to 09-12 week still needs re-locking.',
  },
  {
    name: 'An approved time adjustment stored the wrong day’s total and became a pay cut — the value was cleared rather than the rule loosened',
    status: 'Done',
    completed: '2026-09-15',
    shas: ['89ee046d'],
    basis:
      'Closes on a MEASUREMENT for the same reason as the rate fix. The stored approved_hours of 7.2833 was FRIDAY’s 7.2 plus five minutes, written onto a THURSDAY; under SET semantics that is 1.31h BELOW the tracked 8.5933 — a PAY CUT of about PHP 367, not the rise it was approved as. Re-probed read-only on 2026-09-16: approved_hours is NULL, updated 2026-09-15T15:54:29Z, so derivation rule 2 now produces 8.6767. THE RULE WAS NOT LOOSENED — rule 1 (a stored total wins) still stands, because the VALUE was wrong and not the rule. The standing lesson is written into memory: always diff a stored approved_hours against ITS OWN day’s tracked hours, and audit hubstaff_hours PAGED.',
  },
  {
    name: 'Start Processing plays one bounded cue and pops a modal on every other open Wizard and Dispatch, over its own topic that a late arrival never hears',
    status: 'Pending Deploy',
    shas: ['ed6c92ee', 'b7b22f5b', '9c674472'],
    basis:
      'The cue fires on the BUTTON CLICK and not on confirm; confirming HOLDS it past the modal close and cancelling KILLS it. Bounded by a 12s FLOOR and CEILING — a short clip loops, a long one is faded. ONE cue serves both surfaces; splitting them was REJECTED. The broadcast half uses its OWN topic, `payroll-start-processing`, and never follow/sync/paid, because realtime-js reuses a channel per topic. A LATE arrival never hears it: no replay, plus receive-time staleness. `START_CUE_WINDOW_MS` MUST equal `STAGE_PREPPED_RUN_SECONDS`. Kane supplies the track; the repo carries only the CUT. On origin/main, not confirmed live.',
  },
  {
    name: 'The payroll lock banner named a tab that no longer exists, so every employee read it on every tab — the detail is now required and written per tab',
    status: 'Pending Deploy',
    shas: ['53237600', 'fb04c0ec'],
    basis:
      'A FALSE PREMISE, confirmed and then fixed. The Start-processing lock NEVER gated Documents — not Termination Letters, not COE, not the employee tab. It reaches only KPI/QC takeovers, Profile > Payment, the dead Issues tab, ten score/rate routes and a cosmetic sidebar collapse. The delay everyone was seeing came from the BANNER: it defaulted to "Issues are temporarily paused", the Issues tab is GONE, so every employee on EVERY tab read it. `detail` is now REQUIRED with no default, and the per-tab sentences live in `payroll-lock-detail.ts`. NEVER "fix" the follow-on by loosening `decideCoeActiveGate` — it fails closed BY DESIGN. On origin/main, not confirmed live.',
  },
  {
    name: 'A failing Documents request showed the JSON parser’s complaint instead of the cause — every response is read through one guarded reader',
    status: 'Pending Deploy',
    shas: ['ff20a737', 'e80df0f8'],
    basis:
      '"JSON Token" was never our string — it is the BROWSER’s SyntaxError, or NextAuth’s "JSON Web Token". Eight unguarded `res.json()` calls in AccountingDocuments hid every real cause behind it. The reasoning that cracked it: the route answers JSON on every branch it knows about, so a non-JSON body means the request never REACHED the handler — and `requireFeatureEdit` sat OUTSIDE the try, where a session or DB read can throw. Fixed with `readJsonResponse`, and the 412 steer now keys on STATUS before the body. HONEST LIMIT, and the reason this is not a closed investigation: the ROOT CAUSE IS STILL UNKNOWN. The next step is to ask for the NEW message, which will now be the real one.',
    blockers: ['Root cause still unidentified — the fix makes the real error visible, it does not explain it.'],
  },
  {
    name: 'The Accounting Documents tab no longer reloads itself on every tab switch, and a cached null can never pop the signature dialog',
    status: 'In Progress',
    shas: ['1f7e2078'],
    basis:
      'In Progress, NOT Pending Deploy: `1f7e2078` is the one commit in this range that is NOT an ancestor of origin/main. Vercel deploys origin/main, so this has never been served and cannot have been clicked through. Nothing in this skill pushes — it moves when Kane pushes. The work joins Documents to the shared tab cache with 3 keys and 3 categories: `documentsQueue` is a SHARED QUEUE (banned-list pinned, the mount fetch ALWAYS runs, silent when seeded); `documentsSignature` is cached but `signatureLoaded` is NEVER seeded, because a cached null pops the capture dialog on every switch; `documentsView` is the first UI selection stored here and is re-validated on read. The spinner is DERIVED and the error card shows only when there is nothing to paint.',
    blockers: ['1f7e2078 is not an ancestor of origin/main — not deployed. Kane pushes.'],
  },
  {
    name: 'The reference docs and UI standards catch up with the Sep 14 work, and the Dispatch step drops a pill that stopped being true',
    status: 'Pending Deploy',
    shas: ['f8855cab', '987929f3', '9f613bdc', '27da1f2f'],
    basis:
      'A Chore row, scored 2, covering the record-keeping half of the Sep 14-16 range: reference docs for 3 routes and 4 components, INDEX row 36 re-checked and left un-contradicted, ui-standards taught SlidingTab and the vertical rail with the spring-vs-ease deviation RECORDED rather than ratified, the Sep 14 leftovers and the wizard’s stale clearOffboarded flag removed, and the "Paystubs send 1-by-1 · n8n on Mark Paid" pill dropped from the Dispatch step because it had stopped being true. This is the rule from [[reference-docs-rot-silently]] being paid down. On origin/main, not confirmed live.',
  },
  // ── CARRIED FORWARD from pass 27 — re-derived from git and from the database, not copied ─────────
  {
    name: 'A second bank account sits tucked behind the first as a deck that spins the stack, and the card facing forward never implies where the money goes',
    status: 'Pending Deploy',
    shas: ['9803bba6'],
    basis:
      'ADVANCES one step on evidence. Pass 27 held this at In Progress because `9803bba6` was not an ancestor of origin/main. Re-checked 2026-09-16: it IS an ancestor now, so Vercel has served it and the row moves to Pending Deploy. It does NOT move to Done — being deployed is not the same as someone having looked at it, and the visual verification named as a blocker last pass has still not happened.',
    blockers: ['No visual verification of the deck, the spin or the read-to-edit elongation.'],
  },
  {
    name: 'GoTyme and MariBank are the colour their mark prints on, not the colour of the ink — a swatch source the card reads and never draws',
    status: 'Pending Deploy',
    shas: ['34482dbf'],
    basis:
      'ADVANCES one step on the same evidence: `34482dbf` is an ancestor of origin/main as of 2026-09-16, where it was not on 2026-09-13. Deployed, not confirmed live. The exact-equality test on the near-identical card faces stands and is never loosened.',
  },
  {
    name: 'Sending a second copy of a pay document asks first, and the copy is labelled Reissued or Amended rather than counted as an attempt',
    status: 'Pending Deploy',
    shas: ['4acceeb9'],
    basis:
      'STAYS HELD, and the hold was re-measured rather than carried over on faith. `public.paystub_issues` was probed read-only again on 2026-09-16, with .limit(1) and alongside a negative control that correctly reported MISSING: the table is STILL absent from production. This is the row Kane’s blanket "those pending deploys are already done" confirmation could not reach on 2026-09-13, and it still cannot — an assertion cannot create a table. The feature records nothing until the migration runs.',
    blockers: [
      'references/sql/create/2026-09-12_paystub_issues.sql has not been run — re-measured 2026-09-16, public.paystub_issues absent from production. Ship it with scripts/apply-paystub-issues-migration.mts (--apply gate).',
    ],
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
