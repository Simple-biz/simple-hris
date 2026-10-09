# Accounting Scoreboard Scheduled Posts — the Chat posts that go out on their own, and the Setup area that edits them

Setup → **Scheduled Posts** on the Accounting Scoreboard lists every progress message the scoreboard posts to the
accounting team's Google Chat on a schedule: when it goes out (US Eastern), what it counts, and its words, with a
preview on today's counts. An Admin edits, pauses, removes and adds them; an Assistant sees them read-only. Under them,
the recent posts and what happened to each. Built 2026-10-09 (session `f4065d68`, Open item 430) on Kane's *"Add a new
tab under - Setup - label it "Scheduled Posts" where I can see all the scheduled posts and that I can edit that template
and add a new one as well"*. Until then the schedule was three constants in code (item 412,
[accounting-scoreboard-tasks.md](accounting-scoreboard-tasks.md) § Scheduled posts); they are now the three seeded rows.

## Key files

| Piece | File |
| --- | --- |
| Table, guards, seed, the posts table widened | `references/sql/create/2026-10-09_accounting_scoreboard_chat_schedules.sql` |
| Apply / verify (dry by default) | `scripts/apply-accounting-scoreboard-chat-schedules-migration.mts` |
| When a post goes out (pure) | `src/lib/accounting-scoreboard/chat-schedule.ts` (+ `.test.ts`, which also checks `vercel.json`) |
| The words: `{progress}` (pure) | `src/lib/accounting-scoreboard/chat-template.ts` (+ `.test.ts`) · `progressPhrase` in `chat-summary.ts` |
| What may be saved (pure) | `src/lib/accounting-scoreboard/chat-schedule-input.ts` (+ `.test.ts`, with the route and server source pins) |
| Claim → word → post → stamp (pure, effects injected) | `src/lib/accounting-scoreboard/scheduled-chat-core.ts` (+ `.test.ts`) |
| The cron's wiring | `src/lib/accounting-scoreboard/scheduled-chat.ts` · `app/api/cron/accounting-scoreboard-chat/route.ts` · `vercel.json` (24 entries) |
| The area's reads and writes, the cron's reads | `src/lib/accounting-scoreboard/chat-schedules-server.ts` (its own file, like `archive-server.ts`) |
| Route | `app/api/accounting-scoreboard/chat-schedules/route.ts` (GET · POST · PATCH · DELETE `?id=` archives) |
| Browser cache | `src/lib/accounting-scoreboard/chat-schedules-cache.ts` (`acct-sb:chat-schedules`) |
| UI | `src/components/accounting-scoreboard/ChatSchedulesArea.tsx`, mounted by `SetupPanel.tsx` as the **Scheduled Posts** area |

## Who sees it

- **Read like the rest of Setup, changed like it**: GET asks `resolveAccess('view_setup')` (Admins and Assistants);
  POST, PATCH and DELETE ask `edit_setup` (Admins). The area sits inside Setup's disabled fieldset for an Assistant and
  shows no switch, pencil, remove or New button. `chat-schedule-input.test.ts` pins every handler's gate.
- Not Admin-only like Keys: the posts go to the team's own Chat, and an Assistant already sees the counts (Everyone view).
  To make it Admin-only, change GET to `edit_setup` and the area's entry in `ADMIN_AREAS`.

## What a post is

`accounting_scoreboard_chat_schedules`, one row per post:

| Field | Rule |
| --- | --- |
| Name | 1–60 characters, trimmed, unique among live posts whatever the case (409 `post_exists`) |
| When | `every_day`, or `weekdays` (some of Sun…Sat), or `month_days` (some of 1–31), at a whole Eastern hour 0–23 |
| Counts | one or more of daily, weekly, bi-weekly, monthly, bimonthly, quarterly, annually. **Never as-needed** (never counted) |
| Message | the template, 1–1,000 characters, with `{progress}` (§ The words) |
| Paused | a paused post never goes out |

- **A month day past the month's end posts on the month's last day**: the 30th is the 28th (or 29th) in February, the
  31st is the 30th in April. Several such days fold into one post that day.
- The seeded rows are Carla's schedule, word for word: **Daily** every day at 3 PM (daily), **Weekly** Wednesday and
  Friday at 9 AM (weekly), **Monthly** the 1st and 30th at 9 AM (monthly). Seeded only into an empty table, so a re-run
  never re-adds a post an Admin removed.

## The words

- **One placeholder, `{progress}`**: the counts in words, *"49 of 97 weekly tasks"*, or *"98 of 170 daily tasks and 13 of
  80 weekly tasks"* (`progressPhrase`, the click's own wording). It may appear more than once, or not at all.
- **Any other `{…}` is refused** when saved, and the editor shows why as you type: *"{progres} isn't a placeholder. The
  only one is {progress}."* A typo would otherwise reach the team's Chat as written.
- The seeded template renders **exactly** `buildProgressMessage` (pinned in `chat-template.test.ts`), so the posts read as
  they did before templates existed.
- **The bars card goes under the message either way**, drawn from the counts (`buildProgressPost(progress, now, text)`).
  The card's look is the click's and did not change.
- **The Admin's Post to Chat click and Copy message are NOT templated**: they keep `buildProgressMessage`. Templates are
  the schedule's.

## When a post goes out

- **Posts due at the same Eastern hour are ONE slot and go out as ONE message** (`slotsOn`). This generalises the 10-08
  rule that a Wednesday or Friday that is also the 1st or the 30th posts one message carrying weekly and monthly. Posts
  with the **same words share one sentence** over all their counts, so Friday 10-30 at 9 AM still reads *"13 of 80 weekly
  tasks and 5 of 40 monthly tasks have been completed…"*. Different words are separate paragraphs, in the order the posts
  were created. Each post counts only its own frequencies; the card draws every count in the message.
- **A post whose frequencies have no tasks says nothing**; a slot where none has anything is `skipped` (nothing sent).
- **A post never goes out late on the day it was created, retimed or resumed.** `timing_changed_at` is stamped by the
  table's trigger (the real moment, `clock_timestamp()`, never a value the app sends) on insert and whenever the hour, the
  days or the pause change. A slot whose hour had already begun by then is not that post's: created or resumed at 9:15, a
  9 AM post goes out next time, not at 10:00 on the cron's second call. Editing only the name, the counts or the words
  never moves it, so a fix to the words at 2:55 PM still posts at 3 PM.
- **At most once per post per Eastern day** (`withoutPostedToday`): a post that went out at 9 AM and was moved to 3 PM
  the same day is dropped from the 3 PM slot. A repeat call of the SAME slot is left to the claim (`already_claimed`).
- The 2 AM hour does not exist on the spring-forward day, so a 2 AM post skips that one day.

### How it fires: Vercel cron at every UTC hour

- `vercel.json` calls `GET /api/cron/accounting-scoreboard-chat` **once a day at each of the 24 UTC hours** (each entry is
  `0 H * * *`, so a Hobby plan accepts it; Vercel allows 100 cron jobs per project). Until 2026-10-09 it was 13, 14, 19
  and 20 UTC, enough only for 9 AM and 3 PM. A call outside every slot's window reads the posts table and does nothing.
- **A slot is due for 2 hours from its hour** (`SLOT_WINDOW_HOURS`): Hobby lands anywhere in the hour, and the next hour's
  call is a second chance. `chat-schedule.test.ts` walks three years and proves every Eastern hour of every day is reached
  on time and 59 minutes late, in EDT and EST. **Removing an entry fails that test.**
- Auth, the claim, the stamp, the one sender, the 503 / 502 answers and the audit action are unchanged
  ([accounting-scoreboard-tasks.md](accounting-scoreboard-tasks.md) § One claim per slot, § One sender). The claim is
  still unique per (Eastern date, hour) and now names the posts it carries (`schedule_ids`); the audit row's details add
  `posts` (their names).

## Editing (the area)

- Each post is a card: name, when (*"Wednesday and Friday at 9:00 AM ET"*, `describeWhen`), what it counts, the next time
  it goes out, the last time it did and how, and its message rendered on today's counts. A paused post has a dashed edge
  and says Paused.
- **The switch pauses and resumes** (`PATCH { id, paused }` and nothing else). **The pencil opens the editor**: name,
  Every day / Days of the week / Days of the month (chips), the hour, the counts (chips), the message with *Insert
  {progress}* at the cursor and a 1,000-character count, a live preview, and the reason Save is disabled. A change of time
  or days says *"The new time counts from the next hour. If this post already went out today, it won't go out again
  today."* **New scheduled post** opens the same editor (Friday 9 AM, weekly, the seeded words).
- **A PATCH is a whole definition or a pause, never half**: `{ id, template }` alone is refused, so a stale editor can never
  merge into a newer one field by field. Two Admins saving the same post: the last save wins, and both are audited.
- **Remove asks Remove / Keep**, then archives: the post never goes out again and is final (the trigger refuses any later
  edit). Recent posts still name it. A new post may take its name.
- **Nothing is deleted** (the board's rule since item 410): the trigger refuses DELETE, a row created archived, an edit
  without who and when, a change to who created it, and an archive that changes anything else. 22 negative controls.
- **Every change is audited** as `accounting_scoreboard.chat_schedule_created / _updated / _paused / _resumed / _removed`
  (`resource_id` = the post), with the whole definition on create and remove and `{ field: { from, to } }` on an edit.
  A save that changes nothing writes nothing.
- **Recent posts**: the newest 30 claimed slots (`RECENT_POSTS_SHOWN`, an explicit limit, not a whole-table read): when,
  the posts' names (the two rows from before this area carry no names, so they show what they counted), the outcome
  (*posted*, *skipped (no tasks)*, *refused by Google*, *couldn't reach Google*, *may or may not have posted* for a
  timeout or a row left at `sending`, *failed*), the message and Google's reason.
- **Cached** as `acct-sb:chat-schedules` on the board's envelope, minus the viewer, painted only for a role with
  `view_setup` NOW; every visit fetches again; a 401 / 403 forgets it. Its key lives in its own module, not in
  `SCOREBOARD_CACHE_KEYS`. With nothing painted, `LoadingLines` names the three reads GET makes.
- Today's counts in the preview come from `readTasks(viewer, { kind: 'all' })`, the Everyone view. If that read fails the
  area still loads, says so in an amber note, and previews on sample numbers.

## Not part of the board

- `readBoard` never reads these tables; no write here announces on the live channel (`live.test.ts` lists
  `chat-schedules/` in `NOT_THE_BOARD`). `chat-schedules-server.ts` never reads the webhook env and never calls `fetch`
  (pinned): only `postTaskProgress` and `scheduled-chat.ts` send.

## Not built

- A "send a test now" button (it would post to the real space), minutes (Vercel Hobby fires within the hour anyway),
  per-person @mentions (the personal nudge needs Chat user ids), and templating the click.

## Deploy notes

1. **Migration: APPLIED 2026-10-09 13:23Z** on Kane's *"run the migration for me go"*, `--verify` passes every check (52),
   the three posts read back live (`created_by 'migration'`, `timing_changed_at` 13:23Z, so today's 3 PM daily still
   posts). The dry run on production passed first (every object, 8 positive and 22 negative controls, rolled back). It
   changed no existing row: the 10-08 and 10-09 posts keep `schedule_ids` NULL. The code that was live keeps posting under
   it (its claims are still valid), so applying before the push changed nothing that was running.
2. **The push: done, measured 2026-10-09** (on `origin/main` since 2026-10-09 09:33 EDT, push `c7659cea`; the deploy is not measured from here). It deploys the area, the cron reading the table, and the 24 `vercel.json` entries. Pushed
   without the migration, every slot would answer 503 "not set up" and post nothing; the migration is already in.
3. **After the deploy: PENDING.** Watch the next slot (3 PM ET daily) in the space, then its row in
   `accounting_scoreboard_chat_posts`: `status = 'posted'` and `schedule_ids` holding the Daily post's id.
4. **To stop every scheduled post:** pause each in Setup → Scheduled Posts (no deploy). To stop the cron itself, remove the
   24 `accounting-scoreboard-chat` entries from `vercel.json` and redeploy. **Not** Vercel → Settings → Cron Jobs →
   Disable: that switches off every cron, the deletion reaper and the transfer applier included.
5. **Verified 2026-10-09:** 38 tests across the schedule, template, input (with the source pins) and core files; the scoreboard,
   auth and audit suites 466/466; `npm test` 6,653/6,653; `tsc` clean apart from the two stale `.next/types/validator.ts`
   entries and another session's in-progress `history.ts`. **Rendered** in headless Chromium on the real
   `ChatSchedulesArea` with a mocked API and fictional posts: the list light and dark, the editor (month days, the
   retime note, the disabled Save), a refused `{progres}`, the New form in a 390 px frame with no sideways scroll, and the
   Assistant's read-only view. **Not clicked through signed in, and not watched posting from the deployed cron yet.**
