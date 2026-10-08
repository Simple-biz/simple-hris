# Session: Task 5, the Admin-only weekly lock-in and reopen (Open item 393)

Use the **`blueprint`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: task boards, roles and weekly lock-in (item 393)" › "Weekly lock-in, Admin only". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 5 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints** and **Review Focus 2**. Build only Task 5.

**What Carla asked (2026-10-07):** *"If I've locked it in, it's you can't change it anymore, but I can still change all
this stuff."* Lock and reopen are Admin only. CHOSEN in the plan: lockable from the week's Friday (Eastern); a lock refuses
every dated write in that week, for everyone, Admin included; Setup and task ticks are never locked; lock and reopen are
stamps, never deletes. **A DB trigger is the last line of defence**, and later tasks (6 and 7) attach the same function.

**REQUIRED (Kane, 2026-10-08, "make sure all of the data ... is saved so we can have a histogram"): every lock writes a
frozen, append-only snapshot of the week** (`accounting_scoreboard_week_snapshots`: every section's headline, goal in force,
light and card score, the group scores, the Team Score, each row's week total). Without it a past week's score is
recomputed with today's goals. See plan Task 5 and Open item 410. (Task 7 is already built: tasks are never locked.)

## Check before you start (stop and tell Kane if one fails)
- Task 4 is committed **and applied**: `git ls-files src/lib/accounting-scoreboard/roles.ts` prints the file, and
  `node --import tsx scripts/apply-accounting-scoreboard-roles-migration.mts --verify` passes (read-only). If the verify
  can't run here, ask Kane to confirm it.
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Confirm the exact table and date-column names of
  every dated write from the 2026-10-01 and round-3 SQL before you write any trigger. Where the code disagrees with the
  plan, the code wins: correct Task 5 in the plan in the same commit, and say so.
- `--verify` proves the trigger inside rolled-back transactions only: never leave a real lock behind.
- Audit actions go in `src/lib/audit/registry.ts`. The confirm dialogs are dialogs, never `window.confirm`.
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run, show Kane the output, and stop.** `--apply` only on his go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` (new § Locking a week), the INDEX row and memory `accounting-scoreboard` are
   updated in the same commit.
3. Open item **393**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped and the commit.
4. Reply to Kane in a few lines: the commit hash, then his next steps in order (apply, push).
