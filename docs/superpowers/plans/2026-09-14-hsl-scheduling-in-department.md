# HSL Scheduling moves inside the HSL department, and starts saving

Approved by Kane 2026-09-14.

- **Q1 → recommendation taken: relocate AND wire it.** Relocating a panel that
  silently discards every edit into the main department workflow, in front of 591
  unscheduled people, is worse than leaving it where it is.
- **Q2 → HSL only.** It leaves the top-level sidebar entirely.
- **Placement → beside the department search bar**, not with the global inner tabs.
  Roster / New Hire Check List / Orientation are company-wide; this one is HSL's.

## Decisions made without asking, and why

**The `scheduling` RBAC key stays the gate.** Moving the panel inside My Team would
otherwise silently swap its permission: it would stop being its own hidden-by-default
feature key and inherit `team`, so everyone with My Team would gain it while anyone
holding `scheduling` without `team` would lose it. Rendering it in a new place must not
change who may see it, so the toggle is gated on `can('scheduling')` **and** an HSL
department being selected. Nobody gains or loses access.

**The family-collapse ruling is already settled by precedent.**
`manager-scheduling.md` flags as open whether a manager granted `hsl:<sub_team>` should
see all 591. Measured: `departmentMatchesManagedAssignments` normalises every `hsl:*` to
one family key, so such a manager **already** sees the whole HSL family on their My Team
roster today. The rail inherits that rather than inventing it, and becomes the scoping
control — select the HSL parent for all 591, a sub-team for that team. The doc's open
ruling is corrected to record the precedent, not re-decided.

## Invariants that do not move

- **Nothing here feeds pay.** `manager-scheduling.md`: HSL already prices days by the
  calendar (+₱15/h weekend, PAB coverage, orphanage OT). Once a schedule can answer "was
  it a scheduled day?", letting a pay rule read it is its own decision under `hardening`,
  not a refactor. No pay path is touched.
- **The unit is a PERIOD.** Changing a schedule closes one period and opens another; a
  past period is never edited.
- **`isScheduledDay` returns `boolean | null`** and the null is load-bearing. Not simplified.
- **Overlaps are a hard error**, not a warning.
- **"Hours not set" is a state, not a zero.**
- `summarizeScheduling` counts `unscheduled` separately and always.

## Tasks

- [ ] 1. `references/sql/create/2026-09-14_employee_schedules.sql` — two effective-dated
      tables, exactly the shape `SchedulePeriod` already mirrors.
- [ ] 2. `scripts/apply-employee-schedules-migration.mts` — `--apply` gate. **Kane runs it.**
- [ ] 3. `src/lib/manager/scheduling-rows.ts` (+ test) — pure row↔`SchedulePeriod` mapping
      and the HSL-capability predicate.
- [ ] 4. `app/api/manager/scheduling/route.ts` — GET + PUT, gated exactly like
      `department-members` (`listDepartmentsForManager` + `departmentMatchesManagedAssignments`),
      paged with `selectAllPaged`. **Reports `migrated: false` when the tables are absent
      rather than 500ing** — the migration is Kane's to run, so the surface must degrade
      honestly until it lands.
- [ ] 5. `ManagerApp.tsx` — the toggle beside the department search, gated on
      `can('scheduling')` + HSL selected; remove the top-level tab and its sidebar entry.
- [ ] 6. Delete `src/lib/manager/scheduling-preview.ts` once the panel reads the route.
- [ ] 7. Docs: `manager-scheduling.md` (location, scoping, deploy), `manager-my-team.md`,
      both INDEX rows, memory.

## Deploy notes

**MIGRATION PENDING — Kane runs it.** `.env.local` is production service-role and this
session is read-only by default, so the DDL ships as a script with an `--apply` gate and
is not executed here. Until it runs, the route answers `migrated: false` and the panel
says schedules cannot be saved yet. Nothing 500s and nothing silently pretends to save.

No env var, no n8n import, no cron.
