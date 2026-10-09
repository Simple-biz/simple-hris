# Accounting Scoreboard Setup → Scheduled Posts — build record

> Executed in session `f4065d68` on 2026-10-09, on Kane's *"Add a new tab under - Setup - label it "Scheduled Posts"
> where I can see all the scheduled posts and that I can edit that template and add a new one as well"*, through the
> `blueprint` skill. The governing doc is
> [accounting-scoreboard-scheduled-posts.md](../../features/accounting-scoreboard-scheduled-posts.md).

**Goal:** the three hard-coded Chat posts (daily 3 PM, weekly Wed + Fri 9 AM, monthly 1st + 30th 9 AM, item 412) become
rows an Admin can see, edit (when, what it counts, the words) and add to, without a deploy.

**Measured first (read-only, 2026-10-09):** two rows in `accounting_scoreboard_chat_posts` (10-08 15:00 daily, 10-09
09:00 weekly, both `posted`). Vercel allows 100 cron jobs per project on every plan, Hobby once a day each.

## Tasks

- [ ] **1. SQL + apply script.** `references/sql/create/2026-10-09_accounting_scoreboard_chat_schedules.sql`: the
  schedules table (archive stamp, never deleted; one live name per label), the posts table widened (any counted
  frequency, `schedule_ids`), the three posts seeded with today's wording. `scripts/apply-…-migration.mts`, dry by
  default, `--apply`, `--verify`, positive and negative controls.
- [ ] **2. Pure: the template.** `chat-template.ts`: `{progress}` only, an unknown `{…}` refused; the seeded template
  renders exactly `buildProgressMessage`.
- [ ] **3. Pure: when.** `chat-schedule.ts` reads schedules instead of constants: `postsOn`, `slotsOn`, `dueChatSlots`,
  `nextPostAt`, `describeWhen`; same-hour schedules share ONE slot; a schedule never posts late on the day its timing
  changed. `vercel.json` gets one entry per UTC hour; the drift test proves every hour is reached on time and 59 min late.
- [ ] **4. Core + wiring.** `scheduled-chat-core.ts` renders each schedule's template (same template = one sentence),
  `scheduled-chat.ts` reads live schedules, skips one already posted today, claims with `schedule_ids`.
- [ ] **5. Server + route.** `chat-schedules-server.ts` (read, create, update, archive; audited before → after) and
  `app/api/accounting-scoreboard/chat-schedules/route.ts` (`view_setup` reads, `edit_setup` writes).
- [ ] **6. UI.** `ChatSchedulesArea.tsx` as Setup → **Scheduled Posts**: the posts, an editor (name, days, time,
  counts, words, live preview), Pause, Remove, Add, and the recent posts. Cached as `acct-sb:chat-schedules`.
- [ ] **7. Docs.** Feature doc, INDEX row, the tasks doc's § Scheduled posts pointed at it, memory, audit registry note.
