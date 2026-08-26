# Session Log — the 15 most recent Claude sessions (Aug 25, 2026)

Reconstructed from Claude Code session transcripts. Unlike the previous logs, these 15
sessions are **not one working day** — they are the 15 most recently touched transcripts,
and they cluster into three stretches:

| Stretch | Sessions | Shape |
|---|---|---|
| **Mon Aug 4** | 4 | The HSL-vs-Google-Sheet pay reconciliation day, plus Bank Info exemptions |
| **Mon Aug 24** | 5 | People export · orientation email · orientation attendance · Attestation · wizard load rings |
| **Tue Aug 25** | 6 | Paystub transfer label · roster drift repair · dispatch export reconciliation · Kolan logo |

Continues [audit-2026-07-30-session-log.md](./audit-2026-07-30-session-log.md). Times are ET.

> **Shared checkout throughout.** Up to four sessions ran concurrently in one working tree.
> Every commit staged only its own files; several entries below explicitly record what
> another session had modified at the time. Two commits in this window
> (`667dfe9d` "Fix", `7b9fe312` "ATTESTATION") are catch-all commits that swept up more than
> their message says — noted where it matters.

---

## Big themes this stretch

1. **The Google Sheet, not the engine, turned out to be the specification for HSL pay.**
   A single employee's number (`erjiee@`, "should be 36.5 hours") unravelled into a full
   term-by-term reconciliation of the Hogan sheet formula
   `((AB*AC)+(AD*AE))+(AF*AG)+AJ+(AK*AL)` against the HRIS engine. It reconciled to the
   centavo — and proved the sheet was paying a **weekend line the HRIS paystub never
   rendered**. Downstream: **93 rate rows written to production** (22 people below sheet
   worth ₱61,282.01, 61 with no rate history at all, 10 with a sub-1.5× OT rate), and the
   `hours × rate ≠ amount` guard extended to cover the weekend line it had never
   inspected. See §Aug 4.

2. **Two "silent success" bugs, same shape, three weeks apart.** `sheet_synced = true` was
   being set from a fact about the *database* while never reading the *sheet* — ≥7
   transfers claimed a sheet write that never happened. And `upsertPayStructure`
   conflict-targeted the surrogate `id` while the DB's real uniqueness is
   `(department_key, lower(employee_email))` — for **714 employee-scoped structures** the
   "upsert" quietly degraded to an INSERT and died on the unique index. Both fixed by
   making the code resolve the *real* key before writing, not by loosening the check.

3. **Exports stopped hiding money.** The Payment Dispatch CSVs carried `PAB`, `Tech` and
   `Bonus Total` but neither `Other Bonuses` nor the signed `Adjustment` — so this cycle
   **694 rows carried ₱1,825,433 of unexplained "other"** and **6 rows were withholding
   −₱18,819.49 inside an aggregate**. Separately the log views rendered COP Value and
   System Bonus columns their own export dropped, hiding **₱5,519,915 of frozen system
   bonus across 1,606 records**. Both closed and pinned by two reconciliation identities.

4. **An email reached someone it should never have reached, and the fix moved into the
   app.** A non-Lead-Gen hire got the orientation Zoom link because *nothing anywhere*
   scoped the send by department — the email's Lead-Gen-ness existed only in its copy. The
   gate now lives in the sender and **fails closed** on a blank or unrecognised
   department; the n8n Filter node is layer two, so losing it in the cloud UI can't reopen
   the hole.

5. **Orientation attendance became measurable.** "Who showed up?" produced a weekly tally,
   then its own **Orientation** inner tab on My Team. Two things fell out: attendance is
   the `orientation_attended_at` **stamp**, never `status` (rows exist carrying both
   stamps, and reverted no-shows carry `no_show_at` with `status='ready'`); and the panel's
   week key was wrong for **46%** of the roster until it was re-anchored on HR's
   `period_start`.

6. **Accounting stopped reading a half-loaded wizard as a wrong wizard.** Every wizard step
   from Initialize (1) to Dispatch (8) now carries a determinate bottom-edge progress line,
   predicted from that step's own remembered load times, going green only when *its own*
   data lands. Went through three design rounds (conic sweep → "too premium" → plain
   orange → determinate line). **Shipped but was undocumented until this pass** —
   see [payroll-wizard-step-load.md](../features/payroll-wizard-step-load.md).

---

## Tue Aug 25

### Kolan logo on Payment Dispatch · `ce905f8f` · S
> *"Payment Dispatch - this is the new logo for Kolan"*
> 14:31 → 14:39 · `73697d56`

The read turned up a live gap before any edit: all three `logoSrc` registries already
pointed at `/kolan.png`, **and that file has never existed** — so every Kolan card had been
rendering the orange gradient monogram fallback since the rebrand shipped on 08-24.
`payment-dispatch.md:81` asserting "the live assets are PNGs at the public root
(`/kolan.png`…)" was stale.

Kane's source file was the full lockup with a **white** wordmark, which
`ui-standards.md:681` (white plate in both themes) makes invisible. Installed the **mark
only** — the dark rounded square with the eclipse, aspect 1.0, which is exactly the
"squarish mark gets vertical padding" case `payment-dispatch.md:91` was already written for.

Landed as `ce905f8f` — `public/kolan.svg`, the three `logoSrc` registries, a new
`processor-logo-assets.test.ts`, and corrections to `payment-dispatch.md:81`,
`ui-standards.md` and `public/processors/README.md`. The rebrand rule is unchanged:
**label only, the processor id stays `hurupay`** — renaming it would classify ~697 payees
as WIRES with no error.

### Wizard → Dispatch values and the export CSVs · `1f94ff70` · L
> *"…make sure that the values locked in from Payroll Wizard to Payment Dispatch actually matches and make sure that the export CSV's in there matches"*
> 12:39 → 12:59 · `0ffd7ecc`

**The values already matched.** `scripts/verify-dispatch-carryover.mts` runs the real
production precedence function against live rows. On cycle `2026-08-16_to_2026-08-22`,
**1,040 / 1,040** payees priced from the wizard, **0** fell through to the wizard-blind
recompute, **0** had itemisation unavailable, **0** failed to recompose to the amount being
sent. Worth knowing: the *first* run showed 5 snapshots rejected on the catalog-rate guard
with `chelsieb@` re-pricing ₱6,337.97 → ₱6,587.97 after the lock; by the second run all 6
had cleared because someone reloaded and re-locked in between. **That is the guard working,
and re-locking is always the remedy — never a code change.** Run that script before
believing any future "dispatch doesn't match the wizard" report.

**The exports did not match — two distinct defects:**

1. **A signed withholding hiding inside an aggregate.** No `Other Bonuses`, no
   `Adjustment`, so `Bonus Total − PAB − Tech` was a residual mixing earned money with
   Accounting's signed adjustment. This cycle: 694 rows carrying ₱1,825,433 of "other",
   86 carrying an Adjustment — **6 of them negative, −₱18,819.49 withheld** — and 67 rows
   where both were non-zero, so no arithmetic could separate them. Root cause was upstream
   of the CSV: `WizardBreakdown` and `QueueRow` never carried the fields even though both
   carriers already held them.
2. **Columns on screen that vanished from that screen's own export.** `SENT_COLUMNS` had
   neither COP Value nor System Bonus — hiding **₱5,519,915 of frozen system bonus across
   1,606 records** (939 in the 08-09→08-15 cycle alone) and the COP figure on 4,468. The
   pending worksheet's COP and TXN columns were missing too.

Two identities are now pinned by `dispatch-client-csv.test.ts` (13 tests) *and* asserted
against live rows by the verifier:

```
Regular+OT + Bonus Total + Orphanage − MESA Ded + MESA Disb = Amount (PHP)
PAB + Tech + Other Bonuses + Adjustment                     = Bonus Total
```

Three files landed outside the declared scope and were called out rather than folded in
silently — `UrgentPaymentsQueue.tsx`, `contractor-dispatch-queue.ts` and
`small-wires-wise.test.ts` all needed mechanical `otherBonusesPHP: 0, adjustmentPHP: 0` at
their `QueueRow` construction sites, forced by making the new fields required.

### "Why is kimerl@ on Readiness — offboarded?" → the sheet-sync false success · `667dfe9d` · L
> *"why is kimerl@simple.biz on readiness - offboarded? lol"* → *"How do we fix this"* → *"Apply the fix now"*
> 12:04 → 12:27 · `9cf3c1aa`

**She was never offboarded.** `off_boarded_at`, `off_boarded_reason`, `offboarding_queue`,
`offboarded_sheet` — all empty. Her row's `last_seen_upload_id` pointed at the **2026-06-11**
master sync (873 rows, suspiciously short of the usual ~1,325) while the current upload was
**2026-07-30** (1,326 rows). `active_employees` requires presence on the *current* upload, so
a row stranded on a June upload disappears from every roster surface with `off_boarded_at`
still null. The Offboarded tab's flavor-4 detector ("fell off the sheet UNSTAMPED") was the
only surface that could still see her — and she was plainly working: 38.1h then 29.5h, paid
every week.

Six people were in that state this cycle (`aimei@`, `jesr@`, `cathypa@`, `shainan@`,
`kimerl@`, `markl@`). No money was missing — pay rides Hubstaff hours, not the roster. The
exposure was their **bonuses**, which the wizard's fallback path resolves through the
active-roster master index.

**Root cause was not the sync race.** `apply-transfer.ts:89-98` skipped the Google Sheet
write whenever the DB row already held the target department, then set `sheet_synced = true`
from that DB fact. The sheet kept the pre-transfer department; the master sync's identity key
is `(LOWER("Personal Email"), LOWER("Department"))`, so the next sync would **mint a new row**
rather than update — leaving the real row stranded on an old upload.

Fix: `update-master-sheet-department.ts` now returns three distinguishable outcomes instead
of one boolean (`updated > 0` / `alreadyTarget` / real drift → `sheet_sync_error`), extracted
as a pure `planSheetDepartmentUpdate` with 8 tests pinning them apart. `alreadyInTarget`
survives but only feeds the notification wording, never the sheet verdict.

**Applied to production** (Kane approved): `scripts/fix-sheet-dept-drift.mts --apply` flipped
**6 sheet cells** and re-stamped **5 DB rows**, drift **9 → 3**. Backup at
`scripts/backups/global_master_list-pre-sheet-dept-drift-fix.json`. All six now read the
HRIS-true department, not the stale sheet value:

| | Sheet was | Now |
|---|---|---|
| `kimerl@` · `markl@` | `hsl:intake_specialist` | Lead Gen |
| `jesr@` · `aimei@` | `HSL` | Lead Gen |
| `theresaa@` | `HR` | Lead Gen |
| `noreenb@` | `Client VA` | Lead Gen |

A count that moved the wrong way (1342 → 1341 while adding 6 visible people) reconciled
exactly: **10 people were off-boarded that same day** in two batches, 6 of them in the 16:25
batch. `1342 + 5 restamped − 6 = 1341`. `global_master_list` unchanged at 2,564 rows.

### Mid-week transfer says so on the paystub · `47386073` · L
> *"If a person was transferred midweek that person's pay stub should have a label on it under its department and it should say 'Lead Gen to HSL'… this should go all paystubs from Accounting to Employee Dashboard"*
> 11:53 → 12:24 · `8786dce5`

**This is the common case, not an edge case: 277 of 281 dated transfers are effective
mid-week.** The label now renders under the Department line on the Accounting stub viewer,
the Employee Dashboard modal, the Employee Profile Pay Stubs tab, the Salary-Paid
notification, the wizard Step-8 preview, the emailed statement, and the XLSX/PDF exports —
all through one derivation.

Three decisions worth keeping:

- **It reads `department_transfer_requests`, not the `proration` block.** A transfer is a
  relabel; only a *rate* change prorates. `raymandc@` and `janrielr@` moved into HSL and back
  out inside the 2026-08-09 week with no rate on either side — they have no proration block
  at all, and they are precisely who the label exists for.
- **`applied` rows only** — narrower than the weekend-premium map, which trusts
  `applied` + `approved`. 6 `approved` rows are live with a null `applied_at`, every one still
  sitting in its old department; including them would print "Lead Gen to HSL" under a
  Department line still reading Lead Gen.
- **Staged, not derived at render time.** Paid stubs are frozen as-paid. The flip side, worth
  saying before it is reported as a bug: **already-paid stubs never gain the label.**

**OPEN — needs Kane's word.** The Department line collapses every `hsl:*` cell to
**Hogan Smith Law**; the label uses the raw transfer cell and prints **HSL — Intake
Specialist**, so a transferred HSL person's stub carries two names for one department.
80 transfers read literally "Lead Gen"→"HSL"; 133 target a sub-team and gain the suffix.
One line in `formatTransferLabel` either way.

### `python -m geotab_billing` · no commit · —
> 11:17 · `c918b79c` — interrupted immediately, nothing run.

### Monday board pass · `6768db36` · M
> *"Update our Monday Board if we have fixed anything and make sure we have completion dates"*
> 14:38 → 15:04 · `073d458c`

> **CORRECTED 2026-08-26.** This entry originally read *"skill loaded, session ended before the
> review rendered"* — written at 14:53 while `073d458c` was still running in the same checkout.
> It did not end; it landed `6768db36` eleven minutes later. Full write-up in
> [audit-2026-08-26-session-log.md](./audit-2026-08-26-session-log.md).
> **A concurrent session's transcript is a snapshot, not an outcome** — read the tail timestamp
> against the clock before recording "nothing shipped".

---

## Mon Aug 24

### Attestation gains Referral Leads and SSA.Gov · `681662f7` · M
> *"=IF(Cases>=50,Cases * 100,IF(Cases>=35,Cases * 75,IF(Cases >=25,Cases * 50,0))) +(Referral Leads * 250) + (SSA.Gov * 250)"*
> 15:45 → 17:22 · `f14348c8`

**The tiered half was already correct** — those bands have been in `schema.ts` since the
2026-07-27 threshold correction and were left byte-identical. The delta was the two additive
terms, now two `per_unit` rules: `referral_leads` ₱250 and `ssa_gov` ₱250.

**The tier reads the case count alone.** Referral leads and SSA.Gov cannot push a scorer into
a higher band, and they pay in full when cases fall under 25 and the tiered term is ₱0.
Attestation has no `monthlyMax`, so nothing truncates them.

**Not retroactive — measured, not assumed.** `calculated_bonus` is frozen at save, and a
*recompute* is also unchanged because pre-change `kpi_data` carries no such keys and
`calcBonus` reads absent as `0`. Verified against the live DB after the edit: **174 saved
Attestation rows, zero divergence.** Kane's formula, transcribed literally, was then run
against the shipped code across **50,869 combinations** (cases 0–300 × leads 0–12 ×
SSA 0–12) — every one matches.

**Operational, not code:** Attestation is `cadence: 'weekly'`, so it sits inside the wizard's
unconditional `hslKpiAmounts` auto-pay pass. The ₱250 terms reach the paystub with **no
toggle** — Accounting must not also key them into the Adjustment column, or it double-pays.

Also flagged: `681662f7` **was pushed** — not by this session, but by the concurrent
orientation-attendance session, which carried it along in the shared checkout.

### Orientation attendance — tally, then its own tab · `06f7f669` · `d08a9948` · `d24b49a8` · XL
> *"We should have a place where we can see weekly the number of people who showed up in Orientation and the ones that were not"* → *"The week should match from HR's New Hire Checklist"* → *"Add a new tab for this please"*
> 13:40 → 16:46 · `23f06d5b`

Went through the blueprint gate twice — the first brief was rewritten when Kane pinned the
week key to HR's checklist rather than the hire's own dates.

**Two rules drove the code.**

*Attendance is the `orientation_attended_at` stamp, never `status`.* Row 717 carries both
that stamp and `no_show_at` — it is an attendance. Row 1034 carries `no_show_at` with
`status='ready'` and no attended stamp — a reverted no-show, so it is *awaiting*. Any
status-based rule mis-files both; the tests pin exactly these two rows.

*The week is HR's `period_start`*, joined on personal email. `start_date` is null on
**973 of 974** rows, so the old key always fell through to `created_at` — when HR *staged*
the hire, usually the Friday or Saturday before. It was filing **439 of 954 hires one week
early**. Measured before building: 955 of 974 rows (98%) match a checklist row; 52 emails
appear on more than one week and none twice in the same week, so the tie-break is
deterministic. The 19 with no checklist row fall back to their `created_at` week and are
**labelled** as not-on-checklist, never silently folded in. A name-match tier recovered 0 of
the unmatched sample, so it was deliberately not built.

Live shape at ship: **975 hires across 12 HR weeks, 934 attended, 41 did not, 96%.**

**Also fixed: the No-shows section was dead UI** — it filtered `status === 'no_show'` out of
a payload that never contained one. Now reads the new history endpoint, so 38 no-shows
appear as cards and (because the exports build from that list) in CSV and Excel too.

**Why an inner tab, not a sidebar tab:** `rbac-feature-permissions.md:31` — *no row ==
hidden*. A brand-new top-level tab would have been invisible to every manager until granted
per person. An inner tab inherits the existing `manager`/`team` grant.

One hole opened by the move and closed in the same commit: taking the error branch off the
New Hire Check List meant that on a history failure `checklistWeeks` empties and
`batchKeyOf` silently falls back to the wrong week key. That tab now renders an amber banner
naming the failure. **The doc and the memory both say: if anyone removes that banner, they
must remove the fallback too.**

### Only Lead Gen hires get the orientation email · `d79c1a64` · M
> Teal Crowley, Aug 21: *"This new hire is marked to start with HSL … but she still received an email with the orientation link… Can we get it fixed so anyone not in Lead Gen doesn't receive the orientation link?"*
> 13:34 → 15:40 · `19db7d8c`

**Confirmed against production first.** The hire is row 66 of the locked **2026-08-23** week:
`Giducos, Vera "Vera"` (`veraargylle@gmail.com`), department **HSL**, in a 79-row week locked
by teal@ on 08-21 20:18Z. She was the only non-Lead-Gen row, and the live n8n flow was
`Webhook → Split Out → Gmail` with **no filter at all** — so the sender shipped all 79 rows
and Gmail mailed all 79.

**Root cause: nothing anywhere scoped the send by department.** The email's Lead-Gen-ness
existed only in its copy.

The gate now lives in the **sender**, using `isLeadGenDepartment` — the same predicate that
decides whether marking a hire "orientation attended" fires the CallTools webhook, so both
orientation surfaces agree on who is Lead Gen and there is one place to change it. It
**fails closed**: blank, NULL or unrecognised department is not Lead Gen. Department is
checked **before** the email, so a withheld hire reports `not_lead_gen` rather than sending
HR after a cell that changes nothing. Withheld hires are never silent — `skipped[].reason`
splits the lock toast into a sticky "fix the cell" warning and an informational "not Lead
Gen" notice, and the department lands in the audit detail. The n8n Filter node is now
**layer two**.

Tests replay the incident week: 78 send, the HSL row does not.

**Two registry facts settled from the live config, not the seed file:**

- No new Admin → Webhooks line is needed. `new_hire_checklist_lock` is already `active: true`
  and already points at the **production** URL
  `https://simpledotbiz.app.n8n.cloud/webhook/609dd382-…`. The seed file's `/webhook-test/`
  default is stale, not the stored config.
- **A second active row, `orientation_attended`, points at the same URL.** No code resolves
  that slug — the manager "orientation attended" action fires `call_tools_creation`. Dead
  config, currently harmless, but it reads as though attendance posts into the
  orientation-email flow. **Deletion candidate, awaiting Kane's word.**

### Wizard step-rail load progress · `7b9fe312` (catch-all commit) · L
> *"…each of the steps from Initialize Payroll Data to Dispatch should have an orange outline running through its borders to tell Accounting that data is still being loaded"* → *"Already loaded tabs should… slowly turn into Green"* → *"it looks too premium please just a normal orange"* → *"…make it a line at the bottom… mimic its progress, use prediction from previous loading times"*
> 15:52 → 17:15 · `0db2ac2f`

Four design rounds. Landed on a **3px determinate line along the bottom edge**, inset 12px so
it runs on the straight part of the border: orange while filling, green on completion, holds
~1.7s, clears.

The prediction lives in `src/lib/payroll/step-load-prediction.ts`, extracted from the wizard
specifically so one invariant can be *proven* rather than asserted:

> **Prediction alone never fills the bar.** It ramps linearly to 90% across the prediction,
> then eases asymptotically toward 99% on an overrun. Only the data actually landing takes it
> to 100%.

That is the whole point — the line tells Accounting when figures are safe to read, so a bar
hitting 100% early would say "safe" early, the exact mistake it was added to prevent.

Three judgement calls recorded in the code and now in the feature doc: `orphanageDetailLoadedFor`
is deliberately **not** used (its loader never sets the marker on a failed or aborted fetch, so
a ring driven off it would run forever on exactly the case it must survive); a **280 ms grace
window** stops loader hand-offs flashing green; and the fill is written straight to
`style.transform` from a `requestAnimationFrame` loop rather than through React state.

**This shipped inside the catch-all `7b9fe312 "ATTESTATION"` commit and had no doc until this
pass** — now [payroll-wizard-step-load.md](../features/payroll-wizard-step-load.md).

**Blocked in the same session:** *"add the start date (and other columns as requested) to
DeviceMetaData per 13720"*. `DeviceMetaData` and `13720` appear nowhere in this repo or in
the sibling projects on the Desktop, and the monday.com connector is unauthorised in a
non-interactive session, so item 13720 could not be read. Stopped and asked rather than
guessing at a metadata table's columns.

### People roster export: account last-4 + bank last-updated · `edf0aa10` · M
> *"People - Export Tab - Lets add the Account number's last 4 digits? and last updated this should go to PDF, CSV and XLSX"*
> 11:45 → 12:16 · `1b421b70`

No governing doc existed for the People roster export — `hr-global-master-list-export.md`
documents the HR sibling. The doc was written in the same commit
([people-roster-export.md](../features/people-roster-export.md)).

**The full number never reaches the browser** — masked server-side at
`people-roster.ts:568`, so the client export module has nothing to leak. The masker was
lifted into a dependency-free `mask-account.ts` rather than copied, so sharing it does not
pull SheetJS into the `/api/people` bundle.

**The account is slot-aware.** Measured against production: **14** people sit on the
alternative bank slot, **8** with a different alt number, **2 of them with only an alt** — a
plain `account_number` read would print the wrong account or nothing.

**"Bank Info Updated" reads `bank_update_history`, not the self-update stamp.** The stamp is
written by 3 of the 6 routes that change payout details; the history table by all 6. All 740
stamped people have a history row and the stamp is never newer. The read is paged — 1,334
rows, and a bare select stopping at 1000 would make the tail read as "never changed".

**Fixed on the way:** the PDF's `drawHeader` wrapped each header then drew **only line 0**, so
any header too wide for its column lost the rest invisibly — `Last 4` first shipped as
nothing at all. Now draws every line, pinned by test. Column widths were re-budgeted from
measured Helvetica metrics: **Name keeps its 98pt**, because real master names
(`Cuevas, Mary Rose "Penelope"`) run 158–168pt and 76% of the roster already wrapped there.

The load-bearing test asserts no artifact contains a full account number — and it
decompresses the PDF content streams and hex-decodes pdf-lib's string literals first,
because grepping raw bytes passes *any* "text is absent" assertion and would have quietly
neutered it.

---

## Mon Aug 4

### HSL pay vs the Hogan Google Sheet — the reconciliation day · `c39fad3b` (+ 93 production rate rows) · XL
> *"Can you check how we calculate the Pay for HSL people and compare it to this?"* → *"erjiee@simple.biz should have 36.5 hours"* → *"lets follow the SHEET"* → *"APPLY ALL THE STUFF"* → *"erjie wasnt fixed why"* → *"go fix"*
> 09:32 → 13:55 · `c07e4cee` (32 prompts — the longest session in the window)

**The formula reconciled to the centavo.** Kane pasted the sheet cell
`=((AB6379*AC6379)+(AD6379*AE6379))+(AF6379*AG6379)+AJ6379+(AK6379*AL6379)` = ₱16,617.75:

| Term | Value | Meaning | Amount |
|---|---|---|---|
| `AB × AC` | 31.90 × 355.00 | Regular hours × regular rate | ₱11,324.50 |
| `AD × AE` | 4.50 × 532.50 | OT hours × OT rate (355 × 1.5) | ₱2,396.25 |
| `AF × AG` | 8.10 × 370.00 | **Weekend hours × (355 + ₱15)** | ₱2,997.00 |
| `AJ + (AK × AL)` | | MESA deduction | −₱100.00 |
| | | **total** | **₱16,617.75** |

Against the HRIS stub's visible ₱13,718.68 — **short by the entire weekend line.** The
grouping is itself a clue: `((AB*AC)+(AD*AE))` brackets the original pair with `+(AF*AG)`
appended outside it, mirroring exactly how the weekend carve-out was bolted onto the code on
2026-07-30.

**Then the real bug surfaced inside a single paycheck.** The staged payload had
`weekend.pay_php.regular = 1944.60` — that is `8.1025 × ₱240`, i.e. `225 + 15`. The weekend
hours were paid off a **stale ₱225 base** while the weekday lines used ₱355. His rate history
had `2026-07-27 → 355` set via the Payment Catalog, `2026-07-22 → 225`, and two duplicated
`1970-01-01 → 175` baseline rows — so a mid-week effective date stranded his Sunday on the old
rate.

**Carla's rule, and why the order genuinely does not matter.** Carla: *"Monday–Friday hours
grouped together, Saturday and Sunday grouped together; when sandwiched, the excess is
overtime at a half rate… the order does not matter provided they are lumped together."* Proven
rather than assumed, and it is not obvious — the ₱15 premium attaches to weekend *hours*
whether they land in the regular or the overtime bucket, so the chronological split cancels:

```
two-bucket    r·(MF+WE) + 15·WE + 0.5r·OT
chronological r·REG     + 1.5r·OT + 15·WE
and MF+WE = REG+OT  →  both reduce to  r·REG + 1.5r·OT + 15·WE
```

That is also why the sheet and the old engine agreed on all **6,782** rows despite looking
completely different — and it means the chronological day-walking the old engine did was doing
work that could never change the total.

**Applied to production (Kane: "APPLY ALL THE STUFF"), 93 rows:**

| | before | after |
|---|---|---|
| HSL rates below sheet, current week | 22 people, ₱61,282.01 | **0, ₱0.00** |
| No rate history at all | 61 people | **0** |
| OT rate below the 1.5× policy | 10 people | **0** |

Backups at `references/backups/hsl_rate_match_2026-07-26.json` and
`hsl_ot_ratio_fix_2026-07-26.json`; every row stamped in `created_by` so it is identifiable
and reversible. 21 of the 22 already had `catalog = sheet`, so this made
`employee_rate_history` agree with HRIS's own Payment Catalog.

**Deliberately not applied, and still open:**

- **4 pay cuts** (`gibsn`, `lincolnm`, `reat`, `allanc`, ₱2,262 total). A cut is categorically
  different from a raise, and the July review concluded above-sheet rates were legitimate
  manual raises newer than the sheet. **One question to Carla settles it.**
- **Swapping the live engine to `hogan-week-pay.ts`** — blocked on **90 sheet rows that break
  the sheet's own rules** (`WE Rate ≠ rate+15`, `OT Diff ≠ rate×0.5`). Wiring it in without
  knowing whether those are deliberate overrides or data errors would encode a guess into the
  payroll engine, and it **provably cannot change money** (6,782/6,782 agree), so there is no
  cost to waiting.
- **A ~2,050-row historical backfill.** Not purely records: some past weeks (06-21, 06-28) are
  still `pending`, so backfilling would **re-price those upward**. Needs its own dry-run.
- **A ₱1.14 convention split.** The sheet computes `2dp-rounded hours × rate`; the app computes
  `whole seconds × rate` (`phpHourlyPayFromSeconds`). Both self-consistent, systematically
  different, and it scales with headcount.

**The guard hole this exposed.** After the data fix, `erjiee@` still showed the old number
because the staged snapshot was frozen — but the stub was *displaying* ₱370 while *paying*
₱240 on the same line, and nothing caught it. `paystub-rate-consistency.ts` declared
`RateLine = 'regular' | 'ot'`: **the weekend line was never inspected by the guard built
specifically to stop stubs displaying a rate they did not pay.**

Extended, with two subtleties both now covered by tests: `ratesPaid` would have *defeated* the
check (his rates paid were `[355, 225]`, mapping to weekend equivalents `[370, 240]`, which
"contains" the displayed ₱370 — the weekend line now uses **plain arithmetic only**, no escape
hatch); and the `isHsl` premium headroom must **not** apply, because the weekend line's rate
already includes the ₱15. Wired at both call sites — previously neither passed the weekend
block, so the extension alone would have been inert. Guard tests 15 → 26.

**One thing in this session was later reversed.** `c39fad3b` snapped `rate_history.effective_from`
to the pay-week start. Two weeks later `273319a7` (Aug 18) removed it — snap-to-Sunday was
itself the root cause of the mid-week proration bug, and `pay-week-effective-date.ts` is
deleted. See [[midweek-transfer-proration-ruling]].

**Still Kane's to do:** re-lock the wizard for the affected cycle. The inserts do not re-price
what is already staged.

### Bank Info "Temporary Exemption" · `f45c1c2e` · L
> *"I should have a button beside the 'SET Bank' … labeled 'Temporary Exemption' … this person would pop up next week and is exempted for this week however he will be moved to the exceptions column instantly"*
> 08:31 → 15:37 · `97aa9699`

New table `payroll_bank_exemptions` (a real table over an `app_settings` blob — this codebase
has been burned by blob-style JSON racing under concurrent writes, and `revoked_at` mirrors how
`employee_roles` already handles revocation). Exempted people leave the Bank Info list **and
both bank denominators**, so the score re-curves over who is still owed attention, and land
under Exceptions immediately badged violet "Temp exempt" with an Undo.

**"Pops up next week" is automatic** — the record is keyed to the week it was filed against, so
next week's key simply does not match. No cron, no expiry sweep.

Two decisions worth keeping: the exemption is checked **after** payability, so a bank set later
just stops the row rendering instead of leaving a stale "exempt"; and identity matching is
**email-keyed with `name:` only as a last resort**, unlike the HR-exception set which always adds
a name key — the master list is full of namesakes, and a blanket name key could silently exempt
someone who was never exempted, hiding a real payday blocker.

**Scope reminder:** readiness-only. Payment Dispatch never reads the table, so an exemption does
not make anyone payable.

### "Set rate" could not update an existing rate · `d9f34ef7` · M
> Same session, second track — a raw Postgres duplicate-key error surfacing in the Offboarded tab's Set Rate dialog.

`id` is only a surrogate key. The DB's real uniqueness is the natural key —
**one structure per `(department_key, lower(employee_email))`** — but `upsertPayStructure`
conflict-targeted `id` alone. `SetRateDialog` (used by *both* the Readiness "No Pay Rate" fixer
and the Offboarded tab) never loads the structures list, so it minted a fresh `newPayId()` every
time it opened. For anyone who already had a structure the "upsert" quietly degraded to a plain
INSERT and dumped raw Postgres text into the dialog.

Confirmed against live data before touching anything: the person already had
`pay_mrz6ao7lsnkm111u` — `hogan_smith_law`, **225 / 337.50 PHP, set 2026-07-24 by breaj@** — the
exact figures being re-entered. **Blast radius: 714 employee-scoped structures.** `BonusCatalog`
was immune only because it passes `existing?.id ?? newPayId()`.

The fix resolves the slot's current occupant server-side
(`resolvePayStructureWriteTargetId`), so "set this person's rate" means the same thing from every
surface. A failed lookup now reports plainly instead of falling through to an insert that trips
the index. Emails are compared in JS, not via `.ilike()` — `_` and `%` are LIKE wildcards, and
on a pay-rate write path `a_b@x.com` matching `aXb@x.com` could overwrite the wrong person's
rate.

**OPEN, deliberately not bundled:** `upsertPayStructure` writes
`currency: s.currency === 'USD' ? 'USD' : 'PHP'` — **COP is silently written as PHP** even though
the picker offers it and `mapRow` reads it back. Live spread confirms it: `{PHP: 721, USD: 10}`,
zero COP rows ever. The one-line fix alone would make things *worse*, because `syncRateHistory`
guards on `s.currency !== 'USD'` and a genuine COP structure would start writing COP numbers into
PHP fields.

### Payment Cycle Complete — how it fires, and a manual button · design only, no commit · M
> *"How was the Payment Cycle Completed automation triggered?"* → *"There should be a manual button to declare this inside the Payment Dispatch"*
> 14:50 → 15:05 · `4d911762`

The trigger is **client-observed, server-guarded**: `PayrollDispatch.tsx` watches the same math
as the progress strip (zero pending, zero blocked, zero held, ≥1 paid) and POSTs the cycle's
facts; `/api/payment-dispatches/cycle-complete` owns the "exactly one email ever" guarantee with
an atomic plain INSERT of `app_settings` key `dispatch.cycle_complete_notified.<source_file>` —
a `23505` means already sent, so any number of browsers reporting the same completion is
harmless and Undo→re-pay never re-mails. The claim is released only if n8n delivery fails.

A manual **"Declare the win"** button was designed to Kane's answers (keep both triggers, button
in the progress strip, one click no confirmation, extract-and-share the existing logic).
**It was never built** — verified: no `onDeclareWin` exists in the codebase. The shared
`reportCycleComplete` helper the design called for *does* now exist
(`PayrollDispatch.tsx:627`), used by both the fully-paid and cycle-closed paths, so the
extraction landed via later work; only the button is missing.

### "Note Adjustments — 1 of 104 not yet in wizard" · no commit · S
> 08:40 → 08:41 · `4f76c944` — an answer, not a change.

Step 5 of the Wizard Setup checklist compares Payroll Notes board rows with a *valid* adjustment
amount (a clean number, not prose like "+500 bonus") against how many are already reflected in
the wizard's Adj. override. Amber, not red — it does **not** block dispatch. Resolve by stepping
into wizard step 4 or 5 (visiting triggers the pull and it never overwrites); if the count does
not drop, the usual causes are a locked cycle (the auto-pull is suspended while locked, by
design), the worker not being in this week's Hubstaff CSV, or a hand-edited Worker name having
cleared `worker_email`. `node scripts/diagnose-notes-adjustments.mjs` replays the exact bridge
logic and names the stuck row.

---

## Open items carried out of this stretch

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | **Re-lock the wizard** for the cycles touched by the 93 HSL rate rows | Kane | Staged paystubs still carry the old rates |
| 2 | **Carla's call on 4 pay cuts** — `gibsn`, `lincolnm`, `reat`, `allanc`, ₱2,262 | Carla | `employee_rate_history` fully matching the sheet |
| 3 | **90 Hogan sheet rows breaking the sheet's own rules** — deliberate overrides or data errors? | Carla | Wiring `hogan-week-pay.ts` in as the live engine |
| 4 | **The ~2,050-row historical HSL backfill** — needs its own dry-run; some target weeks are still `pending`, so it would re-price real money | Kane | Historical HRIS/sheet parity |
| 5 | **₱1.14 rounding convention** — sheet `2dp-hours × rate` vs app `whole-seconds × rate`. Pick one | Kane | Reconciliation at scale |
| 6 | **HSL sub-team wording on the transfer label** — `Lead Gen to HSL — Intake Specialist` (as shipped) vs `Lead Gen to Hogan Smith Law` | Kane | One line in `formatTransferLabel` |
| 7 | **3 remaining drifted sheet cells** — `shainan@` (DB says bare `hsl`, not placeable, still invisible), `beao@` and `ellainnec@` (off-board stamps, the Medilo Hanna Grace class of business call). A master sync today would mint 3 duplicate wrong-dept rows | Kane | Clicking Sync safely |
| 8 | **Delete the dead `orientation_attended` webhook row** in Admin → Webhooks — points at the orientation-email URL, resolved by no code | Kane | Nothing today; it is a misleading trap |
| 9 | **Paste the Lead Gen Filter node** into the n8n workflow that already owns path `609dd382-…` — do **not** import as a second workflow, the path would collide | Kane | Belt-and-braces only; the server gate holds regardless |
| 10 | **Decide whether non-Lead-Gen hires get any welcome email at all** — they now get none | Kane | HR communication policy |
| 11 | **COP silently written as PHP** by `upsertPayStructure` — needs the `syncRateHistory` guard widened in the same change | — | COP pay structures ever being storable |
| 12 | **"Declare the win" manual button** — designed and approved, never built | Kane | Manually firing the celebration email |
| 13 | **`cathypa@` has two identical dispatch rows** for 08-09→08-15 (₱7,092.74, both sent 08-19) — duplicate row or duplicate payment, not chased | — | Possible double payment |
| 14 | ~~Kolan logo uncommitted~~ — **closed**, landed as `ce905f8f` while this log was being written | — | — |

## Working conventions confirmed this stretch

- **Commit locally, never push.** Kane pushes. One violation observed and self-reported: a
  concurrent session pushed and carried another session's commit along.
- **Shared checkout, staged by explicit path.** Every session in this window staged only its own
  files and said out loud which modified files belonged to someone else. One session used
  `git stash` on the shared checkout and immediately verified nothing was lost — recorded as a
  mistake, not a pattern.
- **`next build` is never run while a dev server is live.** Every session on Aug 24–25 hit this
  and substituted `tsc --noEmit` plus a live-data verification of the shipped module.
- **The `executive_assistants` KPI test fails on `main` and is a known OPEN item.** Five separate
  sessions independently proved it pre-existing before reporting their own suites clean. Treat
  `n-1 / n` as green until that one is fixed.
- **Read-only probes get cleaned up.** Sessions wrote `scripts/tmp-*.mts` freely against prod and
  deleted them before committing.
- **Live verification beats a passing unit test on a money path.** Every applied change in this
  window was re-run against production read-only after the fact — 1,040/1,040 dispatch rows,
  174 Attestation rows, 448 Hogan pay slots, 975 hires into 12 weeks.
