# KPI live refresh — a Mark Ready, Lock or reopen reaches every open dashboard

Kane, 2026-09-29: *"Please make sure that the KPI Bonus when locked are real time in all
dashboards find its routes please"*, then *"Payroll Wizard, Payroll Notes"*. Before this, a
manager publishing a KPI week reached almost nothing that was already open: the Payroll
Wizard read KPI once per week switch, most Manager boards once per visit, the employee
Overview once per page load. Every surface that looked live was running on a poll, because
its only "real-time" hook was a `postgres_changes` binding that never fires here.

## The transport — server Broadcast from the route that wrote the row

**`postgres_changes` is dead for all three KPI tables, and that is measured.** Read-only probe
with the anon key, 2026-09-29: anon sees **0 of 337** `hsl_bonus_period_status` rows, **0 of
18,969** `bonus_catalog_applied`, **0 of 7,118** `hsl_bonus_entries` (service role sees them
all). RLS hides every row from the browser client, so no row event can ever be delivered —
the same finding as memory `supabase-realtime-anon-rls-dead` for `app_settings` and
`payment_dispatches`. Never "fix" a stale KPI view by subscribing to these tables.

So the route that just wrote the row announces it on its own Broadcast topic,
**`kpi-bonus-sync`** / event `changed` (`src/lib/kpi-live.ts`):

| Route | Write | Announces |
|---|---|---|
| `POST /api/hsl-bonus/period-status` | Mark Ready / Lock / reopen (upsert) | always — status from the row the DB wrote, never the unvalidated body |
| `DELETE /api/hsl-bonus/period` | entries AND status row. **No UI caller:** its only caller, `HslBonusEditModal`, had no importer and was deleted 2026-10-06. The handler is kept | always, `status: null` |
| `POST /api/bonus-catalog-applied` | Departments calculator autosave | only if the week is `ready`/`locked` |
| `DELETE /api/bonus-catalog-applied` | catalog dept-week delete. **No UI caller since Bonus History was retired on 2026-09-29.** The handler is kept (Open item 284) | only if the week is `ready`/`locked` |
| `POST /api/hsl-bonus/entries` | HSL calculator autosave | per dept-week in the batch, only if `ready`/`locked` |
| `DELETE /api/hsl-bonus/entries` | remove one scored person | only if `ready`/`locked` |

Rules, each pinned by a test:

- **A status write always announces; a bonus write only on a published week**
  (`bonusWriteAnnounces`). A reopen takes a week OUT of every view, which is as much a change
  as a Lock. Drafts are invisible to employees, the wizard and rankings, and the calculators
  autosave drafts on every debounced edit — announcing those would make every open employee
  tab re-read on a keystroke. A failed status read announces anyway (a spurious re-read costs
  one fetch; a missed one leaves a published figure stale).
- **Through `after()` (next/server), never `void`.** Work left dangling after a response can be
  frozen with the function, and a dropped Lock message is the exact staleness this exists to
  remove. `kpi-live-routes.test.ts` pins every writer to `after(announce…(`, and refuses a
  `void announce…(`. The other Broadcast senders in this repo still `void` — that is their
  call, not copied here.
- **The payload is a re-read signal, never the value.** Every listener fetches from its own
  gated route; a forged or stale message can cost a re-read but never paint a number.
- **OWN topic, ONE channel per page.** realtime-js returns the existing channel for a repeated
  topic, so a surface that opened and later removed its own channel would tear the topic down
  for the other four on the Accounting shell. `joinSharedBroadcast`
  (`src/lib/supabase/shared-broadcast.ts`) is the PAB hook's shared-channel pattern keyed by
  topic; a RE-subscribe (after a drop) sends every listener a `null` catch-up.
- **Employee surfaces spread their re-read over 0–1.5 s** (`KPI_LIVE_EMPLOYEE_SPREAD_MS`): the
  topic reaches every open employee tab at once.

**"Lock" does not write `locked` today.** Both calculators' Lock is client state; *Submit to
payroll* posts `ready` and Reopen posts `draft` (`DeptBonusCalculator.tsx` Lock/Submit,
`HslBonusCalculator.tsx` Mark Ready). Every existing `locked` row is older data. The channel
announces every status either way.

## What is live now, and how

`useKpiLive({ onChange, enabled, spreadMs })` is the only way in. It is the FAST path: every
surface keeps the poll / focus refresh it already had, so a lost message costs that floor.
**Every `onChange` is a background re-read** — no skeleton, no cleared data, no reset of a
stepper, and anything short of a clean read keeps what is painted.

| Dashboard · surface | Re-read on the broadcast | Floor it keeps |
|---|---|---|
| Employee · Overview KPI Bonus card (`EmployeeDashboard.tsx`) | `/api/kpi-results` (email-stamped, seq-guarded) | `kpi.scored` toast event, focus, 30 s |
| Employee · KPI Results tab | `/api/kpi-results` | `kpi.scored` toast event, focus, 30 s |
| Employee · Profile → Current Paycycle (while on screen) | `/api/employee/current-paycycle` | 60 s, focus |
| Employee · My Team → Rankings | `/api/team-rankings` (a failed read keeps painted weeks) | once per department |
| Manager · Overview "Bonuses to score" (`use-bonus-scoring-queue.ts`) | the four summary reads; a PARTIAL failure keeps the painted chips | week / dept change |
| Manager · KPI Calculator → Departments / HSL | the calculators' own `refreshAll` — a dirty or saving dept is still skipped | 30 s poll (the `useLiveRefresh` realtime half is dead) |
| Manager · KPI Insight cards | follow the Departments calculator's `liveKey` | — |
| Manager · My Team → SP / Appointments / KPI Rankings | the three board reads, quietly; no week-stepper reset; never written under another department's cache key | once per department |
| Accounting · Overview → Payroll Notes card | `/api/payroll-wizard/readiness` | 120 s |
| Accounting · Payroll Notes → Readiness pane (KPI Submissions tab, score) | the pane's background `load` | 30 s |
| Accounting · Payroll Wizard · Step 5 KPI Sub. + HSL KPI Bonus, Validation, Dispatch preview, Reports | same-week background re-read (below) | week switch |
| Accounting · Payroll Wizard · Step 5 HSL tab period cards | background run of the step loader | step entry, week switch |

### The Payroll Wizard contract

The wizard is the money path, so it gets its own rules
(`src/lib/payroll/wizard-kpi-load.ts`, the live block in `PayrollWizard.tsx`):

- **The week-switch loaders are unchanged in behaviour.** They still blank first — so one
  week's KPI can never publish into another week's final-pay snapshot — and still hold the
  publisher (`*Loaded` null) on failure. They now call the same `fetchManagerKpi` /
  `fetchHslKpi` the live refresh calls, so the two paths cannot disagree about what a week pays.
- **A failed read THROWS.** The old manager loader parsed a 500's `{ error }` body as zero
  rows, marked the week loaded, and let the publisher write a KPI-less total — the silent
  underpay its own comment said it refused. Pinned by `wizard-kpi-load.test.ts`.
- **The status read is narrowed to the week** when it is known (`?period_start=`), so it never
  approaches PostgREST's 1000-row cap (the route does not page; 337 rows on 2026-09-29).
- **The live refresh is SAME-week and BACKGROUND.** It swaps the maps in only on success, only
  for the week still on screen, only if no week-switch load started meanwhile, and only when
  they differ (`sameJson` — both fetches fold in sorted department order so equal data
  serialises equal). A failed live re-read keeps what is loaded, which is what the wizard
  showed before it was live. Changed maps flow into `dispatchData` and the 1.5 s final-pay
  publisher, exactly as an Adj. edit does.
- **NEVER once the cycle's values are locked for Payment Dispatch, while Start Processing holds
  the payroll lock, or in a replayed week** (`wizardKpiLiveAllowed`; an unknown lock counts as
  locked). That is the rule `pullNotesAdjustments` already follows — *nothing may drift in
  silently mid-payout*. A change for this cycle's week that arrives while locked is SAID, not
  applied: a toast names the fix (Unlock in Validation). The first moment the cycle is editable
  again, it catches up once.
- **The dead `payroll-wizard-hsl-status` binding is gone.** Had it ever woken (an anon policy
  added later), it would have re-run the BLANKING loader with no values-lock check.

## Deliberately not live

- **The final-pay snapshot hop.** Once the wizard publishes a week, the employee Overview shows
  the snapshot's `otherBonuses`, which it polls every 30 s; Payment Dispatch prices from the
  same snapshot. Broadcasting every snapshot write would re-read every employee tab on every
  accountant keystroke. With the wizard open, a Lock reaches the employee figure in ≈ 2 s
  (wizard) + 1.5 s (publish debounce) + ≤ 30 s (Overview poll).
- **The closed Payroll Notes FAB ring.** It deliberately has NO realtime or polling
  (memory `payroll-notes-fab-readiness-ring`: the readiness endpoint is too expensive for a
  second always-on consumer for a badge). It still refreshes on week change and on dialog close.
- **Accounting Overview "Bonuses keyed in" and the CEO tile.** They count rows of every status,
  drafts included, so a status change does not move them; the CEO tile is once per session by
  design (`accounting-dashboard-cache.md`).
- Paystubs, People → Payroll history, Penny tools — they read issued statements or answer on
  demand.

## Key files

| Piece | File |
|---|---|
| Topic, payload, announce rule | `src/lib/kpi-live.ts` (+ `.test.ts`) |
| Server announcers | `src/lib/kpi-live-server.ts` |
| One channel per topic per page | `src/lib/supabase/shared-broadcast.ts` (+ `.test.ts`) |
| The hook every surface uses | `src/hooks/useKpiLive.ts` |
| Wizard KPI reads + live gate | `src/lib/payroll/wizard-kpi-load.ts` (+ `.test.ts`) |
| Every writer announces | `src/lib/kpi-live-routes.test.ts` |

## Deploy notes

No migration, no env var, no n8n change. Broadcast needs nothing provisioned. **Not verified in
a browser, and the Broadcast path was not probed against production** — the first real Mark
Ready after deploy proves it (open Payroll Notes → Readiness in one tab and Mark Ready in
another; the KPI row should move within about a second, not on the 30 s tick).
