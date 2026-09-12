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

export const PASS_DATE = '2026-09-12';
export const AUDIT_RANGE = '67858c44..e7f41215 (Sep 3 afternoon – Sep 11 night)';
export const AUDIT_COMMITS = 95;
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
  // ── PASS 26 · 2026-09-12 · Kane confirms the held rows, and last night's work joins them ─────────
  // Kane, verbatim: "For table 2 these are done lets commit them and update the board we have done
  // this already as for table 1 we are done with all of these QC Copy paste compare undo override
  // lead gen. #1 if angelicac@ transfer backfill script run it if it hasnt been ran because I think
  // its already done. Also Diagnostics is already done COP is done most of these are ddone even HSL
  // stuff lets move this to done!"
  //
  // WHAT THIS PASS IS. Pass 25 applied its structure and died on the budget after 6 of 36
  // corrections, leaving 31 owed in pending-sp.json. Rather than flush those at Pending Deploy and
  // then immediately re-write them, this pass supersedes the ledger: Kane has now confirmed the work
  // in production, so the 28 held rows go straight to **Done** and the flush would have written a
  // status that is no longer true.
  //
  // THE CONFIRMATION IS THE EVIDENCE, AND IT WAS ASKED FOR. The skill's gate says a row goes Done on
  // Kane's own confirmation — but that it "must be asked for and recorded, never assumed". It was
  // asked for twice (the pass 25 brief's Q2, then a per-row table), and his answer above is recorded
  // verbatim here and on every row's board update. That is the whole basis for these 28 closures;
  // nothing about the code changed between Pending Deploy and Done.
  //
  // WHAT HIS CONFIRMATION CANNOT REACH, held back deliberately. An assertion cannot import an n8n
  // workflow, so **the pay-cycle celebration row stays Pending Deploy** — its blocker is open, Kane
  // hit a conflicting-webhook-path dialog mid-import on 2026-09-11 and it is unresolved. Two other
  // blockers WERE cleared, by doing the work rather than by asserting it: the Bonus Library migration
  // and the angelicac@ backfill both ran on 2026-09-11 with Kane's approval and were verified
  // read-only against PostgREST with a negative control. Their rows therefore close honestly, and
  // their cleared-blocker text moved into the basis rather than being dropped.
  //
  // #1 ANSWERED. Kane asked that the angelicac@ backfill be run "if it hasnt been ran". It had —
  // 2026-09-11, and re-verified before this pass: her master row reads hsl:collections, transfer
  // fb10af2c is applied with sheet_synced true, the Sheet cell at row 530 matches, and audit_log
  // carries one transfer.backfilled event naming its backup. Nothing was re-run.
  //
  // DATES ARE GIT'S, NOT TODAY'S. Every Completed Date is the commit date of that row's LAST sha,
  // re-derived this session and enforced by selfcheck; all 28 fall inside Sprint 28's window
  // (Sep 1-12), checked before anything was written. The work finished when it finished — today is
  // only when the board caught up.
  //
  // THE LEDGER. pending-sp.json's 31 entries are superseded by this pass, not flushed: flushing them
  // afterwards would write Pending Deploy OVER Done and silently downgrade 28 rows. They are marked
  // superseded once this pass applies. If this apply dies mid-way, apply.mts re-queues the remainder
  // under THIS pass's hash at the Done status, superseding by name — so the ledger stays a valid
  // recovery path either way.
  // ── PASS 25 · 2026-09-11 · re-minted from PASS 24, which was staged and never applied ────────────
  // Kane: "All Sprint Tasks that hasnt been closed yet code wise lets close this please check our
  // Commits."
  //
  // WHY A NEW PASS AND NOT THE OLD HASH. Pass 24 (`7b4160be5982`, commit 56bb8488) was staged on
  // 2026-09-10 and never applied — Sep 10 log, Open item 15. `apply.mts` refuses a proposal minted
  // for a different pass date, so the hash had to be re-minted regardless. Everything below was
  // therefore RE-DERIVED from git today rather than carried forward: all 62 shas in this file were
  // re-checked with `git merge-base --is-ancestor <sha> origin/main` on 2026-09-11 and every one
  // passes. HEAD == origin/main == bd7f8402. The staged prose was not trusted — the skill's own rule
  // after a staged row shipped underneath its "NOT STARTED" wording.
  //
  // WHAT "CLOSE EVERYTHING DONE CODE-WISE" CAN AND CANNOT MEAN. Code-wise-done is exactly the
  // definition of **Pending Deploy**: on origin/main, nobody has said they opened it in prod. It is
  // NOT Done. Done is a bonus-bearing claim and needs Kane naming the surface he clicked. So this
  // pass takes every row as far as git can prove and no further, and the Done question is put to him
  // with the review as a list, not assumed from the instruction. Three rows close Done because their
  // evidence is a measurement or a use, not an assumption — see below.
  //
  // THE BOARD'S OPEN SET, read today (pull-state, ~15 calls): 254 of our rows on Sprint Tasks, 27 of
  // them not Done — 17 Pending Deploy (already at the honest ceiling), 4 In Progress, 6 Ready to
  // Start — plus 28 rows the plan declares that the board has never had (pass 24's, uncreated).
  //
  // THE THIRD DONE ROW IS NEW, AND IT CORRECTS A FALSE PENDING. Chasing "what is actually finished"
  // through the six Ready to Start rows turned up one whose claim was folklore. Read-only probe
  // 2026-09-11: the Lawang rate-shadow fix script DID run — pay_mse34sctiw8xsiio reads 225 / 337.5 /
  // hogan_smith_law stamped `updated_by: fix-lawang-rate-shadow.mts` at 2026-08-18T20:09:14Z, the
  // matching 225 rate-history row effective 2026-08-16 carries the same stamp at the same second, and
  // the sheet mirror reads 225. All three steps landed. Both the plan comment and
  // [[lawang-rate-shadow-duplicate-identity]] said "--apply BLOCKED, NOT YET RUN". Same grade of
  // evidence as the Hubstaff rename chore, and dated the same way: `dateBasis: 'commit'` on
  // 4447e404 (2026-08-18), the day the script both landed and ran. It stays in **Backlog** — the row
  // is unscheduled and selfcheck exempts Backlog from the window check, so closing it needs no sprint
  // move and the pass stays on the cheap path. Re-filing it to S27 is a grooming call for Kane.
  //
  // THE OTHER FIVE READY-TO-START ROWS WERE ALSO MEASURED, AND FOUR STAY OPEN — the skill's rule that
  // a PENDING claim is evidence in BOTH directions:
  //   • "Five employees … retired bare hsl" — MEASURED OPEN. Exactly 5 employee-scope rows still
  //     carry department_key 'hsl' (glendac@, domv@, beao@, joee@, jesr@), untouched since the
  //     "rate-divergence fix 2026-07-29" that seeded them. Unchanged.
  //   • "Deletion cron never re-checks the live roster" — OPEN in the code:
  //     app/api/cron/process-scheduled-deletions/route.ts contains no roster re-check. f0eadd18 is
  //     the AUDIT that found it, not a fix.
  //   • "Legacy rates-sheet cell can route null-preferred → hurupay" — a Spike owing a decision; no
  //     guard exists in sync-rates-from-sheet. Unchanged.
  //   • "Audit writes fail silently" — ADVANCES to Pending Deploy on ddf4c790, which is what the row
  //     asks for. Below with the other four advances.
  //   • "Google Sheet sync crons (master / rates / HSL / offboarded)" — **UNVERIFIED, and left
  //     alone.** The four routes exist and have since 2026-05-07/09, but `vercel.json` schedules only
  //     process-scheduled-deletions and apply-scheduled-transfers — nothing in the repo schedules the
  //     four sheet syncs, and whether n8n triggers them externally cannot be settled from here. The
  //     skill forbids a silent downgrade either way, so it is a question for Kane, not a write.
  //
  // NEW SINCE PASS 24's RANGE CLOSED: two features in 47232941 + 4c15670d (COE facts) and bd7f8402
  // (wizard Reports Time Adj. columns). e257eb41 is the session log — docs, no row, consistent with
  // every prior pass.
  //
  // COST AND PATH. Still `--only-new`: no new epic, no re-scored row, no sprint move. 3 label gates +
  // 36 × (lookup + create-or-set + update) ≈ 110 calls. A full reconcile would now re-patch 284 tasks
  // + 37 epics first (~425 calls) and needs its own UTC day. The trade is unchanged and stated: the
  // 30 created rows carry NO epic relation until a later full reconcile adopts them by name.

  // ── PASS 24 · 2026-09-10 · the range 67858c44..a56ce28c (69 commits, Sep 3 afternoon – Sep 10) ────
  // Kane: "Monday skill all withheld SP lets move it to monday board."
  //
  // WHAT "WITHHELD" TURNED OUT TO BE, measured before anything was staged. pending-sp.json reads 11
  // entries / 0 unflushed — the ledger owes nothing. Pass 23 (710ee0892af3) was NOT the withheld half
  // either: the Sep 3 log recorded its apply as mid-flight and unverified, and a board re-read on
  // 2026-09-10 (verify.mts, ~17 calls) returned VERIFY PASS — all 14 rows holding their intended
  // statuses, 254/254 plan rows present, 0 orphans, rollup 1569/874, relation 254/254. So the withheld
  // SP is the third waiting room the skill names: 69 commits on origin/main with no row at all, plus
  // five existing rows whose evidence has moved.
  //
  // HEAD == origin/main (a56ce28c) at staging, so every sha in this file is an ancestor and the four
  // rows pass 23 capped In Progress ("LOCAL ONLY at staging") advance to Pending Deploy — one step,
  // re-derived from git, never carried forward from the staged prose. A fifth existing row advances
  // Ready to Start → Pending Deploy because ddf4c790 did exactly what it names.
  //
  // TWO ROWS ARE DONE, on two different grades of evidence, said plainly:
  //   • the Hubstaff rename chore closes on a MEASUREMENT — audit_log holds one `csv.rename` event by
  //     script:rename-hubstaff-source-file at 2026-09-09T20:49:04Z, a negative control on a
  //     non-existent action returns 0 rows, and the two 2.3 MB restore-set JSONs are on disk.
  //   • the security readiness Spike closes on USE, the way pass 17 closed dev tooling: its
  //     deliverable is a document with no prod surface, and two later commits act on it.
  // EVERYTHING ELSE STAYS SHORT OF DONE. "Move it to the board" is an instruction about the WRITE,
  // not a confirmation about any surface (the 2026-09-02 rule). Which of the held rows Kane has
  // clicked through in prod is the question put to him with the review — the answer, when it comes,
  // is recorded on each row as its basis, never assumed.
  //
  // THREE BLOCKERS WERE MEASURED, NOT ASSUMED. The bonus_catalog history migration is NOT applied
  // (2026-09-10, all four objects absent, read-only). The celebration workflow import is PENDING per
  // both governing docs (cycle-closeout.md, webhook-automations.md) and the live `payment_cycle_complete`
  // slug is present and active — the email sends, without files. The angelicac@ backfill --apply has
  // never run (Open item 9). And the tickets row's remaining blocker was re-measured: `ticket_replied`
  // and `ticket_moved` are still ABSENT from webhooks.config (22 entries) — that row is unchanged and
  // is deliberately not in this file.
  //
  // THE MESSAGE TRAP, twice. 482d5af6 "Push" is the entire Admin Penny console and appears in no
  // session-log table; the transcript 989d5a3f names it. f36a97ce "Push" (PASS 23's range) carried the
  // Manager Overview rebuild UNDER the KPI-header work pass 23 filed it as — the doc and memory both
  // say "git log will not lead you here", and they were right. Both get rows.
  //
  // WHAT IS NOT IN THIS PASS, AND WHY: 13 docs-only commits (three session logs, the meeting record,
  // the implementation plan, CLAUDE.md process rules, reference re-verification) — process, not
  // shipped features, consistent with every prior pass. 6068f1f7 "PAB Fix!" is a tsbuildinfo-only
  // noise commit. The two BLOCKING security items (impersonation redesign, four ungated routes) have no
  // row because nothing has shipped for them — they are offered to Kane as Ready to Start rows, not
  // slipped in.
  //
  // PATH AND COST. --only-new: no new epic, no re-scored row, no sprint move — the sanctioned lean
  // case. 3 label gates + 33 × (lookup + create-or-set + update) ≈ 100 calls, against a full
  // reconcile that would now re-patch 282 tasks + 37 epics before creating anything (~420 calls —
  // pass 5 died at ~285). The trade is stated: the 28 new rows land with NO epic relation until a full
  // reconcile adopts them by name on a later UTC day. Verify with verify-one.mts per row.

  // ── new rows (28) ─────────────────────────────────────────────────────────────────────────────────
  {
    name: 'Orientation date skips enabled US holidays, iteratively — Labor Day Sep 7 moves the invite to Tue Sep 8',
    status: 'Pending Deploy',
    shas: ['609b84ad', '19ea1862'],
    basis:
      'Session 30aeefd5, closing the Sep 3 log\'s deadline item (Lock-in fires the invite Fri ~20:15 UTC). A 200-line orientation-date lib with 139 lines of tests skips enabled US holidays iteratively — Sep 7 Labor Day → Tue Sep 8 — read by the lock webhook (+103 lines of tests) and the lock dialog\'s third bullet, which renders BEFORE the passphrase so Cancel is a free look. Monday stays the default. 19ea1862 is the doc answering "where does HR see this": exactly one surface, HR → New Hire Checklist → the week → Lock in, lock mode only. Both on origin/main. Not Done: the Sep 4 lock fired, but nobody has said the Sep 8 date reached the invite in prod.',
  },
  {
    name: 'Payment Catalog Current Banks tab — 129 spellings folded to 45 official names, real logos measured before they land, and a People tab per bank that marks leavers instead of hiding them',
    status: 'Pending Deploy',
    shas: ['459671ea', 'b471a7e8', '7db4ad3f', '3c478f1c'],
    basis:
      'Session 5a2f134a ("add a new tab within where we can see all the Current Banks that the Users added … that way we can add logos to them", then "Lets add a list of people in that bank as well"). banks.ts (581 lines) + 565 lines of tests, a route, a db module, PayProcessorsTab grown ~770 lines across the Banks and People tabs; 129 receiving-bank spellings folded to 45 official names via a DECLARED table; 23 real logos fetched into public/banks by a script that measures each PNG before it lands; wallet cards reuse the emerald the app already means wallet by. People (N) per bank lists name, work email, department, a chip when the bank is on the person\'s OTHER account, loaded only when opened. Leavers appear with a Left chip and count on the card — Kane\'s approved exception to payment-catalog-hides-offboarded, written into the doc it contradicts. All on origin/main; the Banks tab has not been reported opened in prod.',
  },
  {
    name: 'Employee ID badge as a Profile section — navy flat card that never themes, PNG download, milled-metal sheen, and two painter bugs the tests never saw',
    status: 'Pending Deploy',
    shas: ['f731fe69', '027fce30', 'c30dbdbc', 'b99867fe', '1aaeb5ef'],
    basis:
      'Session b6fcc0e5, artifact-first then impeccable then ship. id-card.ts + id-card-render.ts (~580 lines) with ~450 lines of tests; shipped as a Profile SECTION not a tab, navy-dominant with orange never as text, flat, and verified to render unchanged in dark mode. 027fce30 downloads it as a PNG; b99867fe makes it milled metal with a slow sheen. Two of the five commits fix defects 98 passing tests did not catch, found only by driving the real painter headlessly: c30dbdbc (the serial spaced its glyphs by the font WEIGHT) and 1aaeb5ef (a quoted nickname\'s opening quote became the second initial — punctuation-leading name parts are not initials). formatStartDate is still off by one on every badge — OPEN and NOT claimed by this row. All on origin/main, not confirmed live.',
  },
  {
    name: 'Pay-cycle celebration fires ONE way — from the close-out route itself — with CSV, XLSX and PDF attached; the client-side cycle-complete route is deleted',
    status: 'Pending Deploy',
    shas: ['88474107'],
    blockers: [
      'references/n8n/payment-cycle-complete-celebration.workflow.json changed (+125/−35) and is NOT imported — cycle-closeout.md § Deploy notes and webhook-automations.md both say PENDING Kane (2026-09-04). The live payment_cycle_complete slug is present and active (probed 2026-09-10), so the email sends exactly as before, without the files.',
    ],
    basis:
      'Session f5b15fd7. Kane: "All I want is that this automation only triggers one way and its when stop processing and close payroll cycle is triggered from the UI — there was one instance where It was triggered accidentally … close that gap." The celebration half of 88474107 (26 files / 3,424 lines carrying two features): the accidental trigger is closed at the source — app/api/payment-dispatches/cycle-complete/route.ts (232 lines) is DELETED and only the close-out route fires the webhook, server-side; cycle-close-attachments + report export + PDF (~700 lines with tests) attach CSV/XLSX/PDF, base64, 8 MB cap; notify and trigger reworked (+242, +80). On origin/main. Not Done: the attachments half is dead until the workflow import, and no close-out has been run through it.',
  },
  {
    name: 'Admin → Webhooks automation editor — recipients by role or fixed list, extra payload keys, and a Test that mails only the tester',
    status: 'Pending Deploy',
    shas: ['88474107', '2e24032c'],
    basis:
      'The editor half of the same commit, same session — built for the case Kane named: "if Carla resigns we can change the recipient." WebhookAutomationDialog (516 lines), a 266-line automation route, webhook-config (346) with 210 lines of tests and fixtures; recipients by role with per-person add/remove or a fixed list, extra payload keys, and a Test that sends to the tester\'s email only with a never-real week. 2e24032c is a one-line border fix. On origin/main; nobody has reported editing an automation in prod.',
  },
  {
    name: 'angelicac@ transfer backfill script — the transfer HRIS never filed, replayed through the three Release helpers in order, dry-run by default',
    status: 'Done',
    completed: '2026-09-04',
    dateBasis: 'commit',
    shas: ['658a99ac'],
    basis:
      'Session aae1e82e. Kane: "can we hardcode or SQL Migrate as if she was ever put in HRIS?" — answered as a backfilled transfer, not a raw UPDATE: a 339-line script inserts the transfer request HRIS should have had (Lead Gen → HSL — Collections, effective 2026-06-22, overridable) and runs the SAME three production helpers the Release button runs, in the same order — master list, then the Google Sheet cell, then mark applied — so a Sheet miss surfaces as a Retry badge instead of drifting. One audit row and a JSON backup before any write; notifications off unless --notify. On origin/main. A script has no prod surface, so Done means RUN, and it has not been. CLEARED 2026-09-11 - Kane approved the write and the script RAN with --apply. All five guards passed against live data first and a JSON backup was written before any write. Verified independently through PostgREST: her global_master_list row reads hsl:collections (the value 30 peers already carry), department_transfer_requests fb10af2c is status applied with sheet_synced true and effective_date 2026-06-22, the Sheet cell at row 530 reads the target, and audit_log carries one transfer.backfilled event naming the backup path (negative control on a bogus action returns 0). Notifications deliberately NOT sent (--notify is off by default). Her Payment Catalog row stays keyed to hogan_smith_law - out of scope by design. This row is no longer blocked and can go Done on a prod confirmation. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Admin Penny becomes an operator console — NUL-delimited activity frames report the real tool, Opus 5 engine with refusal fallback, /clear',
    status: 'Done',
    completed: '2026-09-04',
    dateBasis: 'commit',
    shas: ['482d5af6'],
    basis:
      'The message-trap specimen of this pass: 482d5af6 is titled "Push", appears in no session-log table, and is the whole feature — AdminPennyConsole (1,018 lines) replacing BizAiTab on Admin, console-stream / console-phases / console-commands libs (228 lines) with 29 tests, the penny-chat route (+70), CeoChatBubble / ceo-chat-message / use-ceo-chat taking a tone prop and an activity state, a 280-line doc. The reason it has a backend half: Penny\'s routes streamed text/plain deltas only, so a progress readout could only guess — the route now interleaves NUL-delimited JSON activity frames naming the tool actually running, and NUL is the delimiter because the model cannot emit one, so no reply can forge a frame. Engine claude-opus-5 with a refusal fallback; /clear. Transcript 989d5a3f. On origin/main; the CEO Penny, CEO bubble and employee bubble are explicitly unchanged. Not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Diagnostics → Payroll Cycle Performance and HR Pipeline tabs — one honest rate each from close-outs, every cycle listed, and a progress bar that cannot finish early',
    status: 'Done',
    completed: '2026-09-04',
    dateBasis: 'commit',
    shas: ['2ff4c6be', '2a26c4f6', '9c349baa', '5bf484a2'],
    basis:
      'Session b1b67eba, routed to blueprint with the plan approved before code. Two routes, PayrollCyclePerformance (450→616) and HrPipelinePerformance (476), performance-ui (390→700), cycle-performance + hr-pipeline-performance libs (~1,000 lines) with ~880 lines of tests, a cycle inventory. The rule: the payroll rate comes ONLY from close-outs, the one source that carries a denominator; 9c349baa lists EVERY cycle per Kane ("can we add the unclosed? … lets just label unclosed"), shown with their data and WITHOUT a denominator they do not have; 2a26c4f6 takes orange and teal because amber and green already mean something; 5bf484a2 replaces the first-load skeletons with a modal progress bar reusing step-load-prediction.ts — it never reaches 100% before the data lands and a failed read never completes it. All on origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'A failed Payment Catalog read no longer renders an empty catalog in silence',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['d12e8323'],
    basis:
      'Session c1da4d35 — the code fix that fell out of the mixed .next/ incident (a prod build and a dev build sharing one directory made every app/api route 404 while pages rendered fine). A failed catalog read used to say nothing and render an empty catalog, which made an environment fault look like a data fault; BonusCatalog now surfaces the error (+116/−31). On origin/main; a failure state is hard to click through and has not been reported seen. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'COP people see COP — a per-person settlement currency, display-only, on the Payroll Wizard, both KPI calculators, Mark Paid and the Processor Queue',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['68bcc8fb', 'f1c72380', '771eb1e1'],
    basis:
      'Session 5357b812. Kane: "We should have a sticker or any indicator for People who are in COP or Colombian and their Bonus should be in COP NOT in PHP … this should reach Payment Dispatch and Payroll Wizard as well." A settlement-currency route (262) + lib (185) + SettlementChip (107), wired into PayrollWizard, DeptBonusCalculator, MarkPaidDialog and ProcessorQueue, ~320 lines of tests, a verify script. The line that matters, from the settlement-currency-per-person rule: CATALOG currency is the denomination converted to the peso actually paid; SETTLEMENT currency is a property of the PERSON, sourced from onboarding country, and never changes what is disbursed — FORCED_DEPT_CURRENCY was the wrong lever and was not used. f1c72380: COP is the headline and the peso the footnote on Lead Gen totals; the total line carries USD, COP and PHP. 771eb1e1 moved the native renderer inside the calculator. All on origin/main; Kane asked "Where is the COP value now?" mid-session and the answer was the bug in the next row, so the final shape has not been confirmed seen. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Settlement-currency fetch was cancelled by every dependency change and never retried — only an unmount may drop a response',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['5c5adf54'],
    basis:
      'Own row because it is a bug CLASS. The ≈ $446.43 USD lines WERE rendering, proving the FX rate arrived and the code was live — so the request succeeded and its answer was discarded: the fetch effect used a per-effect cancelled flag while settlementEmails derives from state that changes on every department load and keystroke, React ran cleanup on each change and killed the in-flight request, and the emails were already marked "asked" so no retry ever came. Rule: marking work already-requested is only sound if the answer can never be discarded. Now only an unmount drops a response, a dependency change must not (the merge is idempotent, keyed by email), and a failure un-asks. The identical bug was in the Payroll Wizard\'s copy and was fixed there too (42 lines of new tests). On origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'HSL Managers Weekly realigned to the dated 2026-08-30 sheet — banded weekly tiers, three new managers, Pre/Post-Hearing ₱2,500 monthly final-week box outside the cap, Case Managers SSA.Gov ×₱250',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['3d49ebcd', '224762e6', 'c61e1b8a'],
    basis:
      'Session a7f934fc — Carla: "there have been changes to the bonuses for the HSL managers. The KPI calculator isn\'t aligned with the new bonuses so the amounts are incorrect." Three of the six fixes off that report, all in schema.ts (+300) with ~290 lines of tests and HslBonusCalculator: Managers Weekly reads the DATED 2026-08-30 sheet (a new sheet is a new version, an old one is never edited), banded weekly tiers, Sherwin / AR / Jazmine added; Pre/Post-Hearing gets a ₱2,500 monthly bonus as a final-week checkbox OUTSIDE the weekly cap; Case Managers pays SSA.Gov × ₱250 — the term that had only ever reached Attestation. On origin/main; Carla has not confirmed the realigned amounts against her sheet in prod. OPEN and not settled by this row: Carla pinned ₱2,500 on 09-08 and said 3,500 on 09-09 — never pick one, never rewrite the pinned amount or its test without a worked example (pre-post-hearing-2500-vs-3500). Left with Carla, not code: PURPLE re-saves for jennylynf@ and rockym@, and emss@\'s monthly box. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'SSD Medical Records and Collections monthly flat bonuses auto-dispatch again — Ready is the trigger, and the monthly share sums with the weekly bonus',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['6121626c', 'f5b75b19'],
    basis:
      'Same session, the systemic one Carla described across ~49 people: the weekly ₱475 landed and the ₱1,625 monthly KPI share did not. The wizard\'s monthly auto-dispatch fires in the week the period is marked Ready — Ready is the trigger, not the calendar — and the monthly share now SUMS with the weekly bonus instead of replacing it; f5b75b19 does the same for Collections, the second monthly department that never came through. Verified against live data after the fix: the Aug 30 – Sep 5 SSD period is Ready, five teams scored, 49 people, ₱95,500. Because these are now automatic they must not ALSO be typed into the Adjustment column. On origin/main. Not Done: the ₱95,500 is a calculator figure; whether it dispatched in that week\'s run is the click-through nobody has reported. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'HSL KPI bonus is paid for every scored person, not only hogan_smith_law home-department master rows',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['78e69361'],
    basis:
      'Same session, the sixth fix: the wizard paid HSL KPI only to people whose master row said hogan_smith_law, so duplicate master rows and external members were scored and then dropped from the payout — the same coin-flip that paid people "one week and dropped them the next". hsl-kpi-payout.ts (33 lines, 35 of tests) pays every scored person. On origin/main, not confirmed against a paid run. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Bonus Library carries a version and an effective date per bonus, with version and assignment history in the modal — display and audit only, the calculator pays the live definition',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['8c2710ee'],
    basis:
      'Session 0ea9e845, routed to blueprint. Kane: "Bonus Library - Should have a history when we view the bonus so we can see changes on its effectivity date … add version as well please." 1,373 lines: a history route, bonus-catalog-db +311, BonusCatalog +329, a history lib with tests, a 105-line migration and its apply script. Every bonus carries a version and the date it took effect (a v3 · from 2026-09-14 chip); the modal shows Version history and Assignment history; Effective from pickers on create/edit and per department panel. THE LOAD-BEARING DECISION, Kane\'s: DISPLAY AND AUDIT ONLY — the KPI Calculator keeps paying the LIVE definition, not the version in effect for the week scored, and bonus-catalog.md records that pay-by-version was offered and declined. On origin/main; not Done because the history tables it displays do not exist yet. CLEARED 2026-09-11 - Kane approved the write and the migration was APPLIED. scripts/apply-bonus-history-migration.mjs ran against the session pooler; verified independently through PostgREST with a clean negative control: bonus_catalog_bonus_history exists with 49 rows (one baseline version per bonus), bonus_catalog_assignment_history with 26 (one added event per assignment), and bonus_catalog_bonuses.version / .effective_from both exist. 0 bonuses and 0 assignments without history. The surface is fully live rather than half-dead. This row is no longer blocked and can go Done on a prod confirmation. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'PAB step: HSL wins when a person has two master rows and the step says whose department was guessed; the Additions review re-gates PAB off payout weeks',
    status: 'Done',
    completed: '2026-09-08',
    dateBasis: 'commit',
    shas: ['cbfd640a', '0140c07a', '7b760955', '6f15e889', '364fdfca'],
    basis:
      'Session 88e29eb1 — a build-and-revert afternoon, and one row describes the CURRENT rule, not both. 7b760955 implemented Kane\'s words ("The payout week will always be after the PAB Period … it will never be combined") across seven surfaces; 364fdfca reverted it the same evening because production had already paid August\'s PAB on the 08-23 file, 691 people, paid · sent — "the week after the period" meant the calendar week payroll runs in, and the file open in that week IS 08-23. The payout-week rule is therefore UNCHANGED (pab-payout-week-gate-and-pill RECONFIRMED 2026-09-08; the artifact must be named, never "this week"). What SURVIVES the arc, 521 net lines: master-row-tiebreak.ts — measured 267 active people with more than one master row, 138 straddling hsl:* and non-HSL, resolved FIRST-ROW-WINS with no ORDER BY so the winner could change between loads and PAB graded them by the wrong family; HSL now wins (Kane 2026-09-08) and the step flags whose department was guessed — plus audit-duplicate-master-departments.mts, and additions-pab-gate.ts, which re-gates PAB in the Additions review totals so the screen shows what the run pays (bonusTotals stays month-wide by design). Resolves the ambiguity, does not repair the data: the duplicate rows still need deduping. All on origin/main; not confirmed against a run. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Pre-release security readiness sweep — the shared-password impersonation backdoor, six ungated API routes, the unpaid-paystub flag and zero security headers, written up from a transcript',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['362624c3'],
    basis:
      'A Spike, closed on USE the way pass 17 closed dev tooling — its deliverable is a document with no prod surface to click through. Session 1a6b84b8 was asked "what are essential for an HRIS to be done before we release" and stopped four minutes in on a public shared-password impersonation backdoor (the literal default, committed to .env.example, absent from .env.local, rendered on /login in PUBLIC_PATHS), five ungated API routes out of 290 swept (a sixth, presence/last-seen, found by 993aad7f), the SHOW_UNPAID_STAGED_PAYSTUBS flag and zero security headers — and wrote nothing down. 362624c3 gave every finding a home: docs/features/pre-release-security-readiness.md (142 lines), re-verified in the tree before writing, with the praise that bounds it (evaluateRouteAccess centralized and tested, /api/employee/* scoped to the session email, 270 of 290 routes gated). USED: ddf4c790 closed two of the six routes citing it, and the Sep 10 log\'s BLOCKING items 1–2 are its rows. The remediation is NOT this row and has no row yet. Completed Date is the commit date; inside Sprint 28.',
  },
  {
    name: 'Payroll Wizard Reports step gets a search bar — display only, exports and the cycle Total never narrow',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['0573d834'],
    basis:
      'Session 11011fc4, seven minutes, routed to hardening — safe because the brief cited "a filter never hides a row" and "exports reconcile from their own columns". The needle narrows the step-9 table and NOTHING else: both exports still build from the whole snap.employees (the toolbar says so while a search is active), the cycle Total never narrows and a labelled Search subtotal row appears instead, a payee with no department matches "no department", the needle clears on every period switch. 118 lines in PayrollWizard + the doc. On origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Accounting tab cache gets an identity envelope and a sign-out purge so pay data cannot survive into the next account; HR cache gains a 30 s freshness window',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['4e8590cb', 'f5ad83ab'],
    basis:
      'Session e45b1682 — Kane: "Check all Dashboards from Admin to Employee see what dashboard has no proper Caching Practices … lets fix this in order and by your best recommendation." The audit split the ask into two opposite problems and this fixes the worse one: a cache that DECIDES. The Accounting/CEO/Payroll-Clerk store had no identity stamp, no schema version, no age ceiling and no purge function at all, so people:list / dispatch:queue / overview:payouts survived signOut into the next account. 21 files: accounting/tab-cache +359 with 427 lines of tests (identity + schema v + 12 h ceiling, reads fail closed, self-binds because its shells render before identity resolves, only bindAccountingCacheIdentity purges), all three sidebars remove SESSION_EMAIL_KEY first then clearAllAccountingCache(); HR gains isHrTabCacheFresh (30 s) beside hasHrTabCache — paint and may-skip are different questions — with every revalidate silent. f5ad83ab writes down that the two remaining skip-flag exceptions are ratified boundaries, pinned by tests. On origin/main; the sign-out purge has not been exercised across two accounts in prod on record. The Admin store is a separate blueprint brief, awaiting Kane (Open item 20). DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'One audit-action registry behind the panel, Penny and every write path — source-scan test fails the build on an unregistered action, actor from the session never the body, dated purge with a 90-day floor',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['ddf4c790'],
    basis:
      'Session 33c5ffd7 — Kane: "Audit Log Mechanism - let us improve this across - Accounting, CEO, HR and Orphanage." The hardening brief found there was NO governing doc for the mechanism and three private ideas of what an action name means; the panel\'s 14 hand-written predicates claimed no orphanage.*, wizard.*, dispatch.*, documents.*, people.*, bank_*, ticket.* or time_adjustment.* row existed. 34 files / 2,555 lines: registry.ts (567) is the ONE place a family means something; the panel\'s filter and badges and Penny\'s search_audit_log description are GENERATED from it; registry.test.ts source-scans every insertAuditLog call site in app/ + src/ and FAILS THE BUILD on an unregistered action (negative control first). auditFrom(request, authz) makes six routes stop taking edited_by / decided_by off the request BODY as the actor — the body value stays on the row as a business fact, recorded in details as a claim. Destructive paths audit FIRST and abandon the delete if the trail write fails. clearAuditLog (truncate, unable to record itself) is gone — DELETE prunes older than N days, floor 90, after writing audit.purged. Reads page by keyset, never .range(). Also gated: employee-gift-shipping GET+PUT and import-daily-report — 2 of the 6 ungated routes from the security sweep, closed here because an ungated write has no actor to record; four remain, and import-daily-report should be deleted (Kane\'s call). On origin/main; the panel has not been reported opened in prod since. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Rename the paid 2026-08-23 Hubstaff week off its browser "(1)" suffix across every store and reseed its 1,100 disbursement records',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['25a6f677'],
    basis:
      'Closed on a MEASUREMENT, the way a script row must be — a script has no prod surface, so Done means RUN. Read-only probe 2026-09-10: audit_log holds exactly one csv.rename event, actor script:rename-hubstaff-source-file, at 2026-09-09T20:49:04Z; a negative control on a non-existent action returns 0 rows, so the read can detect absence; two 2.3 MB restore-set JSONs sit in references/backups/ stamped 2026-09-09 16:48. THE WORK (session 438013b6, Kane: "Payment Dispatch - Week Selector - is missing last week\'s HUBSTAFF Report"): the week was in the database, paid and locked — 1,101 hour rows, 1,069 dispatches, cycle-complete fired — under a filename carrying the browser\'s duplicate-download "(1)" suffix, which passes the ingest contract and then trips a junk-file heuristic living in FOUR independent copies (dispatch week selector, seedMissingDisbursementRecords, CEO timeline, People payroll history). Nine days invisible; the week had seeded 0 of ~1,100 records. The 361-line script discovers every app_settings key ending in the old name rather than enumerating them, backs the full restore set up first, renames disbursement_records before payment_dispatches (the sync trigger matches on cycle_source_file), and re-seeds LAST so the existing dispatch rows stamp the records paid — 1,100 / 1,051 paid vs the neighbour week\'s 1,070 / 1,023. The wizard\'s own rename button was deliberately NOT used: it migrates one key and would have stranded six others, replaying the week with FX 0. Kane approved the rename ONLY; the ingest guard and the four regex copies are Open item 23, and "the missing is 30 - 5" is Open item 24. Completed Date is the commit date, which is also the day it ran.',
  },
  {
    name: 'Employee PAB card explains the right rule in all four places, and "Not met" drills into the calendar',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['15dbd67f'],
    basis:
      'Session c2cf2f89, the first commit of the Sep 9 meeting\'s build plan. The room said "there\'s no calendar there" and was wrong — an HSL-aware PAB calendar ships twice — but the copy was wrong in FOUR places (the plan first counted three) and the stat cell was an inert div. +104/−16 in EmployeeDashboard: the copy states the rule the person is actually graded by, and "Not met" is a real drill-in, branched on isHsl at the four sites. On origin/main; no employee has been reported clicking it in prod. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'My Hours becomes Time Adjustments, and red days ask for one — a persistent mark, a 5 s looping bubble and a permanent count, shuffled by seed',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['8ab5dcdb', '9841c4c9', '0db725af'],
    basis:
      'Same session — the meeting\'s ONE approved build (time-adjustment-nudge-approved). 8ab5dcdb renames the tab across 7 sites as a LABEL only (the hours key stays). 9841c4c9 is the nudge as THREE layers: a persistent mark on every red day, a 5 s looping bubble that visits red days in seeded-shuffle order, and a permanent count — all off one pure isNudgeableMissedDay (126 lines, 111 of tests). 0db725af fixes the rotation depending on the same thing twice. The trigger, resolved as the plan demanded: red is under 7 h WITH data; Carla\'s own failed click was a zero-hours day, which renders sky/orange and is NOT nudged — a blank cell can also be an ingest artifact. aa48e39d later trimmed 33 lines from the lib. All on origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'QC weekly deal is genuinely random — seeded per (period_start, department), Callback retired from QC_DEPT_KEYS, and the surface gets its first feature doc',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['aa48e39d'],
    basis:
      'Same session — HRIS-16\'s FIRST child row on the board. The meeting said "It\'s randomized already"; verified against code it was a deterministic alphabetical round-robin (qc-db.ts:304-306) so officer #1 got the alphabetically-first slice of Lead Gen every week — the buddy risk Carla was closing. deal.ts (82) over seeded-shuffle.ts (59) with 132 lines of tests including the not-alphabetical regression; Callback leaves QC_DEPT_KEYS (history retained, invisible) so Lead Gen is the only QCed department; qc-scoring.md (150 lines) is the ~7,000-line surface\'s first written record; audit-pending-migrations gains probes for the four QC tables (#88/#89 had been UNMEASURED — item 22b). Still owed and not this row: Kane unchecks Alivia\'s qc role in Admin before the first Monday read; zero-hours eligibility is Carla\'s ruling. Deadline: Jackie and nine officers test with real data Mon 2026-09-14. On origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'QC: paste Jackie’s sheet, Compare it with the first pass in four buckets, Override via setVar only, Undo in memory',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['2e56b84e'],
    basis:
      'Same session, off the qc-compare-override-paste-format brief. paste.ts (135) parses a TAB-only paste; compare.ts (241) sorts it against the QC first pass into four buckets carrying scored_by; Override writes through setVar ONLY, never rows[]; Undo is in-memory; one audit event. 261 lines of tests, 399 lines in DeptBonusCalculator. Q1 was settled by a read-only prod probe: the var is per member (Appts_Set for the dept, Appts for reinelr@). The officer histogram is a separate brief, not this row. On origin/main; Jackie has not pasted a sheet in prod. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'KPI calculators score the upcoming pay week before its Hubstaff file exists, and kpi.published tells Accounting on publish',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['27b193c3', '9eea44b9'],
    basis:
      'Same session (hsl-kpi-calculator-2026-07.md § Scoring the upcoming week). Both pickers offer exactly ONE week past the live batch — live Sunday + 7 via upcomingWeekFor, never the clock — sync is the period_start key and no gate is loosened (isUpcomingWeek is wording only); a period-status route; kpi-published.ts (169 lines, 57 of tests) inserts a kpi.published notification for Accounting on Mark Ready / Lock. The ALTER widening employee_notifications_type_check was run by Kane the same day and 9eea44b9 records the verify: kpi.published present, 45 types, superset intact — re-read again 2026-09-10 on a fresh connection while checking the tickets row. The first REAL insert is still unproven: the next Mark Ready or Lock on any dept-week is the proof, and a missing Accounting card means read audit_log for notification.insert_failed first. On origin/main. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Lead Gen card header — Compare chip beside Payout with motion, Offboarded last pay behind a header chip, week picker border restored',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['e107ab37', 'e8e5926d', '257ecf56', 'a56ce28c'],
    basis:
      'Same session, four polish commits on DeptBonusCalculator in one afternoon: Compare with your sheet moves into the Lead Gen card header beside Payout and unfolds with motion; Offboarded · last pay collapses behind a header chip; the Compare chip wears a running emerald rim while live; the Departments week picker gets its thin border back because it is a control. Chrome only — no scoring math moved. Scored 2 as one component\'s iteration, not four rows. All on origin/main, not confirmed live. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Manager Overview rebuilt — what needs me on the left as one ordered queue, the roster on the right, four stat cells, and no page scroll at lg and up',
    status: 'Done',
    completed: '2026-09-03',
    dateBasis: 'commit',
    shas: ['f36a97ce', 'ba990833'],
    basis:
      'UNDECLARED SINCE 2026-09-02, and inside pass 23\'s own range: f36a97ce "Push" (358 files) carried this rebuild UNDER the KPI-header unification pass 23 filed it as, and the doc (manager-overview.md, ba990833) and memory both warn that git log will not lead anyone here. Session 3dab3af5, Kane: "Manager - Overview - Please redesign this and make it look like this please but use our color theme" → "Make this fit in 1 view port please". Greeting, a divided band of four stat cells (Pending approvals, Bonuses to score, Active right now, On your roster — an em-dash while a gate loads, never a zero), pending time adjustments and unscored bonus departments merged into ONE ordered "Needs you" queue with an All / Approvals / Bonuses filter (NEEDS_PREVIEW = 8, "+N more waiting" pinned BELOW the scroll), the roster on the right. Nothing on the page decides anything — every row links into the surface that owns the decision. At lg and up the page must not scroll: 0 px page scroll verified at 1440×900, 1366×768 and 1280×720; mobile still scrolls, deliberately. ManagerApp.tsx diff 1,553 lines; scoped CSS in a style block. Completed Date would be 2026-09-02, inside S28 — but it is not Done: nobody has confirmed the viewport lock in prod. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },

  // ── existing rows whose evidence moved (5) ────────────────────────────────────────────────────────
  {
    name: 'Stop Processing can no longer file a just-paid person as unpaid — the close-out prunes reconciled-paid employees',
    status: 'Done',
    completed: '2026-09-03',
    dateBasis: 'commit',
    shas: ['1f5b3ce4'],
    basis:
      'RE-DERIVED 2026-09-10, one step: pass 23 capped this In Progress because 1f5b3ce4 was not an ancestor of origin/main at staging (baa7ba21). Kane pushed; it is now an ancestor, so the row advances to Pending Deploy and no further — nobody has said the Stop Processing dialog counted a just-paid person correctly in prod. The work is unchanged: the client iterates the overlaid rows and buildCycleCloseoutRecord prunes reported-unpaid EMPLOYEES that have a paid row in the cycle (unpaid.reconciledPaid), contractors never pruned, 58 lines of tests. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Payment Catalog Pay Processors tab — the source-of-truth registry of send-from processors and their 1:1 rails',
    status: 'Done',
    completed: '2026-09-03',
    dateBasis: 'commit',
    shas: ['5062ccc1', '44aa16f7'],
    basis:
      'RE-DERIVED 2026-09-10, one step: both shas are now ancestors of origin/main (they were not at pass 23\'s staging), so In Progress → Pending Deploy. Since then 459671ea / 3c478f1c grew the same PayProcessorsTab.tsx by ~770 lines for the Current Banks and People tabs — that is the Current Banks row, not this one. Payment Dispatch integration is still the recorded NEXT step (Open item 13) and not in this row. Not confirmed opened in prod. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Wizard Lock-in button greys out once the cycle is locked and sent to Payment Dispatch',
    status: 'Done',
    completed: '2026-09-03',
    dateBasis: 'commit',
    shas: ['5982d3e6'],
    basis:
      'RE-DERIVED 2026-09-10, one step: 5982d3e6 is now an ancestor of origin/main, so In Progress → Pending Deploy. resolveDispatchButtonState (87 lines, 104 of tests): DISABLED while locked and dispatched, Unlock → change → lock only re-stages. The 08-30 → 09-05 week was locked on 2026-09-08 by aliviah@ — whether the button greyed for her is exactly the click-through nobody has recorded. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Edit Department on every Payment Catalog card — rename by alias, sub-department restructure, people moves, CAS-guarded; master-list cards for managers only',
    status: 'Done',
    completed: '2026-09-03',
    dateBasis: 'commit',
    shas: ['7e15aed8', '67858c44'],
    basis:
      'RE-DERIVED 2026-09-10, one step: both shas are now ancestors of origin/main, so In Progress → Pending Deploy. The 8-SP surface is unchanged — rename keeps the registry KEY and records a previousNames alias the rate engine and six pay readers resolve, sub-department restructure, people moves, CAS 409, master-list cards for managers only with HSL excluded. Money-adjacent: a rename that re-points the rate engine has to be seen doing so in prod before anyone credits it. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Audit writes fail silently: insertAuditLog’s error is discarded at 197 of 201 call sites',
    status: 'Done',
    completed: '2026-09-09',
    dateBasis: 'commit',
    shas: ['ddf4c790'],
    basis:
      'ADVANCED Ready to Start → Pending Deploy on 2026-09-10 because ddf4c790 does exactly what this row names, without a new row: insertAuditLog and insertAuditLogs now call reportAuditWriteFailure on every failure path — "[audit] write FAILED — event lost" with the actions and resources — so a lost event is no longer indistinguishable from an action that never happened, at every one of the void call sites at once (182 of 228 by the fix\'s own count). Destructive paths go further and READ the returned error, writing the trail first and abandoning the delete if it fails (purgeAuditLogBefore, the orphanage and HSL delete routes). The observability half is structural; the per-call-site awaiting it does not attempt, by design. On origin/main; a failed audit write has not been provoked in prod to see the log line. RE-DERIVED 2026-09-11: ddf4c790 is still an ancestor of origin/main and the row is unchanged. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },

  // ── PASS 25 · new rows (2) — the work that landed after a56ce28c ─────────────────────────────────
  {
    name: 'The COE states the profile role and the bonuses earned over the last 4 pay cycles, through the one reader the paystub modal already uses',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['47232941', '4c15670d'],
    basis:
      'Session 47232941/4c15670d, 2026-09-10. The certificate stops being dates-and-salary: it states the profile role — OPTIONAL, omitted entirely when unset and never guessed — and the bonuses earned over the last 4 COMPLETED pay cycles (PAB + Tech + Perf). The load-bearing change is that this did NOT add a second bonus reader: src/lib/payroll/employee-paystubs.ts (863 lines) is lifted out of app/api/employee/paystub/route.ts (-804) so the COE, the Employee paystub modal and Penny all read through one listEmployeePayStubs, with the lookback clamped to the person\'s start date. coe-facts +241 with 164 lines of new tests; 4c15670d then pins that the SIGNED copy carries the same facts as the draft — one resolver, one renderer, no opt-out — with coe-request-paths.test.ts (82 lines). Both on origin/main (ancestor-checked 2026-09-11). Not Done: nobody has said a generated certificate was read in prod with the role line and the four-cycle bonus block on it. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },
  {
    name: 'Payroll Wizard Reports XLSX carries Time Adj. Hours, Pay and Dates — the delta is staged on the payload, never recomputed at export',
    status: 'Done',
    completed: '2026-09-10',
    dateBasis: 'commit',
    shas: ['bd7f8402'],
    basis:
      'Session bd7f8402, 2026-09-10. The Reports XLSX grows Time Adj. Hours / Time Adj. Pay / Time Adj. Dates, and the rule is the whole feature: the delta is STAGED on the payload at lock time and read back verbatim, never recomputed at export — so a replayed week exports what was actually paid rather than what today\'s adjustments would say, and a zero is written as a zero rather than a null. report-rows +83 with 120 lines of tests, a new replay-finals-overlay.ts (31) with 74 of its own, plus paystub-recovery and four docs. On origin/main (ancestor-checked 2026-09-11). Not Done: the XLSX has not been reported downloaded and read in prod. The paystub still hides the same delta — that is an Open item, not this row. DONE 2026-09-12 on Kane\'s explicit confirmation - his verbatim instruction is quoted in the PASS 26 header, and it is recorded here as the basis rather than assumed, which is the only thing that turns a confirmation into evidence. The Completed Date is this row\'s LAST SHA\'s commit date, re-derived from git and enforced by selfcheck; it is NOT the day the board caught up.',
  },

  // ── PASS 25 · the false PENDING (1) ──────────────────────────────────────────────────────────────
  {
    name: 'Lawang rate shadow: hours ride lawangc@ on a stale 175 employee-scope override',
    status: 'Done',
    completed: '2026-08-18',
    dateBasis: 'commit',
    shas: ['4447e404'],
    basis:
      'CLOSED 2026-09-11 on a read-only MEASUREMENT that contradicts both the plan comment and [[lawang-rate-shadow-duplicate-identity]], which each said the --apply was BLOCKED and had never run. It ran. payment_catalog_pay_structures/pay_mse34sctiw8xsiio now reads regular 225 / OT 337.5 / department_key hogan_smith_law, stamped updated_by "fix-lawang-rate-shadow.mts" at 2026-08-18T20:09:14Z (it was created 2026-08-04 by jakec@ at 175/lead_gen). employee_rate_history holds the matching 225 / 337.5 row effective 2026-08-16 with created_by the same script at the same second, beside the original 175 row effective 2026-08-04. The sheet mirror 03b7882a-98fd-4c48-ab34-bab59cf2c568 reads 225 / 337.5. That is all three of the script\'s declared steps, each verified by the script\'s own stamp — the same grade of evidence that closed the Hubstaff rename chore. Dated by commit: 4447e404 (the commit messaged "ss" that carried the 145-line script) landed 2026-08-18, the day the script also ran. The row stays in Backlog, which selfcheck exempts from the window check; re-filing it to Sprint 27 is a grooming call, not a correctness one. NOT closed by this row and still open: merging the two Lawang master rows, and the five employees who still hold a bare-hsl override — measured present again 2026-09-11.',
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
