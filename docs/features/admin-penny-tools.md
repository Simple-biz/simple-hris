# What Admin Penny can be asked

The capability reference for the Admin dashboard's Penny AI: the **24 tools** it
can call, what each one really answers, and — the more useful half — **what it
will refuse to tell you and why**.

Three sibling docs, and this one does not repeat them:

| Doc | Covers |
|---|---|
| `admin-penny-console.md` | the console *surface* — activity frames, the terminal styling, the CRT power-on, `/clear`, the engine, attachments and table structuring |
| `ceo-assistant.md` | the shared widget and the CEO's own payroll tool set |
| `employee-penny-ai.md` | the employee bubble (Haiku 4.5, metered, no identity argument) |

**Where it lives:** Admin → Penny AI (the tab) and the chat bubble on every Admin
tab. Route `POST /api/admin/penny-chat`, gated by `requireAdminSession()` —
elevated **and** the `admin` role, stricter than the CEO route. Engine is
`claude-opus-5` with thinking on and effort `high`, falling back to
`claude-opus-4-8` if the model declines. **Admin is not metered** — the ten-a-day
allowance is the employee surface only.

**Everything is read-only.** No tool writes to the database, and the model never
writes SQL — each tool is a narrow, pre-shaped query. The console's boot banner
claims "read-only" and "audited", and a test pins both: the banner text *and*
that the route still writes `admin_assistant.query`. If Penny ever gains a write
tool, that banner is lying and the test is where you will find out.

---

## 1. Finding a person

Penny is told to call **`find_employee` first** whenever you name someone, and to
**ask which one** if several match rather than guessing. So "what happened to
Mark" costs an extra step — "what happened to markm@simple.biz" does not.

| Tool | Ask it |
|---|---|
| `find_employee` | Resolve a name or partial email to the exact `work_email` every other tool needs. Returns 0, 1 or several matches — **active AND off-boarded people** (since 2026-09-15). Every match carries `status`; an off-boarded match also carries when they left, the recorded reason, who recorded it, and every department their master rows held. Active matches rank first. |
| `get_employee_profile` | A balanced read on a person: identity, department, employee id, start date, current regular + OT rate, self-entered skill sets, **recognition** (commendations) **and concerns** (manager "flag for review" notes). Deliberately returns both sides so an assessment is never praise alone. |
| `get_employee_access` | What someone is *allowed* to do: active roles, which dashboards they can open, the per-tab hidden/view/edit overlay, departments they manage, and the admin / elevated / pay-rate-visible flags. **Access rights, not pay.** |

## 2. Who did what — forensics

| Tool | Ask it |
|---|---|
| `search_audit_log` | Any "who did / who changed / who opened / when did" question, across the whole HRIS. Filter by dashboard (`surface`), action family (`action_prefix`, comma-separated for several), actor, affected person, and date range. |
| `list_audit_actions` | What action names *actually exist*, with counts and first/last seen. Reads the live table, so it is right even when a tool description has rotted. Use it when a search comes back empty and you suspect the name. |
| `get_change_timeline` | **One person's complete record, merged.** The right tool for open-ended "what changed for X", "walk me through X". Pulls audit events from every family naming them, plus `bank_update_history`, `employee_rate_history` and `payroll_wizard_notes` into one chronological list. Narrow with `kind=` (bank / rate / identity / access / employment / payroll). |
| `get_payroll_notes_history` | Who edited the Payroll Notes board and **what the note actually said**. The raw audit events carry only a row id and the field names touched, so this one resolves each edit back to the worker, pay week, note text, adjustment and Done state. |

**The action families in `search_audit_log`'s description are generated from
`src/lib/audit/registry.ts`** — the same registry the Admin audit panel filters
by — so the list cannot drift from the log the way its hand-written predecessor
did.

## 3. One person's history, by kind

| Tool | Ask it |
|---|---|
| `get_rate_history` | Every rate change with **who set it**: the `employee_rate_history` rows, the Payment Catalog structure (the current source of truth) with who created/updated it, and the matching audit events. For the current *effective* rate use `get_employee_profile`. |
| `get_transfer_history` | Department transfers — from, to, when, who requested and approved. Omit the email for recent transfers company-wide. |
| `get_onboarding_info` | Start date, department, employee id, plus the HR onboarding submission: who invited them, when paperwork was submitted, status, and onboarding-pipeline audit events. Takes a work **or** personal email. |
| `get_offboarding_info` | *(2026-09-15)* Whether and how someone **left**: every master-list row's off-board stamp (date, reason, note, **who recorded it**, deletion schedule), the HR off-boarding queue request (who asked, who processed, when decided), the Offboarded-sheet ledger row, and the `hr.employee.*` / `offboarding.*` / `manager.suspended` audit events — plus whether they are on the active roster right now. `status` is `offboarded`, `active`, `mixed` (a stamped row beside a live one: re-hire, temporary pause or duplicate) or `not_on_master_list`. Takes a work **or** personal email. |
| `get_bank_change_history` | Who changed someone's payout details. Returns the non-clearable `bank_update_history` trail (fields written, **masked** before→after, processor, channel, IP) plus admin-side audit events. |

## 4. The files on record *(new — 2026-09-12)*

| Tool | Ask it |
|---|---|
| `list_employee_attachments` | **Every file this HRIS holds about one person**, as openable thumbnails — not a description of them. Time-adjustment evidence screenshots, MESA receipts, requested documents **and their signed copies separately**, the onboarding W-8BEN and IP assignment, and the profile photo. |

Images open in a lightbox over the console; PDFs open in a new tab. Narrow with
`source=`, or ask for everything.

Two things to know before you rely on it:

- **There is no ID photograph and no bank-card photograph in this HRIS.** See
  §6 — this is the single most likely wrong assumption about this tool.
- **Opening a file is audited** (`admin_assistant.attachment_opened`), and the
  link is minted at the moment you click, not when Penny lists it. Each source
  keeps its own lifetime — the W-8BEN's link lasts **5 minutes**, an ordinary
  document's an hour.

Pay plans are **not** included: they are keyed by (department, country), so a
pay plan is a departmental document a person merely received, not a record of
theirs.

## 5. Pay, payroll and system state

| Tool | Ask it |
|---|---|
| `get_employee_pay` | One person's recent weekly pay, **reconciled on the payroll's own identity** (`payment-dispatch.md` §4.2.3): hours, **hourly pay** (regular + OT, never called "computed"), the bonus **itemised into PAB / Tech / Other / Adjustment**, Orphanage, the MESA deduction and disbursement, and what was actually paid in **both ₱ and $**. The itemization is read from the **Payroll Wizard final-pay snapshot** — the carrier that priced the payment — because `payment_dispatches.system_bonus_label` names only the PAB/Tech part (₱157,805 labelled "PAB ₱5,000" on a real row). Plus a summed total so "add up the last four weeks" answers directly. An unreconciled remainder comes back as `unexplained_php`, never attributed. |
| `get_payroll_report` | Company-wide weekly totals: paid, to how many people, still outstanding. **Since 2026-09-17 `paid_php` / `paid_usd` / `paid_count` come from the live dispatch log — what actually LEFT, bonuses and adjustments included.** Before that the peso column was `disbursement_records.amount_php`, regular + OT only, understating four weeks by **₱14.4M (~28%)** while the USD column beside it was right. A cycle with no dispatch rows keeps its record figures and carries `paid_php_warning`. `outstanding_usd` is still regular + OT only. |
| `get_financial_summary` | A **calendar month**'s payroll financials with a per-week breakdown *and* the prior month's headline plus % change — enough to write a trend. Pass `YYYY-MM`. |
| `get_overtime_leaders` | Rank people by overtime over recent pay weeks, with the exact period covered so a report can be labelled. |
| `get_department_bonuses` | Rank departments by bonuses actually awarded, from the Payment Catalog. Cross-currency totals are approximate — the amounts are stored mostly in PHP. |
| `get_bonus_breakdown` | *(2026-09-15)* **Where one person's bonus for one pay week came from.** Side by side: what the HRIS *shows* (the Payroll Wizard's final-pay snapshot — PAB, Tech, other bonuses, accounting Adj., final; the staged/paid paystub lines; the paid dispatch's system-bonus line) and every *source* (each HSL KPI Calculator row with the manager's inputs, the rule behind each input, whether the period is `ready`/`locked` = payable and who locked it; each Payment Catalog department row such as Lead Gen appointments; the wizard's per-person toggles and Adj.; the Payroll Notes adjustments for the week) — then a **reconciliation**: do the sources add up to the shown figure. Lists every master-list row the person has, because a duplicate identity is scored in several calculators. `week` is any date in the Sunday–Saturday week; defaults to the just-completed week. |
| `get_hours_uploads` | The weekly Hubstaff batches behind each pay run: source file, period, uploader, row count, and which batch the wizard is currently using. |
| `get_uploaded_hours` | The raw hours *inside* one batch — time logged before rates or bonuses. For money, use the pay tools instead. |
| `get_payroll_wizard_notes` | The clerks' carry-over checklist: open items by default, grouped by who wrote them. |
| `get_payroll_wizard_status` | Is payroll running right now — the processing lock (who pressed Start Processing and when), the current cycle, live paid/remaining progress with a per-department breakdown. |
| `run_diagnostics` | The same health probes as Admin → Diagnostics: Supabase + Postgres, pg pool, Hubstaff freshness, master list, audit log recency, disbursements, auth, daily reports, app settings, Sheet syncs, rate history, onboarding + offboarding, rates, tickets, time adjustments, payroll notes, MESA. |

---

## 6. What it will not tell you, and why

This is the section worth reading twice. Every line is a deliberate refusal, not
a gap waiting to be filled.

- **There is no photograph of a government ID and none of a bank card anywhere
  in this system.** The two things *named* "ID card" and "Bank card" are
  **renderings**: the employee ID badge is generated from roster data
  (`employee-id-card.md`) and the People bank card draws the payout record
  (`people-bank-card.md`). Penny is instructed to say so plainly rather than
  offer the nearest lookalike. If real ID capture is ever wanted, that is a new
  surface with an upload path, a retention rule and a consent question — not a
  Penny change.
- **Full account numbers are never stored in the change history and never
  returned.** `get_bank_change_history` masks before→after values.
- **Penny must not blanket-attribute a bank change to the employee.** The
  `channel` decides: `external_link` is the employee themself through the secure
  link; every other channel is a staff member acting on their behalf, and Penny
  is told to name that admin from the matching audit event. It is also told to
  **flag a mismatch** between the account-holder name and the employee's own —
  complete bank details can still be the wrong person's.
- **Absence within a window is not absence.** Every history tool returns a
  coverage note saying how far back it searched, and Penny is instructed to say
  *"nothing on record since <date>"* rather than *"this never happened"*. This
  rule exists because the per-person tools once scanned only the newest 300
  events per family — about **two days** of `bank_update.*` — and answered "no
  records" for anything older. See `penny-audit-log-visibility` in memory.
- **An action absent before its `first_seen` was simply not audited yet.** That
  is not evidence the underlying thing never happened.
- **Profile edits before 2026-07-31 record only *which* field changed, not its
  old value.** Penny names the field and the actor and does not guess what it
  changed from.
- **`pab_exclusion.*` events have no author before 2026-08-20.** The 107
  pre-existing entries cannot be backfilled.
- **The audit log can be truncated by admins** (only events older than 90 days,
  and the purge itself is audited). Bank changes also live in a dedicated
  non-clearable history, which is why `get_bank_change_history` reads both.
- **The `auth-login` probe always reports a warning by design.** Penny mentions
  it only if asked.
- **It never answers a data question from memory.** If a tool errors or returns
  nothing, it says so and suggests what to check — it does not fabricate an
  event, a date, a rate or a status.
- **An off-boarded person is never "not in the system".** `find_employee`
  returns leavers with `status: offboarded` and the date; only zero matches
  across active *and* off-boarded rows means the name is unknown. Until
  2026-09-15 the search covered the active roster only, so someone off-boarded
  the day before a question (adrianm@simple.biz, 2026-09-14) was reported as
  absent while his pay records were sitting one tool away.
- **It cannot recover what a KPI score used to be.** The HSL KPI Calculator and
  the Payment Catalog calculators save without an audit row (a deliberate
  decision — autosave volume, see `audit-log.md`), so `get_bonus_breakdown`
  quotes the **current** stored value of every source. When the sources do not
  add up to the wizard's figure it says so, compares the snapshot's save time
  with each source's, and stops — it does not infer the value that was
  overwritten.
- **A missing money figure means "not recorded", never ₱0 — and never "we do
  not store this".** `get_employee_pay` **omits** a money field it does not have
  rather than returning `null`, because a null cannot be told apart from a
  genuine zero or from a code path that never ran. That distinction is not
  academic: on 2026-09-17 a `paid_amount_php: null` — emitted by an overlay that
  skipped every *already-paid* week — was reported to the CEO as *"the system
  stores the actual paid amount in USD only"*. It stores it in
  `payment_dispatches.amount_php`, and always had.
- **`system_bonus_label` is NOT the bonus.** It is frozen from the dispatch and
  names only the PAB/Tech part of a total that may be far larger — measured
  2026-09-17, `kaner@`'s 2026-08-23 row is `system_bonus_php: 157805` labelled
  **"PAB ₱5,000"**, with ₱152,805 of Other Bonuses invisible behind it. Penny
  itemises from the wizard's final-pay snapshot instead, and where the label
  still understates the total the result carries `bonus_label_note` telling it
  to ignore the label.
- **A week with no wizard snapshot is `breakdown_unavailable`, not a ₱0
  breakdown.** Penny says the itemization is unavailable rather than printing
  components nobody computed. On a week that IS itemised the reverse holds — a
  ₱0 PAB is a real claim and is published, because "no PAB this week" and "we
  never checked" are different answers.
- **What a report says is OUTSTANDING does not include bonuses.**
  `outstanding_usd` and `total_owed_usd` are summed from
  `disbursement_records.amount_usd`, which is regular + OT only, so a bonus
  someone is still owed is not in the figure. Only the PAID columns were fixed
  on 2026-09-17; the owed ones cannot be, because an unpaid week has no
  dispatch row to read and the wizard snapshot is per-cycle, not per-status.
- **`get_employee_pay` says WHAT a bonus was, never WHERE it came from.** It
  reads the wizard's computed figures; it cannot see which KPI row or department
  calculator produced them. `get_bonus_breakdown` is the tool for provenance,
  and it is **Admin-only** — the CEO surface deliberately does not have it.
  When the identity does not close, the remainder is `unexplained_php` and Penny
  **must not name a cause**.

---

## 6a. Leavers and bonus provenance (2026-09-15)

Carla, on adrianm@simple.biz's Sep 6–12 bonus: *"according to all of our stuff he
should only have 250, but he has 500 in HRIS, where does the other 250 come
from?"* — then *"Also it's saying he's not in the system. How is he NOT lol"*,
then *"He was offboarded 9/14. Penny should also be able to look at the
offboards."*

Two defects, one session:

- **`find_employee` read `active_employees` only.** He had been off-boarded by
  jakec@ the previous afternoon, so Penny said he was not on the roster and
  went looking for the nearest Adrian. The search now reads the stamped
  `global_master_list` rows too (paged — 1,058 of them), collapses a person's
  duplicate rows into one labelled match, and keeps the active roster as the
  authority: a stamped duplicate beside a live row never demotes anyone.
  `getEmployeeMasterRecord`'s rule (never resolve a *login identity* to an
  off-boarded row — work emails are recycled) is untouched; a labelled search
  hit is not an identity resolution.
- **No tool read a bonus source.** `get_employee_pay` excluded bonuses (changed
  2026-09-17 — it now itemises the dispatch's `system_bonus_php` / `_label`, which
  names *what* the bonus was; `get_bonus_breakdown` remains the only tool that can
  say *where it came from*) and the audit log never sees a KPI save, so Penny had four tools that
  could each honestly say "nothing" and none that could say where ₱250 came
  from. The data had it: one `hsl_bonus_entries` row (attestation, ₱250 =
  1 × SSA.Gov), one `bonus_catalog_applied` row (Lead Gen, ₱0), and a wizard
  snapshot showing ₱250 of other bonuses. He carries **two master rows** —
  `Lead Gen` and `hsl:attestation` — so he is scored in two calculators, which
  is the shape a 250 + 250 = 500 takes. The Lead Gen dept-week was re-saved at
  15:16 that day with his appointments at 0; whether it held 1 before is
  unrecoverable, because that save is unaudited. The tool now says exactly
  that instead of guessing.

The pure rules live in `src/lib/penny/roster-match.ts` and
`src/lib/penny/bonus-breakdown.ts` (25 tests between them); the reads in
`ceo-tools.ts` / `admin-tools.ts`; the live check in
`scripts/verify-penny-bonus-tools.mts` (read-only, runs the real tool runners
against production and fails loudly).

---

## 7. The console itself

- **Progress lines are real.** Each one is a step the *server* named, sent
  before that tool ran. The only line the client asserts on its own is "Writing
  the answer", because it can see the text arriving.
- **Commands:** `/clear` wipes the screen and starts a new session. The left
  rail lists the commands so they are remembered by being visible; clicking a
  row **inserts** it into the prompt rather than running it, so a stray click
  can never wipe a transcript you were reading. An unknown slash word is passed
  through to Penny, not rejected.
- **Keys:** `enter` sends, `shift enter` starts a new line.
- **Tables** are real tables. Columns of figures are right-aligned even when the
  model omits the alignment marker, long text columns wrap while numbers never
  do, and no cell is dropped even when a value contains a stray `|`.
- **Files open in the console, not over it.** An image opens in a viewer wearing
  the same window chrome — title bar, status dot, a framing reticle — and it is
  a real modal: Escape, the ✕ and the backdrop all close it, Tab stays inside,
  and focus returns to the chip you clicked. PDFs and anything else open in a
  new tab, because a PDF viewer belongs to the browser. The link is minted when
  you click, and that click is what gets audited.
- **The transcript is ephemeral** — held in the component only, gone on reload.
  There is no server-side conversation store.

## 8. Adding a tool

Four things, or a test fails:

1. Append the definition to `ADMIN_TOOLS` (or `CEO_TOOLS`) and a `case` to the
   runner. Keep the result small, exact, and labelled with `field_notes`.
2. Add a phrase to `TOOL_PHASES` — `console-phases.test.ts` fails otherwise, by
   design: an unmapped tool prints a raw `get_bank_change_history` to an admin.
3. If it raises a new audited action, add it to `src/lib/audit/registry.ts` —
   `registry.test.ts` source-scans every `insertAuditLog` call site and fails
   the build on an action with no family.
4. Mention it in the route's system prompt, or the model will rarely reach for
   it. Add the row to §1–§5 above in the same commit.
