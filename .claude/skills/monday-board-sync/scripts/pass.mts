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
 *
 * ── PASS 36 · 2026-09-29 — THE WITHHELD WEEK, plus the Sprint 29 → Sprint 30 rollover ──────────────
 * Kane asked two things. First: "update our monday board based on what work we have done that is
 * withheld". Then: "move unfinished task from 29 to 30 we have a new sprint". The budget was DEAD on
 * arrival. The first read-only call, at 12:41:39Z, returned DAILY_LIMIT_EXCEEDED with retry_in_seconds
 * 40699, which resets at 00:00Z on 09-30. So this pass is STAGED and self-checked offline. No review
 * hash can exist yet, because review.mts reads the board.
 *
 * THE RANGE. 217544cd..0fa0b89d, 127 commits (pass 33 ended at 217544cd). All 127 are ancestors of
 * origin/main (0 ahead / 0 behind after a fetch). 79 commits make the 52 rows below. The other 48:
 * 37 docs-only commits (audit items and briefs); nine board-pass records, five that stage
 * hris-plan.ts (feab043f 1d3d1d07 d4c30650 f0956940 b0f19914) and four that touch only the
 * ledger (2ee7e02a cea56d5a 0795b70d 5c8eadd4); 00721734, a docs commit whose one code change is a
 * comment in CarlaSongToast.tsx; and 7586a85f (paystub_issues RLS), already evidence on the pass-35
 * reissue row carried below. The 127 were counted by script, and no code commit is left unnamed.
 *
 * FILE-OVERLAP FINDINGS. `6cabcff3` is titled "0". It retires the employee sending-bank pick across
 * 28 files and deletes 1,621 lines. `cbe1754f` is docs(security), yet it edits the Data catalog's
 * datasets.ts, so it is evidence on that row. `0f4667c5` REVERSES the 12-second bound of an S29 row
 * that is already Done, so it becomes its own row with the current rule; the old row stays as history.
 * `ca36e17e`'s write-a-master-row approach was superseded by `6565022d`'s ledger arm, so one row
 * describes the current rule. `87c407ff` touches both an in-app email and an n8n workflow, so it is
 * split: the in-app half is Pending Deploy, the n8n half is held.
 *
 * SPRINT. Sprint 30 exists on the board (Kane), but its group id, label index and window cannot be
 * read until the reset. On the Tue→Sat pattern it opens Tue Sep 29, which makes Sprint 29's
 * ATTRIBUTION Sep 15-28, so every row here that finished (last sha Sep 23-28) files under S29. If
 * the live title says otherwise, re-derive before review. What rolls to S30 is ONLY the work whose
 * remaining step lies ahead: the ten open S29 rows (all re-measured 2026-09-29, all still blocked or
 * unstarted) plus the three new rows marked ROLLS TO S30 in hris-plan.ts. A code-complete Pending
 * Deploy row stays in S29. Its Done date is its commit date, which lies outside S30, so selfcheck
 * would refuse it there. That is pass 32's rule.
 *
 * BLOCKERS RE-MEASURED read-only on 2026-09-29 (one BEGIN READ ONLY transaction per query, script
 * deleted after use):
 *   • support.closed is absent from employee_notifications_type_check; 1 rejection 09-25 20:03Z
 *   • 0 employee_roles and 0 live employee_feature_permissions matching support
 *   • ticket_replied / ticket_moved: active=false, url empty (webhooks.config saved 2026-09-12)
 *   • employee_schedule_periods absent; paystub_issues present, RLS on, 0 rows
 *   • gift_orders, gift_order_lines and gift_order_delete() present
 *   • Lead Gen 2026-09-06 bonus_catalog_applied: the same 290 rows by carla@ at 09-15 15:16Z, so the
 *     restore has not run
 *   • OMS_RETURN_TABLE is not set in .env.local
 *
 * ── PASS 36, RESUMED 2026-09-30 — Kane: "All withheld sp push them to monday asap and if there are
 * unfinished Tasks from sprint 29 move them to 30" ────────────────────────────────────────────────────
 * The budget was ALIVE: tmp-probe-s30.mts (2 calls) at 11:05Z read Sprint 30 = group_mm7m3x2d,
 * label 106, "Sprint 30 · Sep 29-Oct 9 · Backlog Pull". So the Tue Sep 29 assumption held, and S29's
 * attribution is Sep 15-28 as staged. All four maps are mirrored and the 13 rolling rows say S30.
 * PASS_DATE moved to 09-30 because the CONTENT changed (11 new rows, S30 mirrored, one rename). It was
 * not moved to clear a mismatch: no hash was ever minted for 09-29.
 *
 * THE RANGE GREW. origin/main moved from 0fa0b89d to 31fd9c0a (0 ahead / 0 behind after a fetch on
 * 2026-09-30), so the withheld set is now 217544cd..31fd9c0a, 142 commits. The 15 new ones all carry
 * an author date of 2026-09-29, inside S30. 13 make the 11 new rows; c76bb25a (this pass's staging)
 * and 54803650 (one audit line) carry none. 56e0a7f4 REVERSES the staged whole-song length, and that
 * row had never reached the board, so it was renamed to what 0f4667c5 still makes true and the new
 * length is its own S30 row. Every staged row's status was re-derived from git: no other later commit
 * contradicts one.
 *
 * BLOCKERS RE-MEASURED read-only 2026-09-30 ~11:10Z (pg, BEGIN READ ONLY per query, from the
 * scratchpad, nothing written). Every one is unchanged since 09-29:
 *   • support.closed still absent from employee_notifications_type_check; 0 rows of the type
 *   • 0 live employee_roles employee_support / support_tickets; 0 live support feature grants
 *   • ticket_replied / ticket_moved: active=false, url '' (webhooks.config updated_at 2026-09-12)
 *   • to_regclass('public.employee_schedule_periods') is null
 *   • Lead Gen 2026-09-06 bonus_catalog_applied: 290 rows, applied_by carla@ only, all 09-15 15:16:08Z
 *   • OrphanageOmsPanel.tsx still mounts omsReturn with no button that opens it; OMS_RETURN_TABLE unset
 *   • the Advisor fix HOLDS: relrowsecurity true on all three tables, 0 public tables with RLS off,
 *     active_employees reloptions [security_invoker=true], 0 public views left as definer
 *
 * PASS 36 APPLIED 2026-10-01. Kane: "Push", "Continue". The 11:27Z probe was alive, the blockers were
 * re-measured unchanged, and review.mts minted e8e9a7031db4 in EXACTLY the shape put to him: 63
 * created, 10 re-filed, 65 corrected, 4 Done (19 SP), 0 orphans, 0 duplicates. `apply.mts --apply
 * --only-new` wrote 65/65 with 0 skipped. The budget then died at 11:32:30Z (retry 44,849 s → 00:00Z
 * 10-02) on the mover's first call, so the 10 moves and every verify-one are still OWED.
 *
 * ── PASS 37 · 2026-10-01 — the commits after pass 36's staging ────────────────────────────────────
 * 31fd9c0a..57e712f9, 12 commits, all on origin/main (0/0), all authored 2026-09-30, inside Sprint 30.
 * Three rows / 14 SP, all Pending Deploy (see the cluster note in hris-plan.ts). No new blocker: no
 * .sql, no apply script, no n8n workflow in the range. This needs ITS OWN review hash; pass 36's
 * approval does not cover it.
 *
 * ── PASS 40 · 2026-10-06 — Oct 5's commits, closed on Kane's word with their completion date ─────
 * Kane: "check our github commits yesterday and lets push it to monday close it with the completion
 * date". 4aa73d38..a1a9860d, 28 commits, all authored 2026-10-05 (inside S30, Sep 29-Oct 9), all
 * ancestors of origin/main (pushed through a1a9860d). 16 rows / 69 SP (cluster note in hris-plan.ts).
 * Pass 39 was applied and read back 2026-10-04, so its rows leave this array (git history keeps them).
 *
 * Kane's word closes every row with no MEASURED open step outside git. Every external step in the
 * range was measured read-only on 2026-10-06, not taken from the docs:
 *   • COE email (item 347): webhooks.config coe_request_notify is active with an n8n cloud URL, and a
 *     real send at 2026-10-05 20:05Z returned 200 to jakec@ (audit webhook.coe_request_notify). CLEAR.
 *   • MESA email (item 350/352): mesa_request_notify is active with an n8n cloud URL (config saved
 *     2026-10-05 18:21Z). No member has filed since, so 0 sends. Imported, so CLEAR.
 *   • MESA archive migration (item 350): --verify FAILED 4/4 at 11:40Z. Kane then ran it, and at 11:47Z
 *     --verify passes every check and both columns read through PostgREST. CLEAR, Done on 2026-10-06.
 *   • No-show backfill (item 343): applied 55/55 on 10-05; the owed post-deploy rerun was dry-run on
 *     10-06 and plans 0 inserts. CLEAR.
 *   • Start-date restore (item 344): dry run on 10-06 plans 0 DB rows and 0 Sheet cells. CLEAR.
 * Not clicked through by any session (Kane's word is the evidence): the login loader, the picker
 * sweep, PAB bulk Ignore, Profile cold load, MESA (items 357, 351, 345, 350).
 *
 * PASS 40 APPLIED 2026-10-07. Kane: "Push to monday". The budget was alive at 12:44Z; review.mts minted
 * 8cb5a8b824a9 in exactly the approved shape (16 created / 16 Done / 69 SP, 0 re-filed), so no second
 * ask. `apply.mts --apply --only-new` wrote 16/16, and verify-one read back all 16: Done, Sprint 30,
 * Est = Actual SP, the dated Completed Date. No epic relation until a full reconcile.
 *
 * ── PASS 41 · 2026-10-07 — Oct 6's commits, staged Pending Deploy ──────────────────────────────────
 * Kane: "Push to monday". a1a9860d..05b48730, 28 commits, all authored 2026-10-06 (inside S30), all
 * ancestors of origin/main (pushed through 05b48730, 0 ahead). 16 rows / 77 SP (cluster note in
 * hris-plan.ts). Kane has given no word on these, so every row is Pending Deploy, the honesty gate's
 * default for pushed-not-confirmed. Every external step in the range was MEASURED read-only on
 * 2026-10-07, not taken from the docs:
 *   • MESA suspensions migration (item 360): APPLIED. --verify passes every object, positive and
 *     negative control; its one FAIL is "the table starts empty", i.e. suspensions already exist.
 *   • Accounting Scoreboard round 3 migration (item 379): APPLIED, --verify all checks passed.
 *   • Address letter migration (item 375): NOT APPLIED. document_requests_document_type_check admits
 *     only paystub / coe / award / other, and an 'address' control row is refused. BLOCKER.
 *   • PAB forgive backfill (item 363): NOT RUN. The dry run would null 19 stored-hours rows. The doc
 *     calls it verdict-neutral, but it is an open step in the range. BLOCKER.
 *   • Arriola ghost stamp (item 364): NOT RUN, and the plan run now REFUSES on 2 guards. jakec@ wrote
 *     marka@simple.biz, a real Personal Email and Alternate Work Email "tony@simple.biz." onto the ghost
 *     row 327a7857 at 2026-10-06 16:27Z (people.profile.updated), then returned Carla's offboarding
 *     request on it. BLOCKER, and a finding.
 *   • SSD (item 365): live and USED. Carla re-saved all 68 SSD 2026-09-27 rows at 15:07Z with catalog
 *     inputs, 22 minutes after the push (14:45Z), and the week went Ready at 15:08Z. Its total moved
 *     from the 10-06 morning's PHP 103,449.96 (code) to PHP 87,704.49. The deploy gate said Ready
 *     first. That is a money finding for Kane, not a board blocker.
 *
 * ── PASS 42 · 2026-10-08 — every Sprint 30 commit accounted for, pass 41 folded in ──────────────────
 * Kane: "Summon the monday skill and check our commits make sure we log every single one into Monday
 * sprint 30". Pass 41 was never applied (hash a5329d0f1366 waited on Kane), so its 16 rows ride here,
 * re-derived, with this pass's 19 new rows and one advance of a row already on the board.
 *
 * COVERAGE, measured not assumed: 200 commits are authored inside S30 (Sep 29 onward). Each sha was
 * grepped against every version of pass.mts and hris-plan.ts since 09-20 plus the two 10-02 paste TSVs.
 * 73 were uncited: 59 in 05b48730..6745bafd (its other 3 are Kane's KANE_EXCLUDED sign-in song
 * commits) and 14 dated 10-02 that fell between pass 38 (ended 89b4347f) and pass 40 (started
 * 4aa73d38). 27e69bca then landed from a concurrent session mid-pass, making 74, and the range closes
 * on it: 05b48730..27e69bca is 63 commits. Of the fourteen, three are code: 9d6225b6 (its own row),
 * 9129b1d0 (pass 41's NPD "leaves out" row, the version 089357f9 reversed) and f082ba96 (the OMS row).
 * e88315ac is a security doc (its own row). The other ten are board-sync bookkeeping. Every uncited
 * sha is now on a row or named in the hris-plan.ts pass 42 note as bookkeeping.
 *
 * MEASURED read-only 2026-10-08 (every migration by its own --verify, every data step by its plan run):
 *   • Seven migrations APPLIED, all checks passed: address letter (item 375, CLEARS pass 41's blocker),
 *     scoreboard custom-host (385), outcomes + zero problems (387), overview visibility (391), Pre-arb
 *     flag (392), external API offboarded scope (389), bank_update_history.safety (401).
 *   • Arriola (item 384) APPLIED, which CLEARS pass 41's blocker by another route: the revert script's
 *     guards read the reverted values, the stamp reads 07-16 duplicate_cleanup by
 *     system:arriola-ghost-redate-2026-10-07, and both Lead Gen bonus rows read MISSING. The stamp
 *     script it was blocked on was never applied; Kane's ruling (b) replaced it.
 *   • COP rates (item 373) APPLIED: the dry run finds every pay structure, the Lead Gen (COP) bonus
 *     and the one applied row already in COP.
 *   • PAB forgive backfill (item 363) STILL NOT RUN: the dry run plans the same 19 rows. BLOCKER stays.
 *   • OMS production env: UNVERIFIED. No Vercel CLI on this machine, so it is named as a blocker.
 * Push state after a fetch: origin/main is 63500994, local main 11 ahead. c88c554c, 42388492 and
 * 27e69bca are local only, so their rows are In Progress. Kane has given no word on any row, so every
 * pushed row is Pending Deploy. One row goes Done on USE (the pass 17 precedent): the KANE_EXCLUDED
 * evidence tooling, which this very pass ran.
 *
 * PASS 42 APPLIED 2026-10-08 (hash 0166fd80774f, 36/36 read back), so its rows leave this array.
 *
 * ── PASS 42b · 2026-10-08 — what closes on EVIDENCE after Kane's push ─────────────────────────────
 * Kane: "Anything in there we can close? I have pushed it already". After a fetch, local main ==
 * origin/main (a2a95911), so every pass 42 sha is pushed. Pushed is not live, so a row closes here
 * only on MEASURED production use or a measured data state, never on the push itself:
 *   • Proof of Address: one address letter issued and SIGNED in production, signed_at 2026-10-07
 *     16:42Z (document_requests, read-only). Dated 10-07, the day it became provable.
 *   • Offboarded external API: the job portal's own key made 40 successful production reads on
 *     2026-10-07 (cb0b94d4's probe), and its migration is applied.
 *   • SSD: Carla re-saved all 68 SSD 09-27 rows with the catalog inputs at 2026-10-06 15:07Z, and the
 *     week went Ready.
 *   • Arriola: a data cleanup whose deliverable is the production state, measured done 2026-10-08.
 *   • The grid-clear script: Kane ran it and the result was measured (6745bafd). Done on USE.
 * The two rows whose shas were local (c88c554c, 27e69bca) move In Progress → Pending Deploy.
 * NOT closed on evidence, by measurement: payout change safety (deployed, but 0 real safety rows,
 * so nobody has saved through it yet) and COP (its --apply backup is stamped 13:56Z on 10-07, 3½
 * minutes after 14ea111a was committed, so it almost certainly ran before the deploy its own
 * --deployed flag asserts, and the doc still says PENDING). The other 28 pushed rows with no open step
 * close only on Kane's word that he has seen them live.
 *
 * PASS 42b APPLIED 2026-10-08 (hash 72b77167d2b5, 7/7 read back), so its rows leave this array.
 *
 * ── PASS 43 · 2026-10-08 — the two features that landed after pass 42 ─────────────────────────────
 * Kane: "add". 27e69bca..a2a95911, 10 commits, all on origin/main (local == origin after a fetch).
 * Two are code, one feature each, so 2 rows / 13 SP (cluster note in hris-plan.ts). Both migrations
 * were MEASURED read-only 2026-10-08 by their own --verify: the scoreboard roles table APPLIED, and the
 * payout_account_reports table APPLIED. Item 406 still recorded that --apply as pending, so this is
 * one more stale PENDING claim. No external step is open. Kane has given no word that either is live,
 * so both are Pending Deploy.
 *
 * PASS 43 RE-DERIVED 2026-10-08 19:2xZ — Kane: "update monday board". The budget was still dead
 * (one boardGroups probe, DAILY_LIMIT_EXCEEDED, retry_in_seconds 16598 at 19:23:21Z → 00:00 UTC), so
 * nothing above was ever reviewed or hashed, and 28 more commits had landed: the range is now
 * 27e69bca..b7cfe890, 38 commits, 16 rows / 73 SP (cluster note in hris-plan.ts). After a fetch,
 * origin/main is 81040a76: 4884086a and b7cfe890 (item 421) are local, so that row is In Progress.
 * MEASURED read-only 2026-10-08:
 *   • Three more migrations APPLIED by their own --verify: chat posts (412; its Open item still read
 *     PENDING, another stale claim), task boards (393) and hires sync (411).
 *   • Item 412 is LIVE: the Vercel cron claimed the 15:00 ET slot (schedule 0 19 * * *) at
 *     19:00:49Z and the accounting_scoreboard_chat_posts row reads `posted`, with an audit row by
 *     "Scoreboard Chat Schedule" / System. Only a deployed build carries that cron, and `posted` needs
 *     the webhook env set in Vercel production, so every step its row named is done.
 *   • Item 393's task boards are IN USE: 97 ticks by 13 people on 10-08, 12 of them not Kane, from
 *     14:34Z to 19:15Z, on 346 tasks (338 sheet-imported, 6 added by Carla). Nobody but Kane runs a
 *     local dev server, so those ticks are production use.
 *   • Item 411's HRIS_HIRES_* in Vercel production: UNVERIFIED (no Vercel CLI), named as a blocker.
 *   • The realtime-js patch (419) needs no hand step: package.json runs patch-package on postinstall.
 *   • The interns cap (417) was applied 9/9 in production before the push.
 * Two rows close on that measured use (the pass 42b precedent). The rest are Pending Deploy, because
 * Kane has given no word that he has seen them live.
 *
 * PASS 43 WAS NEVER WRITTEN. The 2026-10-09 morning probe (one boardGroups call) read
 * DAILY_LIMIT_EXCEEDED at 11:41:39Z, retry_in_seconds 44300 -> 00:00 UTC, so the budget was spent by an
 * unknown consumer before any pass ran that UTC day. Its rows are carried into pass 44 below.
 *
 * ── PASS 44 · 2026-10-09 — Kane closes the withheld SP ──────────────────────────────────────────────
 * Kane: "Update our Monday board close everything that are closed already from withheld SP". The three
 * waiting rooms: the pending ledger owes 0 (70 entries, 0 unflushed); pass 43 is staged and unwritten;
 * and 13 commits after b7cfe890 have no row. Plus the board itself: 35 open plan rows, 30 of them
 * Pending Deploy from passes 41-42. After a fetch on 2026-10-09, local main == origin/main == f0eac591,
 * so every sha below is pushed (b7cfe890 and b2f79853 were pushed 2026-10-08 20:01Z).
 *
 * WHAT CLOSES, on Kane's word (the 2026-10-02 and 2026-10-08 precedents: his close covers every pushed
 * row with no open external step, never a row whose step is measured open):
 *   • pass 43's 14 Done rows, unchanged (Kane closed them 2026-10-08, or measured production use).
 *   • pass 43's hires placement row, RE-DERIVED: ed616a87's "A" rule was replaced by e50cb9f4 (item 423,
 *     "(b) Only the week on screen") the same evening, so the row now describes the current rule, adds
 *     e50cb9f4 and cd27f41a, and goes 3 -> 5 SP. It never reached the board, so nothing is orphaned.
 *   • item 421's card row, In Progress -> Done: both shas are pushed, and the one doubt its row named
 *     ("Google does not document cards on incoming webhooks") is MEASURED settled. audit_log reads
 *     tasks_progress_posted with card=true at 2026-10-08 19:12Z and 19:41Z, so Google answered 2xx WITH
 *     the card twice. Both were Kane's clicks from code not yet pushed, so this is not production use.
 *   • 28 pass 41-42 Pending Deploy rows with no open step.
 *   • 2 new rows from the 13 commits: bf7d7eb9 (the Synced data list) and d358a4ca (item 422).
 * WHAT STAYS, re-measured read-only 2026-10-09 ~11:45Z:
 *   • Tickets emails: webhooks.config (updated 2026-10-05 18:21Z) has ticket_replied and ticket_moved
 *     active=false with an EMPTY url, so neither email is sent.
 *   • HSL scheduling: employee_schedule_periods present (a PGRST205 negative control), 0 rows. Nobody has
 *     saved a period, the row's standing rule since item 342. The 10-08 call put HSL scheduling in V2
 *     (item 427), which changes no status: the code shipped, and the row waits on its first save.
 *   • Send to OMS: OMS_* in Vercel production is UNVERIFIED (no Vercel CLI). The one send in audit_log
 *     (2026-10-07 15:38Z, wizard.orphanage_oms_returned, Kane) cannot say which build sent it.
 *   • PAB forgiveness: the backfill dry run still plans the same 19 rows.
 *   • Not started: the legacy rates-sheet spike (S30) and the bare hsl overrides (BL), Kane's calls.
 *   • b2f79853 (item 408, the Projects Portfolio refresh) gets no row yet: item 340's hardening hard stop
 *     waits on Kane's (a) doc stands / (b) doc stale, and the script has never run.
 *   • d1c25a5e (the 10-08 Carla meeting record, items 424-428) landed at 11:51Z on 10-09, after the fetch.
 *     It is docs only, a record of asks with nothing built, and it is local (main 1 ahead), so no row.
 * Measured beside, not blocking: bank_update_history has 0 rows with a safety attestation, so payout
 * change safety closes on Kane's word alone; no hires sync is audited since e50cb9f4 (the last three, 10-08
 * 18:24Z-18:59Z, ran the old rule).
 * Shape: 46 rows, all Done, all Sprint 30: 18 created, 28 existing corrected.
 */
import { execFileSync } from 'node:child_process';
import { PLAN_TASKS, REPO_ROOT, TASK_SPRINT_LABELS, taskSprintAttribution } from './monday.mts';
import type { TaskStatus } from './monday.mts';
import { planSpProblems, taskSpProblems } from './sp-scale.mts';

export const PASS_DATE = '2026-10-09';
export const AUDIT_RANGE = '27e69bca..f0eac591';
export const AUDIT_COMMITS = 51;

/** The standing proof state of every Pending Deploy row in passes 36-38 — pushed is not deployed. */
const ON_MAIN =
  'Every sha is an ancestor of origin/main (re-checked after a fetch on 2026-10-02), and ' +
  'Vercel deploys main, but nobody has confirmed this live in prod. It goes Done on Kane\'s word ' +
  'that he has looked at it, with the last sha\'s commit date as the Completed Date.';
const pd = (what: string) => `PENDING DEPLOY. ${what} ${ON_MAIN}`;
const LOCAL_ONLY =
  'IN PROGRESS: committed on local main and NOT on origin/main (main was 3 ahead after a fetch on ' +
  '2026-10-02). Kane pushes; once it is on origin/main it is Pending Deploy.';
const ip = (what: string) => `${LOCAL_ONLY} ${what}`;
/**
 * Kane's word on the Pending Deploy rows, 2026-10-02 (to session d2ba4c35): the basis for every row
 * that goes Done on it. It does NOT close a row with a MEASURED open external step (the honesty gate,
 * SKILL.md: an assertion cannot run a migration or set an env var). Those keep Pending Deploy and
 * their blocker, re-measured read-only the same evening.
 */
const KANE_LIVE =
  'DONE ON KANE\'S WORD. Kane, 2026-10-02, on the Pending Deploy rows: "Why are most of these pending ' +
  'deploye close them and end them they are already done lol". Every sha is on origin/main (0 ahead / ' +
  '0 behind after a fetch on 2026-10-02), no external step is open, and the Completed Date is the last ' +
  'sha\'s commit date.';
const live = (what: string) => `${KANE_LIVE} ${what}`;
/** Kane's word on Oct 5's commits, 2026-10-06 — the basis for every pass 40 row that goes Done. */
const KANE_CLOSE_1006 =
  'DONE ON KANE\'S WORD. Kane, 2026-10-06: "check our github commits yesterday and lets push it to ' +
  'monday close it with the completion date". Every sha is on origin/main (pushed through a1a9860d), ' +
  'no external step is open (each was measured read-only on 2026-10-06), and the Completed Date is the ' +
  'last sha\'s commit date.';
const closed = (what: string) => `${KANE_CLOSE_1006} ${what}`;
/** Pass 41's standing proof state: Oct 6's commits are pushed, and nobody has said they are live. */
const ON_MAIN_1007 =
  'Every sha is an ancestor of origin/main (pushed through 05b48730, 0 ahead on 2026-10-07), and ' +
  'Vercel deploys main, but Kane has not confirmed it live. It goes Done on his word, with the last ' +
  'sha\'s commit date (2026-10-06) as the Completed Date.';
const pd41 = (what: string) => `PENDING DEPLOY. ${what} ${ON_MAIN_1007}`;
/** Pass 42's standing proof states, measured after a fetch on 2026-10-08 (origin/main 63500994). */
const ON_MAIN_1008 =
  'Every sha is an ancestor of origin/main (re-checked after a fetch on 2026-10-08), and Vercel ' +
  'deploys main, but Kane has not confirmed it live. It goes Done on his word, with the last sha\'s ' +
  'commit date as the Completed Date.';
const pd42 = (what: string) => `PENDING DEPLOY. ${what} ${ON_MAIN_1008}`;
const LOCAL_1008 =
  'IN PROGRESS: the last sha is committed on local main and NOT on origin/main (11 ahead after a ' +
  'fetch on 2026-10-08). Kane pushes; once it is on origin/main it is Pending Deploy.';
const ip42 = (what: string) => `${LOCAL_1008} ${what}`;
/** Pass 43's local rows: origin/main is 81040a76 after a fetch on 2026-10-08 19:2xZ, main 2 ahead. */
const LOCAL_1008_PM =
  'IN PROGRESS: the shas are committed on local main and NOT on origin/main (2 ahead of 81040a76 ' +
  'after a fetch on 2026-10-08). Kane pushes; once it is on origin/main it is Pending Deploy.';
const ip43 = (what: string) => `${LOCAL_1008_PM} ${what}`;
/**
 * Kane's word on pass 43's Pending Deploy rows, 2026-10-08 19:3xZ (session 723157e6). It closed the 11
 * rows with no open step first. The two hires rows waited, because their HRIS_HIRES_* env in Vercel
 * production was unverified and every hires sync in audit_log (18:24Z, 18:45Z, 18:59Z) ran as Kane (the
 * pass 38b rule: an assertion cannot set an env var). Kane then SET the env and redeployed (~19:38Z), so
 * the step was done, not just asserted, and those two close on the same word.
 */
const KANE_CLOSE_1008 =
  'DONE ON KANE\'S WORD. Kane, 2026-10-08, on pass 43\'s Pending Deploy rows: "All of those 13 pending ' +
  'deploys are already done". Every sha is on origin/main (81040a76 after a fetch), no external step is ' +
  'open, and the Completed Date is the last sha\'s commit date.';
const closed43 = (what: string) => `${KANE_CLOSE_1008} ${what}`;
/**
 * Kane's word on the withheld SP, 2026-10-09 (session 85af82ec). It closes every pushed row with no open
 * external step. It does NOT close the four rows whose step was re-measured open the same morning (the
 * honesty gate: an assertion cannot import a workflow, run a backfill or set an env var).
 */
const KANE_CLOSE_1009 =
  'DONE ON KANE\'S WORD. Kane, 2026-10-09: "Update our Monday board close everything that are closed ' +
  'already from withheld SP". Every sha is on origin/main (local == origin == f0eac591 after a fetch on ' +
  '2026-10-09), no external step is open, and the Completed Date is the last sha\'s commit date.';
const closed44 = (what: string) => `${KANE_CLOSE_1009} ${what}`;
/** Measured production use closes a row without Kane's word (the pass 42b precedent). */
const inUse = (what: string) =>
  `DONE ON MEASURED PRODUCTION USE (the pass 42b precedent). Every sha is on origin/main, no external ` +
  `step is open, and the Completed Date is the last sha's commit date. ${what}`;
/** Dev tooling has no prod surface, so it goes Done on USE (the pass 17 precedent). */
const used = (what: string) =>
  `DONE ON USE. Dev tooling with no prod surface (the pass 17 precedent): selfcheck() runs it over the ` +
  `whole plan on every review and apply, and it ran clean for this pass. Every sha is on origin/main. ${what}`;
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
  // —── PASS 43, carried into pass 44 · 2026-10-08 · 14 rows, Sprint 30, all Done (Kane 10-08, or use) ─
  {
    name: 'The Accounting Scoreboard has its own roles - Admin, Assistant and Team member, granted in Setup - and HRIS accounting alone no longer manages it',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['74f6d2ee', '7ed5b3f8'],
    basis: closed43("Item 393, Carla's roles from the 2026-10-07 call, which Kane confirmed. 7ed5b3f8 adds the apply script's --keep-access-only, so the accounting holder who would have lost access stays a Team member. Its roles migration is MEASURED applied 2026-10-08 (--verify, all checks passed), and the two Admin grants are recorded in a2a95911. No external step is open."),
  },
  {
    name: 'Employees can report a payout account closed, deactivated or frozen, and Accounting sees it on Mark Paid and People before paying',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['20a1287a'],
    basis: closed43("Item 406, Kane's ask 2026-10-08. It informs only: it never holds a payout or switches to the backup account. Its table is MEASURED applied 2026-10-08 (--verify, all checks passed), although the building session recorded the --apply as pending. No external step is open."),
  },
  {
    name: 'People Banking shows how many times the paid account was paid successfully, before the reveal',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['cfb65d35'],
    basis: closed43('Kane, 2026-10-08: "the People - Roster - Banking should have the counts on the successful bank payments". The same floor count the employee sees, from paid dispatch rows to the account Payment Dispatch pays today. One read, no new endpoint, no migration. A failed read says so and never shows 0.'),
  },
  {
    name: "The Accounting Scoreboard is live - a teammate's save shows on every open board in seconds over Supabase Realtime, and no value travels on the wire",
    status: 'Done',
    completed: '2026-10-08',
    shas: ['01e49496'],
    basis: closed43('Item 409. All 15 write handlers send a Broadcast signal, and an open board re-reads through the gated GET, so no value is ever on the wire. No migration and no env var. A Broadcast leaves no trace in the database, so nothing here can be measured from outside a browser.'),
  },
  {
    name: "Accounting Scoreboard per-person task boards - Carla's sheet tasks imported, each person ticks their own, an Everyone view, and Post to Chat",
    status: 'Done',
    completed: '2026-10-08',
    shas: ['0ded334b'],
    basis: inUse('Item 393, plan Tasks 7 and 8. Its tasks migration is MEASURED applied (--verify 2026-10-08, all checks passed), and the sheet import landed 338 tasks on 23 boards (0b7d39c9). Measured read-only in production on 2026-10-08: 97 ticks by 13 people, 12 of them not Kane, from 14:34Z to 19:15Z, and Carla added 6 tasks of her own. Post to Chat shares its one sender with the scheduled post, which is proven live on the scheduled-post row. The weekly lock-in (Task 5) is NOT in this row; it is not built.'),
  },
  {
    name: "The Accounting Scoreboard task progress posts itself to the accounting Google Chat on Carla's schedule - daily at 3 PM, weekly Wed and Fri, monthly",
    status: 'Done',
    completed: '2026-10-08',
    shas: ['5079c89e'],
    basis: inUse('Item 412. Every step its Open item named is MEASURED done: the chat posts migration is applied (--verify 2026-10-08, all checks passed; the item still read PENDING), the code is pushed, and the first 3 PM ET slot posted. The Vercel cron (0 19 * * *) claimed the 2026-10-08 15:00 ET slot at 19:00:49Z, its accounting_scoreboard_chat_posts row reads posted, and the audit row is by "Scoreboard Chat Schedule" / System. Only a deployed build carries that cron, and posted needs the webhook env set in Vercel production.'),
  },
  {
    name: 'An Accounting Scoreboard task changes how often it is done from its edit pencil, and the Tasks view caches and loads with a skeleton',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['3e3fbae0'],
    basis: closed43('Item 413. A changed frequency is a NEW task, and the old one is archived with its ticks. No migration. The only two archives in production (13:47Z and 14:13Z, both Kane) came before this commit, so no use of it has been measured.'),
  },
  {
    name: "Accounting Scoreboard Tasks load behind NPD's loading card, fed line by line by a streamed read",
    status: 'Done',
    completed: '2026-10-08',
    shas: ['aa5d12b7'],
    basis: closed43("Item 414. GET /tasks?stream=1 streams a line as each read answers. No migration. Owed: one signed-in Tasks load through Vercel, since the stream has not been proven through Vercel's edge (the board's and NPD's streams are the precedent)."),
  },
  {
    name: 'The New Hire Checklist polls the hiring database and places each hire as Synced - interview dates read in US Eastern, a dropped connection retried',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['7dc7500d', 'f6a1c2b0', 'fefe84fc'],
    basis: closed43('Item 411. It polls public.hires every 30 s while the tab is open and broadcasts to the week room, with no cron. f6a1c2b0 reads the interview date in US Eastern, not Manila. fefe84fc retries a dropped connection instead of failing the pass. Its migration is MEASURED applied (--verify 2026-10-08, all checks passed). The HRIS_HIRES_* env in Vercel production is UNVERIFIED: there is no Vercel CLI here, and local dev writes the same database, so a synced row cannot say which build wrote it. Its one open step was the HRIS_HIRES_* env in Vercel production: Kane set it and redeployed at about 19:38Z ("redeployed"). No production sync is in audit_log yet, because a poll that changes nothing writes no audit row, so this closes on his word and his action, not on a measured sync.'),
  },
  {
    name: 'Payment Dispatch never shows a paid person as Pending when the paid-list read fails - a failed read is an error, never nobody is paid',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['c0766122'],
    basis: closed43("Item 415. On 2026-10-08 the production database was overloaded (load average 43), the queue read fell back to rows ?? [], and paid people were painted Pending. The duplicate guard was beaten once (cheskac@'s echo). Fixed in code; no migration. The unique index the item calls for is still OPEN and is not in this row."),
  },
  {
    name: 'A remote change costs Payment Dispatch one queue load per visible screen, not two',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['b51f8f15'],
    basis: closed43('Item 416. The load grows with payments times open screens (about clerks squared). 5 clerks broke it and this halves the cost per payment. 8 clerks needs a lighter reload or more compute, which is still OPEN and not in this row. No migration.'),
  },
  {
    name: 'Orphanage interns are paid up to 6 hours a week - hours over it are shown and never paid, and all 9 profiles moved to 6',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['74763e67'],
    basis: closed43("Item 417, Ralph's cap. scripts/set-intern-caps-6h.mts ran --apply in production 2026-10-08 at about 17:37Z: 9/9 changed, and the re-read was ok. Whether to return to 5 next time, and the share mode, are still OPEN for Ralph and Kane, and neither is in this row."),
  },
  {
    name: 'The collab rail names the tab a person is actually on, and a closed tab leaves - realtime-js presence patched',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['39d04215'],
    basis: closed43("Item 419. realtime-js 2.101.1's transformState deleted phx_ref in place, so a leave never matched and stale sections and ghosts stacked. The patch ships through patch-package on postinstall, so Vercel applies it with no hand step. pickLiveMeta replaces [0] in CollabLayer and CeoPayrollLive. Not verified live (no browser was driven). PresenceProvider and usePayrollLivePresence still read [0], OPEN and not in this row."),
  },
  {
    name: "Admin Diagnostics' Supabase Postgres card tells a Supabase outage from our own database overloaded",
    status: 'Done',
    completed: '2026-10-08',
    shas: ['c87a6703'],
    basis: closed43('Item 420. No migration and no env var. It still alerts nobody while the page is closed: an alert is a new cron or notification, which needs Kane\'s pick, and is not in this row.'),
  },
  // —── PASS 44 · 2026-10-09 · Kane closes the withheld SP ─────────────────────────────────────────
  // Pass 43's two changed rows, then this pass's two new rows (created), then the 28 pass 41-42
  // Pending Deploy rows already on the board (corrected). All Done, all Sprint 30.
  {
    name: 'The Accounting Scoreboard Chat post carries a card of progress bars that go red, orange and green as the goal nears, through one Chat sender',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['4884086a', 'b7cfe890'],
    basis: closed44(`Item 421. Both the scheduled post and the click send through chat-webhook.ts, which falls back to text alone once on a 400. The doubt this row named, that Google does not document cards on incoming webhooks, is MEASURED settled: audit_log reads tasks_progress_posted with card=true at 2026-10-08 19:12Z and 19:41Z, so Google answered 2xx with the card twice. Both were Kane's clicks from code not yet pushed, so they prove Google, not production. Both shas were pushed 2026-10-08 20:01Z. The first scheduled post from the pushed code is the 2026-10-09 15:00 ET slot.`),
  },
  {
    name: 'The hires sync writes only the week on the selector and holds a hire it cannot place for HR to add, the New Hire button moves to the top, and its interview date opens on that week',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['ed616a87', '81040a76', 'cd27f41a', 'e50cb9f4'],
    basis: closed44(`Items 411 and 423. Re-derived before it reached the board: ed616a87 was Kane's "A" rule (a hire with no usable week joins this week or the next open week), and e50cb9f4 replaced it with Kane's "(b) Only the week on screen". A hire with no interview date, a past week or a locked week is held under Not placed for HR's one-click Add and never auto-added, and a test sweep (every date x selected week x lock state) proves nothing is placed outside the selected week. 81040a76 pins that the sync never touches a manual add, cd27f41a moves the one New Hire button to the top of the toolbar, and the modal's Date of interview opens on the selected week's interview week. No migration. HRIS_HIRES_* was set in Vercel production 2026-10-08 ~19:38Z. No production sync is audited since e50cb9f4.`),
  },
  {
    name: 'The hires sync shows what it has pulled - a Synced data list, and an In database tag beside Synced and Manual',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['bf7d7eb9'],
    basis: closed44(`Item 411, Kane: "I want to know the data that has been synced already" (34 of 35 database hires had been matched to rows HR typed, so the grid showed them as Manual). The strip gains Synced data (N), read on demand and never on the 30 s poll. The Received column tags Synced, In database or Manual; the tag is information only and fails open to no tag. No migration.`),
  },
  {
    name: 'Everyone rearranges their own Accounting Scoreboard task list within a card, and an Admin can rearrange anyone',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['d358a4ca'],
    basis: closed44(`Item 422, Aliviah via Kane: "each user could rearrange their task list". It was Admin-only, a CHOSEN default from the round 4 plan. Drag or keyboard, within one frequency card. POST /api/accounting-scoreboard/tasks/order is the whole card or nothing: 409 stale, 422 mixed, 403 for anyone but the owner or an Admin. Adding, renaming, changing how often and removing stay Admin-only. No migration; an order is not audited by design.`),
  },
  {
    name: "Accounting can suspend a member's MESA contribution from an effective date without opting out, and every MESA Action column is the same buttons",
    status: 'Done',
    completed: '2026-10-06',
    shas: ['1f0a7350', '972edc8d'],
    basis: closed44(`Item 360. Its migration was MEASURED applied 2026-10-07, with suspensions already in production.`),
  },
  {
    name: 'MESA saving but not deducted no longer counts opted-out members - saving needs an open account',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['55999aa5'],
    basis: closed44(`Item 361. No migration.`),
  },
  {
    name: 'The whole People tab paints from the cache - roster and summary as one entry, the week list, Statistics and Bank changes',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['8186145a'],
    basis: closed44(`Item 362. No migration.`),
  },
  {
    name: "HRIS vs NPD Export CSV - every row whatever the search or chip, with the person's paystub as Notes on a Mismatch or Not in NPD row",
    status: 'Done',
    completed: '2026-10-06',
    shas: ['921ddfcd', 'ae229888'],
    basis: closed44(`Items 366 and 370. No migration.`),
  },
  {
    name: 'HRIS vs NPD leaves out anyone configured not to be paid this week - excluded or paused are not rows, and one line counts them',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['9129b1d0', '7dbd82a3', '089357f9'],
    basis: closed44(`Items 339 and 367. 089357f9 is the rule after Kane's answer, and the row describes it only. No migration.`),
  },
  {
    name: 'HRIS vs NPD says why under every Mismatch, Not in HRIS and Not in NPD row, and Export CSV gains a Why column',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['fcd609ec'],
    basis: closed44(`Item 371. Questions (a) and (b) on the NPD columns stay open with Kane, beside this row and not in it.`),
  },
  {
    name: 'My Team cold load paints the frame and skeletons only the data - rail entries, counts and roster rows',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['a2a9ad07'],
    basis: closed44(`Item 369. No migration.`),
  },
  {
    name: 'An opened paystub in Dispatch Preview Emails has a Refresh - a background re-read of every outside source, with a strip naming the lines that moved',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['fbe841ba'],
    basis: closed44(`Item 377. The loader gaps are item 378, open on their own and not in this row.`),
  },
  {
    name: 'Accounting Scoreboard round 3 scoring - Buckets 10xC/(C+O), Payment Verified, PM No Meeting Streak, Chargebacks Open Disputes and Outcomes',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['66f40a60'],
    basis: closed44(`Item 379. Its round 3 migration was MEASURED applied 2026-10-07.`),
  },
  {
    name: 'Accounting Scoreboard typed Payroll Problems log, and custom sections on top of Setup',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['66f40a60'],
    basis: closed44(`Item 379, the two new logs. Same migration, MEASURED applied 2026-10-07.`),
  },
  {
    name: 'The Accounting Scoreboard paints from the browser cache - no loader on reload, no wait on a cached week, silent refreshes',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['2c7739e8'],
    basis: closed44(`Item 380. No migration.`),
  },
  {
    name: 'The Accounting Scoreboard loading modal is accurate - the GET streams each group of reads, and the bar is green only once the board is painted',
    status: 'Done',
    completed: '2026-10-06',
    shas: ['05b48730'],
    basis: closed44(`Item 381. No migration.`),
  },
  {
    name: "HRIS vs NPD reads NPD's locked sheets itself once both All Departments and HSL are locked, and Save output proves the feed against them",
    status: 'Done',
    completed: '2026-10-02',
    shas: ['9d6225b6'],
    basis: closed44(`Item 337. A read-only npd-feed route. No migration.`),
  },
  {
    name: 'An Accounting Scoreboard custom section can sit inside a built-in tab, and the onboarding section becomes Sales - Payments',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['72f96e70'],
    basis: closed44(`Item 385. Its migration was MEASURED applied 2026-10-08.`),
  },
  {
    name: 'Every Accounting Scoreboard section can take a goal - Open Disputes is scored like Buckets, Outcomes on a win ratio, and a payroll problem line may be 0',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['0b8748f6', '34b937a2'],
    basis: closed44(`Item 387, with 34b937a2 (item 399) folded in by file overlap. Its migration was MEASURED applied 2026-10-08.`),
  },
  {
    name: "Carla's Team Score on the Accounting Scoreboard Overview, on the same pace as the lights",
    status: 'Done',
    completed: '2026-10-07',
    shas: ['fb080059'],
    basis: closed44(`Item 388, the Team Score only. The spec's nine card edits wait on Carla and are not in this row.`),
  },
  {
    name: 'An Accounting Scoreboard section can be hidden from the Overview and the Team Score',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['476b6b9f'],
    basis: closed44(`Item 391 (2). Its migration was MEASURED applied 2026-10-08.`),
  },
  {
    name: "The Accounting Scoreboard No Meeting Streak shows as this week's date pills",
    status: 'Done',
    completed: '2026-10-07',
    shas: ['f770d29b'],
    basis: closed44(`Item 391 (3). No migration.`),
  },
  {
    name: 'Accounting Scoreboard Losses and Pre-arb show negative with a Net, set by a flag and never a typed sign, and Pre-arb counts as a loss in the win ratio',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['63500994', 'c88c554c'],
    basis: closed44(`Item 392, Kane's ruling that Pre-arb is a loss. The Pre-arb flag migration was MEASURED applied 2026-10-08.`),
  },
  {
    name: 'Payout change safety on both self-service bank saves - a notice to acknowledge, and card and holder checks that ask to confirm and never block',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['eb9a0005'],
    basis: closed44(`Item 401. The safety column was MEASURED applied 2026-10-08, and the docs record it pushed and deployed that day. bank_update_history holds 0 attestation rows (re-read 2026-10-09), so nobody has saved through it yet: this closes on Kane's word, not on use.`),
  },
  {
    name: 'Self-service bank saves fail closed on an unreadable payroll lock, and the code check answers the same for every email',
    status: 'Done',
    completed: '2026-10-08',
    shas: ['27e69bca'],
    basis: closed44(`Item 402, two of the four gaps item 266 found. Gap #4 stays open on item 266, not in this row.`),
  },
  {
    name: 'Time adjustment requests filed under an alternate work email resolve to their owner',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['c073e076'],
    basis: closed44(`Item 390. The pay overlay for such requests is NOT bridged, an open money item beside this row and not in it.`),
  },
  {
    name: "A returned offboarding queue row notifies the requester and the department's managers",
    status: 'Done',
    completed: '2026-10-07',
    shas: ['3e5f960e'],
    basis: closed44(`Item 397. Never the returner or the subject.`),
  },
  {
    name: 'The interns lock-in popup says it locks one week, split per intern',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['134ce6b9'],
    basis: closed44(`Item 396, the label and the capped-hours measurement. The share mode and the 'next time' cap stay open with Ralph and Kane, beside this row.`),
  },
  {
    name: "COP rates are stored as COP - the Colombians' hourly rates convert at each cycle's FX and still pay on their processor rails",
    status: 'Done',
    completed: '2026-10-07',
    shas: ['14ea111a'],
    basis: closed44(`Item 373, Kane's reading (a). Its data step was MEASURED applied 2026-10-08. Item 407's finding (the --apply ran about 3.5 minutes after the commit, likely before the deploy), item 428 (one payee's peso equivalent and an NPD vs HRIS gap of about $2, from the 10-08 call) and the 09-27 NPD confirmation stay open as money notes beside this row, not in it.`),
  },
  {
    name: 'The Oct 7 Carla and Alivia call becomes a 13-task round 4 plan in four waves, with one paste-ready session prompt per task',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['cf2b5ff5', '9118312f', '7ae4536c', '9e4eee8e'],
    basis: closed44(`Docs only: the meeting doc, the round 4 implementation plan, a session prompt per task, and Kane's rulings on the Oct 7 asks.`),
  },
  {
    name: 'The meeting-notes skill is ported from Gridline - a call writes its notes, its INDEX links and an Open items row for every ask',
    status: 'Done',
    completed: '2026-10-07',
    shas: ['cf2b5ff5'],
    basis: closed44(`The skill and CLAUDE.md half of cf2b5ff5. The meeting doc in the same commit is the round 4 plan row.`),
  },
  {
    name: 'Security review - API keys on phones, certificate pinning and deep links, answered from the code and a production probe',
    status: 'Done',
    completed: '2026-10-02',
    shas: ['e88315ac'],
    basis: closed44(`Item 336. Docs only. Its findings live in the repo report, and item 405 (the report on a public repo) is open on its own.`),
  },
];

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

  // The whole plan, not only this pass's rows: the reconciler creates every missing plan row.
  bad.push(...planSpProblems(PLAN_TASKS));

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
    for (const p of taskSpProblems(row.name, plan.sp)) bad.push(`${p}: ${row.name.slice(0, 55)}`);

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
