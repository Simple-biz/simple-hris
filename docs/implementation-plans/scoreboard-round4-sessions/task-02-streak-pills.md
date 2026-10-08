# Session: Task 2, the No Meeting Streak as date pills (Open item 391)

Use the **`hardening`** skill first. Use **`impeccable`** for the visual pass once the logic is in.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: changes to shipped sections (item 391)" › "PM Buckets: the No Meeting Streak, prettier". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 2 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints**. Build only Task 2. It is display only: no migration, no new read.

**What Carla asked (2026-10-07):** *"Can you make this prettier? Just like we want it to be like, yes, five days, no
meeting. Keep it going, guys."* Kane: *"date pills"*. The streak number stays the existing computed `noMeetingStreak`.
Colour is never the only signal.

## Check before you start (stop and tell Kane if one fails)
- Task 1 is committed (`git log --oneline -15` shows the hide-from-Overview commit).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Read the files the task names and cite
  `file:line`. Where the code disagrees with the plan, the code wins: correct Task 2 in the plan in the same commit, and
  say so in the commit message.
- Verify in the esbuild + Playwright harness described in memory `accounting-scoreboard` (§ Verifying the UI), at 1360 px
  and 390 px, light and dark, and under reduced motion. The page needs sign-in, so the harness is the check.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` § PM Buckets and memory `accounting-scoreboard` are updated in the same commit.
3. Open item **391**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped and the commit.
4. Reply to Kane in a few lines: the commit hash, and "push".
