# Accounting Scoreboard: scheduled progress posts to Google Chat — build record

> Executed on 2026-10-08 through the `blueprint` skill. The source is Carla's schedule, relayed by Kane the same day:
> *"Daily: Every day around 3:00 PM · Weekly: Twice a week, ideally Wednesday and Friday mornings · Monthly: On the 1st
> and 30th of each month · The other task don't need to be posted since they are mainly Claire and I task."*
> The governing doc is [accounting-scoreboard-tasks.md](../../features/accounting-scoreboard-tasks.md) § Scheduled posts.

**Goal:** the team progress message posts itself to the accounting team's Google Chat on Carla's schedule. Until today
an Admin had to click Post to Chat. The doc held the schedule back for two reasons: it needed a time from Kane, and a
scheduler proven to fire. Both are now met. Carla gave the times, and both existing Vercel crons are measured to have
fired every day since 2026-10-03 / 10-05.

## Tasks

- [x] **1. Data.** `references/sql/create/2026-10-08_accounting_scoreboard_chat_posts.sql`: one row per scheduled
  post, unique by (Eastern date, hour), inserted as the CLAIM before anything is sent, then stamped with its outcome
  once. Never deleted. Service role only. `scripts/apply-accounting-scoreboard-chat-posts-migration.mts` (dry by
  default, `--apply`, `--verify`). Dry run 2026-10-08: 16 object/privilege checks, anon refused, 7 positive and
  13 negative controls, all PASS, rolled back.
- [x] **2. Schedule (pure) + tests.** `src/lib/accounting-scoreboard/chat-schedule.ts`: the Eastern clock, which posts
  fall on a date, and which are due at an instant (a 2-hour window after the slot time). Tests cover DST on both sides,
  February, the 30th of a 31-day month, a Wed/Fri that is also the 1st or the 30th, weekends, and the window edges.
- [x] **3. Server.** *Changed from the brief:* `server.ts` is untouched. Another session had it mid-edit (the
  change-frequency feature), and committing it by path would have swept that work into this commit. Instead:
  `scheduled-chat-core.ts` (pure; claim → read → filter to the slot's frequencies → post → stamp once → audit a real
  post; effects injected, 10 tests) and `scheduled-chat.ts` (the wiring). The counts come from the existing
  `readTasks(…, { kind: 'all' })`, read as an Assistant, so they match the click. The send is a second copy of the
  click's (same timeout, same timeout wording), and the feature doc names both. A post writes the same audit action
  with `trigger: 'schedule'`.
- [x] **4. Route.** `app/api/cron/accounting-scoreboard-chat/route.ts`: GET (what Vercel sends) and POST, Bearer
  `CRON_SECRET` only.
- [x] **5. Scheduler.** `vercel.json`: the route at 13:00, 14:00, 19:00 and 20:00 UTC, each once a day. The route
  works out from the Eastern clock which entry is the real 9 AM / 3 PM.
- [x] **6. Docs.** Feature doc § Scheduled posts, the INDEX row, the audit registry note, memory.
- [ ] **7. PENDING (Kane):** migration `--apply` → `--verify` → push (deploys the vercel.json entries) → watch the
  space at 3:00 PM ET, then check the row in `accounting_scoreboard_chat_posts`.
