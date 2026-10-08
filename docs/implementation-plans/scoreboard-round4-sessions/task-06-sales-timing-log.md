# Session: Task 6, Sales Onboarding becomes a payment-timing log (Open item 391)

Use the **`hardening`** skill first. This converts a built-in section, the way round 3 converted Payroll Problems.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: changes to shipped sections (item 391)" › "Sales Onboarding becomes a payment-timing log". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 6 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints** and **Review Focus 1 and 4**. Build Steps 0–7. **Steps 8–9 (Joana's sheet)
only if Kane has given the link (W0.5).** Otherwise stop after Step 7 and say they are waiting.

**What Carla asked (2026-10-07):** one line per payment (date, sales rep, amount, message time, billing rep, start, end,
duration, result), judged on the weekly average: *"Three is like bottom. Two is like wow. One is perfect."* Sales reps never
get access. The old daily grid becomes read-only, and its counts still count as payments for their weeks.

**Deploy at a week boundary.** The apply runs on a Saturday or Sunday (Eastern), and Kane pushes before Monday. Round 3's
mid-week switch is why Monday's Payroll Problems are stuck as "No type". Say this in the first line of your reply.

## Check before you start (stop and tell Kane if one fails)
- Task 5 is committed **and applied**: `node --import tsx scripts/apply-accounting-scoreboard-week-locks-migration.mts --verify`
  passes (read-only), because this task's migration attaches `acct_sb_refuse_locked_week()`. If the verify can't run here,
  ask Kane to confirm it.
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Copy round 3's Payroll Problems path (section
  definition, `entryAllowed`, the log route, the "No type" reading) instead of inventing a new one. Where the code disagrees
  with the plan, the code wins: correct Task 6 in the plan in the same commit, and say so.
- No native time input (memory `picker-popups-escape-clipping`). Dropdowns are `SmoothSelect`. Tables carry `table-keep`.
- The new read joins a `BOARD_READS` group, or the load-progress test fails.
- The sheet read is read-only, and prints headers, counts and formats only, never names. The rep mapping file stays
  gitignored under `docs/audits/backups/`.
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run, show Kane the output, and stop.** `--apply` (migration or import) only on his
  go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` (new § Sales Onboarding: a payment-timing log, and the sections table), the INDEX
   row and memory `accounting-scoreboard` are updated in the same commit.
3. Open item **391**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped, the commit, and
   whether W0.5 is still owed.
4. Reply to Kane in a few lines. First line: "Apply on Saturday or Sunday, push before Monday." Then the commit hash and
   the exact commands.
