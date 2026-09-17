# FPU groups, weekly attendance, and the eligible list that opens MESA

Approved by Kane 2026-09-17, after a 81-agent scoping pass (72 claims checked against their
files, 64 confirmed, 8 refuted and dropped). The feature touches money, so that pass doubled as
the `hardening` doc-check.

## The rulings

- **Q1 → the rule applies to retakers too.** Everyone in a class must attend every session,
  first-timers and retakers alike. **Nobody's existing MESA balance is ever released** — an
  existing member cannot enroll in a class at all (`fpuVerdict` bars them on
  `alreadyCompletedFpu`), so the un-enroll path is unreachable by construction and is not built.
- **Q2 → failing is per-class, not permanent.** A non-attender fails THIS class and may enroll in
  a later batch. That needs a terminal status that does **not** stamp `mesa_fpu_completed_on`,
  because that stamp bars every future class forever and nothing can clear it.
- **Q3 → fail closed on unmarked.** An unmarked session counts against the person, and the
  eligible list names **unmarked** separately from **absent** so HR can chase the leader.
- **Q4 → the number is a target, not a cap.** 13 at "4 per group" is 4/3/3/3, never 4/4/4/1.
- **Q5 → HR marks the leaders.** A leader never marks their own attendance (reviewer ≠ filer).
- **Q6 → HR can override, audited, per person.** The verdict reads the override column; it never
  recomputes over it.
- **Q7 → sessions are derived weekly** from `class_starts_on`..`class_ends_on`. A class with no
  end date cannot be grouped or attended — the end date is required first.
- **Q8 → Close class is the completion event.** Closing means the class's end date has arrived;
  it produces the eligible/ineligible split, enrols the eligible into MESA, and frees the next
  batch to proceed. The manual per-person **Mark completed** bulk action retires.
- **Q9 → directory parity.** Groupmates see short name + work email, redacted server-side.
  Attendance is visible to its owner, their leader, and HR.

## Invariants

- **The randomizer runs once per class, ever.** Groups are persisted on confirm and read from
  those rows forever. A deal recomputed on read reshuffles under HR mid-class and orphans every
  attendance row — the exact QC bug (`src/lib/qc/deal.ts:10-29`).
- **`seededShuffle` only.** `Math.random()` is refused in writing by
  `src/lib/seeded-shuffle.ts:9-17`. Seed = `classId|perGroup|roll`. Confirm **re-derives** from
  the seed; it never trusts posted membership.
- **Sort before shuffling.** `seededShuffle` is deterministic in `(items, seed)` *including the
  input order*, so the population is sorted by a stable key first.
- **A member row is never deleted.** A leaver is stamped `left_on`; attendance already recorded
  stays truthful.
- **Attendance is keyed `(enrollment_id, session_no)`** so it follows the person, not the group.
- **A missing mark is UNKNOWN, never absent.** `present` is `NOT NULL` on a row that exists; the
  absence of a row is its own state and is reported as *unmarked*.
- **Nothing here rewrites a snapshotted week.** Eligibility gates whether MESA *opens*; it never
  reaches back into the ledger, an account, or a paid week.
- **`toggle-mesa-member` stays the one choke point** that opens an account. Unchanged.

## Tasks

- [ ] 1. `references/sql/create/2026-09-17_fpu_groups_attendance.sql`
- [ ] 2. `scripts/apply-fpu-groups-migration.mts` + `scripts/Apply FPU Groups migration.cmd`
- [ ] 3. `src/lib/mesa/fpu-groups.ts` (+ test) — divide, balance-fill, seed
- [ ] 4. `src/lib/mesa/fpu-sessions.ts` (+ test) — weekly session derivation
- [ ] 5. `src/lib/mesa/fpu-attendance.ts` (+ test) — the per-person verdict
- [ ] 6. `src/lib/mesa/fpu-groups-server.ts` — paged reads, leader resolution, migrated check
- [ ] 7. `app/api/hr/fpu-classes/groups/preview/route.ts` — pure, writes nothing
- [ ] 8. `app/api/hr/fpu-classes/groups/confirm/route.ts` — re-derives, then writes
- [ ] 9. `app/api/hr/fpu-classes/groups/leader/route.ts`
- [ ] 10. `app/api/fpu-attendance/route.ts` — self-or-leader, re-checked server-side
- [ ] 11. `app/api/hr/fpu-classes/class-close/route.ts` — the split + the MESA enrolment
- [ ] 12. `src/components/hr/FpuGroupsPanel.tsx`
- [ ] 13. `src/components/employee/EmployeeFpuGroup.tsx`
- [ ] 14. Docs: `fpu-groups-attendance.md`, INDEX row, memory, api-reference, data-sources,
      components.md, `fpu-enrollment.md` cross-link, log row.

## Deploy notes

- `scripts/Apply FPU Groups migration.cmd` — **its own launcher**, never bolted onto the FPU
  classes one (memory: every migration needs its OWN .cmd). Kane runs it.
- Until it lands every new route reports `migrated: false` and the panels say so. Nothing 500s.
