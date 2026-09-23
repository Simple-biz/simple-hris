# CEO Assistant

*Added 2026-06. A floating Claude-backed chat widget on the CEO dashboard with read-only payroll tools, an admin-managed API key, and an audit trail.*

A floating `/chatbubble.png` image button pinned to the bottom-right of the CEO dashboard (it swaps to an `X` icon when the panel is open; the `Sparkles` icon shows only in the open panel's header avatar). It talks to Claude (**Opus 5.5** since 2026-09-23) over a streaming endpoint and can pull **real** figures through read-only tools — the CEO payroll set, `get_access_map` (who holds access over whom), and since 2026-09-23 **every Admin Penny tool except `list_employee_attachments`** (audit log, change timeline, rate / transfer / onboarding / off-boarding / bank history, bonus provenance, wizard status, diagnostics) — e.g. *"what was Kane's last pay"* or *"add up the last four weeks of Kane's pay"*. It can also do non-data work (draft announcements, summarize pasted text, think through decisions). Access is gated to `ceo` / `admin`, and every request that touches the tools is audit-logged.

---

## Where it lives

| Layer | File |
|---|---|
| Mount point | `src/components/ceo/CeoApp.tsx` — renders `<CeoChatBubble />` at the end of the CEO shell ("CEO dashboard only") |
| Widget | `src/components/ceo/CeoChatBubble.tsx` |
| Route | `POST /api/ceo/chat` — `app/api/ceo/chat/route.ts` |
| Tools | `src/lib/anthropic/ceo-tools.ts` — `CEO_TOOLS` + `runCeoTool()` |
| Key resolution | `src/lib/anthropic/api-key.ts` — `resolveAnthropicApiKey()` |

The bubble is mounted **only** in the CEO shell at `/ceo`. The shell itself gates entry: `CeoApp` reads `/api/employee-roles?email=` and only renders for `ceo` or `admin` (`src/components/ceo/CeoApp.tsx`). The route re-checks the same gate server-side, so the widget being on the page is not the access control — the route is.

---

## Request flow

```
CeoChatBubble.send(text)
   │  POST /api/ceo/chat  { messages: [{role, content}, …] }
   ▼
route.ts
   1. getServerSession → require email → 401 if not signed in
   2. roles must include 'ceo' or 'admin' → 403 otherwise
   3. resolveAnthropicApiKey() → 503 if no key configured
   4. sanitize history (drop empties, slice content 8000, keep last 20,
      require trailing user message)
   5. tool-use loop (≤ 10 turns), streaming the final text back as
      text/plain; charset=utf-8, Cache-Control: no-store
   ▼
widget reads the body as a ReadableStream, appends each chunk to the
last assistant bubble; shows "Thinking…" until the first text token
```

The response is a **plain UTF-8 text stream** (not SSE / not JSON). The widget reads `res.body.getReader()` and concatenates decoded chunks straight into the message. There is no token framing — Claude's `text` deltas are forwarded verbatim.

### Tool-use loop

The route runs Claude's tool loop server-side (`MAX_TURNS = 10` as a backstop — 6 until 2026-09-23, raised because access and history questions chain find_employee → a history tool → an audit search):

1. `client.beta.messages.stream({ model, max_tokens, betas, fallbacks, output_config, system, tools: [...CEO_TOOLS, ...CEO_ADMIN_TOOLS], messages }, { signal })` — aborted when the widget goes away.
2. `text` deltas are enqueued to the client as they arrive.
3. On `stop_reason === 'tool_use'`, every `tool_use` block is executed via `runAdminTool` (an Admin tool) or `runCeoTool`; a name in `CEO_WITHHELD_ADMIN_TOOLS` is refused even if the model names it; each result is stamped **`fetched_at`**; the assistant turn + a `user` turn of `tool_result` blocks are pushed onto `convo`, and the loop continues.
4. Any other `stop_reason` ends the loop; `refusal` (the whole fallback chain declined) and `max_tokens` ("cut short") are said out loud rather than passed off as a finished answer. If no text was produced, the route emits a fallback line so the widget never freezes on "Thinking…".

The system prompt instructs the model to **call tools silently** — no "let me look that up" text in the same turn as a tool call — so the widget shows "Thinking…" through the tool turns and only streams the written answer at the end.

### Model + generation config

| Setting | Value |
|---|---|
| `MODEL` | `claude-opus-5-5` *(2026-09-23, Kane: "Let the CEO use - Opus 5.5"; was `claude-sonnet-4-6`)* |
| `max_tokens` | `32000` — thinking and the answer share it (was `8000` with thinking off) |
| `thinking` | **omitted** — Opus 5.5 always thinks (adaptive); `{ type: 'disabled' }` and `budget_tokens` are a **400** at every effort level. A half-applied edit that still sent `disabled` 400'd the CEO's question mid-rollout on 2026-09-23 (*"thinking.type.disabled is not supported for this model"*) |
| `output_config` | `{ effort: 'high' }` — set explicitly because this model's default is `medium` |
| fallback | `betas: ['server-side-fallback-2026-06-01']` + `fallbacks: [{ model: 'claude-opus-4-8' }]` — the array form this SDK (0.105) types; the scalar `"default"` needs the `-07-01` header, and mixing them is a 400 |
| `system` | two blocks: the static `SYSTEM_PROMPT` with `cache_control`, then the per-request date section **after** it (inside the cached block it changes every minute and voids the cache) |
| `runtime` | `nodejs`, `dynamic = 'force-dynamic'`, `maxDuration = 300` |

Opus 5.5 also rejects forced `tool_choice` (`any` / `tool`) and assistant prefill; the route sends neither. Its thinking blocks are bound to the conversation: within a request the loop appends each assistant turn verbatim, and across requests the widget sends text only, so no block is ever replayed or edited. Cost: $4 / $20 per MTok (Sonnet 4.6 was $3 / $15).

---|---|
| `MODEL` | `claude-sonnet-4-6` |
| `max_tokens` | `1500` |
| `thinking` | `{ type: 'disabled' }` (off for low latency) |
| `output_config` | `{ effort: 'medium' }` |
| `system` | inline `SYSTEM_PROMPT` (see below) |
| `runtime` | `nodejs`, `dynamic = 'force-dynamic'` |

---

## Tools (read-only knowledge base)

Defined in `src/lib/anthropic/ceo-tools.ts`. The model **never writes SQL** — each tool is backed by an existing server function or a narrow pre-shaped query. Results are kept small, exact, and labelled with `field_notes` so the model interprets them correctly.

| Tool | Input | What it returns |
|---|---|---|
| `find_employee` | `query` *(string, required)* — name, partial name, or email | `{ match_count, active_matches, offboarded_matches, matches[≤8], truncated, lookup_errors?, note? }`. Each match: `{ name, work_email, department, employee_id, status }`, plus `off_boarded_at / off_boarded_reason / off_boarded_by / departments` when `status = 'offboarded'`. The model is told to call this **first** whenever a person is named, and to disambiguate (not guess) on multiple matches. |
| `get_employee_pay` | `work_email` *(string, required)*, `weeks` *(int 1–26, default 1)* | One entry per pay week (most recent first) + a summed `totals`. Each week **reconciles** on the payroll's own identity, in both ₱ and $, with the bonus **itemised** into PAB / Tech / Other / Adjustment. |
| `get_payroll_report` | `weeks` *(int 1–12, default 4)* | Company-wide weekly totals (paid / outstanding / owed) + a combined `totals`. |
| `get_access_map` *(2026-09-23)* | one of `work_email` / `department` / `role` / `dashboard`, or none | **Who holds access over whom** — the reverse of `get_employee_access`. See below. |

The other CEO tools (`get_overtime_leaders`, `get_department_bonuses`, `get_employee_profile`, `get_financial_summary`, `get_employee_access`, `get_hours_uploads`, `get_uploaded_hours`, `get_payroll_wizard_notes`) and the Admin tools this surface also carries are described in [admin-penny-tools.md](./admin-penny-tools.md) §1–§5.

### Admin tools on the CEO surface *(2026-09-23)*

The CEO: *"Penny should know everything like who has permissions on who and what not"*. Kane chose resolution **(b)**: the CEO's Penny carries **`CEO_ADMIN_TOOLS`** = every `ADMIN_TOOLS` entry except those in **`CEO_WITHHELD_ADMIN_TOOLS`** (`src/lib/anthropic/admin-tools.ts`), **`get_bonus_breakdown` included** — Admin-only by design until that day. The one tool withheld is `list_employee_attachments`: its refs open through `/api/admin/penny-chat/attachment`, which is admin-gated, and this widget renders no attachment frames, so a CEO-only holder would be shown files they cannot open. The route refuses a withheld name even if the model produces one.

### `get_access_map`

Pure rules in `src/lib/penny/access-graph.ts` (10 tests); the read lives in `ceo-tools.ts`, so Admin Penny has it too. Reads `employee_roles`, `department_managers` and `employee_feature_permissions` (active rows, **paged** — 123 / 290 / 735 on 2026-09-23) plus the active roster, live on every call.

- **Department coverage uses the routes' own matcher**, `departmentMatchesManagedAssignments` — the one `/api/manager/department-members` and eight other routes enforce. A home-grown comparison would answer "who can see X" differently from what the routes allow, which a permissions answer must never do. A test pins that the matcher treats *Lead Gen* and *Lead Generation* as one department (negative control first).
- **Grants join to a person, not an address.** A role on an alternate work email and a manager grant on the primary one belong to the same human; the roster's four email columns fold them.
- For a person it returns both layers: the **department managers** whose grants cover them (with `holds_manager_role` — a grant opens `/manager` only with the `manager` or `admin` role) and the **company-wide** roles (admin; `can_act_on_any_employee` = admin / accounting / hr_coordinator; `can_see_pay_rates` = admin / accounting / ceo).
- `on_active_roster: false` marks an address that holds a grant but matches nobody on the active roster; `dormant: true` marks a tab grant on someone with no role that opens that dashboard. Measured 2026-09-23: 3 such addresses (`accounting@`, `ainsleyw@`, `filinglead@hoganlegal.com` — none has a master-list row) and 16 dormant Accounting tab grants.
- **Any failed read returns an error and nothing else** — a partial grant set would answer "nobody else can see this" when the truth is "some rows were not read". An off-roster person gets no department managers (they are in no department) and a note saying so, never every manager.

`get_employee_access` gained the same discipline the same day: `fetchFeaturePermissionsForEmail` returns `{}` on a read error, which read as "no tab grants"; the tool now probes the table first (not `head: true`, which hides a missing-table error) and reports the grants as unknown. Its dashboard list also names QC and Tickets instead of the raw prefix.

### `find_employee`

Loads the active roster via `getEmployeesForAuthorizedServerRoute()` **and every off-boarded `global_master_list` row** (paged; since 2026-09-15 — a leaver asked about the day after they left was being reported as "not in the system"), and filters in memory. Email queries (contain `@`) match `work_email`/`personal_email` exactly; name queries match `name` substring or the work-email local part. Each match carries `status: 'active' | 'offboarded'`; an off-boarded match also carries `off_boarded_at`, `off_boarded_reason`, `off_boarded_by` and every `departments` its rows held (a person's duplicate rows collapse to one match, latest stamp wins). The active roster is the authority — a stamped duplicate beside an active row never demotes anyone — and active matches rank first. Returns at most 8 matches with a `note` that nudges the model to ask the user when >1 match, and that spells out the off-boarded state when the single match is a leaver. The matching and labelling rules are pure and tested in `src/lib/penny/roster-match.ts`.

### `get_employee_pay`

- Normalizes the input email (`normEmail`) and **shape-guards** it with `isSafeEmail()` — rejects commas/parens/quotes/whitespace because the value flows into a PostgREST `or()` filter unquoted.
- Expands to an **alias set**: looks up the master record (`getEmployeeMasterRecord`) and adds `work_email`, `personal_email`, `alternate_work_email`, `alternate_work_email_2` (each shape-guarded), since a disbursement row may be keyed on any of the person's addresses.
- Queries `disbursement_records` (service-role client, falls back to server client) with `.or(recipient_email.ilike.<alias>,…)`, ordered by `cycle_period_start` desc, limited to `weeks`.
- Per-week entry: `period_start`, `period_end`, `total_hours`, `regular_hours`, `ot_hours`, `hourly_pay_php`, `hourly_pay_usd`, `bonus_pab_php`, `bonus_tech_php`, `bonus_other_php`, `bonus_adjustment_php`, `bonus_total_php`, `bonus_label`, `orphanage_php`, `deduction_php`, `mesa_disbursement_php`, `paid_php`, `paid_usd`, `status`, `paid_at`, `source`, `breakdown_source`, `reconciles`.
- `totals`: `weeks_returned`, `sum_hourly_pay_php`, `sum_hourly_pay_usd`, `sum_bonus_pab_php`, `sum_bonus_tech_php`, `sum_bonus_other_php`, `sum_bonus_adjustment_php`, `sum_bonus_total_php`, `sum_orphanage_php`, `sum_deduction_php`, `sum_mesa_disbursement_php`, `sum_paid_php`, `sum_paid_usd`, `weeks_reconciled`, `all_checked_weeks_reconcile` (rounded to 2 dp).
- Empty result returns a `note` ("new hire / non-payroll / paid outside this system") rather than a bare empty array.

#### Every week adds up *(2026-09-17)*

The payroll's **own two identities**, taken verbatim from
[payment-dispatch.md §4.2.3](./payment-dispatch.md#423-what-the-exports-must-carry), published
per week and checked in the result (`reconciles`, and `unexplained_php` when one does not close):

```
Regular+OT + Bonus Total + Orphanage − MESA Deduction + MESA Disbursement = Amount (PHP)
PAB + Tech + Other Bonuses + Adjustment                                   = Bonus Total
```
 Carla, pulling four cycles for
an employee: *"Why is the paid USD different from the computed USD? Wouldn't they be the
same, if not WHY?"* — then, on the answer: *"it should give me **EVERYTHING** … if it wants
to give a number like that it should be called **Hourly Pay**, not computed, computed sounds
like we total everything up, but that's not true, we are excluding adjustments and bonuses."*

She was right on all three counts, and the tool had failed her three ways:

- **A null that meant "branch never ran".** The dispatch overlay copied the paid PHP amount
  only inside `if (existing.status !== 'paid')`, so every **already-paid** week — i.e. every
  historical week — emitted a literal `paid_amount_php: null`, and the model reported *"the
  system stores the actual paid amount in USD only"*. **It does store it**, in
  `payment_dispatches.amount_php`. `disbursement_records` genuinely has no paid-PHP column;
  the dispatch log does, and the query already had the row in hand.
- **A guess on a money question.** A $79.88 gap was called *"almost certainly a bonus"* —
  against this route's own *never guess* rule — while the fetched row carried
  `system_bonus_php: 5000` and `system_bonus_label: "PAB ₱5,000"`. The select simply never
  asked for those two columns. It does now.
- **A missing third term: MESA.** `mesa_ledger.worker_contribution_php` is ₱100 a week, so
  hourly + bonus alone never equalled what landed. **`simple_match_php` (₱300) is Simple's
  money and is deliberately NOT read** — netting it would understate take-home.

Two rules the pure module enforces, both tested:

- **An unknown money figure is OMITTED, never emitted as `null`.** That is the first defect
  generalised: a `null` on a money field cannot be told apart from a genuine zero or a code
  path that did not run, and the reader will guess. Absent fields carry a `_note` saying why.
- **Two records of the same payment that disagree are both reported.** When the weekly
  record's `paid_amount_usd` and the dispatch log's `amount_usd` differ by more than a cent,
  `paid_usd_disagreement` names both figures instead of silently preferring one.

**The itemization comes from the Payroll Wizard's final-pay snapshot, not from the dispatch
row.** `payment_dispatches` freezes only a bonus **total** plus `system_bonus_label`, and that
label names only its PAB/Tech part — measured 2026-09-17, `kaner@`'s 2026-08-23 row reads
`system_bonus_php: 157805` labelled **"PAB ₱5,000"**, hiding ₱152,805 of Other Bonuses.
Describing the bonus from the label understates it by two orders of magnitude, so the week is
itemised from `app_settings["payroll.wizard.final_pay.<sourceFile>"].finals[email]` —
**the carrier that priced the payment** — reached through the dispatch row's own
`cycle_source_file` (falling back to `disbursement_records.source_file`). Where the label still
understates the total the result carries `bonus_label_note` telling the model to ignore it.

That snapshot is also the authority on **Regular + OT**: `adrianm@`'s 2026-09-06 week reads
₱9,616.00 in `disbursement_records.amount_php` but ₱9,615.03 in the snapshot, and only the
snapshot closes the identity. A week with no snapshot is marked `breakdown_unavailable` with
`breakdown_source` saying why — never a ₱0 breakdown nobody computed
([payment-dispatch.md §4.2.2](./payment-dispatch.md)). On an itemised week a **zero is
published**, because there a zero is a real computed claim.

**`bonus_adjustment_php` is SIGNED and is never gated on `> 0`** — a negative Adjustment is
Accounting withholding money, and hiding it is the one thing `payment-dispatch.md:644` forbids
outright. It is an adjustment, not a bonus, and the field notes say so.

Pure assembly + reconciliation: `src/lib/penny/pay-reconciliation.ts` (23 tests, pinned
against the four real weeks measured in production on 2026-09-17). Live check:
`scripts/verify-penny-pay-reconciliation.mts` — read-only, runs the real `runCeoTool`
against production. It **separates a code failure from a data finding** (exit 1 vs exit 2):
a week that genuinely does not reconcile is the tool working, and reporting that as a
broken build is how a verifier gets ignored. Measured the same day: `adrianm@`'s
2026-09-06 week is ₱0.97 short and is correctly returned as `unexplained_php`, unattributed.

**The totals are a closed sum only when every week could be checked.** A week paid before
its hours record was seeded contributes to `sum_paid_php` with no `hourly_pay_php` to
match it, so `weeks_unchecked` and `totals_note` say outright that the figures will not
add up — publishing a bare "all weeks reconcile" over totals that visibly do not is the
same class of mistake as the null.

`field_notes` baked into the result explain the money semantics: `hourly_pay_php` / `hourly_pay_usd` = **regular + OT pay only, hours × rate** — labelled **"Hourly Pay"**, never "computed" and never a total; `bonus_php` / `bonus_label` = the bonus folded into the payment; `deduction_php` / `deduction_label` = money withheld (MESA is the employee's own savings contribution, not a charge); `paid_php` / `paid_usd` = what actually left, bonuses and deductions already in it; `status` values `paid` / `pending` / `not_paid` / `threshold` / `problem`.

### `get_payroll_report`

> **Its peso column was salary-only until 2026-09-17.** Kane: *"Are you really sure that the
> Tech Bonus, PAB and KPI bonuses even the Adjustments are added when I pull the latest
> report?"* They were not. `listDisbursementReports()` tallies
> `paidUSD += paid_amount_usd || amount_usd` (what was **disbursed**) but
> `paidPHP += amount_php` (**regular + OT only**) — so the two money columns of the same row
> were different money and the peso one silently dropped every bonus and adjustment.
> Measured over four weeks: **₱36,704,762.39 reported against ₱51,106,248.37 dispatched —
> ₱14.4M, about 28%, missing**, ₱11.87M of it `system_bonus_php`. The PAB week (2026-08-23)
> was understated by ₱6.43M alone. USD was right to within 0.05%, which is what made it hard
> to see — the tell was the implied FX rate swinging between **38 and 49** across four rows
> where it should sit near 62.
>
> `disbursement_records` has **no paid-PHP column**, so the figure cannot be repaired from the
> records. `paid_count` / `paid_usd` / `paid_php` are now summed from the **live dispatch log**
> (paid, non-contractor, paged past the 1000-row cap — one cycle is already ~1,050 payments),
> and **both currencies come from the same rows**: a PHP from one population beside a USD from
> another implies an FX rate that is nobody's. After the fix the implied rate is 61.7–62.8
> across the same four weeks.
>
> **A cycle with no dispatch rows keeps its record figures** and carries `paid_php_warning`.
> ~2,900 records across 2026-06-21…07-12 have no paid dispatch at all, and overwriting those
> with a ₱0 sum would turn an understated week into one that reads as never paid — a worse lie
> than the one being fixed.
>
> Still not included: **`outstanding_usd` and `total_owed_usd` are regular + OT only**, so a
> bonus still to be paid is not in what the report says is owed. The field notes say so.
>
> This is the same disease the Accounting Overview hero had — salary-only figures presented as
> a total, ₱9.52M shown against ₱12.29M real, fixed 2026-07-30 via `payout-extras.ts`
> ([[overview-total-payout-salary-only]]). Worth assuming it exists anywhere a "total" is
> summed from `disbursement_records`.

Calls `listDisbursementReports()` and **drops synthesized "urgent" buckets** (MESA / orphanage budget cycles — `cycleId` contains `urgent` or `sourceFile` starts with `urgent`) so they don't muddy a payroll total. Takes the top `weeks` regular cycles. Per-week: `period`, `period_start`, `period_end`, `is_current_cycle`, `paid_count`, `paid_usd`, `paid_php`, `outstanding_count`, `outstanding_usd`, `total_owed_usd`. `totals` sums `total_paid_usd` / `total_paid_php` / `total_outstanding_usd`.

### Adding a tool

Append a definition to `CEO_TOOLS` and a `case` to `runCeoTool()`. Keep results small, exact, and source-labelled; back them with an existing server function rather than ad-hoc SQL.

---

## System prompt

Inline `SYSTEM_PROMPT` in the route. Key behaviours it pins down:

- Persona: assistant for the CEO of Simple, embedded in the HRIS; the CEO is authorized to see all payroll/employee data. Warm, concise, lead with the answer, skip preamble.
- Non-data help: draft announcements, summarize pasted text, explain the dashboard, general questions.
- **Always the latest data** *(2026-09-23, Kane: "Make sure Penny responds with the most latest and accurate data")*: every tool reads live, each result carries `fetched_at`, and the prompt tells Penny to **call the tools again for every new question** — never re-use a figure, status or list from earlier in the conversation. The readers behind these tools hold no data cache (the only cache is a Hubstaff column-schema lookup) and the route is `force-dynamic`, so staleness could only come from the transcript.
- **Everything the Admin console knows**: the prompt routes who-did-what, change history, off-boarding, bonus provenance, bank changes, wizard status and diagnostics to the Admin tools with the same reading rules Admin Penny follows (channel attribution on bank changes, "nothing on record since <date>", never guess a pre-overwrite KPI value).
- **Financial discipline**: use tools for any pay question — *never guess, never answer a financial question from memory*. `find_employee` first; disambiguate on multiple matches; `get_employee_pay` for one person; `get_payroll_report` for org-level. Call tools **silently**.
- **Fair assessments of people** (added 2026-06-25): when asked to assess/evaluate/give an opinion on a person, give an honest, balanced read — *not* flattery. Pull `get_employee_profile` first and present BOTH sides: it returns `recognition` (public commendations) **and** `concerns` (manager "flag for review" red-flag notes — CEO-visible only). State concerns plainly when they exist; don't bury them, and don't manufacture faults when there are none. The prompt also reminds the model how to read the signals honestly (commendations are opt-in praise so absence ≠ poor work; red flags are concerns for review, not verdicts).
- Reading results: **show the workings — `hourly_pay + bonus − deduction = paid`** — and call `hourly_pay_*` **"Hourly Pay"**, never "computed" and never a total; report `unexplained_php` as unexplained rather than guessing at it; treat an **absent** money field as *not recorded*, never as ₱0 and never as "the system does not store this"; flag `pending` as owed-not-yet-paid; always state which pay week(s) a figure covers; format money with thousands separators + 2 decimals + currency symbol (₱ / $); report tool errors plainly.

---

## Auth, key resolution, and audit

### Auth gate

The route mirrors the **CEO dashboard's own gate**, *not* the "elevated" set used elsewhere. `ceo` is intentionally **not** an elevated role (it can't act on other employees' payroll) but must be able to use its own assistant:

```ts
const session = await getServerSession(authOptions);   // → 401 if no email
const roles = sessionRoles(session);
if (!roles.includes('ceo') && !roles.includes('admin')) // → 403
```

### Key resolution

`resolveAnthropicApiKey()` (`src/lib/anthropic/api-key.ts`) prefers the **admin-managed DB key** over the env var:

1. `app_settings["secret.anthropic_api_key"]` (raw key string, not JSON-wrapped) — settable/rotatable from **Admin → API tokens** without a redeploy.
2. Falls back to `process.env.ANTHROPIC_API_KEY`.
3. `null` → route returns **503** with a message pointing the CEO at Admin → API tokens.

The `secret.` prefix makes `/api/app-settings` treat the key as sensitive (`isSensitiveKey`) and refuse to hand it to non-elevated callers; the full key never reaches the client (see `maskAnthropicKey`). See `docs/features/admin-api-keys.md` for the management UI.

### Audit logging

In the stream's `finally`, if any tool ran, the route writes an `audit_log` entry — sensitive payroll figures pass through, so every data request leaves a record:

```ts
insertAuditLog({
  user_name: email,
  user_role: roles.includes('ceo') ? 'ceo' : 'admin',
  action: 'ceo_assistant.query',
  resource: 'ceo_chat',
  details: { tools_used: toolsUsed },   // e.g. ["find_employee","get_employee_pay"]
});
```

Pure-chat turns that call no tools are **not** audit-logged. The log records *which* tools ran, not the pay figures themselves.

---

## The widget

`CeoChatBubble.tsx` is a self-contained client component:

- Floating `/chatbubble.png` button (amber, `motion/react` icon swap to `X` when open); panel is a `role="dialog"` card anchored bottom-right.
- Empty state shows three suggestion chips: *Draft a company-wide announcement*, *Summarize this for me*, *Help me think through a decision* — none are payroll prompts (those are typed freely).
- `Enter` sends, `Shift+Enter` newlines; `Escape` closes; autofocus on open; transcript auto-scrolls.
- **Streaming render**: on send, an empty assistant message is appended; chunks from the stream are concatenated into it. While `busy` and the last assistant message is still empty, a spinning "Thinking…" placeholder shows.
- History is the full local transcript (`messages`), sent each request; the server independently caps it to the last 20 turns and 8000 chars/message.
- Errors: non-OK responses surface the JSON `error` string in the bubble; mid-stream failures from the route arrive inline as `[Assistant error: …]`.
- Footer disclaimer: *"Assistant can make mistakes. Verify important details."*

The transcript is **ephemeral** — held in component state only, lost on unmount/reload. There is no server-side conversation store.

---

## Notes & boundaries

- **Read-only.** No tool writes to the database; the model cannot run arbitrary SQL.
- **No migration.** The feature reuses existing tables (`disbursement_records`, `app_settings`, `audit_log`) — nothing new to apply.
- **Data scope.** `get_employee_pay` covers regular payroll disbursements. **Since 2026-09-17 a bonus is itemised (`bonus_php` / `bonus_label`, from `payment_dispatches.system_bonus_*`) and the MESA worker contribution is itemised (`deduction_php`, from `mesa_ledger.worker_contribution_php`)**, so a week reconciles on screen instead of leaving a gap the reader has to guess at — that guess is exactly what went wrong. What it still cannot see: **accounting adjustments and Payroll Notes entries**, so an unreconciled remainder is reported as `unexplained_php` and never attributed. For where a bonus *came from* (which calculator, which manager input) use `get_bonus_breakdown` — Admin-only until 2026-09-23, on this surface since (Kane, resolution (b)). `get_payroll_report` excludes MESA/orphanage urgent buckets by design.
- **Currency.** Figures carry both PHP and USD where present; the model is told to format with the right symbol. Disbursement amounts are stored per the payroll currency model (see `docs/features/usd-bonuses-and-dispatch.md`).
