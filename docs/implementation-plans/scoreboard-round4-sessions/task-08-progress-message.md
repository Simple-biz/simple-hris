# Session: Task 8, the team's task progress message: copy, then Google Chat (Open item 393)

Use the **`blueprint`** skill first.

**Meeting notes (read first):** `docs/meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md` § "Accounting Scoreboard: task boards, roles and weekly lock-in (item 393)" › "Per-person task boards (the reminder bullet)". Read that section word for word, plus the note's **Decisions made on the call**, **Open questions** and **Reference notes** (the transcript's name garbles, e.g. Kenchin = Kentshin, Olivia = Alivia). Carla will judge the result against her quotes there, and the plan only restates them.

**Your scope:** Task 8 of `docs/implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md`. Read that task
in full, plus the plan's **Global Constraints**. Build Steps 1–4 (the Copy button). **Steps 5–8 (Post to Chat) only if the
webhook is set (W0.4):** `grep -c "^ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL=." .env.local` prints 1. **Never print the URL**,
because it carries a key. Otherwise stop after Step 4 and say the Chat part is waiting.

**What they do today:** someone posts by hand *"Current progress, 98 out of 170 daily tasks and 13 of 80 weekly tasks have been
completed. As you complete your task, remember to check them off"*. Carla is fine with a copy-paste note. Kane: *"Connect
accounting scoreboard to accounting group chat."* **No scheduled post in this session.** That needs a time from Kane and a
scheduler proven to fire (memory `scheduled-deletion-cron-never-ran`).

## Check before you start (stop and tell Kane if one fails)
- Task 7 is committed (`git ls-files src/lib/accounting-scoreboard/tasks.ts` prints the file).
- Lane A runs one session at a time. `git status --short -- src/lib/accounting-scoreboard src/components/accounting-scoreboard app/api/accounting-scoreboard app/accounting-scoreboard references/sql/create docs/features/accounting-scoreboard.md` must show nothing.

## Rules for this session
- **Step 0 is mandatory.** The plan was written without reading the code. Read how Task 7 shipped `taskProgress` and
  `TasksPanel`. Where the code disagrees with the plan, the code wins: correct Task 8 in the plan in the same commit, and
  say so.
- The audit action goes in `src/lib/audit/registry.ts`. The env var goes in `.env.example` with no value.
- The one real post to Chat (Step 7) happens only with Kane watching the space, on his go.
- Kane pushes. You never push. Stage by explicit path, re-run `git status` right before committing, commit to `main`.

## Done means
1. The task's tests pass, then `npm test` and `npm run lint` (give the counts; name any pre-existing failure).
2. `docs/features/accounting-scoreboard-tasks.md` and memory `accounting-scoreboard-tasks` are updated in the same commit.
3. Open item **393**'s row in `docs/audits/audit-2026-09-29-session-log.md` gets a dated note: what shipped, the commit, and
   whether W0.4 is still owed.
4. Reply to Kane in a few lines: the commit hash, then his next steps (set the webhook URL in Vercel too, push).
