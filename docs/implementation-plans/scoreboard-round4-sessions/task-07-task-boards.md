# Session: Task 7, per-person task boards (Open item 393)

Use the **`blueprint`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: task boards, roles and weekly lock-in (item 393)" › "Per-person task boards". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 7 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints**. Build only Task 7. The progress message is Task 8, a separate session.

**What Carla asked (2026-10-07):** each person's task board (daily, weekly, bi-weekly, monthly, bimonthly, quarterly,
annually, as needed) moved off her sheet onto the scoreboard, behind a **Scoreboard | Tasks** switch. Each person sees their
own board through Google sign-in; Carla sees everyone's. CHOSEN in the plan: only an Admin adds or archives tasks; the owner
ticks; as-needed tasks are listed and never counted; "bimonthly" = every two months; a frequency change = archive + new task.

**The import:** the scoreboard sheet (`1JqLyLtO…`) is already shared with the HRIS service account. **The Florida tabs carry
an extra column with Monday in a different place**, so detect each tab's layout from its header cells, never fixed column
letters. Import tasks only, never ticks.

## Check before you start (stop and tell Kane if one fails)
- Tasks 4 and 5 are committed **and applied** (their apply scripts' `--verify` pass, read-only, or Kane confirms).
- Task 6 is committed (lane order).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Read the member check's alias handling (so
  someone signed in under an alternate address sees their own board) and the Payment Verified tick/untick pattern. Where the
  code disagrees with the plan, the code wins: correct Task 7 in the plan in the same commit, and say so.
- Tasks are read on their own route, never inside `readBoard()`, so the board's load stays as it is.
- The sheet read prints layouts and counts only. The tab → person mapping stays gitignored under `docs/audits/backups/`.
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run the migration and the import, show Kane the output, and stop.** `--apply` only
  on his go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. A new `docs/features/accounting-scoreboard-tasks.md` and its INDEX row; `accounting-scoreboard.md` § Not built loses "task
   checklists"; memory gets a new `accounting-scoreboard-tasks` entry and a `MEMORY.md` line, all in the same commit.
3. Open item **393**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped and the commit.
4. Reply to Kane in a few lines: the commit hash, the import's dry-run counts per frequency, then his next steps in order
   (apply the migration, the import `--apply`, push).
