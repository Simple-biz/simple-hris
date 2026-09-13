# What Admin Penny can be asked

The capability reference for the Admin dashboard's Penny AI: the **22 tools** it
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
| `find_employee` | Resolve a name or partial email to the exact `work_email` every other tool needs. Returns 0, 1 or several matches. |
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
| `get_employee_pay` | One person's recent weekly pay — hours, computed amount, actually-paid amount, status, plus a summed total so "add up the last four weeks" answers directly. |
| `get_payroll_report` | Company-wide weekly totals: paid, to how many people, still outstanding. |
| `get_financial_summary` | A **calendar month**'s payroll financials with a per-week breakdown *and* the prior month's headline plus % change — enough to write a trend. Pass `YYYY-MM`. |
| `get_overtime_leaders` | Rank people by overtime over recent pay weeks, with the exact period covered so a report can be labelled. |
| `get_department_bonuses` | Rank departments by bonuses actually awarded, from the Payment Catalog. Cross-currency totals are approximate — the amounts are stored mostly in PHP. |
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
