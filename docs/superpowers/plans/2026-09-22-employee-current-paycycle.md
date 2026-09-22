# Employee → Compensation → Current Paycycle

**STATUS: APPROVED BY KANE 2026-09-22.** Eight questions asked, eight answered. Two of the answers
widened the scope from the first brief and it was re-posted; this plan is written against rev 2.

A fourth section on the Compensation strip that shows the employee the pay week that is being
processed right now — its hours day by day, every line that will land on the statement, and an
eight-step track of where payroll has got to. The point is anticipation: the employee watches the
figure assemble instead of finding out on Friday.

## What Kane ruled

| Q | Ruling | Consequence for the build |
|---|---|---|
| 1 | *"Just show the latest hubstaff week"* | ONE week resolver, the newest `hubstaff_uploads` row. Never the accounting `is_current` fork, never `payrollNotesWeekStart()`. |
| 2 | *"Add another tab beside Payout"* | A 4th section appended AFTER `payout`. Index 3, so `rates` stays the default landing section. |
| 3 | *"Awaiting Payout is when it is sent to Dispatch already where it is awaiting Payout"* | Step 7 = a staged queue row exists. Step 8 = staged AND not yet paid, resolving when the paid dispatch lands. They no longer light together. |
| 4 | *"These are just documentation and text which are to be displayed"* + *"should not show in PAYSTUB"* | Display copy, in this section only. `pay-schedule.ts` is NOT touched. |
| 5 | *"Real Time"* | Poll + focus refetch, the cadence already shipped on the dashboard. Not `postgres_changes` — see below. |
| 6 | *"They should see it the moment it was marked as ready by the Manager"* | No change. That is current behaviour; only drafts stay hidden. No guard is loosened. |
| 7 | *"If the Orphanage was already added but that person has no hours"* | `not_applicable` requires POSITIVE evidence the week's orphanage data landed. Before that: `pending`. |
| 8 | *"All of the fields that fill the paystub"* | Reuse `PayStubView` itself rather than re-deriving lines. |

## The three decisions that carry the most risk

**Absent is not zero — and the track is built entirely out of absences.** Every step except
"Hubstaff loaded" is a question of the form *has X happened yet*, and in this pipeline a missing
row means "we have not read it", "it does not apply", or "the read failed" indistinguishably.
This is why the status vocabulary is four-valued and copied wholesale from
`src/lib/payroll/wizard-setup-steps.ts:37-39` rather than being the boolean green dot the request
describes. A failed read reads `pending` with a "Couldn't read this" detail. There is no code path
that turns a failed read into a green dot.

**Real-time cannot mean `postgres_changes`.** `app_settings` is RLS admin-only and the anon browser
receives no row events — `useDispatchLock` already subscribes and its binding has never fired
(memory `supabase-realtime-anon-rls-dead`, verified 2026-09-02); the lock actually moves on its 30s
poll. Broadcast would work but would mean adding publish calls to the payroll wizard and Payment
Dispatch WRITE routes, which are `out:` in the approved brief. So liveness is poll + focus refetch,
matching `EmployeeDashboard`'s shipped Estimated Take-Home cadence. If Kane wants true push later,
that is a scope change with the wizard and dispatch back in scope, not a tweak here.

**The arrival note is copy, and copy about money going stale is the failure mode.** It is one
exported constant with a test, in `paycycle-arrival.ts`, so a day change is a one-line edit. It
deliberately prints NO per-person date: the Pay Stubs pane one section away renders `payDate` from
`resolvePayDateIso` (wires→Thu, all else→Tue), and two dates on one screen that disagree is worse
than no date. Friday is the promise; everything else is described as processing lead time.

## Tasks

### 1 — `src/lib/employee/paycycle-arrival.ts` (+ test)

- [ ] `ARRIVAL_DAY_BY_RAIL: Record<ProcessorId, Weekday>` — Kolan · Higlobe · Wise · Wepay ·
      Jeeves → Tuesday, Wires → Wednesday. Keyed on `ProcessorId` so a new rail is a tsc error,
      never a silent default.
- [ ] `PAYDAY_LABEL` / the note copy, exported as data not JSX, so the test can assert it.
- [ ] Test: every `ProcessorId` in `PROCESSOR_OPTIONS` has an entry (the exhaustiveness tripwire);
      the note never names a specific date; Friday is present in the promise line.

### 2 — `src/lib/employee/paycycle-steps.ts` (+ test)

Pure. No I/O, no `server-only`, so `node:test` walks every branch — the same reason
`wizard-setup-steps.ts` is pure (its header, :15-16).

- [ ] `PaycycleStepKey` = `hubstaff | fx | orphanage | kpi | adjustments | locked | dispatch | payout`
- [ ] `PaycycleStepStatus` = `done | pending | not_applicable` — narrower than the wizard's four:
      an employee has no action to take, so `attention`/`blocked` (which mean *you must go fix
      this*) have no meaning here. `not_applicable` is new and is Q7's ruling.
- [ ] `PaycycleStep { key, stepNo, label, status, detail }`
- [ ] `derivePaycycleSteps(input): { steps, doneCount, totalCount }`
- [ ] Test per branch, and specifically: a degraded read never reads `done`; orphanage reads
      `pending` until the week's data is known to have landed, then `not_applicable` for a person
      with no hours; step 8 is `pending` while staged-and-unpaid and `done` once paid.

### 3 — `app/api/employee/current-paycycle/route.ts`

- [ ] Session only. `getServerSession(authOptions)` → email → 401. NO `?email=` — mirrors
      `app/api/employee/orphanage-hours/route.ts:21-52`.
- [ ] `getEmployeeMasterRecord(email)` → `callerEmails(...)`, and EVERY lookup uses that
      server-derived set. The staged-queue reader has no alias expansion of its own
      (`paystub-dispatch-queue.ts:266-271`), so folding identity here is what makes step 7 correct.
- [ ] Resolve the week: newest `hubstaff_uploads` row → its `source_file`.
- [ ] Per-day hours: one alias-filtered, PAGED query over `hubstaff_hours` (never `.range()`
      alone), then `resolveCanonicalColumnsToIso` when the columns are canonical.
- [ ] The statement: `reconstructStubForWeek` — reuse, do not re-derive. It already carries the
      four-tier fallback and every line Q8 asks for.
- [ ] The steps: read the wizard's own keys server-side (`cycleFxSettingKey`,
      `orphanageConfirmedSettingKey`, `payroll.dispatch_lock.<file>`, the additions blob) and hand
      `derivePaycycleSteps` plain booleans. The blob is read SERVER-side and only the caller's
      entry is returned — the employee never receives the company-wide object.
- [ ] Every read in its own try/catch feeding `degradedKeys`. One failed read degrades one step,
      never the response.

### 4 — Registry

- [ ] `src/lib/employee/profile-tabs.ts` — `'currentPaycycle'` into `SectionId` and into
      `PROFILE_SECTIONS.compensation`, LAST.
- [ ] `src/lib/employee/compensation-sections.ts` — same entry, same position.
      `compensation-sections.test.ts:38` deep-equals the two, so both or the suite reds.

### 5 — `src/components/employee/CurrentPaycycle.tsx`

- [ ] Four render states in the shipped order: loading → error (amber inline) → empty → content.
- [ ] Day ladder Sun→Sat. Copy the row anatomy from `WeeklyEarningsRail`
      (`EmployeeMyHours.tsx:311-534`) and its paired skeleton; do NOT copy its Mon→Sun anchor,
      its `isHsl` null return, or its missing reduced-motion gate.
- [ ] The step rail beside it, `prefers-reduced-motion` respected.
- [ ] The arrival note from task 1.

### 6 — `src/components/employee/EmployeeProfile.tsx`

- [ ] State in the parent block above :1813 (the pane unmounts on every section swap).
- [ ] Fetch effect gated on tab THEN section, per :1238-1269 — but with a poll + focus refetch
      instead of the one-shot ref, which is Q5. The one-shot ref is the thing being deliberately
      not copied, and the reason is written down at the call site.
- [ ] One `{activeCompensationSection === 'currentPaycycle' && (...)}` branch inside the existing
      keyed panel at :2160-2173. It does not add a panel.

### 7 — Verify

- [ ] `npx tsc --noEmit` (NOT `next build` — a dev server is live on :3000 and they share `.next/`).
- [ ] `npm test`.

### 8 — Document, same commit

- [ ] `docs/features/employee-current-paycycle.md`
- [ ] `docs/features/INDEX.md` row with the Key invariant
- [ ] memory `employee-current-paycycle.md` + `MEMORY.md` pointer + the INDEX wikilink
- [ ] Open items row in `docs/audits/audit-2026-09-16-session-log.md`

## Not in this build

The payroll wizard, Payment Dispatch, paystub generation, `pay-schedule.ts`'s actual dates, every
write path. And the three ungated routes found while scoping — they are recorded as findings with
their own Open items rows, not fixed in passing.
