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

export const PASS_DATE = '2026-08-25';
export const AUDIT_RANGE = '2951167a..HEAD';
export const AUDIT_COMMITS = 20;
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
    name: 'Kolan and HiGlobe are assignable when a person is unrouted, and picking one sets the Disbursement rail',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['59dc91af'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" That is the production evidence this row was short of — 59dc91af is an ancestor of origin/main (re-checked after a fetch today), and Kane has exercised it. UNDECLARED UNTIL THIS PASS: it landed BETWEEN the 08-24 pass's review (10:23) and its apply (10:49), so that pass could not have seen it. Two things ship together and neither works alone: the wallet rails become assignable for an unrouted person (they were absent from the assignable set entirely), and picking one MIRRORS into the Disbursement rail so a wallet payee cannot sit with a bank rail underneath them. The new guard (src/lib/employee/wallet-rail-lock.ts, 66 lines) reads the EFFECTIVE rail across three tiers and FAILS CLOSED — unset is NOT locked, so an unknown rail is never read as permission. 12 files, 479 insertions, 148 lines of new test across two files, three API routes and three components. Scored 5 as the peer of the 5-SP People Bank-changes band row. Not 8 — it reprices nothing and moves no money. Not 3 — it changes who can be routed where, on the payment rail.",
  },
  {
    name: 'Overview Expanded roster table leads with the person, with shared sort and page size',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['38670c4c', '0764c802', '565229ae', 'ac23232c'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" All four shas are ancestors of origin/main. FOUR commits, ONE row: all four touch nothing but src/components/Overview.tsx on the same day — 38670c4c built it (381 insertions), then three fit-and-finish passes (the Employees card back to a panel with ID leading, the table fitting its card at every width, and the corners plus a one-line ID). Clustering by file overlap makes that one screen built and finished, not four rows. The roster leads with the PERSON rather than the ID, and sort plus page size are SHARED with the Simple view so the two cannot disagree. A shadcn Table component was abandoned on the way because it breaks sticky headers. Not 5: no new module, no test file, no money path — it is one screen. Not 2: 452 net lines across four passes.",
  },
  {
    name: 'Raw hsl: department keys stop reaching human-readable screens — formatDeptLabel applied app-wide',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['bc5a9296'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" bc5a9296 is an ancestor of origin/main. Raw `hsl:*` keys were leaking into rendered UI across the whole app, so people read `hsl:filing_specialist` on screens meant for humans. 54 files, 420 insertions: formatDeptLabel applied app-wide (a no-op off HSL), with a 137-line render test plus a source-scan test guarding the regression. Deliberately NARROW, and the narrowness is the design: the raw key is KEPT in exports, tooltips, search haystacks and filter VALUES, because those are machine-side and collapsing them would break matching. Scored 3 as the peer of the 3-SP Kolan rename — wide, shallow, label-only. Not 5: no logic moves, nothing reprices. Not 2: 54 files plus two guard tests. STATED and NOT closed by this row: the headcount cards still group on the raw key, and the scan guard covers only whole-line JSX children under src/components, so green tests there are not proof of coverage elsewhere.",
  },
  {
    name: 'People roster export carries the masked account last 4 and the date the bank last changed',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['edf0aa10'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" edf0aa10 is an ancestor of origin/main. 10 files, 665 insertions: the People roster export gains the masked account last 4 and the date the bank last changed, on two small new modules (mask-account.ts, bank-update-history.ts) with 246 lines of test and a 166-line feature doc. Three decisions worth recording because each is a way this could have been wrong: masking is done SERVER-side and never in the browser, so the full number never leaves the server; the export is slot-aware, because 8 people sit on an alternate bank slot and a slot-blind read would show the wrong account; and the date comes from bank_update_history and NEVER from the self-update stamp, which records a different event entirely. Not 5: it adds two columns to an export that already existed, where the 5-SP Gift Tracker row built a new one. Not 2: bank data leaving the system is a disclosure surface.",
  },
  {
    name: 'Only Lead Gen hires get the orientation email — gated in the sender, failing closed on a blank department',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['d79c1a64'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" d79c1a64 is an ancestor of origin/main. It closes a live incident: on 2026-08-21 teal@ locked the 2026-08-23 week (79 rows) and row 66 — an HSL hire — was emailed the Lead Gen orientation Zoom link, because nothing anywhere scoped the send by department; the live n8n flow was Webhook to Split Out to Gmail with NO filter at all. The gate now lives in the SENDER (`isLeadGenDepartment`, the SAME predicate that gates the CallTools webhook, so both orientation surfaces agree on who is Lead Gen and there is exactly one place to change it), and it FAILS CLOSED — blank, NULL or unrecognised department is not Lead Gen. Withheld hires are never silent: they come back in `webhook.skipped` with a reason and their own toast, and hire_index still counts the full week so a trimmed resend lines up with the original n8n numbering. 7 files, 392 insertions, 121 lines of new test. Not 2: a live incident with a two-layer remedy. Not 5: one predicate and one payload builder. THIS ROW CLOSES ON THE SENDER GATE, WHICH IS THE FIX. The un-imported n8n Filter node is the deliberate SECOND layer and is deliberately NOT held against this row — it is split out as its own S27 chore row so closing this one buries nothing. STATED and open, Kane's call: non-Lead-Gen hires now receive NO welcome email at all, so the paperwork expectations that email carried reach them nowhere.",
  },
  {
    name: 'An unresolvable payroll week stops being a forever-loading KPI Calculator screen',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['8cd16525'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" 8cd16525 is an ancestor of origin/main. A payroll week that could not be resolved from a batch FILENAME left the KPI Calculator on a skeleton forever — the skeleton was TERMINAL, with no error state and no way out, so the screen simply never revealed. Two fixes in one row on purpose: the reveal is now a tested rule (src/lib/manager/kpi-calculator-reveal.ts, 48 lines + 38 of test) so an unresolved week surfaces instead of hanging, and undatable batch names are REFUSED AT INGEST so the poisoning state cannot be created again. Fixing only the screen would have left the data able to re-poison it, which is why both halves are here rather than split. 10 files, 342 insertions, three new modules including calendar-column-dedupe and a payroll-week-filename test. Not 2: three new modules and a change to what ingest will accept. Not 5: no money path, no new surface.",
  },
  {
    name: 'Attestation pays Referral Leads and SSA.Gov on top of the case tier',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['681662f7'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" 681662f7 is an ancestor of origin/main, and it is the ONLY commit in this range that actually touches Attestation — 7b9fe312, whose message is literally ATTESTATION, contains no attestation code whatsoever and is filed as the wizard step-rail row instead. Attestation now pays Referral Leads and SSA.Gov at ₱250 each on TOP of the case tier, and the tier itself still reads CASES ONLY: the two must not be conflated or the tier inflates for everyone in the department. 4 files, 158 insertions — 9 lines of schema change with 84 lines of test and scripts/verify-attestation-tiers.mts extended. NOT retroactive, per Kane. Scored 2 and not 3 because it is one rule in one schema; not 1 because it pays real money and a wrong tier boundary overpays every member of the department. WORTH KNOWING for the first scored week: no Attestation dept-week had been scored through this at the time it closed, so the first real payout is the first live exercise of the new components.",
  },
  {
    name: 'Orientation gets its own tab on My Team — weekly attendance tally, drill-down and PDF export',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['06f7f669', 'd08a9948', 'd24b49a8'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" All three shas are ancestors of origin/main. THREE commits, ONE row: 06f7f669 built the panel and the model, d08a9948 stamped the doc, d24b49a8 lifted it out of the New Hire Check List into its own tab — same panel, same model, same day. Manager to My Team to Orientation carries a weekly attendance tally, per-week drill-down and Export PDF. TWO design facts are load-bearing and both are the kind that silently sink a feature: it is an INNER tab, because a new TOP-LEVEL tab is a new feature key and no permission row means hidden, so nobody but an admin would have seen it; and attendance is the STAMP (`orientation_attended_at`), never `status` — live rows exist carrying both stamps with status `no_show`, and a `no_show_at` with status `ready`, so any status-based rule is wrong on real data. The week key is HR's checklist `period_start`, replacing a date-derived key that was 46% WRONG (439 of 954 matched hires filed a week early). Verified against prod by running the shipped builder over the live tables: 975 hires to 12 HR weeks plus 19 off-checklist, 934 attended / 41 not, every hire in exactly one bucket. Not 8: no money path, no new table, and the My Team no-comp rule means the PDF carries no money column. Not 3: a new API route, a 261-line tested model with 255 of test, a 439-line PDF builder, a new panel and a hook.",
  },
  {
    name: 'Payroll Wizard step rail shows a predicted load bar that never reaches 100% on prediction alone',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['7b9fe312'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" 7b9fe312 is an ancestor of origin/main. THE COMMIT MESSAGE IS WRONG — it is titled ATTESTATION and contains no attestation code at all. Clustered by file overlap it is the Payroll Wizard step rail: step-load-prediction.ts (109 lines) with 117 lines of test, PayrollWizard.tsx +250, and 42 lines of CSS. The wizard's loaders cannot report progress (a fetch either is or is not done), so a determinate bar has to be PREDICTED from that step's own load history in localStorage, smoothed, with bounds so one pathological load cannot poison every refresh after it. Extracted from the component precisely so the invariant that matters is proven in a test rather than asserted in a comment: the bar NEVER reaches 100% on prediction alone (ceiling 0.9, and 0.99 once a load overruns) — the line exists to tell Accounting when the figures are safe to read, and a bar that hit 100% early would say so early. 12 tests. Not 3: one module and one rail, no data path. Not 1: a real invariant with its own test file and 250 lines of wizard change. ALSO IN THIS COMMIT and deliberately given no row: five `.tmp-vfy-*.mjs` probe scripts, two `scripts/tmp-probe-*` files and two report JSONs were committed as working residue — noise, not a deliverable, but they are in the tree and worth a cleanup commit.",
  },
  {
    name: 'A mid-week department transfer says so under the Department line on every paystub surface',
    status: 'Done',
    completed: '2026-08-25',
    shas: ['47386073'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" 47386073 is an ancestor of origin/main. A person moved mid-week now has \"Lead Gen to HSL\" printed under the Department line on EVERY paystub surface — app, email, export and PDF. This is the COMMON case, not an edge case: 277 of 281 dated transfers are effective on a non-Sunday. Three rules decided the build and each rules out an easier wrong answer. SOURCE is department_transfer_requests and NEVER the proration block, because a same-rate move prorates nothing and those are exactly the people the label exists for. `applied` rows ONLY, deliberately narrower than the premium map, which also trusts `approved` — live there are 276 applied and 6 approved with a NULL applied_at, all still in their old department. And it is STAGED into the payload rather than derived at render, because paid stubs are frozen as-paid, so a transfer released next month must not rewrite a statement already in an inbox — the stated consequence being that already-paid stubs never gain the label, by design, and backfilling would mutate a legal pay record. The label is derived ON THE VIEW, which is the fix for the failure this area suffered twice (weekend rows and the proration chip both shipped in-app while the email stayed stale); a parity test pins both surfaces to one string. Round trips are real and collapse (`Lead Gen to HSL to Lead Gen`). 18 files, 1,232 insertions, a 253-line tested legs model with 234 of test. Not 8: it prices nothing. Not 3: two API routes and six paystub modules. OPEN and NOT closed here, Kane's call: an HSL person's stub carries two names for one department, because the Department line collapses to the parent while the label prints the sub-team.",
  },
  {
    name: 'sheet_synced was a false success — the sheet write is always attempted and reports three outcomes',
    status: 'Done',
    completed: '2026-08-25',
    shas: ['667dfe9d'],
    basis:
      "DONE ON KANE'S CONFIRMATION, 2026-08-25: \"All of those are deployed already Ive tested them.\" 667dfe9d is an ancestor of origin/main — and its commit message is just \"Fix\". `department_transfer_requests.sheet_synced = true` did NOT mean the Google Sheet was written: when the DB row already held the target department the sheet write was SKIPPED ENTIRELY and success was recorded from the DB apply result — a fact about the database asserted about the spreadsheet. Measured: 197 of the last 200 applied transfers report success and at least 7 provably never landed (markl@, kimerl@, theresaa@, jesr@, aimei@, hannam@, shainan@ all still carry their pre-transfer department on the live sheet). The damage was not cosmetic — a stale sheet cell breaks the master sync's (personal_email, department) identity key, so those people silently drop out of active_employees and go invisible across the app while still being paid. The write is now ALWAYS attempted and returns THREE distinguishable outcomes instead of one boolean — cell flipped, already target (a genuine success, so no false Retry badge), or real drift — with planSheetDepartmentUpdate as the pure tested core and 8 tests pinning them apart. Do not collapse them back into one flag. Not 2: the false-success branch corrupted a downstream identity key. Not 5: one write path and its outcome type. THIS ROW CLOSES THE CODE ONLY. The 9 cells already drifted are NOT repaired by it and are split out as their own S27 chore row, because a fix that stops new drift repairs none of the old.",
  },
  {
    name: 'Dispatch exports carry the Adjustment, COP Value and System Bonus they were hiding',
    status: 'In Progress',
    shas: ['1f94ff70'],
    basis:
      "HELD AT IN PROGRESS AGAINST KANE'S \"all of those are deployed\" — deliberately, because git disagrees and git is checkable. Re-fetched 2026-08-25 after that message: origin/main is 667dfe9d and `git merge-base --is-ancestor 1f94ff70 origin/main` FAILS. Vercel deploys origin/main, so this commit cannot be in production; it is committed locally and unpushed, and Kane pushes. Marking it Done would put a claim on the board that one command disproves. It advances the moment it is pushed. THE WORK ITSELF: Kane asked whether the values locked in from the Payroll Wizard to Payment Dispatch actually match and whether the export CSVs match — two questions with different answers. THE VALUES ALREADY MATCHED, measured and not assumed: scripts/verify-dispatch-carryover.mts on the live 2026-08-16 cycle returned 1,040 of 1,040 staged payees priced by the wizard, 0 falling through to the wizard-blind path, every row recomposing to the amount being sent. THE EXPORTS WERE THE GAP, in two classes. A signed component hidden inside an aggregate: the pending CSV had no Other Bonuses and no Adjustment column, so Bonus Total minus PAB minus Tech was a residual mixing earned dept/KPI money with Accounting's SIGNED withholding — 694 rows carrying ₱1,825,433 of other, 86 carrying an Adjustment of which 6 were NEGATIVE, and 67 rows where both were non-zero so the residual was unsplittable by arithmetic. And columns on screen but absent from that screen's own export: all five log views RENDER COP Value and System Bonus while neither was in SENT_COLUMNS, hiding ₱5,519,915 of frozen system bonus across 1,606 records. Two identities are now pinned by 13 tests and asserted against live rows by the verifier. Not 2: these files are the HRIS-vs-Google-Sheet validation artifact, and a column that vanishes between screen and file reads as \"we did not pay that\". Not 5: no value changed, only what the file discloses. OPEN and reported rather than fixed: pending rows and log views still resolve Department by different precedence, which diverges only on a mid-cycle transfer.",
    blockers: ['Not pushed — 1f94ff70 is not an ancestor of origin/main, re-checked after a fetch on 2026-08-25. Vercel deploys origin/main, so this is not in production whatever the working tree shows'],
  },
  {
    name: 'Hurupay is renamed Kolan everywhere a human reads it, with the stored value left untouched',
    status: 'Done',
    completed: '2026-08-24',
    shas: ['2951167a'],
    basis:
      "CLOSES ON TWO INDEPENDENT FACTS, one confirmed and one MEASURED. The 08-24 pass filed this In Progress for two reasons and both are now gone. (1) THE PUSH: `2951167a` was not an ancestor of origin/main then; re-checked after a fetch today, it is. (2) THE MIGRATION, which is the one that mattered and the one an assertion could not settle — this row was blocked because the payout_brand column did not exist, and a feature whose column is missing is code-complete and functionally dead. So it was PROBED read-only rather than taken on anyone's word: `hr_onboarding_submissions.payout_brand` returns rows, and the negative control on the same table returns `42703 column does not exist`, which is what proves the probe can actually detect an absent column. The migration has been run. On top of that Kane confirmed 2026-08-25: \"All of those are deployed already Ive tested them.\" THE WORK: 48 files, 576 insertions, LABEL ONLY — the stored value `hurupay` never moves, no history is rewritten, nothing re-routes, and `kolan` is aliased in all three normalisers, which must agree or the rail breaks. The routing value staying `hurupay` is deliberate: `payment_method`'s CHECK, the mirrored employee_ids.bank_preferred literal and isWiresPreferred() all key on that exact string, so a value rename would make every Hurupay/Kolan payee read as WIRES and lock them out of the wallet rail.",
  },
  {
    name: 'Import orientation-email-leadgen-only.json into live n8n as the second-layer filter',
    status: 'Ready to Start',
    shas: ['d79c1a64'],
    basis:
      "SPLIT OUT of the orientation-email gate row so closing that row buries nothing. The gate row closes on the SENDER, which is the fix and which Kane has tested; this is the deliberate SECOND layer and has never been imported. The live n8n flow is still Webhook to Split Out to Gmail with no filter — the exact shape that let an HSL hire receive the Lead Gen Zoom link on 2026-08-21. references/n8n/orientation-email-leadgen-only.json exists in the repo only. The node checks `lead_gen === true` OR a department normalising to `leadgen`. Losing it in the n8n cloud UI must never re-open the hole, and the server gate must never be removed because n8n filters it. 1 SP: an import, not a build. Kane's to run.",
    blockers: ['The workflow has never been imported into live n8n — it exists in references/n8n/ only'],
  },
  {
    name: 'Repair the 9 drifted master-sheet department cells left behind by the sheet_synced false success',
    status: 'Ready to Start',
    shas: ['667dfe9d'],
    basis:
      "SPLIT OUT of the sheet_synced code row, because a fix that stops NEW drift repairs none of the old. Measured 2026-08-25 across 1,592 sheet rows and 2,564 DB rows: 1,583 agree, 0 sheet rows lack a DB identity, 9 DRIFT, and 4 active rows are absent from the sheet (which correctly drop out). Those 9 stale cells are why people who are still being paid fall out of active_employees and go invisible across the app — markl@ was frozen on the 2026-06-11 upload for exactly this. THE ORDER IS NOT OPTIONAL: flip the Sheet cell to the DB department, re-stamp, and only THEN sync. Clicking Sync first would mint 9 duplicate rows in pre-transfer departments and clobber HRIS truth for precisely the invisible people. scripts/fix-sheet-dept-drift.mts does the first two — dry-run by default, `--apply` gate, backup written first — and REFUSES three classes rather than guessing: an off_boarded_at stamp anywhere (beao@, ellainnec@), DB rows disagreeing with each other, and a DB department that is not placeable (shainan@ sits on bare `hsl`, which resolves no base rate and needs a sub-team before her cell can be written). 6 of the 9 are repairable. NOTE for whoever runs it: the backup file already committed in 667dfe9d proves nothing about whether --apply ran, because the script writes that backup on dry runs too. 3 SP: a gated data repair on live payroll identity.",
    blockers: ['The repair has not been run — scripts/fix-sheet-dept-drift.mts needs Kane to approve the --apply, and 3 of the 9 rows need a business decision before their cell can be written'],
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
