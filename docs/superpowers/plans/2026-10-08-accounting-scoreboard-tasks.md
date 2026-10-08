# Accounting Scoreboard Tasks (plan Tasks 7 + 8) — build record

> Executed in session `39022c5c` on 2026-10-08, on Kane's *"Build it now"*, through the `blueprint` skill. The spec is
> Tasks 7 and 8 of [the round-4 plan](../../implementation-plans/implementation-plan-scoreboard-round4-and-oct7-asks.md);
> the source is [the Oct 7 meeting](../../meetings/2026-10-07-carla-alivia-scoreboard-tasks-roles-and-interns.md);
> the governing doc is [accounting-scoreboard-tasks.md](../../features/accounting-scoreboard-tasks.md).

**Goal:** per-person task boards on the Accounting Scoreboard, the Everyone view, and the team progress message (Copy +
Post to Chat), plus an import of the sheet's person tabs.

**Order changed from the round-4 plan, on purpose:** Tasks 7 and 8 ran before Tasks 5 and 6. Their only real
dependency is Task 4's roles (committed and applied 2026-10-08, `a2a95911`). Tasks are never locked, so the weekly lock
(Task 5) does not touch them, and the Sales timing log (Task 6) shares no table with them.

## Tasks

- [x] **1. Data.** `references/sql/create/2026-10-08_accounting_scoreboard_tasks.sql` (tasks + task_checks, append-only
  guards, one live tick per task per period, service role only) and
  `scripts/apply-accounting-scoreboard-tasks-migration.mts`. Dry run 2026-10-08: every check passed (2 positive and 17
  negative controls, anon refused on both tables), rolled back. `--apply` is Kane's.
- [x] **2. Pure modules + tests.** `tasks.ts` (periods, progress, by-owner progress; 9 tests), `chat-summary.ts`
  (4 tests), the parsers in `validate.ts` (`tasks-validate.test.ts`, 5 tests), `task-import.ts` (5 tests).
- [x] **3. Server + routes.** `server.ts` § Task boards (`listTaskPeople`, `readTasks`, `createTask`, `patchTask`,
  `setTaskDone`, `postTaskProgress`); `app/api/accounting-scoreboard/tasks/` (route, `checks/`, `post-progress/`);
  the audit registry entry for `accounting_scoreboard.tasks_progress_posted`.
- [x] **4. UI.** `TasksPanel.tsx` (my board, a person, Everyone; add / rename / remove; ticks; Copy; Post to Chat with a
  confirm step) and the header's Scoreboard | Tasks switch in `ScoreboardApp.tsx` (the week arrows, the section row
  and the burger hide in Tasks).
- [x] **5. Import.** `scripts/import-accounting-scoreboard-tasks.mts` (dry by default; map file in `docs/audits/backups/`;
  `--undo` archives). Parse-only dry run 2026-10-08: 437 tasks in 30 tabs, 12 tabs mapped.
- [x] **6. Verify.** Scoreboard suite and `npm test` green; `tsc` clean apart from the stale `.next` validator pair.
- [ ] **7. PENDING (Kane):** migration `--apply` → map the 18 null tabs → import dry run → `--apply` → push → a signed-in
  click-through (own board, a tick, Everyone, Copy, one Post to Chat while watching the space).
