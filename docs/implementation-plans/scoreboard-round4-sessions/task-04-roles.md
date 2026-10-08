# Session: Task 4, board-local roles: Admin / Assistant / Team member (Open item 393)

Use the **`blueprint`** skill first. It takes its own recommendations as `CHOSEN` lines and stops only on `NEEDS`.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: task boards, roles and weekly lock-in (item 393)" › "Board-local roles in Setup". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 4 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints** and **Review Focus 3**. Build only Task 4.

**What Carla asked (2026-10-07):** Team member edits everything except Setup; Assistant sees Setup but can't change it and
sees everyone's tasks; Admin has full write. No edit/view/hidden matrix (*"Nah."*).

**This changes a documented rule. Kane CONFIRMED the change on 2026-10-07 (Open item 393), and your brief still says so up front:** today "Managers are the `admin` and `accounting`
roles". After this, an HRIS `admin` is always a board Admin (break glass), and **HRIS `accounting` alone makes a Team
member**. Report, as counts and never names, how many `accounting` holders lose manager rights and how many lose access
entirely (memory says 2 are not on the GML). Kane sees those numbers before any `--apply`.

**NEEDS (W0.6):** the second Admin's work email. Build everything. The seed takes both Admin emails as script arguments
and refuses to apply without them. Carla's is `carla@simple.biz`.

## Check before you start (stop and tell Kane if one fails)
- Task 3 is committed (`git log --oneline -15`).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. List every place that reads `isManager` (routes
  and components) and map each one to a `BoardAction`. Where the code disagrees with the plan, the code wins: correct
  Task 4 in the plan in the same commit, and say so.
- The new audit actions go in `src/lib/audit/registry.ts` (the single source).
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run, show Kane the output, and stop.** `--apply` only on his go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` § Who may open it (rewritten), the INDEX row and memory `accounting-scoreboard`
   are updated in the same commit.
3. Open item **393**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped, the commit, the
   two counts, and whether W0.6 is still owed.
4. Reply to Kane in a few lines: the commit hash, the two counts, then his next steps in order (the second Admin's email,
   apply, push).
