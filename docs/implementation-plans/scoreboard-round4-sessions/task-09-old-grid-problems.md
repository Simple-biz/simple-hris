# Session: Task 9, Monday's untyped Payroll Problems (Open item 391)

**Paste this only after Kane has ruled W0.2.** Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: changes to shipped sections (item 391)" › "Payroll Problems: Monday's untyped entries cannot be edited". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 9 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints**. Build **only the branch Kane chose**.

**Kane's ruling (W0.2):** look for it on Open item 391 in `docs/audits/audit-2026-09-29-session-log.md`. **If there is no
ruling there, stop and ask.** This is a contradiction between Carla's *"I don't have an option to edit or delete the Monday
problems"* and the documented *"the grid takes no writes"*. You do not pick.

- **(a) Clear the week with a script:** dry by default, a backup first, `--revert <backup>`. It refuses any entry newer than
  the round-3 apply (2026-10-06 18:04Z) and prints counts per day and row, never names. `--apply` runs only on Kane's go.
  Afterwards Carla's team re-logs the problems with types.
- **(b) Admins may edit the old grid:** `entryAllowed` for `payroll_problems`, Admin only (needs Task 4's roles), weeks
  before the round-3 cutover only, with tests for both limits. Record it as Kane's ruling loosening a documented rule.
- **(c) Leave it:** one line in `docs/features/accounting-scoreboard.md` § Payroll Problems that Carla asked and the answer
  was no. No code.

## Check before you start (stop and tell Kane if one fails)
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** Read how the old grid's counts are stored and read as "No type" and cite `file:line`. Where the
  code disagrees with the plan, the code wins: correct Task 9 in the plan in the same commit, and say so.
- `.env.local` is **production**. Every bulk change has a `SELECT` backup written to disk first.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. Tests (if any) pass, then `npm test` and `npm run lint`.
2. The feature doc § Payroll Problems and memory `accounting-scoreboard` say what was ruled and done, in the same commit.
3. Open item **391**'s row gets a dated note: the ruling, what shipped, the commit.
4. Reply to Kane in a few lines: the commit hash, and the exact command(s) he runs, in order.
