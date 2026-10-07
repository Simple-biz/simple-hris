# Orphanage Management System (OMS) pull — the Orphanage step's second door

Payroll Wizard → step 3 Orphanage → the **Orphanage Management System** tab. The orphanage
team prepares and **approves** each week's hours in OMS, a separate Supabase project; this
tab pulls the approved rows for the pay period on request, matches them to the people in
the period through the paste tool's resolver, and shows what the HRIS makes of them — who
matched, which hours are regular and which are overtime, and what they price to. Shipped
2026-09-16 (Kane: *"we are now pulling it from their database"*), commit on `main`.

The pay half of the step is still [orphanage-pay-step.md](./orphanage-pay-step.md) — this
document adds one input surface and changes no rule about money.

Since 2026-09-28 the tab also sends the other way: **Send to OMS** returns each person's
regular and overtime hours and the amount the HRIS pays them to a table OMS owns, so the
orphanage team can report it to accounting ([§ Sending to OMS](#sending-to-oms)).

## Key files

| Piece | File |
| --- | --- |
| The ONE resolver (tokenize · match · price) | `src/lib/payroll/orphanage-rows.ts` (+ `.test.ts`) |
| OMS env config, identifier-checked | `src/lib/oms/oms-config.ts` (+ `.test.ts`) |
| OMS read (status count · paged pull) | `src/lib/oms/oms-hours.ts` |
| Route | `app/api/orphanage-pay/oms/route.ts` — `GET ?mode=status\|pull&week_start=` |
| Client fetch state (manual Refresh + Load, 15s timeouts, previous pull) | `src/components/payroll/use-oms-hours.ts` |
| Change detection (count/stamp since pull · row diff between pulls) | `src/lib/oms/oms-diff.ts` (+ `.test.ts`) |
| Save payload (raw + resolved per row) + route validation | `src/lib/oms/oms-save.ts` (+ `.test.ts`) |
| Saves table (probe · append-only insert · latest per week, paged) | `src/lib/supabase/orphanage-oms-hours-db.ts` |
| Saves route | `app/api/orphanage-pay/oms/saves/route.ts` — `GET ?week_start=` · `POST` |
| Table DDL · apply script | `references/sql/create/2026-09-16_orphanage_oms_hours.sql` · `scripts/apply-orphanage-oms-hours-migration.mts` |
| The tab | `src/components/payroll/OrphanageOmsPanel.tsx` |
| LIVE confirm | `src/components/payroll/OrphanageOmsLiveConfirmDialog.tsx` |
| Section strip · lock-in wiring | `src/components/PayrollWizard.tsx` — `ORPHANAGE_SECTIONS`, `orphanageResolveCtx`, `lockInResolvedOrphanageRows`, `lockInOmsRows` |
| Send to OMS — row builder (blob + records → rows, verdict, aliases, week) | `src/lib/oms/oms-return.ts` (+ `.test.ts`, which also pins the DDL below) |
| Send to OMS — write config (`OMS_RETURN_TABLE`) | `src/lib/oms/oms-config.ts` `readOmsReturnConfig` |
| Send to OMS — OMS write (probe · ONE insert · newest send) | `src/lib/oms/oms-return-write.ts` |
| Send to OMS — strict paged records read | `src/lib/supabase/orphanage-pay-db.ts` `listOrphanagePayStrict` |
| Send to OMS — route | `app/api/orphanage-pay/oms/return/route.ts` — `GET ?source_file=&week_start=` · `POST` |
| Send to OMS — client state · modal | `src/components/payroll/use-oms-return.ts` · `OrphanageOmsReturnDialog.tsx` |

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

## Detecting changes

Kane, 2026-09-16: *"can we also have this detect changes?"* Two layers, both pure in
`src/lib/oms/oms-diff.ts` (+ tests), neither automatic:

| Layer | When | What it compares | What you see |
| --- | --- | --- | --- |
| **Refresh** — `omsChangedSincePull` | you press Refresh after a pull | the status count + newest stamp vs the ones the last pull carried | the pill turns amber: "Changed since your last pull — N more approved · edited 3 min ago — load again"; the Load button gains an amber ring. A Load replaces the pull's numbers, so the flag clears itself |
| **Re-load** — `diffOmsPulls` | a second Load in the same week | the new rows vs the pull they replaced, keyed by normalized email, hours to 4dp | a "Changed since your previous pull" box: `+` added, `~` hours changed (before → after), `−` removed; changed rows are tinted in the table. Identical pulls say so in one line |

Without a stamp column (`OMS_HOURS_COL_UPDATED_AT=""`) only the count can speak on
Refresh — an edit that keeps the count invisible until the re-load. The previous pull
lives in memory for the week only; a new source file or a LIVE lock-in clears both.
This detects change in **OMS**, not drift against what is already locked in the
period — that remains the reconciliation panels' job on the step.

## Saving — the HRIS's own record of a pull

Kane, 2026-09-16: *"add a save button in here where the loaded data gets saved within the
HRIS … a supabase table … let us not merge it with the current supabase table."*
Approved: append-only snapshots; each row stores BOTH the raw OMS values and the HRIS
resolution at save time.

**Table:** `public.orphanage_oms_hours` (references/sql/create/2026-09-16_orphanage_oms_hours.sql).
One row per OMS row per save; `save_id` groups a Save. **NOT MONEY** — nothing prices,
dispatches or prints a paystub from it, and nothing on the step reads it back into the
pay column. That is why **Save is allowed in TEST mode**: it touches neither carrier
([orphanage-pay-step.md § Two carriers](./orphanage-pay-step.md)).

| Rule | Why |
| --- | --- |
| **Append-only.** No UPDATE or DELETE path exists in the app or the DB layer. | A save is a snapshot; the next one is simply newer. No delete ⇒ no "nothing destroyed unsnapshotted" machinery to get wrong. |
| Each row is **raw + resolved**: `oms_*` as OMS returned it, then `matched`, the Additions key, reg/OT split, rates, amount — or `skip_reason`. | A saved pull reads back without re-resolving, and an unmatched row is kept with the reason, never dropped. The `resolution_shape` CHECK makes the in-between unrepresentable. |
| `mode` records the TEST/LIVE switch at save time. | So a reader can tell a rehearsal from a week that was also locked in. |
| Actor = the session (`saved_by` NOT NULL, blank refused); audited as **one** `wizard.orphanage_oms_saved` row per Save (counts, total, save_id). | Every snapshot has an author and a trail. |
| **Table not applied ⇒ the panel says so.** Both verbs probe first (`count:'exact'`, no `head`) and answer 503 `tableReady:false` with the script to run; Save is disabled with that reason. | A pending migration is folklore until measured; a 500 in a toast tells nobody what to do. |
| RLS on, no policies; reads and writes go through the service-role route only. | Rows name workers and hours; the anon key ships in the bundle. |
| The "Last saved" line and the "saving now changes N" diff refresh with **Refresh, Load and Save** — the same manual moments. | Nothing polls, consistent with the rest of the tab. |

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

**Repeats are where the two doors differ (2026-09-29).** The paste door now ADDS a person's
repeated lines and prices the total once (`repeats: 'combine'`, Kane: *"if there are two line
items just add them both"*,
[orphanage-pay-step.md § A person on more than one pasted line](./orphanage-pay-step.md#a-person-on-more-than-one-pasted-line-2026-09-29)).
This door still calls the resolver with the default `refuse`, so the rule above is unchanged.
The reason is that `buildOmsSavePayload` maps ONE resolution to each OMS row by `line`, and a
combined result would leave the second row with neither a match nor a skip reason. Test:
`orphanage-rows.test.ts` "OMS door (default `refuse`)". Making OMS combine too needs a
decision from Kane and a change to the Save's row grain.
`orphanage_pay` gains no `source` column for this: provenance lives in the audit row
above. If "which weeks came from OMS" ever needs to be queryable, that is a migration.

## Sending to OMS

Kane, 2026-09-26: *"after they provide the hours we calculate it and send it back with the
Emails, Hours that were Regular and OT and the amount as well so they can report it to
accounting … I want the loading not to be in the button but in a small modal."* Until
2026-09-28 this document said *"OMS itself is read only"*; Kane repealed that on the record
(*"i mean to OMS"*, session `a3cfb82b`, audit item 235). The HRIS now writes to OMS in
exactly **one** way, described here, and nowhere else.

| Rule | Why |
| --- | --- |
| **One table, append only.** The HRIS INSERTs into the table named in `OMS_RETURN_TABLE` and nothing else — no UPDATE, no DELETE, never OMS's hours table (`readOmsReturnConfig` refuses that name). | We are a guest in their database. A re-send is a new `push_id`; OMS reads the newest per `week_start`. Nothing we sent can be rewritten by us afterwards. |
| **`OMS_RETURN_TABLE` has no default.** Unset ⇒ the modal says "Sending to OMS is not set up" and names the variable. | A write to someone else's system never goes to a guessed table. |
| **The server rebuilds every row** from the SAVED carriers — the additions blob (`orphanageAmounts`, what PAYS) and `orphanage_pay` (hours, reg/OT split, rates) — via `buildOmsReturnRows`. The tab sends only `source_file`, `week_start` and `aliases`. | A tab holding stale state is how the 2026-08-18 correction was reverted ([orphanage-pay-step.md § incident](./orphanage-pay-step.md)). It must not be able to send stale money into another company's accounting. |
| **The amount is the blob's, never the record's `amount_php`.** Each row also carries `verdict` = `reconcileLockedOrphanageAmount` (`ok` / `amount_mismatch` / `ot_underpriced` / `unverifiable`). | The blob is what is paid; the verdict says whether it agrees with its own hours × rates, so OMS reports what was paid and can see where it is doubtful. Re-pricing stays a human action on the step. |
| **A hand-typed amount goes with hours BLANK** (`hours`/`regular_hours`/`ot_hours` null, verdict `unverifiable`). | It has no record; inventing hours for it would be a fabricated figure. |
| **Hours on record with NO amount on the column are not sent** — the modal counts them (red line). | They pay ₱0 today (the step's red panel). Sending hours with ₱0, or the record's amount, would report something nobody was paid. Fix on the step, then send. |
| **A corrupt blob amount refuses the whole send** (422), and so do two blob keys that differ only in case. | A partial accounting report that silently omits a person is worse than none. |
| **The week is derived** from the source file's parsed date range (`weekStartFromSourceFile`), and a tab naming a different week is refused (400). | A week's money must never land under another week's label ([[orphanage-source-file-drift-hides-a-week]]). |
| **ONE insert per send — all rows or none.** Never chunked. | A half-landed send is a report missing people with nothing saying so. |
| **`cycle_locked` rides on every row** = the dispatch lock (`payroll.dispatch_locked`, global) at send time. Sending is allowed before the lock. | Amounts can still move until the lock (Re-price, Restore, a hand edit). The flag tells OMS whether a figure is final instead of blocking a send. |
| **`work_email` is OMS's own address when the tab's current pull carried it** (`aliases`, relabel only — they can neither add a row nor change a figure; a malformed pair is a 400, never a silent drop). `hris_email` always carries the address the HRIS pays under. | OMS matched on its address; the Additions row may key someone by an alternate one. Without a pull, `work_email = hris_email` (measured 2026-09-21: all 156 orphanage emails were the GML Work Email). |
| **LIVE only.** The button is disabled in TEST ("Test mode writes nothing, anywhere") and in replay. The route cannot see the switch — the panel enforces it, exactly like the LIVE lock-in. | TEST's contract (§ TEST and LIVE) is that nothing is written anywhere; a rehearsal must not reach their accounting. |
| **Audited once per send**: `wizard.orphanage_oms_returned` (push_id, OMS table, week, source file, count, total, cycle_locked, verdict counts, the unsent emails, and up to 300 rows as sent). | OMS holds the rows; the HRIS keeps its own proof of what it sent and who pressed the button. |

**The modal carries the loading, and the motion may not lie.** Opening it runs the GET
(the same builder as the send, so the preview IS what goes). **The bar is the connector
between the HRIS and OMS chips**, not a second track under them. At rest it is a thin
neutral rail. Until 2026-10-07 an empty track sat under the strip and read as a stalled
loader; Kane's request that day was *"Fix the modal"*. The OMS chip's icon stays neutral, because rose is this modal's failure colour.
While the POST is out, rows
stream HRIS → OMS and the bar eases toward 90% on an estimate (`predictedProgress`, the
[[payroll-wizard-step-load-progress]] rule: an estimate never fills the bar). Only OMS's
ack takes the bar to 100% and ticks the rows — together, because the insert is one
statement. A failure turns the bar rose and sends every row back to queued. A **timeout**
is ambiguous (the insert may have landed), and the modal says so: reopen to read OMS's
newest copy before sending again. The modal cannot be dismissed while sending. "OMS already
holds a send for this week" is read back **from OMS**, not from our audit row.

**The figures are never cut.** The shell is `sm:max-w-[520px]` and keeps the primitive's phone
gutter. A base-only `max-w-md` lost to the primitive's `sm:max-w-sm` (384px), and on
2026-10-07 that clipped the Amount tile to "₱313,299.9" ([[dialog-content-no-height-cap]]).
The four tiles sit 2×2 on phones. From `sm:` up, Amount takes the wide column, and the
numbers are `whitespace-nowrap` and never truncated. The height is capped
(`max-h-[calc(100dvh-1.5rem)] sm:max-h-[92dvh]`) with shrink-0 chrome. The row list has no
fixed max-height: it fills what the cap leaves, scrolls, and shrinks to a 7.5rem floor, and
past that floor the body scrolls. The Send button stays reachable at every window height
([responsive-design.md § Dialogs and modals](../design/responsive-design.md)).

**What looks like a bug and is not:** the GET answers 200 even when sending is not set
up — the preview is real either way and the modal names the missing piece. The probe
needs SELECT on the table, so OMS must grant INSERT **and** SELECT.

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

**Migration — PENDING until Kane runs it:** `public.orphanage_oms_hours`
(references/sql/create/2026-09-16_orphanage_oms_hours.sql). Dry run by default;
DATABASE_URL = the SESSION POOLER on 5432 ([[migration-apply-needs-database-url]]):

```
node --import tsx scripts/apply-orphanage-oms-hours-migration.mts           # rehearse + roll back
node --import tsx scripts/apply-orphanage-oms-hours-migration.mts --apply   # commit
```

Until applied, the OMS tab's Save button reads "Saving is not ready" with that command.
Everything else on the tab works without it. OMS is read-only except for the one
append-only table in [§ Sending to OMS](#sending-to-oms). That exception was ruled by Kane
on 2026-09-28; until then this line said "OMS itself is read only".

Env, server-only (`.env.example` carries the full block). **PENDING — Kane fills
`.env.local`:**

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `OMS_SUPABASE_URL` | yes | — | the OMS project URL |
| `OMS_SUPABASE_KEY` | yes | — | a key with SELECT on the hours table, plus INSERT + SELECT on the return table (and nothing else) |
| `OMS_RETURN_TABLE` | for Send to OMS | **none** | the table OMS created from the DDL below; unset ⇒ "Sending to OMS is not set up" |
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

### Send to OMS — PENDING, three steps outside this repo

> **2026-10-07 — this plan is on hold; OMS will not create the table below.** Their dev answered that OMS
> already built the return path: `POST /api/hris/payroll-report` (HMAC-signed over the raw body, idempotent
> on `idempotency_key`, lands in their `payroll_report`) and `GET /api/hris/approved-hours`. Measured read-only:
> `payroll_report` exists in their prod (`xllfslvceolnfzdfgudo`) and holds only rows from their own simulator,
> and no HRIS code calls either endpoint. Re-pointing Send to OMS at that endpoint is Kane's call and needs
> OMS's contract (URL, HMAC details, body schema incl. the reg/OT split, idempotency and batch semantics).
> Audit item 334.

1. **PENDING — the OMS team creates the table in THEIR project** (this file is the contract;
   `oms-return.test.ts` fails if the column list below drifts from `OMS_RETURN_COLUMNS`).
   **The file to send their dev** is `references/sql/external/oms/2026-10-07_hris_orphanage_returns.sql`
   (2026-10-07): the same columns, also test-pinned, plus the concrete access block. Our key is an
   `sb_secret_` (service_role) key, so it turns RLS on, revokes anon/authenticated, grants
   `service_role` SELECT + INSERT and revokes its UPDATE/DELETE/TRUNCATE, which makes append-only hold
   in their database too. The generic shape:

```sql
create table public.hris_orphanage_returns (
  push_id           uuid           not null,
  pushed_at         timestamptz    not null,
  pushed_by         text           not null,
  source_file       text           not null,
  week_start        date           not null,
  pay_week          text,
  work_email        text           not null,
  hris_email        text           not null,
  employee_name     text,
  hours             numeric(12,4),
  regular_hours     numeric(12,4),
  ot_hours          numeric(12,4),
  regular_rate_php  numeric(14,4),
  ot_rate_php       numeric(14,4),
  amount_php        numeric(14,2)  not null,
  verdict           text           not null check (verdict in ('ok', 'amount_mismatch', 'ot_underpriced', 'unverifiable')),
  cycle_locked      boolean        not null,
  primary key (push_id, hris_email)
);
create index hris_orphanage_returns_week_idx on public.hris_orphanage_returns (week_start, pushed_at desc);
-- The role behind OMS_SUPABASE_KEY needs exactly these two privileges here:
grant select, insert on public.hris_orphanage_returns to <that role>;
-- If RLS is on and the key is not service_role, add INSERT + SELECT policies for that role.
```

   OMS reads a week as: the rows of the newest `push_id` for that `week_start`. Older
   pushes stay as history; the HRIS never deletes them.
2. **PENDING — Kane sets `OMS_RETURN_TABLE`** (e.g. `hris_orphanage_returns`) in `.env.local`
   **and Vercel production**. Unset ⇒ the modal says so and Send stays disabled.
3. **The "Send to OMS" button is wired (2026-10-03, Kane: *"Send to OMS - fix this code wise"*;
   committed, NOT pushed).** It sits after **Load Orphanage Hours** in the Refresh / Load row and
   only opens the modal: no spinner, because the modal carries the loading. It is disabled while
   `sendBlockedReason` is set (Test mode, replay, no period), and its wrapper's `title` names the
   reason, because a disabled button gets no hover. `src/lib/oms/oms-panel-wiring.test.ts` pins
   the four points (it opens the modal, the disabled guard, Test and replay both block, and no
   spinner), so the button cannot silently disappear again. From 2026-09-28 to 2026-10-03 the modal
   shipped with nothing opening it: the one edit that added the button was refused by a permission
   classifier and not retried. Audit items 235, 334. **Steps 1 and 2 are still PENDING**: until OMS
   creates the table and `OMS_RETURN_TABLE` is set, the button opens a modal that says *"Sending to
   OMS is not set up"*.

No HRIS migration: what we sent is recorded in the audit row and held by OMS's own table.
