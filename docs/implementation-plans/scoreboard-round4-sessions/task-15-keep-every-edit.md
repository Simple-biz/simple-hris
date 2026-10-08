# Session: Task 15, keep every edit: typed-cell history and goal history (Kane's histogram ask, 2026-10-08)

Lane A: the next free scoreboard slot, never alongside another lane-A session. Before Task 5 if you can. Use the
**`hardening`** skill first.

**Why (Kane, 2026-10-08):** *"Please make sure all of the data in the accounting dashboard is saved so we can have a
histogram created later."* Read the Open item for this ask in `docs/audits/audit-2026-09-29-session-log.md` (search
"histogram"), memory `accounting-scoreboard`, and `docs/features/accounting-scoreboard.md` § Writes.

**Your scope:** Task 15 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that
task in full, plus the plan's **Global Constraints**. Build only Task 15: two append-only history tables filled by
triggers, plus their migration and apply script. **No UI**: the histogram itself is a later `blueprint`. The weekly
score snapshot is Task 5's, not yours.

**Rules that must not move:**
- A cleared cell stays a DELETED entry, never a stored 0 (the board's "absence is not zero" rule). You record the clear
  in the history; you never change how the clear works.
- History rows are append-only: UPDATE and DELETE refused by the table.
- Every `*_by` is the session email. The DELETE of a cleared cell carries no "who" today. Step 0 decides how the
  trigger learns it, and the commit message says what was chosen.

## Check before you start (stop and tell Kane if one fails)
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** Read `writeEntry` and the section and custom-section writes in `server.ts`, and the entries
  and sections DDL, and cite `file:line`. Where the code disagrees with the plan, the code wins: correct Task 15 in the
  plan in the same commit, and say so.
- Copy the shape of `scripts/apply-accounting-scoreboard-tasks-migration.mts` (dry by default, `--apply`, `--verify`,
  positive and negative controls in rolled-back savepoints, anon refused).
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run, show Kane the output, and stop.** `--apply` only on his go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The apply script's controls pass: an edit, a clear and a goal change each write exactly one history row; history
   rows refuse UPDATE and DELETE; anon is refused. `npm test` and `npm run lint` pass.
2. `docs/features/accounting-scoreboard.md` gets a § "History kept for later charts" (what is kept, from which date,
   and that history starts on the apply date), plus its INDEX row and memory `accounting-scoreboard`, in the same commit.
3. The histogram Open item in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped, the commit,
   and that the weekly snapshot is still Task 5's.
4. Reply to Kane in a few lines: the commit hash, then his next steps in order (apply, push).
