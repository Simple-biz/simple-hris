# Session: Task 1, hide a section from the Overview (Open item 391)

Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: changes to shipped sections (item 391)" › "Hide a section from the Overview". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 1 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints** and **Review Focus 1**. Build only Task 1.

**What Carla asked (2026-10-07):** a "Show on Overview" switch under Setup → Sections, for built-in and custom sections, so
she can take "Sales Projects Onboarded" (and one other) off the Overview. CHOSEN in the plan: a hidden card also leaves the
Team Score. A board cached in the browser without the new field must paint as "shown".

## Check before you start (stop and tell Kane if one fails)
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing. If it shows changes, another session is mid-task: stop.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Read the files the task names and cite
  `file:line`. Where the code disagrees with the plan, the code wins: correct Task 1 in the plan in the same commit, and
  say so in the commit message.
- Name new SQL and script files with **today's date**, not the plan's placeholder date.
- `.env.local` is **production**. Read-only unless Kane says go. **Dry-run the migration, show Kane the output, and stop.**
  Run `--apply` only on his go in this session, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md`, its `docs/features/INDEX.md` row and memory `accounting-scoreboard` are updated
   in the same commit as the code.
3. Open item **391**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped, the commit,
   and what Kane still owes. If a newer session log has taken over, add a row there instead.
4. Reply to Kane in a few lines: the commit hash, then his next steps in order (the apply command if not yet run, then
   push).
