# Session: Task 3, Chargebacks signs, a Pre-arb flag and a Net (Open item 392)

Use the **`hardening`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: Chargebacks negatives and Pre-arb (item 392)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 3 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints**. Build Steps 0–5. **Step 6 (the win ratio) only if Kane has ruled W0.1.**
Look for his ruling on Open item 392 in `docs/audits/audit-2026-09-29-session-log.md`. If there is none, stop after
Step 5 and say Step 6 is waiting.

**What Carla asked (2026-10-07):** wins positive, Pre-arb and Losses negative, so the board shows *"we're in the hole"*.
CHOSEN in the plan: **the sign comes from the line's flag, never from a typed minus.** That keeps the 0–100,000 rule on every
box and avoids double negatives. The $25 fee is NOT added to the Net (W0.3 d).

**Contradiction you must not resolve yourself:** Carla said Pre-arb *"is still considered a loss"*. Item 387 CHOSE a win
ratio that leaves Pre-arb out. Only Kane's W0.1 ruling changes `winRatio`.

## Check before you start (stop and tell Kane if one fails)
- Task 2 is committed (`git log --oneline -15`).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Copy the live `acct_sb_rows_outcome_valid`
  CHECK verbatim from its SQL file and add only `'pre_arb'`. Where the code disagrees with the plan, the code wins: correct
  Task 3 in the plan in the same commit, and say so.
- The data step flags exactly ONE live "Pre-arb" Outcomes row. Back it up first, and refuse if the match is not exactly one.
- Name new SQL and script files with **today's date**.
- `.env.local` is **production**. **Dry-run, show Kane the output, and stop.** `--apply` only on his go, then `--verify`.
- **Migration FIRST, then the push.** Kane pushes. You never push.
- Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard.md` § Chargebacks (the "Not built … item 317 (a)" line becomes built), the INDEX row
   and memory `accounting-scoreboard` are updated in the same commit.
3. Open items **392** (and 317) in `docs/audits/audit-2026-09-29-session-log.md` get a dated note: what shipped, the
   commit, and whether W0.1 is still owed.
4. Reply to Kane in a few lines: the commit hash, then his next steps in order (apply, then push, then W0.1 if open).
