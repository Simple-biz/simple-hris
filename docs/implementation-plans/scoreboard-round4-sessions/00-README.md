# Scoreboard round 4: one session per task

Each `task-NN-*.md` file here is the **first message of a fresh Claude Code session** in `simple-hris`. Paste the whole
file. The spec is [the plan](../implementation-plan-scoreboard-round4-and-oct7-asks.md), and the source is
[the Oct 7 meeting](../../meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md). Open items 391–398 are in
`docs/audits/audit-2026-09-29-session-log.md`.

## Two lanes, because the checkout is shared

**Lane A (scoreboard): one session at a time, in this order.** Every scoreboard task edits the same files (`server.ts`,
`types.ts`, `validate.ts`, `SetupPanel.tsx`, `ScoreboardApp.tsx`, the feature doc). Two at once means one session's
commit sweeps in the other's half-finished edits. Start the next lane-A file only after the previous one is committed.

| Order | File | Can start | Kane after it |
|---|---|---|---|
| 1 | `task-01-hide-from-overview.md` | now | apply migration → push |
| 2 | `task-02-streak-pills.md` | after 1 is committed | push |
| 3 | `task-03-chargebacks-signs-net.md` | after 2 | apply migration → push |
| 4 | `task-04-roles.md` | after 3, **and W0.6** (second Admin) for the apply | apply migration → push |
| 5 | `task-05-weekly-lock.md` | after 4 is **applied** | apply migration → push |
| 6 | `task-06-sales-timing-log.md` | after 5 is **applied**; apply on a weekend | apply (Sat/Sun) → push before Monday |
| 7 | ~~`task-07-task-boards.md`~~ **BUILT 2026-10-08 (session `39022c5c`), do not paste** | — | apply the tasks migration → fill the import map → import `--apply` → push |
| 8 | ~~`task-08-progress-message.md`~~ **BUILT 2026-10-08 with Task 7, do not paste** | — | (same push) |
| any | `task-09-old-grid-problems.md` | **W0.2 ruled (a)**: in the next free lane-A slot, never alongside another lane-A session | run the clear script `--apply`, then the team re-logs |
| any | `task-10-compliance-portal.md` | only after **W0.7** (Kentshin's endpoint) | push |

**Lane B (not the scoreboard): may run alongside lane A, one session per file.**

| File | Can start |
|---|---|
| `task-11-job-portal-probe.md` | now (you run the probe it writes) |
| `task-12-interns-measure-and-label.md` | now (measure + label only); the money part is on **HOLD** (Kane) until Ralph |
| `task-14-arriola-revert-and-stamp.md` | now (**384 ruled (a)**) |
| `task-13-queue-return-notification.md` | now |

## Wave 0: what only you can give (from the plan § 1)

- [x] W0.1 Pre-arb in the win ratio: **RULED (a), counts as a loss** (Kane, 2026-10-07; on Open item 392).
- [x] W0.2 Monday's untyped Payroll Problems: **RULED (a), a script clears them and the team re-logs** (Kane, 2026-10-07;
  on Open item 391).
- [x] W0.4 The Google Chat webhook URL: **set in `.env.local` 2026-10-08** as `ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL`
  (the accounting team space, avatar = the HRIS favicon). **Vercel Production: still Kane.**
- [ ] W0.5 Joana's sales sheet link (Carla).
- [x] W0.6 The second Admin's work email: **`claire@simple.biz`** (Kane, 2026-10-08). The roles migration was APPLIED that day.
- [ ] W0.7 Kentshin builds the endpoint in plan Task 10.
- [ ] W0.8 Ralph answers on interns' hours over 5, the monthly payout and the PAB. **Kane: HOLD** (2026-10-07) until then.
- [ ] W0.9 Run the probe from session 11.

Also ruled 2026-10-07: the HRIS `accounting` role change in Task 4 is **CONFIRMED**, and the Arriola ghost row (item 384)
is **(a) revert + stamp** (`task-14`). The 09-20 ₱750 on the ghost key is still yours to rule.

## Every session follows the same rules

They are repeated in each file so each paste stands alone: Step 0 reads the code before anything else, nothing is
applied without your go, migration before push, no push ever, commit by explicit path, doc + INDEX + memory + the Open
items row in the same commit, and a short reply that ends with your next steps in order.
