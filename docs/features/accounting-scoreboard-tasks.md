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
| The progress message and its bars card (pure) | `src/lib/accounting-scoreboard/chat-summary.ts` (+ `.test.ts`) |
| The ONE Chat sender (the click and the schedule) | `src/lib/accounting-scoreboard/chat-webhook.ts` (+ `.test.ts`, which also pins that nothing else calls `fetch` for it) |
| Request parsing | `src/lib/accounting-scoreboard/validate.ts` § Task boards (+ `tasks-validate.test.ts`) |
| Reads, writes, the Chat post | `src/lib/accounting-scoreboard/server.ts` § Task boards |
| Routes | `app/api/accounting-scoreboard/tasks/route.ts` (GET, `&stream=1` streams it for the loading card · POST / PATCH) · `tasks/checks/route.ts` (POST) · `tasks/frequency/route.ts` (POST, change how often) · `tasks/order/route.ts` (POST, rearrange a card) · `tasks/post-progress/route.ts` (POST) |
| Loading card: the lines ↔ the reads, the reporter, the fail-closed stream assembler (pure) | `src/lib/accounting-scoreboard/task-load-progress.ts` (+ `.test.ts`), on `src/lib/refresh-progress/refresh-progress.ts` · the card `src/components/accounting-scoreboard/TasksLoadCard.tsx` |
| Rearranging a card: the whole card or nothing (pure) | `src/lib/accounting-scoreboard/task-order.ts` (+ `.test.ts`) · `setTaskOrder` in `server.ts` · the grips in `TasksPanel.tsx` (`TaskList`, `SortableTaskRow`) |
| Changing how often: add, then archive, then undo on failure (pure) | `changeFrequencyInOrder` in `src/lib/accounting-scoreboard/tasks.ts` (+ `tasks.test.ts`) |
| Browser cache: one key per view, never the viewer | `src/lib/accounting-scoreboard/tab-cache.ts` (+ `tab-cache.test.ts`) |
| UI | `src/components/accounting-scoreboard/TasksPanel.tsx` (the boards, the edit form, the skeletons); the switch and the picked view in `ScoreboardApp.tsx` |
| Scheduled posts: when (pure) | `src/lib/accounting-scoreboard/chat-schedule.ts` (+ `.test.ts`, which also checks `vercel.json`) |
| Scheduled posts: claim → post → stamp (pure, effects injected) | `src/lib/accounting-scoreboard/scheduled-chat-core.ts` (+ `.test.ts`) |
| Scheduled posts: the wiring, the cron route, the schedule | `src/lib/accounting-scoreboard/scheduled-chat.ts` · `app/api/cron/accounting-scoreboard-chat/route.ts` · `vercel.json` |
| Scheduled posts: table + apply / verify | `references/sql/create/2026-10-08_accounting_scoreboard_chat_posts.sql` · `scripts/apply-accounting-scoreboard-chat-posts-migration.mts` |
| Sheet import | `scripts/import-accounting-scoreboard-tasks.mts` + `src/lib/accounting-scoreboard/task-import.ts` (+ `.test.ts`) |
| Wire types | `src/lib/accounting-scoreboard/types.ts` (`TasksPayload`, `BoardTask`, `TaskCheck`, `TaskPerson`) |

## Who sees and does what (the board's roles, `roles.ts`)

| | Team member | Assistant | Admin |
|---|---|---|---|
| Own board, tick own tasks | yes | yes | yes |
| Rearrange own tasks (within a card) | yes | yes | yes |
| Rearrange someone else's tasks | no | no | yes (`manage_tasks`) |
| See a person's board, or Everyone | no | yes (`view_all_tasks`) | yes |
| Add, rename, change how often, remove tasks | no | no | yes (`manage_tasks`) |
| Untick someone else's task | no | no | yes |
| Copy message | no | yes | yes |
| Post to Chat | no | no | yes |

- **Only the owner ticks a task.** An Admin may untick anyone's (a wrong tick), never tick for them: a tick says who
  did the work. This is the Payment Verified pattern.
- **Everyone rearranges their own list** (Aliviah, relayed by Kane 2026-10-08: *"each user could rearrange their task
  list"*). Until then only an Admin could reorder: a default CHOSEN in the round-4 plan (Task 7, "confirmable"), now
  changed. Adding, renaming, changing how often and removing stay Admin-only. § Rearranging a list.

## Rearranging a list

- **A grip on each row** of a board the viewer may rearrange: their own (by any of their addresses), or any board for
  an Admin. An Assistant looking at someone else's board sees no grips. Drag by the grip (a click on it does nothing:
  5 px of travel starts a drag, the tickets board's rule), or with the keyboard: focus the grip, **Space**, the up and
  down arrows, **Space** to drop, **Escape** to cancel. Screen readers hear the task's title and its place ("3 of 16").
- **A task moves only within its card.** Moving it to another frequency is changing how often, which makes a new task
  (§ Tasks and ticks are history). Each card is its own drag area, and the server refuses a list that mixes cards or
  people.
- **The order is the owner's list**, stored on each task (`sort_order`), so an Admin looking at that board sees the same
  order. It is not a private view per viewer.
- **A new order is the whole card or nothing** (`task-order.ts`, `POST /tasks/order { ids }`). The request lists every
  live task of that card, each once. A list that misses one (it was added since the page loaded) or names one that was
  removed is refused **409, "This list changed since it was loaded. Refresh and try again."**, never applied in part,
  so no task drops out of the order. The page moves the rows at once and puts them back if the server refuses.
- It writes `sort_order` 0, 1, 2… down the card, only on the rows that move. New tasks still go last (`createTask`
  takes the owner's highest `sort_order` + 1). The writes are not one transaction: if one fails part way the answer is
  409 `partly_saved` and a refresh shows the order as saved. An order is not money and not history, so it is not
  audited and its past orders are not kept (the histogram rule above is about tasks and ticks).
- `PATCH /tasks { sortOrder }` is still Admin-only and still accepted. The board does not use it.
- The route is the board's: `resolveAccess` on every request, and the Tasks view reads its own route
  (`GET /api/accounting-scoreboard/tasks`), **never the board payload**. Nothing about tasks is in `readBoard`, its
  progress lines or the board's cached blob: the Tasks view has cache keys of its own (§ Loading and the browser
  cache). The viewer's role is resolved per request and never cached.
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

### Changing how often (2026-10-08)

Kane, 2026-10-08: *"the tasks edit button can also edit the frequency like we can change the daily weekly biweekly and
all that"*. The pencil on a task (Admin) opens one form with the title **and How often**.

- **A new frequency is a new task, never an in-place edit** (the rule above, the table's trigger and
  `tasks-validate.test.ts`, which pins that PATCH refuses `frequency`, all stand). Saving with a different frequency
  calls `POST /tasks/frequency`: the server **adds** a task with the same owner, the new frequency and the title (or the
  new one, in the same save), last on the owner's list like any new task, then **archives** the old one.
- **The old task keeps its ticks, and the new one starts unticked.** A weekly task ticked on Monday and made daily on
  Tuesday shows Tuesday as not done. The form says so before saving: *"Saving makes this a new weekly task and archives
  this one. Ticks stay with the old task, so the new one starts unticked."* Made as-needed, it adds that as-needed tasks
  are never ticked or counted.
- **Order is the guard** (`changeFrequencyInOrder`, `tasks.test.ts`), because the two writes cannot share a transaction
  over PostgREST. Add first: a failed add changes nothing. Then archive: if that fails (or someone removed the task
  meanwhile), the new task is archived again, so the change never leaves the task on the board twice, and the old one is
  still live. If that undo fails too, the answer is 500 `on_board_twice` and says to refresh and remove one, never a
  plain "failed". Archive-first was rejected: a failed add would take the task off the board for good, because
  archived is final.
- The same frequency is 422 `same_frequency` (the form renames in place instead). The owner never changes here either
  (400). The owner must still be one of the board's people, as for Add.
- A title alone is still renamed in place (`PATCH`), and keeps its ticks.
- Like Add, it does not refuse a title that is already live at the new frequency.

## Loading and the browser cache (2026-10-08)

Kane, 2026-10-08: *"Scoreboard Accounting - Please enhance skeleton loading on the table and store cache data"*. Before
this, the panel unmounted on every Scoreboard → Tasks switch, so every switch and every person picked showed
*"Loading tasks…"* with a spinner and waited for the server.

- **A view is cached in `sessionStorage`** under its own key, `acct-sb:tasks:<view>` (`me`, `all`, or a person's work
  email), on the board's envelope (`tab-cache.ts`: bound to the viewer, 12 h ceiling, a different viewer purges first).
  The **8** most recently written views are kept. Tasks are never inside a board blob.
- **The board's rules, unchanged** (accounting-scoreboard.md § Browser cache): a cached view **paints, it never decides**.
  Every open, switch back and person picked fetches again, silently, and the server's answer replaces it. **Only the
  server's answer is written back** (and edits made on top of it), never the seed. The seed runs in a layout effect,
  before the browser paints. **The viewer is never cached**: it comes from the page on every load.
- **Two guards of its own**, because a task view is both a permission and a period (`readCachedTasks`, pinned in
  `tab-cache.test.ts`):
  - **Someone else's board, or Everyone, paints only for a role that may see it now** (`view_all_tasks`, from the role the
    page just resolved). An Assistant demoted to Team member never sees a cached Everyone, even for a frame. A 401 or 403
    from the server forgets that view and takes it off the screen.
  - **A view paints only on the Eastern day it was read.** A tick counts for its period, so yesterday's daily ticks would
    paint as done today. A view from another day is a miss, and the skeleton shows instead.
  - A blob filed under the wrong view (my key holding someone else's board) is refused.
- **The picked view lives in `ScoreboardApp`**, so Scoreboard → Tasks lands on the board you left, painted at once.
- **Skeleton, never a spinner** (`ui-standards.md` § 12.3): a view with nothing of it on screen shows a skeleton **shaped
  like what arrives**, on the same cards. *My tasks* or a person: the Add form (Admins), then frequency cards of task rows,
  at the board's own heights (header 37 px, an Admin's row 45 px). *Everyone*: the progress message card, then the table
  (`table-keep`). The heading already names the view picked, the previous person's board is never shown under the new
  name, and the picker keeps its list. The skeleton is `aria-busy`; the card over it does the talking. The shimmer goes
  still under reduced motion. **A refetch never re-skeletons**: revalidating a painted view is silent, and only a Refresh
  click spins its button. A failed refresh keeps the view on screen under *"Couldn't refresh (…). You're seeing these
  tasks as of the last good load."*
- **Over the skeleton, the loading card** (Kane, 2026-10-08: *"on top of the skeleton lets add the modal loading similar to
  HRIS - NPD"*; `TasksLoadCard`): NPD's card (npd-dashboard.md § Loading a sheet) in the board's orange, on the shared
  step model the board's own modal uses. **Only a read with a skeleton under it has a card**: a board painted from the
  cache, the silent revalidation and a Refresh click have none. One per board picked: picking another board cancels the
  read and its card.
  - **Every line is a real read** (`task-load-progress.ts`). *Checking you're on the scoreboard* is done when the route
    answers: the member check and who may see that board are settled **before** the stream starts, so a refusal is still a
    plain 401 / 403 / 400. Then `GET /tasks?person=…&stream=1` (NDJSON) sends a line the moment each of `readTasks`' three
    reads answers, saying what came back: *Found 14 people on the board* · *Read 23 tasks* · *4 tasks ticked this period*
    (the ticks line also waits for the tasks, because a tick is matched to its task's period before it counts). Then the
    view, or an `error` line naming whose read failed. The three reads run **side by side** (they never depended on each
    other; until 2026-10-08 they ran one after another), so the lines tick in the order they really answer.
  - **No percentage is printed**; the bar **never moves backwards**; it is **full and green only once the tasks are
    painted** (two animation frames; a timer in a hidden tab). *Your tasks are ready* holds 450 ms, then the card fades
    (300 ms) and goes.
  - **Assembled fail-closed** (`createTasksStreamAssembler`): a stream that stops early, a line it cannot read, an unknown
    line, a view that is not the board asked for (Blake's board never paints as mine), or anything after the view is a
    failed load, never a partial board.
  - **A failure** holds the card red where it stopped, marking **only the failed read's line** (a read beside it that
    answered stays done). The amber box above carries the server's sentence and *Try again*, and no skeleton is left
    promising an arrival. *Try again* is a new read: the box goes, and the skeleton and a new card come back.
  - **It never blocks**: the card is absolute and `pointer-events: none`, so the picker and Refresh stay usable under it.
    It announces each line (`aria-live`) and is a `progressbar` whose value text is the current line. Reduced motion: the
    fill steps, nothing sweeps or fades.
  - `readTasks` reports as `lines`, never `progress`: the board's own pin (`load-progress.test.ts`) reads every
    `progress?.done(` in `server.ts` as a board read.
- **Verified 2026-10-08** in headless Chromium on the real `ScoreboardApp` with a mocked API and **synthetic** tasks
  (fictional people, a 1.5 s read), **64 scripted checks** at 1360 px light and dark and 390 px: the skeleton on first open
  with no spinner; tasks painted at once on switching back, with the fetch still made and no spinner; the Everyone table
  skeleton under the right heading, with the previous board not shown; My tasks instant from the cache; the How often
  picker, its note, the POST body, the task under its new frequency and the counts; a rename as a PATCH; a reload painting
  from the cache with the edits and no viewer or role in the blob; no page-wide horizontal scroll; no console errors; the
  shimmer still under reduced motion. **Not clicked through signed in.**
- **The loading card, verified 2026-10-08:** 11 tests in `task-load-progress.test.ts` (the plan, the sentences, the
  reporter, fail-closed assembly, and source pins: every line reported in `readTasks`, the route refusing before it
  streams). The same headless harness, now **110 checks**: the card over the skeleton on first open, titled *Loading your
  tasks*; *You're on the scoreboard* once the route answered; the lines in the order the reads answered; each done line's
  sentence; no `%`; the fill never backwards, never full before the tasks were painted, green *ready* only with them on
  screen, then gone; no card for a cached board, a silent revalidation (plain JSON, not the stream) or a Refresh click;
  Everyone's own card over its table skeleton, and clicks passing through it; a failed ticks read holding red with only
  that line marked, the box with *Try again*, no skeleton, then *Try again* bringing a new card and the board; the fill
  not animating under reduced motion. **Not clicked through signed in, and not watched streaming through Vercel.**

## The Everyone view and the progress message

- One row per person with live counted tasks: done / total per frequency (green when all done, red when none, amber in
  between). A name opens that person's board.
- The message keeps the wording someone posts by hand today: *"Current progress: 98 of 170 daily tasks and 13 of 80
  weekly tasks have been completed. As you complete your tasks, remember to check them off."* (`buildProgressMessage`).
  No tasks: *"No tasks on the board yet."*
- **Copy message** copies it. **Post to Chat** (Admin) asks first ("Post this to the accounting team's Google Chat?"),
  then posts it through the space's incoming webhook.
- **The Chat post is the sentence plus a card of bars** (Kane, 2026-10-08: *"Can we send a progress bar?"*;
  `buildProgressPost`). Google Chat shows neither an HTML page nor a GIF sent through a webhook, but a card's text takes
  `<font color>`. So each frequency gets one row: its name, a 20-cell bar of `█` (the done cells in one colour, grey
  for the rest) and *"98 of 170 done · 57%"*. The card's header is *"Task progress"* and the Eastern day and
  time the counts were read. The sentence stays as the message text above the card, word for word. **Copy message
  stays the sentence alone.** No tasks = the sentence alone, no card.
  - **A bar is full only when every task is done, and the percent rounds DOWN** (`barCells`, `percentDone`): 169 of 170
    is 19 cells and 99%, and 1 of 170 still shows 1 cell. Rounding never makes a frequency look finished, or untouched.
  - **The colour goes red → orange → green as the goal nears** (Kane, 2026-10-08: *"as we are reaching the goal we are
    like red orange green"*; `barTier`): **red under 50%, orange from 50%, green from 90%** (the 50 / 90 cut-offs are
    CHOSEN, `ORANGE_FROM_PERCENT` / `GREEN_FROM_PERCENT`). The tier is read off the **printed** percent, so the colour
    and the number never disagree (89.9% prints 89% and stays orange). Green from 90% does not fill the bar: 99% is
    a green bar with one grey cell. One colour per bar. Until this rule, the bar was amber for any partial and green
    only when all done. The Everyone view's colours (above) are a separate rule and did not change.
  - **A card Google refuses with HTTP 400 is sent once more as the sentence alone** (`chat-webhook.ts`). A 400 posted
    nothing, so this can never post twice. Google does not document cards on incoming webhooks; this keeps the proven
    text post working if it refuses them. No other status is re-sent, and a timeout never is. The click answers
    `withCard: false`, the audit row says `card: false`, and a scheduled post's row says so in `detail`.
- **The webhook URL carries a key.** It is `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL`, read only inside
  `postTaskProgress` and the scheduled post's `runScheduledChatPosts`, both of which send through `sendChatPost`
  (§ One sender). It never appears in a response, an error, the posts table or the audit row. Unset = 503 and the button is
  disabled with the reason. Google refusing = 502 naming its HTTP status. **No answer within 10 s = 502 that says the
  message may or may not have posted**: check the space before posting again (a timeout is ambiguous, never "failed").
- Every post writes `accounting_scoreboard.tasks_progress_posted` (the message, the counts and `card`, whether the bars
  went with it) to the audit log, registered in `src/lib/audit/registry.ts`. The click answers
  `{ message, postedAt, withCard }`.
- **It also posts itself on Carla's schedule** (2026-10-08): § Scheduled posts below. Carla's personal "you still
  have tasks left" nudge would @mention each person and needs their Chat user ids: not built.

## Scheduled posts

Carla, relayed by Kane 2026-10-08: *"Daily: Every day around 3:00 PM · Weekly: Twice a week, ideally Wednesday and
Friday mornings · Monthly: On the 1st and 30th of each month · The other task don't need to be posted since they are
mainly Claire and I task."* Until then this section was "nothing posts on a schedule", for want of a time and of a
scheduler proven to fire. Both are now met: the times are hers, and the two older Vercel crons have fired every day
since 2026-10-03 (measured in `audit_log` on 2026-10-08).

| Post | When (US Eastern) | Counts |
|---|---|---|
| Daily | every day at 3:00 PM, Saturday and Sunday included | daily tasks |
| Weekly | Wednesday and Friday at 9:00 AM | weekly tasks |
| Monthly | the 1st and the 30th at 9:00 AM; February posts on its last day | monthly tasks |

- **Each post counts only its own frequency.** A Wednesday or Friday that is also the 1st or the 30th posts ONE
  message carrying weekly and monthly. Bi-weekly, bimonthly, quarterly and annual tasks are never posted: they are
  mostly Carla's and Claire's. The wording is `buildProgressMessage`'s, the same as the click.
- **CHOSEN 2026-10-08, each one line in `chat-schedule.ts`:** Eastern time, the board's day, so the 3 PM count is
  today's; "mornings" = 9:00 AM; daily includes weekends ("every day"); the 1st posts the NEW month's count (a kick-off,
  close to 0 done), not a recap of the month that just ended.
- **The counts are the Everyone view's**: `readTasks(…, { kind: 'all' })`, read as an Assistant (the least role that
  sees everyone's tasks). A scheduled post and an Admin's click at the same moment say the same thing.

### How it fires: Vercel cron, at both UTC hours of each slot

- `vercel.json` calls `GET /api/cron/accounting-scoreboard-chat` at **13:00, 14:00, 19:00 and 20:00 UTC**: each
  slot's EDT and EST hour. Vercel cron is UTC-only, so the route reads the Eastern clock (`dueChatSlots`) and does
  nothing outside a slot's window. Each entry runs once a day, so a Hobby plan could not refuse the deploy.
- **A slot is due for 2 hours from its time** (`SLOT_WINDOW_HOURS`). That is wide enough for a cron that lands late
  (Hobby: up to 59 min) and for the second UTC entry, and never wide enough to reach the next slot. A test walks three
  years of days and proves every slot is reached on time and 59 minutes late, on both sides of DST. **Moving an hour
  in `chat-schedule.ts` without `vercel.json` (or the reverse) fails that test.**
- **Auth: `Bearer CRON_SECRET` only.** `proxy.ts` lets `/api/cron/*` past sign-in only with it. There is no signed-in
  trigger: the manual path is the Admin's Post to Chat button.

### One claim per slot: the row comes before the post

`accounting_scoreboard_chat_posts` holds one row per scheduled post, unique by (Eastern date, hour).

- **The row is inserted BEFORE anything is sent.** Vercel can deliver a cron twice, and both UTC entries of a slot can
  land inside its window. The second call finds the slot claimed (`already_claimed`) and sends nothing. **Any other
  claim error posts nothing:** no claim, no post.
- **One attempt per slot.** The outcome is stamped once (`posted`, `skipped`, `refused`, `unreachable`, `timed_out`,
  `failed`); the table's trigger refuses a second stamp. The schedule never retries a failed post (Carla can click Post
  to Chat), and **never retries a timeout, which may have posted.** The one re-send inside an attempt is the bars card
  refused with 400 going again as the sentence alone (a 400 posted nothing). That post is stamped `posted` with *"Sent
  as the sentence alone: Google Chat refused the bars card (HTTP 400)."* as its `detail`.
- `skipped` = no live tasks of that frequency, so nothing was sent. `failed` = the task read failed, nothing was sent.
- **A row left at `sending` is not a bug to clean up.** The function died between the claim and the stamp, so the post
  may or may not have gone out. Check the space.
- Never deleted (the histogram rule above). Service role only. The Admin's click is not recorded here.
- The route answers **200** when nothing was due, or every due post went out, was skipped or was already claimed;
  **502** when a due post did not go out (so Vercel's cron log shows it); **503** when the webhook env or the table is
  missing (nothing claimed, nothing posted).
- A post that went out writes the click's audit action, `accounting_scoreboard.tasks_progress_posted`, as
  `Scoreboard Chat Schedule` / `System`, with `trigger: 'schedule'`, the slot, `card` (did the bars go with it), and
  `resource_id` = the posts row.

### One sender

**Every scoreboard Chat post goes through `sendChatPost` (`chat-webhook.ts`)**, the click (`postTaskProgress`) and the
schedule (`scheduled-chat.ts`) alike: one 10 s timeout, one reading of a timeout ("may or may not have posted"), one
400 rule. The URL is passed in and never appears in an outcome, so it cannot reach a response, an error, the posts
table or the audit row. **Never add a `fetch` to the webhook anywhere else**: `chat-webhook.test.ts` fails if
`server.ts` or `scheduled-chat.ts` gets one. (On 2026-10-08 they were briefly two copies while another session had
`server.ts` mid-edit; folded into one the same day.)

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

- The personal nudge, ticks on someone else's behalf, live refresh of the Tasks view (the board's Broadcast refresh is
  a separate change). (A reorder control was on this list until 2026-10-08: § Rearranging a list.)

## Deploy notes

- **Migration: APPLIED, measured 2026-10-08** (Open item 393: its `--verify` passes, and `0ded334b` is on origin/main).
  `node --import tsx scripts/apply-accounting-scoreboard-tasks-migration.mts` (dry run, rolled back) had passed every
  check that day, including 2 positive and 17 negative controls and the anon refusal on both tables. The board read never
  touches these tables, so an unapplied migration only makes the Tasks view say "not set up yet"; the scoreboard itself
  is unaffected. Re-check any time with `--verify`.
- **Changing how often and the browser cache (2026-10-08): no migration, no env var, no table change.** The new route
  writes only what Add and Remove already write (an insert and the archive stamp). **The push: PENDING** (Kane).
- **The loading card (2026-10-08): no migration, no env var.** `GET /tasks` gains `&stream=1`; without it the answer is
  unchanged (the silent revalidation and a Refresh click read it). The scheduled post calls `readTasks` directly, with no
  `lines`, so its reads now run side by side too and nothing else changes for it. **The push: PENDING** (Kane).
- **Env:** `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL` is in `.env.local` (2026-10-08; proven with two manual posts) and in
  `.env.example` with no value. Vercel Production: Kane (he was deploying it on 2026-10-08).
- **Import: APPLIED 2026-10-08 14:05Z** on Kane's *"Go"* (Open item 393, `0b7d39c9`): 338 tasks on 23 boards. The 7 Florida
  tabs whose people are not on the board are "skip" in the map (99 tasks): add them under Setup → Members, map them, and
  re-run (it skips what is already live).
- **Scheduled posts migration: PENDING (Kane). Apply it BEFORE the push.**
  `node --import tsx scripts/apply-accounting-scoreboard-chat-posts-migration.mts` (dry run, rolled back) passed every
  check on 2026-10-08: 16 object and privilege checks, the anon refusal, 7 positive and 13 negative controls. Then
  `--apply`, then `--verify`. Pushed without it, each due slot answers 503 "not set up" and posts nothing.
- **Scheduled posts go live with the push** (the four `vercel.json` entries deploy with it). No new env:
  `CRON_SECRET` is already set in production (the older crons fire daily) and the webhook env is the click's.
  **PENDING:** watch the space at the first 3:00 PM ET after the deploy, then check its row in
  `accounting_scoreboard_chat_posts` (`status = 'posted'`).
- **To stop the schedule:** remove the four `accounting-scoreboard-chat` entries from `vercel.json` and redeploy.
  **Not** Vercel → Settings → Cron Jobs → Disable: that switches off every cron, the deletion reaper and the transfer
  applier included.
- **Scheduled posts verified (2026-10-08):** 9 schedule tests + 10 claim/post tests; the scoreboard suite 290/290; `tsc`
  clean apart from the same two stale `.next/types/validator.ts` entries. **Not run against Google from the deployed
  cron yet.**
- **Rearranging, verified 2026-10-08:** `task-order.test.ts` 8 tests (the numbering, ties from the import, a stale or
  shrunk list refused whole, a removed task, mixed cards and people, the card read narrowed, the board order) and the
  parser test; scoreboard + audit suites 352/352; `tsc` clean apart from the same two `.next` entries. **PENDING: not
  rendered or dragged in a browser, and not tried signed in** (the page resolves the viewer on the server, so the
  browser-side mocks of the earlier harness cannot sign in). No migration: the table already lets `sort_order` change.
- **The bars card, verified 2026-10-08:** chat-summary 10 tests (cells, percent, colours, heading, the post), the
  sender 10 (every Google answer, the 400 re-send, never the URL, and the source pin), the core 11; the scoreboard and
  audit suites 342/342; `tsc` clean apart from the same two `.next` entries. **PENDING: the first real post.** Google
  does not document cards on incoming webhooks, so whether the bars show (`card: true` in the audit row) or the sentence
  goes alone (`card: false`) is only known from a post. **Red → orange → green, same day:** chat-summary now 11 tests
  (the tier boundaries 49 / 50 / 89 / 90%, 89.9% staying orange, each tier's cells, one colour per bar); the scoreboard
  suite 319/319; `tsc` clean apart from the same two `.next` entries.
- **Verified:** 18 task tests + 5 import tests; the scoreboard suite 227/227 and `npm test` 6,402/6,402 before the import
  module; `tsc` clean apart from two stale `.next/types/validator.ts` entries for another feature's routes. **Not
  rendered in a browser and not clicked through signed in.** Rendered on 2026-10-08 with the frequency change and the cache
  (headless Chromium, synthetic tasks, 64 checks: § Loading and the browser cache); still **not clicked through signed in**.
