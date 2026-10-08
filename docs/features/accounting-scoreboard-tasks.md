# Accounting Scoreboard Tasks — per-person task boards and the team progress message

The person tabs of Carla's scoreboard sheet (daily, weekly, bi-weekly, monthly, bimonthly, quarterly, annual and
as-needed tasks, each with a checkbox) moved onto the Accounting Scoreboard, behind a **Scoreboard | Tasks** switch in
the header. Everyone opens on their own board and ticks their own tasks; Carla and Claire see everyone's; the team's
progress posts to the accounting Google Chat space instead of being typed into it by hand. Built 2026-10-08 (session
`39022c5c`, plan Tasks 7 + 8, Open item 393) from the [Oct 7 meeting](../meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md).
It lives inside the scoreboard ([accounting-scoreboard.md](accounting-scoreboard.md)) and shares its access and roles.

## Key files

| Piece | File |
| --- | --- |
| Tables, guards, lock-down | `references/sql/create/2026-10-08_accounting_scoreboard_tasks.sql` |
| Apply / verify (dry by default) | `scripts/apply-accounting-scoreboard-tasks-migration.mts` |
| Frequencies, periods, progress (pure) | `src/lib/accounting-scoreboard/tasks.ts` (+ `.test.ts`) |
| The progress message (pure) | `src/lib/accounting-scoreboard/chat-summary.ts` (+ `.test.ts`) |
| Request parsing | `src/lib/accounting-scoreboard/validate.ts` § Task boards (+ `tasks-validate.test.ts`) |
| Reads, writes, the Chat post | `src/lib/accounting-scoreboard/server.ts` § Task boards |
| Routes | `app/api/accounting-scoreboard/tasks/route.ts` (GET / POST / PATCH) · `tasks/checks/route.ts` (POST) · `tasks/post-progress/route.ts` (POST) |
| UI | `src/components/accounting-scoreboard/TasksPanel.tsx`; the switch in `ScoreboardApp.tsx` |
| Sheet import | `scripts/import-accounting-scoreboard-tasks.mts` + `src/lib/accounting-scoreboard/task-import.ts` (+ `.test.ts`) |
| Wire types | `src/lib/accounting-scoreboard/types.ts` (`TasksPayload`, `BoardTask`, `TaskCheck`, `TaskPerson`) |

## Who sees and does what (the board's roles, `roles.ts`)

| | Team member | Assistant | Admin |
|---|---|---|---|
| Own board, tick own tasks | yes | yes | yes |
| See a person's board, or Everyone | no | yes (`view_all_tasks`) | yes |
| Add, rename, remove tasks | no | no | yes (`manage_tasks`) |
| Untick someone else's task | no | no | yes |
| Copy message | no | yes | yes |
| Post to Chat | no | no | yes |

- **Only the owner ticks a task.** An Admin may untick anyone's (a wrong tick), never tick for them: a tick says who
  did the work. This is the Payment Verified pattern.
- The route is the board's: `resolveAccess` on every request, and the Tasks view reads its own route
  (`GET /api/accounting-scoreboard/tasks`), **never the board payload**. Nothing about tasks is in `readBoard`, its
  progress lines or its browser cache. The viewer's role is resolved per request and never cached.
- **A task's owner is one of the board's people**: a live person row (named by its row label, what the team calls
  them), a member, or a role grant (`listTaskPeople`). Not any HRIS address: a task on someone who cannot open the board
  helps no one. Someone signed in under an alternate address sees their own board through their aliases.

## Periods: what a tick counts for

A tick belongs to its task's **current period**, in US Eastern (the board's day). The server computes the period key
(the period's first day) from today; **the client never sends one**.

| Frequency | Period | Key on Wed 2026-10-07 |
|---|---|---|
| Daily | the day | 2026-10-07 |
| Weekly | the Sunday week (the board's week key) | 2026-10-04 |
| Bi-weekly | two-week blocks from Sunday 2026-01-04 (`BIWEEKLY_ANCHOR`, CHOSEN) | 2026-09-27 |
| Monthly | the month | 2026-10-01 |
| Bimonthly | two-month blocks starting Jan, Mar, May, Jul, Sep, Nov (CHOSEN: "every two months") | 2026-09-01 |
| Quarterly | the quarter | 2026-10-01 |
| Annually | the year | 2026-01-01 |
| As needed | none | — |

- **As-needed tasks are listed, never counted and never ticked** (Carla: "if it's needed, cool, do it. If it's not,
  okay, whatever"). The table refuses a tick on one.
- "Done of total" counts live tasks of that frequency against live ticks in the current period. A frequency with no
  tasks is left out, never "0 of 0".
- A tick from yesterday does not count today; a weekly tick from Monday still counts on Friday and not next Sunday.

## Tasks and ticks are history: nothing is deleted

Kane, 2026-10-08: *"make sure all of the data … is saved so we can have a histogram created later."*

- **A task is archived, never deleted** (the table's trigger refuses DELETE). Its **owner and frequency never change in
  place**: a new frequency is a new task, so an old tick never changes meaning. Only the title, the order and the
  archive stamp change, and an archived task is final.
- **A tick is unchecked by a stamp** (`unchecked_at` / `unchecked_by`), never deleted; ticking again inserts a new row.
  One live tick per task per period (a unique index).
- So any past period can be counted again: the tasks live at a time *t* are those with `created_at <= t` and no
  `archived_at` before *t*; a period's done count is its live ticks with that `period_key`; `checked_at` says when in
  the day the work was ticked. That is everything a completion histogram (per person, per frequency, per week) needs.

## The Everyone view and the progress message

- One row per person with live counted tasks: done / total per frequency (green when all done, red when none, amber in
  between). A name opens that person's board.
- The message keeps the wording someone posts by hand today: *"Current progress: 98 of 170 daily tasks and 13 of 80
  weekly tasks have been completed. As you complete your tasks, remember to check them off."* (`buildProgressMessage`).
  No tasks: *"No tasks on the board yet."*
- **Copy message** copies it. **Post to Chat** (Admin) asks first ("Post this to the accounting team's Google Chat?"),
  then posts it through the space's incoming webhook.
- **The webhook URL carries a key.** It is `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL`, read only inside
  `postTaskProgress`, and it never appears in a response, an error or the audit row. Unset = 503 and the button is
  disabled with the reason. Google refusing = 502 naming its HTTP status. **No answer within 10 s = 502 that says the
  message may or may not have posted**: check the space before posting again (a timeout is ambiguous, never "failed").
- Every post writes `accounting_scoreboard.tasks_progress_posted` (the message and the counts) to the audit log,
  registered in `src/lib/audit/registry.ts`.
- **Nothing posts on a schedule.** A daily post needs a time from Kane, and a scheduler proven to fire (memory
  `scheduled-deletion-cron-never-ran`). Carla's personal "you still have tasks left" nudge would @mention each person
  and needs their Chat user ids: not built.

## Importing from the sheet

`scripts/import-accounting-scoreboard-tasks.mts --sheet=<id>` (the id is in memory `carla-accounting-scoreboard-sheet`;
the repo is public). Dry by default; `--apply` commits; `--undo` archives every live imported task.

- **The layout** (measured read-only 2026-10-08, 31 person tabs): a header row (row 1, or row 2 on a few tabs) names each
  frequency; a frequency's block runs to the next header; its first column holds the titles, with a TRUE/FALSE checkbox
  on the same row. **The Florida tabs ("FL …") add a weekday column inside the weekly block**: kept as a title prefix
  ("Mon: Send the report"), the way the other tabs already write it ("Tuesday: Send Higlobe"). Columns are found by
  their header text, never by letter (`parseTaskTab`).
- A title with no checkbox beside it is a heading or a note and is **skipped and reported**, never imported. Tasks
  only, never ticks (the sheet's ticks are this week's state).
- **Who a tab belongs to is a map file, never a guess at write time**: `docs/audits/backups/accounting-scoreboard-task-tabs-map.json`
  (gitignored: tab names are people's names), `{ "<tab>": "<work email>" | "skip" }`. The first run drafts it: a tab
  whose name equals exactly one board person's label is proposed, every other tab is null. The dry run prints
  first-name matches as **hints only**. `--apply` refuses while any tab is null or names someone not on the board.
- A task already live on that board (same frequency, same title, any case) is skipped, so a re-run adds nothing twice.
  Imported tasks are `created_by 'sheet-import'`.
- **First dry run, 2026-10-08 (parse only, the table did not exist yet):** 437 tasks in 30 tabs; 12 tabs mapped
  (152 tasks), 18 to map (285 tasks), 0 skipped cells. People not on the board (memory: Shannon, Shayla, Jenn,
  Ainsley, Karen are not on the GML) need Setup → Members first, or "skip".

## Not built

- A scheduled post, the personal nudge, a reorder control (the API takes `sortOrder`; new tasks go last), ticks on
  someone else's behalf, live refresh of the Tasks view (the board's Broadcast refresh is a separate change).

## Deploy notes

- **Migration: PENDING (Kane).** `node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts` (dry run, rolled
  back) passed every check on 2026-10-08, including 2 positive and 17 negative controls and the anon refusal on both
  tables. Then `--apply`, then `--verify`. The board read never touches these tables, so an unapplied migration only
  makes the Tasks view say "not set up yet"; the scoreboard itself is unaffected. Apply it before the push anyway.
- **Env:** `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL` is in `.env.local` (2026-10-08; proven with two manual posts) and in
  `.env.example` with no value. Vercel Production: Kane (he was deploying it on 2026-10-08).
- **Import:** after the migration, fill the 18 null tabs in the map, dry-run, then `--apply` on Kane's go.
- **Verified:** 18 task tests + 5 import tests; the scoreboard suite 227/227 and `npm test` 6,402/6,402 before the import
  module; `tsc` clean apart from two stale `.next/types/validator.ts` entries for another feature's routes. **Not
  rendered in a browser and not clicked through signed in.**
