# Orphanage Management System (OMS) pull — the Orphanage step's second door

Payroll Wizard → step 3 Orphanage → the **Orphanage Management System** tab. The orphanage
team prepares and **approves** each week's hours in OMS, a separate Supabase project; this
tab pulls the approved rows for the pay period on request, matches them to the people in
the period through the paste tool's resolver, and shows what the HRIS makes of them — who
matched, which hours are regular and which are overtime, and what they price to. Shipped
2026-09-16 (Kane: *"we are now pulling it from their database"*), commit on `main`.

The pay half of the step is still [orphanage-pay-step.md](./orphanage-pay-step.md) — this
document adds one input surface and changes no rule about money.

## Key files

| Piece | File |
| --- | --- |
| The ONE resolver (tokenize · match · price) | `src/lib/payroll/orphanage-rows.ts` (+ `.test.ts`) |
| OMS env config, identifier-checked | `src/lib/oms/oms-config.ts` (+ `.test.ts`) |
| OMS read (status count · paged pull) | `src/lib/oms/oms-hours.ts` |
| Route | `app/api/orphanage-pay/oms/route.ts` — `GET ?mode=status\|pull&week_start=` |
| Client fetch state (manual Refresh + Load, 15s timeouts) | `src/components/payroll/use-oms-hours.ts` |
| The tab | `src/components/payroll/OrphanageOmsPanel.tsx` |
| LIVE confirm | `src/components/payroll/OrphanageOmsLiveConfirmDialog.tsx` |
| Section strip · lock-in wiring | `src/components/PayrollWizard.tsx` — `ORPHANAGE_SECTIONS`, `orphanageResolveCtx`, `lockInResolvedOrphanageRows`, `lockInOmsRows` |

## One resolver, two doors

`orphanagePasteParse` used to be a loop inside the wizard. It is now
`resolveOrphanageHourRows` in `orphanage-rows.ts`, and **both** the paste tool
(`tokenizeOrphanagePaste` → resolver) and the OMS pull (rows → resolver) run through it,
then through `priceOrphanageHours`. A pasted line and an OMS row for the same person
price identically — the first test in `orphanage-rows.test.ts` pins that. Adding a third
way for hours to arrive means feeding rows to this resolver, never writing another loop:
the 2026-08 incident was exactly a second pricing path drifting from the first.

**Overtime is decided by the HRIS, never read from OMS.** OMS hands over pay week, work
email and hours. The resolver stacks the hours on what the person already worked this
pay week against the 40h cap, honouring the global and per-department OT switches, and
prices the OT leg at the FULL 1.5× rate. The pay-week label from OMS is informational,
exactly as the pasted one is: every matched row applies to the period being edited.

## Only approved rows, only this week, only on request

- **Approved only.** OMS releases a week by approving it (Kane, Q3). The read filters
  `status = OMS_HOURS_APPROVED_VALUE` and nothing else is ever visible here.
- **One week.** Filtered on the OMS week-start DATE column equal to the period's Sunday
  (`markerWeekStart`), the same Sun–Sat anchor the pay period uses (Kane, Q2: *"this week
  is 13-19"*). The client never chooses a different week than the one it is editing.
- **Nothing polls. Two manual buttons.** `Refresh` calls `?mode=status`, a **count**
  (approved rows + newest stamp, no rows) and is the ONLY thing that updates the
  indicator besides a Load; `Load Orphanage Hours` calls `?mode=pull` and is the only
  call that fetches rows. There is no ping on tab open and no timer (Kane, 2026-09-16:
  *"the querying should only load from the button request not automatic"*, then *"its not
  a live polling just a manual polling button for the refresh"*). Until the first Refresh
  the pill reads "Not checked yet". Both fetches time out at 15s so a button is never
  stuck in "Checking…".
- **Paged, capped, loud.** The pull uses `selectAllPaged` (PostgREST caps a page at 1000
  even with `.range()`), a stable order, and `OMS_MAX_ROWS` (10,000) with an explicit
  `truncated` flag the panel shows in red. Never a silent tail drop.
- **`count: 'exact'` without `head: true`.** A HEAD count against a missing table can
  come back as a clean zero; the indicator must fail loud ("OMS is unreachable"), not
  read "not ready". See [[postgrest-head-true-hides-missing-table]].

## TEST and LIVE

The Switch on the panel is **TEST on** by default, on **every** wizard mount, session-only,
never persisted (Kane, Q4 = recommendation). LIVE is a conscious act each session.

| Mode | Pull | Preview | Write |
| --- | --- | --- | --- |
| TEST | yes | matched + skipped, reg/OT split, amounts | **nothing, anywhere** — no blob, no record, no audit |
| LIVE | yes | same | `Lock in N amounts` → `OrphanageOmsLiveConfirmDialog` → `lockInResolvedOrphanageRows(ok, 'oms')` |

LIVE **is the paste's lock-in** (Kane, Q5 = recommendation): the additions blob under
CAS first, a refused save aborts everything after it, then the `orphanage_pay` records,
then the PAB coverage refresh. The amounts land on the Additions Orphanage column and
from there reach Final pay and the paystub line — the confirm dialog says so in words.
A successful LIVE lock-in additionally writes ONE `wizard.orphanage_oms_locked_in` audit
row (week, people, total, approved/pulled/skipped counts, truncation, newest stamp) so a
week's orphanage money can be traced back to an OMS pull. `lockInOmsRows` refuses in TEST
mode even if called; the panel never offers the button in TEST.

Replay is view-only as everywhere on the step: the tab shows, the pull works in TEST,
the Switch is disabled and LIVE cannot be reached.

## Skipped rows are never written

An OMS row that does not match a person in this period, repeats a person, or cannot be
priced (no rate, an OT rate below regular) lands in the amber **skipped** list with its
reason and is written in **no** mode. The fix is in OMS or the rates, then pull again.
`orphanage_pay` gains no `source` column for this: provenance lives in the audit row
above. If "which weeks came from OMS" ever needs to be queryable, that is a migration.

## The strip

`Paste data | Orphanage Management System` is a section strip in the step-4
`Departments | HSL` shape ([ui-standards §11.1](../design/ui-standards.md), underline
variant, shared `layoutId="orphanage-section-indicator"`, directional slide, reduced-motion
gated). **Paste is the default** so the tutorial's `step3-paste-data` anchor is mounted on
arrival. The OMS tab badges the approved-row count once a Refresh or Load has asked OMS —
after that the "data is ready" signal is visible from either tab. The **Locked in this period** list
and the reconciliation panels sit **outside** the swap: they are the period's money
whichever door it came through.

## Deploy notes

**No migration.** No HRIS table changes; OMS is read only.

Env, server-only (`.env.example` carries the full block). **PENDING — Kane fills
`.env.local`:**

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `OMS_SUPABASE_URL` | yes | — | the OMS project URL |
| `OMS_SUPABASE_KEY` | yes | — | a key with READ access to the hours table only |
| `OMS_HOURS_TABLE` | no | `orphanage_hours` | |
| `OMS_HOURS_COL_WEEK_START` | no | `week_start` | DATE — the week's Sunday |
| `OMS_HOURS_COL_EMAIL` | no | `work_email` | |
| `OMS_HOURS_COL_HOURS` | no | `hours` | |
| `OMS_HOURS_COL_STATUS` | no | `status` | |
| `OMS_HOURS_APPROVED_VALUE` | no | `approved` | |
| `OMS_HOURS_COL_PAY_WEEK` | no | `pay_week` | text label; `""` disables (label derived from the range) |
| `OMS_HOURS_COL_UPDATED_AT` | no | `updated_at` | feeds "prepared … ago"; `""` disables |

Every identifier is regex-checked (`isSafeOmsIdentifier`); a bad one is refused **by
variable name**, and no value is ever echoed. Without URL + key the route answers 503
`configured:false` and the tab says "OMS is not configured". **Until the OMS schema is
confirmed against these names, the week filter is an assumption** (a DATE column holding
the Sunday); if OMS keys the week differently, the column env var changes, not the code.
