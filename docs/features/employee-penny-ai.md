# Employee Penny AI — a metered, self-only chat bubble on the employee Overview

Penny answers an employee's questions about **their own** pay, bonuses, policies and
who to contact, from a floating bubble on the employee **Overview** tab only. It runs
on **Claude Haiku 4.5** and gives each employee **10 questions per Asia/Manila day**,
counted server-side; the panel warns as the count falls and greys its composer when it
runs out. It reads; it never writes, and it cannot see another employee.

Shipped 2026-08-19 — the third mount of the existing Penny (after CEO and Admin), not a
fork. Commit: see `git log --oneline -- docs/features/employee-penny-ai.md`.

## Key files

| Piece | File |
| --- | --- |
| Mount | `src/components/employee/EmployeeApp.tsx` — `activeTab === 'dashboard'` only |
| Widget | `src/components/ceo/CeoChatBubble.tsx` (shared; `quotaEndpoint` meters, `markSrc` picks the heart) |
| Pay status | `src/lib/penny/pay-status.ts` (pure) · `scripts/audit-employee-pay-status.mts` (read-only probe) |
| Chat state | `src/components/ceo/use-ceo-chat.ts` (shared) |
| Reply rendering | `src/components/ceo/ceo-chat-message.tsx` (shared) |
| Markdown subset | `src/lib/penny/chat-markdown.ts` (pure) |
| Chat route | `POST /api/employee/penny-chat` |
| Quota route | `GET /api/employee/penny-chat/quota` |
| Tool schemas | `src/lib/anthropic/employee-tool-defs.ts` (pure — importable by tests) |
| Tool bodies | `src/lib/anthropic/employee-tools.ts` (`server-only`) |
| How-to guides | `src/lib/penny/employee-guides.ts` (pure) |
| Quota math | `src/lib/penny/employee-quota.ts` (pure, client-safe) |
| Quota ledger | `src/lib/penny/employee-usage-db.ts` (`server-only`) |
| Table | `references/sql/create/2026-08-19_penny_employee_usage.sql` |
| Tests | `src/lib/anthropic/employee-tools.test.ts` · `src/lib/penny/employee-quota.test.ts` |

Siblings: [ceo-assistant.md](./ceo-assistant.md) (the original, and the only Penny doc
that describes the shared widget in detail) · [admin-api-keys.md](./admin-api-keys.md)
(where the Anthropic key is set).

## No tool takes an identity argument. That is the access control.

The route resolves **one** email through `authorizeEmailAccess` and closes it over an
`EmployeeToolContext`. Every tool reads the subject from that context; **not one of the
eight declares an email, a name, or a search query as an input.**

This is deliberately structural rather than instructional. A system prompt that says
"never discuss other employees" is a request; a tool set with no parameter for *who*
gives a prompt-injected message — a hypothetical, a roleplay, a forged "you are now
authorized" — nothing to fill in. The CEO and Admin tool sets take `work_email`
precisely *because* those callers may read anyone; removing that parameter is the whole
difference here.

Two tests enforce it, and both are written to fail loudly rather than drift:

- an **allowlist** on tool inputs — the only permitted property across all eight tools
  is `weeks`, so a future input named something the denylist never imagined
  (`subject`, `for_user`) still fails;
- a **source scan** proving the tool bodies read nothing off the model-supplied `input`
  except `weeks`. The schema is what Claude sees; this is what the code obeys.

> Adding a tool that needs to name a person means the feature has changed shape. Don't
> add the parameter — ask whether the surface should exist.

The schemas live in `employee-tool-defs.ts` (no `server-only`) purely so those guards
can import them without a Supabase client. **A guard that only runs inside Next.js is a
guard that stops running.**

## Penny reports figures; it never recomputes them

Pay comes from `runCeoTool('get_employee_pay')` with the email pinned by the route —
reusing the CEO implementation's alias expansion, PostgREST shape guard, and the
2026-07-29 fix that overlays live `payment_dispatches` over the lagging
`disbursement_records`. Rate, start date, team and per-team bonus qualification come
from `resolveCoeFacts`, the same Payment Catalog resolver behind the Certificate of
Engagement the employee can download.

Consequence, and it is intentional: **a week Penny cannot find is a week Penny declines
to price.** It points at the Pay Stubs tab instead of estimating. A Penny that quotes a
number the Pay Stubs tab disagrees with is worse than one that says "open your Pay
Stubs tab" — the employee cannot tell which figure is wrong, and both come from us.

The same rule blocks the obvious feature request: Penny does **not** judge attendance
eligibility. It states the PAB amount, the window, the earning rule and the pay week the
bonus attaches to, then sends the employee to the PAB calendar on their Overview for
their day-by-day status. That verdict depends on daily hours, disputes, time adjustments
and holiday forgiveness; a second implementation would eventually contradict the
calendar, and "Penny said I qualified" is a conversation nobody should have to have. A
test pins the tool description's pointer to the calendar.

## The two configured windows must be asked for, never derived

- **PAB window**: `parsePabPeriodOverrides` → `resolvePabMonthForDate` →
  `resolvePabRangeForMonth`, the same pair the employee's own Overview PAB card uses, so
  Penny and the calendar always name the same dates. The pay week is derived through
  **`isFinalPabWeek`** (containment: `weekStart ≤ periodEnd ≤ weekEnd`) — see
  [[pab-payout-week-gate-and-pill]] for why `weekEnd >= periodEnd` is wrong.
- **Tech bonus week**: `resolveIsTechBonusWeek(monday, overrides)` against
  `listTechBonusWeekOptions`, never the raw heuristic. A direct `isTechBonusWeek(` call
  anywhere in `src/` fails the repo-wide scan in `tech-bonus-week.test.ts`, and would
  make Penny announce the heuristic's week while payroll paid the wizard's configured
  one. This file's own test asserts the **positive** (the gate and the overrides parser
  are both used); the negative belongs to that repo-wide scan and is deliberately not
  duplicated here — a regex literal of the banned pattern makes the copy an offender in
  the real guard, and widening that guard's allowlist to fit a redundant copy would
  weaken the only check that matters.

## Penny speaks first — five seconds in, once, and never into a dead end

Kane, 2026-08-19: five seconds after the employee dashboard loads, the bubble asks
whether it can help, offering *"at least 5 unique messages that Penny can achieve"*.
A speech balloon off the chat head — the same shape the Payroll Wizard's guide uses
(`payroll-wizard-tutorial-mode.md`) — with **five** FAQ chips, an "Ask something else"
escape, and a dismiss.

### Five fresh chips per page load, guaranteed

Kane, 2026-08-19: *"Only show 5 FAQs please each time refresh should be different."*
`pickFaqs` shuffles the pool while **excluding the previous load's five**, remembered in
`sessionStorage` under `penny_faq_last_shown`. Excluding rather than merely shuffling makes
"different" a **guarantee, not a probability** — random selection repeats, and a repeat is
exactly what reads as broken.

That guarantee has one precondition, and a test enforces it: **the pool must hold at least
`2 × GREETING_FAQ_COUNT`.** It currently holds 12 across 9 tools. Deleting FAQs, or raising
the count to 6, silently degrades "different every refresh" into "mostly different" — the
test fails first.

Degradation is deliberate in both directions: if the exclusion list ever swallows the pool,
`pickFaqs` **tops up from the excluded entries rather than returning a short list** (a
three-chip balloon is a worse bug than a repeated chip), and an unavailable or corrupt
store falls back to plain random instead of throwing on a render path. The RNG is
injectable so a bad-looking set is reproducible.

The pick happens in a `useState` initialiser, **not during render**: `EmployeeApp`
re-renders on its notification, dispatch-lock and MESA polls, and re-picking per render
would visibly reshuffle the chips while the balloon is open. Hydration is safe because the
balloon is not in the first paint at all — it appears five seconds after mount — so the
randomised list is never in the server HTML.

### Engaging is not a "no"

Two dismissals, and the distinction is the reason a refresh greets you at all:

| Action | Effect |
| --- | --- |
| The ✕ | persisted for the browser session — an explicit no is respected |
| Tapping a chip, or opening the panel | **this page load only**, not persisted |

Originally *opening* Penny also persisted, which meant that once someone had ever opened
the panel, refreshing showed no greeting for the rest of the session — directly defeating a
fresh set of questions per load. Corrected 2026-08-19.

> **A proactive offer is a promise, so the bar is higher than for a typed question.**
> Penny raised the subject on its own initiative; an offer it cannot fulfil spends one
> of the employee's ten prompts on an apology. So `src/lib/penny/employee-faq.ts` names
> the tool that answers each entry, and **a test asserts that tool exists in
> `EMPLOYEE_TOOLS`** — a question with nothing behind it cannot be added. Another test
> forbids the specific temptations: leave balances (not tracked), peer pay (unreachable
> by construction), and "did I earn the PAB?" (the tool deliberately does not judge
> eligibility).

**Five is the number on both surfaces.** The panel's empty state originally rendered the
whole pool; at twelve entries that was a scrolling wall of buttons (Kane, with a
screenshot, 2026-08-19: *"There is a lot in here"*). Balloon and panel now show the same
five for a given page load — shorter, and more coherent: tapping "Ask something else"
shows the questions Penny just offered rather than a different, longer list. A test pins
the count, so raising it is a decision made in `employee-faq.ts` rather than a side effect
of a caller passing a bigger array.

One pool feeds both, on purpose: a chip Penny volunteers and a chip it shows in an empty
panel must both be answerable, and two lists would drift.

### It stays quiet when speaking would be wrong

Every reason not to speak lives in one render-time expression, `showGreeting`, rather
than spread across effects — the balloon is suppressed while the panel is open, once a
conversation exists, when the shell hides the widget, and **when the daily allowance is
spent**. Inviting someone to ask a question they have no prompt left for is worse than
saying nothing.

The suppression list is a **pure, tested predicate** — `shouldShowGreeting` in
`employee-faq.ts`, not a condition assembled in the component — so the case nobody would
click through by hand (greeting someone whose composer is greyed out) is covered by a
test rather than by hope.

The five-second fuse is armed once on mount and is deliberately *not* re-armed or
gated on `open`/`messages`: a timer that long outlives any of those changing, so gating
it in the effect would be a stale closure either way. The render guard is re-evaluated
every render and cannot go stale — **if you add a new reason to stay quiet, add it
there, not to the timer.**

> **The timer effects depend on `greeting.delayMs` / `.autoHideMs` as extracted
> primitives — never on the `greeting` object.** Callers pass it as an inline object
> literal, so its identity changes every parent render, and the employee shell re-renders
> on its notification, dispatch-lock and MESA polls — i.e. well inside five seconds. An
> effect keyed on the object cleared and re-armed the fuse on every render, so **the
> greeting would in practice never have fired at all** (found 2026-08-19 from a
> `useEffect`-dep-size console warning that was itself only a Fast Refresh artifact).
> Extracting the numbers puts that guarantee in the component instead of relying on every
> caller to `useMemo`. Opening Penny at all counts as the nudge having worked and
dismisses it for the session, so closing the panel cannot bring the balloon back;
dismissal persists in `sessionStorage` per signed-in identity, so an elevated viewer
moving between employees is not re-greeted for each one. It also retreats on its own
after ~22s.

## Accounting's payment status never reaches an employee

Kane, 2026-08-19: *"All weeks should not be pending already."* Penny was passing
`disbursement_records.status` straight through, whose vocabulary `ceo-tools.ts` defines
for Accounting as **"pending = owed but not yet sent"**. On his own account that labelled
2026-06-21, 06-28 and 07-05 "pending" — weeks seven to nine weeks past.

Measured read-only and paged the same day (`scripts/audit-employee-pay-status.mts`):

| Cycle | records paid | records pending | paid dispatches |
| --- | ---: | ---: | ---: |
| 2026-08-09 | 543 | 503 | 555 |
| 2026-08-02 | 0 | 0 | 1,056 |
| 2026-07-12 | 330 | 732 | 330 |
| 2026-07-05 | 0 | 1,009 | **0** |
| 2026-06-28 | 0 | 972 | **0** |
| 2026-06-21 | 0 | 935 | **0** |

~2,900 records across those three cycles carry **no paid dispatch at all** — the gap
already recorded in `memory/never-paid-and-misdelivered-paystubs` item 3, whose question
*"were those weeks paid outside HRIS, or were the records never written?"* has been
**open since 2026-08-07**.

> **Both obvious fixes are lies about the same missing flag.** Mapping pending → paid
> invents a payment nothing evidences. Leaving it as "owed but not yet sent" asserts a
> non-payment nothing evidences either — and tells a thousand people they are owed money
> they were very likely paid months ago.

So `src/lib/penny/pay-status.ts` translates into five employee-facing states, and the raw
`status` key is **deleted** from the payload rather than renamed alongside — leaving both
in would hand the model two vocabularies and let it pick the wrong one:

| `payment_status` | When | What it says |
| --- | --- | --- |
| `paid` | paid status, or any real `paid_at` | "Paid." |
| `scheduled` | pay date still ahead | "Not due yet — scheduled for `<date>`." |
| `processing` | pay date passed ≤ 4 days | "Due `<date>`; runs take a day or two to record." |
| `not_recorded` | pay date passed > 4 days, no mark | no confirmed record — **explicitly not a claim of non-payment** |
| `on_hold` | `threshold` / `problem` | "Accounting has it flagged — ask them." |

A `paid_at` timestamp **outranks the status column**, because the column is the
unreliable half. An underivable pay date falls to `not_recorded`, never to `scheduled` —
claiming a week is upcoming when its schedule cannot be computed is a guess dressed as
reassurance. The grace window exists so that Tuesday's payroll is not called "unrecorded"
on Wednesday.

This keeps faith with the surface next door: `app/api/employee/paystub/route.ts:47-59`
deliberately does *not* gate stubs on a paid dispatch, because doing so "would hide most
(or all) of an employee's weeks". **An unmarked week is not presented as unpaid anywhere
in the employee suite.**

**The CEO and Admin assistants keep the raw status** — Accounting needs the ground truth
including its holes. Only the employee wording changes, and `disbursement_records` is not
touched: closing the underlying gap needs an answer to that open question, not code.

## Self-service guides: procedure is data, and it is tested against the UI

`get_company_how_to_guides` returns three procedures — request a **COE**, get
**pay stubs**, file a **leave request** — each naming the real tab, the real button
and the real options (added 2026-08-19 at Kane's request).

They live in `src/lib/penny/employee-guides.ts` as data rather than prose in the
system prompt, because **a guide that names a button which no longer exists is worse
than no guide**: the employee loses five minutes, then asks HR anyway, having learned
that Penny makes things up. Tests assert every label still appears in the component
that owns it — the Profile tab labels in `EmployeeProfile.tsx`, the sub-tab labels and
all five leave types in `EmployeeLeaves.tsx`, the document-type strings in
`documents/types.ts`, and `Request certificate` / `Submit request` /
`Signed document` / the period options in `RequestDocumentsTab.tsx`. Rename any of
those and the suite tells you Penny is now lying.

The guides carry the counter-intuitive facts, and the tool's `field_notes` tell the
model to keep them:

- **A COE has nothing to attach.** Every other document type is a file the worker
  already has; the COE is issued by Simple, so the HRIS writes it — which is why that
  button says *Request certificate*, not *Submit request*. Employees look for a file
  input and get stuck.
- **A COE can be refused.** A missing start date, department or rate returns 422 rather
  than printing blanks (`documents-tab.md` § Refusals), so Penny warns instead of
  promising a certificate.
- **"Pay stubs" means two different things.** The Profile → Pay Stubs tab is instant and
  needs nobody's approval; the signed copy for a bank/loan/visa goes through Profile →
  Request Documents and waits on Accounting. Confusing them is why someone waits three
  days for a file they could have downloaded in one click.
- **Reconstructed weeks are estimates.** Weeks rebuilt from logged hours exclude
  performance bonuses and manual adjustments, so the total can differ from what was paid.

### The notice period is per-team, and Penny may not invent one

Measured 2026-08-19: **10 teams publish an advance-notice period — one week for nine of
them, two weeks for AI/Automation — and the company-wide fallback carries no attendance
policy at all.** There is no company-wide value to fall back on.

So the leave guide takes the notice sentence from `policiesForDeptKey(deptKey)` **verbatim**
(never parsed into a number — the sentence also carries the attendance-bonus condition), and
for a team that publishes none it says so and points at the manager. This is
`employee-team-directory.md:176` holding: *"a default would tell someone the wrong shift."*
Folding the value into this tool rather than making the model chain `get_company_policies`
is deliberate — a forgotten second call is exactly how an invented notice period reaches
an employee.

> **Kane, 2026-08-19, asked for "the notice period" and this is the answer he got: the
> team's, or none.** If a company-wide default is ever wanted, it is a change to
> `COMPANY_WIDE_POLICIES` plus this doc, the memory entry, and the test that pins the
> omission — not a line added to a guide.

**The form enforces no notice period.** `EmployeeLeaves.tsx` validates only that the start
date is today or later and that the end date is not before it; a request for tomorrow
submits fine. A test pins the guide saying so, because implying the system blocks a
short-notice request is a plain untruth about how the software behaves.

## Policies: the two absent rules are absent on purpose

`get_company_policies` returns `policiesForDeptKey(deptKey)` verbatim plus a
`has_team_page` flag. When a team has no published page, the company-wide fallback
**omits the workday window and the time-off notice period** — the two policies that
genuinely differ per team ([employee-team-directory.md](./employee-team-directory.md)).

An LLM asked "how much notice do I need for time off?" will supply a plausible default
unless told not to. So the tool returns those two as an explicit
`unpublished_for_this_team` list, the `field_notes` say why they are missing, and the
system prompt names this as one of two traps in the data. A test pins the instruction in
the tool description: **if that sentence falls out, Penny starts inventing shifts.**

Nothing in `team-policies.ts` drives logic, here or anywhere. Penny reads it aloud.

Same principle for contacts: `get_my_contacts` returns only managers recorded against
the employee's own department. There is no canonical HR-contact record in this system, so
Penny names no one when the list is empty — it says so and points at HR generally.

## Replies are rendered, not printed — the renderer owns formatting, not the prompt

Until 2026-08-19 the design instructed the model to emit plain text and printed
whatever arrived, with pipe tables as the single exception. That bet holds for Sonnet
and loses for Haiku: employees saw raw `**bold**` and rows of `***` (Kane: *"remove
the *** it's a lot and looks ugly AF"*).

> **The fix was the renderer, not a firmer prompt.** "Do not use Markdown" is a
> request to a text generator whose strongest habit is Markdown — the loosest
> guarantee available. `src/lib/penny/chat-markdown.ts` now parses the subset models
> actually emit (bold, italic, bold-italic, strike, inline code, `-`/`*`/`•` bullets,
> numbered lists, `#` headings, and `***`/`---` thematic breaks) and
> `ceo-chat-message.tsx` maps it to React elements.

Three layers, outermost first, and **the order is the safety property**:

1. ```` ```biz-report ```` fences → a download card (CEO reports)
2. GitHub pipe tables → real `<table>`s
3. everything else → the Markdown subset

Fences and tables are consumed **before** the Markdown pass ever sees the text, so
JSON inside a report block is never reformatted. A test pins that structurally: the
block parser has **exactly one call site** (the text branch), and table cells get the
**inline** pass only — run the block parser on a cell holding `-` (Penny's
empty-value marker) and it becomes a bullet list.

No HTML is produced or accepted on this path. The parser returns data and the
renderer emits React elements; a guard test scans both files for React's raw-HTML
escape hatch by name, which is why neither mentions it even in a comment.

### The parser rules that exist because of a specific failure

| Rule | The failure it prevents |
| --- | --- |
| A delimiter followed by whitespace cannot **open** emphasis | `Rate * hours = pay. 2 ** 3` italicised the ten words between two unrelated strays. **Found by server-rendering a real reply, not by the tests** — each earlier test held only one stray delimiter, so nothing had a partner to close against. |
| A delimiter preceded by whitespace cannot **close** emphasis | The mirror case; together these are CommonMark's flanking rules. |
| `_` emphasis only at word boundaries | `work_email`, `source_file`, `some_file_name.csv` would render as `some`*file*`name`. |
| Unmatched delimiters render literally | A mid-stream reply ending in `…**` must not swallow the words after it. A test walks **every prefix** of a formatted reply and asserts no characters are lost. |
| Backtick spans are opaque | No emphasis inside `` `a*b` ``. |
| Longest delimiter first (`***` → `**` → `*`) | `***urgent***` otherwise parses as an empty italic inside a bold. |
| A rule never opens a reply, never stacks, never dangles | A hairline flush against the bubble's edge reads as a broken render. |

The employee prompt's formatting section was rewritten to match: it now shows a worked
pipe-table example, requires a table whenever the answer holds **more than one record
of the same shape** (pay weeks, holidays, leave requests), caps tables at 4 columns for
the 380px panel, and **forbids `***` and `---` as section dividers** — the renderer
handles them, but a three-sentence answer does not need them.

> **The CEO and Admin prompts were deliberately NOT changed.** The shared renderer
> gaining capability is strictly additive for them; rewriting their prompts to *use*
> bold would change how the CEO's and Admin's Penny look, which nobody asked for. They
> under-use a supported feature — not a bug. Their prompts still claim asterisks show
> literally; that parenthetical is now stale as an explanation but harmless as an
> instruction, and correcting it means accepting the style change.

## The daily allowance is a row count, and it fails closed

Ten questions per **Asia/Manila calendar day** (Kane, 2026-08-19). Manila is a fixed
`+08:00` with no DST, so the day boundary is built from the offset literal — a prompt at
23:59 and one at 00:01 Manila land in different windows, pinned by test.

**The count of non-refunded `penny_employee_usage` rows since Manila midnight *is* the
meter.** There is no counter column: a read-modify-write counter loses an update when
two tabs send at once, and that lost update is a free prompt. Row counting cannot drift
from what happened.

It is **not** kept in `audit_log`, even though Penny also audits there. The audit log is
truncatable by admins, and a truncation would silently refund the whole company's daily
allowance. Penny writes `employee_assistant.query` for the trail (who asked, which tools
ran — never the figures) and `penny_employee_usage` for the meter. Two records, two jobs.

**Reserve, then settle.** The row is INSERTed *before* the Anthropic call, so a
double-send cannot both slip past the pre-check; if the turn produces no answer text
(upstream error, aborted stream, a tool loop that wrote nothing) it is stamped
`refunded_at` and stops counting — soft-deleted, with a reason, like
`payroll_bank_exemptions.revoked_at`. A route error must never cost an employee one of
their ten, and "it errored but still counted" must be answerable from the ledger.

Every failure path **fails closed**: `countUsedToday` returns the limit on a missing
client, a query error, or a null count, and `quotaFromUsed` treats a non-finite count as
spent out. A DB outage makes Penny decline politely; the alternative is unmetered
Anthropic spend on a shared org key. This mirrors the OTP send-cap
(`src/lib/bank-update/otp.ts`), where failing open would have handed out the very thing
the cap rations.

> **The client never counts.** It renders the number the server returns — seeded by
> `GET /quota` on open, refreshed from the `X-Penny-Quota` header on every reply,
> including the 429. Clearing browser storage buys nothing. A refunded turn leaves the
> header one low until the next open re-seeds it: the error direction is always **fewer**
> questions shown, never more.

### Warn, then grey out — never vanish

Kane, 2026-08-19: *"there should be sufficient warning before it greys out or locks
out."* One escalation ladder, in `quotaFromUsed`/`quotaMessage` so the header pill and
the composer line can never disagree:

| Left | `warnLevel` | What the employee sees |
| --- | --- | --- |
| 4–10 | `none` | Neutral `7/10` pill. No nagging. |
| 2–3 | `low` | Pill brightens + "3 questions left today." |
| 1 | `last` | Amber pill + "This is your last question today. Penny resets at …" |
| 0 | `exhausted` | Composer greyed and disabled, starter chips disabled, Enter inert, the reset time and an escalation path shown. |

At zero the **bubble stays on the page** — greyed, and the heart stops beating. A
disappearing bubble reads as a broken feature and generates the HR ticket the assistant
exists to prevent. The panel still opens and the transcript is still readable.

The employee mount uses a different heart: `/Chatbubblev2.png`, the orange heart wearing a
headset (Kane, 2026-08-19), passed via `markSrc`. CEO and Admin keep `/chatbubble.png` by
default. The headset reads as a support desk, which is what Penny is to an employee —
where for the CEO it is a reports assistant. `SidebarBrandMark` is unaffected.

### The button's size drives three anchors

The button is `h-16 w-16` at `bottom-5` (Kane asked for bigger, 2026-08-19; it was `h-14`),
so its top edge sits at 84px. Three values are derived from that and must move together if
it is ever resized: the panel's `bottom-[6.5rem]`, the greeting balloon's `bottom-[6.5rem]`
(both keeping the original 20px gap), and the panel's `h-[min(560px,calc(100dvh-7.5rem))]`,
whose subtrahend preserves ~16px of clearance above the panel on a short viewport. A comment
at the panel says so, because the relationship is invisible from any one of the four numbers.

### What was removed from behind it

The Overview PAB calendar's legend carried an `ml-auto` "PAB Eligible / PAB Not Met" verdict
— i.e. in the exact bottom-right corner the floating bubble covers. Removed 2026-08-19, and
**it must not come back in that form**: it had only two states, so a period still *running*
rendered a red "PAB Not Met" — the mid-period false verdict
`memory/pab-payout-week-gate-and-pill` rules out ("running period → neutral In Progress …
don't flip the pill back"). Nothing was lost: the PAB status chip on the bonus card above it
is the real display and resolves a running period to "In Progress" via
`isPabPeriodInProgressByCalendar`. `isPAEligible` still drives five other sites, so no
computation changed.

> `EmployeePabCalendar.tsx` has the same two-state badge and was **deliberately left
> alone** — it lives on a different tab, where the bubble is not mounted, so it was out of
> scope. It carries the same mid-period flaw and is worth revisiting on its own.

## Elevated viewers: subject and meter are different people

`/employee?email=someone.else` is an existing elevated path (the shell already shows the
viewed person's notifications and badges). Kane's ruling (Q3a, 2026-08-19) splits the two
identities, and the table stores both columns for exactly this reason:

- **`subject_email`** — whose data the answer is about: `effectiveEmail`, the viewed person.
- **`session_email`** — whose allowance is charged: the signed-in human.
- Elevated viewers are **exempt** from the cap (`elevated: true` on the row), so a staff
  member reading a dashboard never spends that employee's ten. The row is recorded
  anyway — it is a record of a question asked, not of an allowance consumed.

**Any "how many has X used" query keys on `session_email`.** Counting by subject would
charge an employee for questions staff asked about them.

A plain employee cannot reach this path at all: `authorizeEmailAccess` 403s a non-elevated
session requesting another address, on the quota route as well as the chat route, so the
indicator can't be used to probe whether an address exists.

## Haiku 4.5 is an older-generation model — do not copy the Admin route's config

Kane specified Haiku (`claude-haiku-4-5`, the bare id, never date-suffixed). Its request
surface is **not** the Admin route's:

| Setting | Value | Why |
| --- | --- | --- |
| `thinking` | **omitted** | `{type:'adaptive'}` is not this model's shape. Omitting means no thinking — right for a fast FAQ. |
| `output_config` | **omitted** | `effort` **errors** on Haiku 4.5. Copying `{effort:'medium'}` from `penny-chat/route.ts` breaks every request. |
| `max_tokens` | 4000 | No thinking shares the budget; enough for a small pipe table. |
| `MAX_TURNS` | 4 | find-the-fact → answer. A low ceiling stops a confused loop from spending a prompt on nothing. |
| `maxDuration` | 120 | A cold Supabase read plus two tool turns can outrun 60s. |

The system prompt is **split in two blocks**: a static one carrying `cache_control`, and
an uncached tail holding the date and the employee's name. The sibling routes stamp the
clock *inside* the cached block, which invalidates the prefix on every request — a cache
that never hits. Keep anything per-request out of the cached half.

The transcript guard from both siblings is here too, and matters more: after slicing
history, **leading assistant turns are dropped**, because an alternating transcript
sliced to an even count starts on an assistant message and the API rejects it with a 400.
Ten prompts a day makes that reachable within a single day's conversation.

## What Penny refuses

Encoded in the system prompt, and true of the tools regardless of what the prompt says:

- **Another person.** No tool can look one up. Penny says it can only see their own
  information — for any framing, including a claimed authorization.
- **Any change.** No time adjustment, pay correction, record edit, leave approval or
  payment. It points at the form on their dashboard or at their manager.
- **Any promise.** Never "your payment will arrive" or "your bonus is approved".

`get_my_leave_requests` returns a request log, never a balance — this system does not
track a leave allowance, so a "days remaining" answer would be fabricated.

## Deploy notes

1. **Migration — PENDING until Kane confirms.** The table does not exist yet:
   ```
   node scripts/apply-penny-employee-usage.mjs            # verify only (default)
   node scripts/apply-penny-employee-usage.mjs --apply    # create the table + indexes
   ```
   Needs `DATABASE_URL` in `.env.local` (direct port 5432, not the pooler). Idempotent;
   a re-run is a no-op. Nothing to back up — the table starts empty, and an empty ledger
   correctly reads as "nobody has spent a prompt today".

   **Until it is applied, Penny is unavailable to employees, by design:** `countUsedToday`
   fails closed on the missing table, so every employee reads as spent out. That is the
   fail-closed rule working, not a bug — no unmetered spend before the meter exists.

2. **Anthropic key** — reuses the existing one (`app_settings["secret.anthropic_api_key"]`,
   else `ANTHROPIC_API_KEY`). No new key, no new env var. With none configured the route
   returns 503 with employee-safe copy.

3. **No new notification type, webhook, cron, or RBAC entry.** Employee tabs are not in
   `FEATURE_CATALOG` (there is no `employee` FeatureViewKey), and the bubble is not a tab,
   so nothing needs a grant. Page-visibility settings do not hide it — it follows the
   Overview tab.

4. **Cost.** Haiku 4.5 at 10 questions/employee/day across ~1,000 employees is the
   ceiling this feature was given; there is no separate kill switch beyond removing the
   mount in `EmployeeApp.tsx` (one conditional) or clearing the API key.
