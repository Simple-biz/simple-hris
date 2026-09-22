# Current Paycycle — the in-flight pay week, disassembled, beside an eight-step payroll track

A fourth section on the employee's **Profile → Compensation** strip (Rates · Pay Stubs · Payout ·
**Current Paycycle**). It shows the pay week being processed right now: hours Sunday to Saturday,
every line that will land on the statement, and where payroll has got to — eight steps from the
Hubstaff upload to the money leaving. The point is anticipation: the employee watches the figure
assemble instead of finding out on Friday.

Built 2026-09-22, commit `e3ee5541`; blueprint brief posted and ruled on the same day. **No migration** — every signal
already existed; what was missing was an employee-safe way to read them.

## Key files

| Piece | File |
| --- | --- |
| The step decision layer (pure) | `src/lib/employee/paycycle-steps.ts` (+ `.test.ts`) |
| The arrival-day copy | `src/lib/employee/paycycle-arrival.ts` (+ `.test.ts`) |
| The server assembler | `app/api/employee/current-paycycle/route.ts` |
| The pane | `src/components/employee/CurrentPaycycle.tsx` |
| Section registration | `src/lib/employee/profile-tabs.ts` · `src/lib/employee/compensation-sections.ts` |
| Host + fetch loop | `src/components/employee/EmployeeProfile.tsx` |

## 1 · The week is the NEWEST Hubstaff upload, and that is a choice among three

`listUploadIndex()` returns files newest-first, so `files[0]` is the week. Kane ruled this on
2026-09-22 (*"Just show the latest hubstaff week"*), and it matters because this repo deliberately
maintains **three** different answers to "the current week":

- the **newest upload** (the public `?source_files=1` path, what `EmployeeDashboard` takes) — this pane;
- the **`is_current` batch** (the accounting fork) — `hubstaff-hours-db.ts:510-518` states the split
  is deliberate and must NOT be harmonized;
- **`payrollNotesWeekStart()`**, the just-completed Manila Sun–Sat week — what KPI scoring floors on.

They are routinely different weeks. Do not "fix" this pane to agree with the wizard; it is answering
a different question on purpose.

The week's **Sunday** is parsed from the filename, never Monday-anchored. Pay weeks are
Sunday-anchored (the uploader refuses a filename whose range does not start on a Sunday) and the
`payroll.wizard.orphanage_confirmed.<Sunday ISO>` marker is keyed on exactly that value — an
ISO/Monday week start pulls it back a full week and reads an empty marker. Four SQL DDL comments
still call this key a Monday; **they are wrong and the code is right**.

## 2 · Three statuses, and a failed read is never green

`PaycycleStepStatus` is `done | pending | not_applicable`. The request asked for "a green dot per
Level", which implies a boolean. A boolean is wrong here, and this is the rule most likely to be
broken by someone simplifying this module.

On this pipeline an absent row means **"has not happened"**, **"does not apply to you"**, or **"we
could not read it"** — routinely indistinguishable at the source. `listAllOrphanagePayHours` breaks
out of its paging loop on error and returns `{rows: [], error: null}`. A person with no tracked time
gets no Hubstaff row at all. "Awaiting payout" is the *absence* of a paid dispatch, because
`payment_dispatches.status` is `paid | not_paid | threshold | problem` with no pending state and a
row is inserted only once money is logged. Memory `catalog-visible-dispatch-absent-means-no-hours`,
`kpi-departed-guard-hides-working-people` and `orphanage-source-file-drift-hides-a-week` are three
separate occasions this pipeline shipped a wrong answer by reading an absence as a zero.

So every read in the route is individually try/caught into `degradedKeys`, and `statusFor` consults
the degraded set **before** the fact. `paycycle-steps.test.ts` asserts this for all eight keys
against an input where every fact is true — a `if (fact) return 'done'` added above the degraded
check fails that test. **Never remove it to make a step look complete.**

`not_applicable` is excluded from **both** sides of the `N of M` count, so the number an employee
reads can actually reach its ceiling.

## 3 · Steps 6, 7 and 8 are not the wizard's steps

In the wizard, "lock" and "send to dispatch" are **one button**
(`dispatch-button-state.ts:47-48` — *"Lock in Values & Send to Payment Dispatch"* stages the queue
AND sets the lock). If this pane mirrored that, one of the eight dots would be decorative.

They are separated here because **step 7 is measured per person**: a non-`excluded`
`paystub_dispatch_queue` row for *you*, not the fleet's lock. A held or excluded employee therefore
stops at 6 rather than marching to "awaiting payout" behind a lock that was never about them.

Step 8 is Kane's Q3 ruling (*"Awaiting Payout is when it is sent to Dispatch already where it is
awaiting Payout"*): its **pending** state is the meaningful one — it *is* the awaiting — and it
resolves to `Paid` when the paid dispatch row lands. It is gated behind `stagedForDispatch` rather
than standing on an absence by itself.

**The staged-queue reader has no alias expansion.** `listPaystubPayloadsForEmployee` matches ONE
address with `.eq("recipient_email", …)` (`paystub-dispatch-queue.ts:266-271`), so an alias-keyed
staged row is invisible to it. The route calls it once per address in `callerEmails(...)` and merges.
If a future refactor collapses that to a single call, step 7 silently goes dark for everyone whose
staged row was keyed on their personal address.

## 4 · "Adjustments filled" would be vacuously green, and is not

Most people have no adjustment in most weeks. If "none found" meant done, this dot would be green
from Sunday morning and carry no information. It reads `done` only when the person **has** an
adjustment, or when the week is **locked** — the additions blob keeps moving until then, so "no
adjustment for you" is not a settled fact before the lock.

The carrier is `app_settings['payroll.wizard.additions.<file>']`, a **company-wide object**. It is
read server-side and only this caller's overlay (`pickAdditionsOverlay`) is returned. **The blob
itself must never reach a browser** — `EmployeeDashboard.tsx:684` already client-fetches the
neighbouring `payroll.wizard.final_pay.<file>` through `GET /api/app-settings?key=`, which gates only
the `secret.`/`auth.`/`webhook`/`token` families and so hands **the whole company's net pay to any
signed-in user**. That is a known open finding (session log item 161), not a pattern to copy.

For the avoidance of a repeat: the app *is* gated globally. **`proxy.ts` is Next.js's renamed
`middleware.ts`** and it 401s every `/api/*` outside a small allowlist. Grepping for `middleware.ts`
and concluding there is no auth layer is a mistake this repo has already produced once.

## 5 · "Orphanage — Not applicable" needs positive evidence

Kane's Q7 ruling: *"If the Orphanage was already added but that person has no hours."* So
`not_applicable` requires the week's orphanage data to be **known to have landed** — real
`orphanage_pay` rows for the file, or the clerk's confirm-none marker. Before that it is `pending`,
because lock-in **accumulates**: "no row for me yet" can still become a row from a later paste, and
printing *"Not applicable"* at someone who is owed orphanage money is this step's failure mode.

Real rows outrank the confirm-none marker — evidence beats an assertion, mirroring the wizard
checklist's own rule.

Note for the reader who finds the numbers odd: orphanage hours for a visit in week W land in week
**W+1**'s file (`orphanage-pab-coverage.ts:88-90`, window = `range.start − 7 days`). The hours shown
beside the Sun→Sat grid therefore belong to **no day in that grid**. They are correct; the grid is
Hubstaff time only.

## 6 · Live means poll, and it cannot mean `postgres_changes`

Kane asked for real time. `app_settings` is RLS admin-only and the anon browser receives **no row
events** — `useDispatchLock` subscribes and its binding has never fired (memory
`supabase-realtime-anon-rls-dead`, verified 2026-09-02); the lock actually moves on its 30s poll.

So the pane refetches on a 60s interval and on window focus, the cadence `EmployeeDashboard`'s
Estimated Take-Home already ships. Only the **first** load shows a spinner — a pane that repaints as
a skeleton every minute reads as a fault, not as liveness. True push would mean adding Broadcast
calls to the payroll wizard and Payment Dispatch **write** routes, which is a larger change than
this pane and was explicitly out of scope.

**The payload is deliberately NOT cached**, unlike every other section here. `tab-cache.ts:75-83`
names this exact hazard in its own words: *"a laptop lid closed on Friday and opened on Monday would
otherwise paint Friday's pay week as the current one."* A cached payload would paint last week's
track as this week's, green dots and all.

## 7 · The statement is reused, not re-derived

Kane's Q8 (*"All of the fields that fill the paystub"*) is served by returning `PayStubView` itself —
the same object the Pay Stubs pane renders, via the same `reconstructStubForWeek` four-tier fallback.
The pane imports the visibility rules (`showsOrphanageLine`, `view.hasWeekend`) rather than restating
them, because `paystub-view.ts` keeps them beside the view expressly so the renderers cannot answer
the question differently for the same week. **Do not add a fourth opinion in this component.**

A missing statement is a legitimate mid-cycle state, not an error: the day ladder and the track still
render, with a line saying the figures appear once the week has been worked out.

## 8 · The arrival note prints no date, and is not the schedule

`paycycle-arrival.ts` carries the rail → day map as copy: **Kolan · Higlobe · Wise · Wepay · Jeeves →
Tuesday, Wires → Wednesday**, with Friday as the promise.

This **differs from `pay-schedule.ts`**, which computes wires → Thursday and everything else →
Tuesday. That is allowed, and only because this module never prints an actual date. Kane ruled twice
that the note is display text (*"These are just documentation and text which are to be displayed not
a code issue"*, *"this should not show in PAYSTUB"*). The Pay Stubs section one pane away renders the
real `payDate` from `resolvePayDateIso`, and two dates on one screen that disagree is worse than one
date. **If this note ever starts printing a real date, that exemption dies and the two must be
reconciled first.**

His sentence named Wise on both Tuesday and Thursday. The first clause was kept (it names Wise
explicitly beside Higlobe) and the trailing duplicate dropped; Kolan, Wepay and Jeeves were unnamed
and take Tuesday, which is also what `pay-schedule.ts` computes for them. The map is
`Record<ProcessorId, ArrivalDay>` and not partial, so a seventh rail is a compile error rather than a
person silently inheriting someone else's day. An **unset** rail returns null and is told the Friday
promise only — a guessed day is an invented claim about someone's money.

## 9 · Registration, and the silently-empty-pane trap

A new Compensation section is three edits: the id in the `SectionId` union
(`profile-tabs.ts`), in `PROFILE_SECTIONS.compensation`, and in `COMPENSATION_SECTIONS`
(`compensation-sections.ts`) — **in the same position in both lists**, because
`compensation-sections.test.ts:38` deep-equals them. `CompensationSections.tsx` needs no edit; it
maps the canonical list.

`currentPaycycle` is **last** on purpose: `resolveCompensationSection` lands on `available[0]`, so
appending keeps Rates the default pane.

The render chain is a series of bare `activeCompensationSection === '…' &&` guards with **no default
branch**, so an id registered in the vocabulary but missing a render branch gives the employee a
**silently empty pane with no tsc error**. If you add a fifth section, add its branch in the same
commit.

## 10 · Disclosure

Every step detail is scoped to the caller. The accountant's checklist details say things like
*"3 people locked in"* and *"2/5 departments ready"*; those are company-scoped and must never appear
here. `paycycle-steps.test.ts` asserts no detail contains a fleet count, the words "people" or
"departments", an `N/M` figure, or an `@`.

The route accepts **no email**. Identity comes from the NextAuth session and the address set is
derived server-side via `getEmployeeMasterRecord` → `callerEmails`. Do not add a `?email=`
parameter; if an elevated previewer ever needs one, it goes through `authorizeEmailAccess` plus the
cross-person rate clamp from `app/api/employee-hourly-rates/route.ts:39-42`, because this payload is
money.

## Deploy notes

**No migration.** No new table, no DDL, no `references/sql/` file — every signal already existed in
`hubstaff_uploads`, `hubstaff_hours`, `orphanage_pay`, `app_settings`, `paystub_dispatch_queue`,
`payment_dispatches`, `bonus_catalog_applied` and `hsl_bonus_entries`.

**No env vars. No n8n import. No cron.**

**Nothing to hide it behind.** `src/lib/pages/visibility.ts` has a single `profile` key, so a
Compensation *section* cannot be admin-hidden, cannot ship under-construction, and cannot be rolled
out to a subset. It is visible to every employee the moment it deploys. Making it gateable means
promoting it to a top-level page, which is a different build.

**Verified 2026-09-22:** `npx tsc --noEmit` clean; `npm test` 4188/4190 — the two failures are
`dept-label-render.test.ts` and `manager-time-adjustments-live.test.ts`, both scanning
`ManagerApp.tsx` / `EditBuiltinManagersDialog.tsx`, untouched by this build and already failing on
`main` (session log item 96). `next build` was NOT run: a dev server was live on :3000 and they share
`.next/`.

## See also

`paystub-dispatch.md` (what a statement is) · `employee-profile.md` (the host shell) ·
`payroll-readiness.md` (the accountant's checklist this track is modelled on) ·
`employee-dashboard-cache.md` (the cache contract this section deliberately opts out of) ·
`payment-dispatch.md` (the rails) · `orphanage-pay-step.md` · `bonus-calculator.md`
