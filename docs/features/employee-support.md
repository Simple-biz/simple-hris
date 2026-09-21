# Employee Support — an employee-filed ticket, answered by five named people

A button beside FAQs on the Employee Dashboard opens a form; what the employee writes becomes a
numbered support ticket that five named people answer from their own tabs inside `/tickets`. It
exists because a question about a payslip, a missing bonus or a time adjustment had nowhere to go —
it became a chat message to whoever seemed likely, with no record, no number, and no way to see
whether anyone was dealing with it.

**Approved by Carla Thomas 2026-09-15** (signed, `Employee-Support-for-approval.pdf`).
**The data layer shipped 2026-09-16 in `99716520`.** **The employee side shipped 2026-09-21** — the
Help button, the filing form, the ticket history with its track map, and the routes behind them.
**The staff board shipped 2026-09-21** — the line, the board, claim/rank/reassign, reply/close/
reopen; see *The staff board — shipped 2026-09-21*. The live chat half is a separate document —
`employee-support-chat.md` — and was built first by Kane's override; see *The chat came first*
below.

> The governing plan is `docs/superpowers/plans/2026-09-14-employee-support.md` (v1) plus
> `docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md` (the staff board). Read
> both before changing anything here: they carry the signed decisions, the reasoning, and the task
> lists.

## Key files

| Piece | File |
| --- | --- |
| Tables | `references/sql/create/2026-09-16_employee_support.sql` |
| Migration runner | `scripts/apply-employee-support-migration.mts` + `Apply Employee Support migration.cmd` |
| Vocabulary — statuses, categories, labels, `ES-` format | `src/lib/support/types.ts` |
| Support window (Eastern) | `src/lib/support/hours.ts` |
| Category routing / the steered subjects | `src/lib/support/routing.ts` |
| Language screening | `src/lib/support/screening.ts` |
| Who hears about an event | `src/lib/support/recipients.ts` |
| Triage: the line/board split, the sort, the counts | `src/lib/support/triage.ts` |
| Lifecycle: who may claim/rank/reply/close/reopen/reassign | `src/lib/support/lifecycle.ts` |
| The live channel's shared contract | `src/lib/support/ticket-live.ts` |
| Staff board route (list + claim/rank/reassign) | `app/api/support/tickets/route.ts` |
| Staff thread route (reply/close/reopen) | `app/api/support/tickets/[id]/reply/route.ts` |
| Staff board UI | `src/components/tickets/SupportTicketsTab.tsx` |
| Audit family `employee_support.` | `src/lib/audit/registry.ts` |

## It is not on the dev ticket board, and that is not a preference

Three measured facts rule out reusing `public.tickets`, and each is a reason on its own:

1. **`tickets`, `ticket_comments` and `ticket_events` have no RLS and no policy, and all three sit
   in the `supabase_realtime` publication** (`references/sql/migrate/2026-07-15_tickets_kanban.sql`).
   Authorization is entirely in the route handlers. That is survivable for *"the board flickers on
   drop"* and not survivable for *"my manager is underpaying me."*
2. **Every ticket is force-assigned to `kaner@simple.biz`** (`app/api/tickets/route.ts:91-93`), with
   owner-only reassignment and a second hardcoded copy of the address in
   `src/lib/tickets/notify.ts`. Support work that only one person can hand out is not support work.
3. **There is no `employee` role.** An employee is a signed-in user with an *empty roles array*, so
   `requireFeatureAccessAnyView` never enters its loop and default-denies
   (`src/lib/auth/authorize-feature.ts:111-128`). An employee cannot call `/api/tickets/*` at all,
   and `route-access.ts` bounces them off `/tickets`.

Carla's signed privacy paragraph says the same thing in her words: *"their own private area rather
than reusing the existing developer ticket board, specifically so that only the people you name in
Decision 1 can read them."*

**So the tables are RLS-on with zero policies, they have their own `ES-` identity series, and they
are deliberately absent from `supabase_realtime`.** The SQL file says so in capitals at `:26-33`
along with the sanctioned alternative: broadcast the FACT that a ticket changed and let each client
re-fetch through its own gated route. **Never put a message body on a public topic.** Adding these
tables to the publication would require a permissive anon SELECT policy on pay disputes.

## Granting access is the dangerous part

The five answerers are **Carla, Claire, Ainsley, Grace and Alivia** (Decision 1). **None of them
holds the `tickets` role**, and they must not get it: Carla's own *not included* table says *"the
support team only sees support questions."*

The trap is that **granting a role auto-provisions `access:'edit'` for every feature in that view's
catalog** (`app/api/employee-roles/route.ts`, `provisionDashboardTabs`). Putting an
`employee_support` key inside `FEATURE_CATALOG.tickets` would therefore hand all five the HRIS dev
Kanban at edit until an admin downgraded each by hand.

**So `employee_support` is its own role AND its own `FeatureViewKey`**, hosted at `/tickets` as its
own tabs, using the per-tab overlay (`allowedTabsForUser`) that every other dashboard already uses
and that `/tickets` had opted out of. A support-only holder sees support tabs and nothing else — by
click or by typed URL.

## The rules inside the feature

**The session writes the row, never the body.** `authorizeEmailAccess` gates, then the row is
written with `authz.effectiveEmail` (the precedent is `app/api/time-adjustments/route.ts:135`). And
`work_email` is the **master** work email resolved server-side — an employee's session email can be
a personal or alternate address, so the address they signed in with is not necessarily who they are.

**Nine categories, and two subjects that are not categories at all.** `SUPPORT_CATEGORIES`
(`types.ts:27-37`) is the six Carla printed plus Gmail, Hubstaff and Roboform from her write-in.
Nothing was crossed out. *Requesting* a time adjustment, your schedule, and time off are **steered**
to a manager by copy shown before the person types (`routing.ts`) — they are `STEERED_SUBJECTS`,
not categories, and **nothing refuses a ticket**. A misfiled ticket costs one reply; a wrong refusal
costs someone their only way to ask.

> **Open with Carla:** she wrote *"They shouldn't be able to request an adjustment through the
> support channels"*, and this is a notice that accepts the ticket anyway. Softer than her words.
> Do not harden it without asking her — and do not soften the copy either.

**A screening flag never blocks.** `screening.ts` returns a verdict, the ticket is filed either way,
and a human sees the flag beside the text. A blocking filter turns every false positive into an
employee who cannot report a problem on the one channel built for reporting problems — someone
describing harassment uses the words that were used on them. It **fails open** on an internal
error. Turning a flag into a refusal is a policy change, not a configuration change.

**Support hours are Eastern, and this is the only non-Manila window in the HRIS.** `hours.ts` stores
an IANA zone (`America/New_York`) plus local clock times — **never a fixed offset**, because Eastern
observes DST and a stored `-05:00` becomes a bug in March. Kane confirmed the zone 2026-09-16, and
on 2026-09-18 ruled that **every employee is on EST**, which closes the Manila-reader problem the
dual-zone formatter was originally built for. The formatter stays; the second zone is now belt and
braces rather than protection.

**A recipient is decided in code and is `null`, never `''`.** `recipients.ts` mirrors
`src/lib/tickets/recipients.ts`. The n8n Gmail node is **stop-on-error**, so an empty `send_to`
breaks the workflow — every hook returns early on `null`. The recipient is never chosen inside n8n.

**The claim is a compare-and-set, never a read-then-write.** A lost race is a **409** the UI
re-reads from, never an auto-merge — so two people never answer the same question, which is what
Carla was promised in step 3 of the signed flow.

**The staff list sorts longest-waiting-unanswered first, not newest.** Her words: *"Sorted so the
longest-waiting unanswered question is at the top, **not the newest**."* Kane's urgency ranking
(2026-09-18) sits *above* that rule, not instead of it: urgency descending, then longest-waiting
within each band, dated from **filing**.

## The employee side — built 2026-09-21

**The two portals.** Beside FAQs on the Employee Dashboard the button is **Help**, not Chat (Kane,
2026-09-21). It opens a chooser with exactly two doors: **Chat Support**, which opens the shipped
live-chat dialog, and **Raise a ticket**, which opens `EmployeeSupportTickets`. Both are in **both**
header clusters (mobile icon, desktop labelled), always edited together. It is **never a floating
bubble** — Penny owns the employee side's one fixed bottom-right control.

**Filing.** `POST /api/employee/support`. The row is written from the **session**, never the body:
`work_email` is the master email resolved server-side, `filed_by_email` is `authz.sessionEmail`, and
`body.email` reaches exactly one place — `authorizeEmailAccess`, which grants or denies it. Name and
work email are shown filled-in and read-only, as Carla asked. The category picker is the nine
`SUPPORT_CATEGORIES`; choosing one shows `steerForCategory`'s notice **before** the person types, and
`describeSteeredSubjects()` renders once on the form. Screening **flags and never blocks**, and the
employee never sees the flag. On success: the `ES-` number and the one-working-day promise.
**No per-day cap** (Decision 6) and **no file input** (Decision 8) — honoured by absence.

**My tickets and the track map.** `GET /api/employee/support` returns the caller's own tickets,
newest first, paged. Each carries the **track map** Kane asked for on the 18th — the four stops of
`SUPPORT_STATUS_LABELS` (Waiting → Being looked at → Answered → Closed) with the current one lit.
A reopened ticket is drawn at its *current* stop: `closed_at` survives the reopen, so the Closed stop
is never lit from that column alone.

**Replying, and the asymmetry that is deliberate.** `GET`/`POST /api/employee/support/[id]/messages`
is scoped to the caller's own ticket and answers **404, never 403,** on anybody else's id. An
**employee** reply to a **closed** ticket **reopens** it — Carla's *"either side can reply again"* —
as a compare-and-set on `status = 'closed'`, with the message written **first** so a lost race
loses the reopen (retried free on the next reply), never the reply. A **staff** reply to a closed
ticket does **not** reopen it: that is a postscript, not a disagreement. `lifecycle.ts` holds the
rule and the reasoning; the routes only enforce its verdict.

**The notification Carla signed.** *"A notification the moment someone replies."* `support.replied`
and `support.answered` are mapped to `['employee']` in `notification-views.ts` beside the chat pair;
an unmapped type reaches nobody. The recipient for every ticket event is decided in code
(`recipients.ts`) and is `null`, never `''` — the Gmail node is stop-on-error.

**Hours are Eastern only.** Both dialogs build the sentence from `SUPPORT_OPEN_HOUR` /
`SUPPORT_CLOSE_HOUR` and do **not** call `describeSupportHours`, which prints a Manila zone nobody is
in. The Help badge **never clamps a queue position to `99+`** — 100th in line is something an
employee deserves told honestly.

## The staff board — shipped 2026-09-21

**Session-log correction first.** Audit item 118 (2026-09-21) and this section, as they stood
before this pass, said the staff routes were "a paused partial in the working tree, not on `main`."
That was true when written; an unlabeled commit titled `push` (`26292c44`, later the same day)
landed `app/api/support/tickets/route.ts` in full (GET the line/board/counts via `selectAllPaged`,
PATCH claim/rank/reassign, each a compare-and-set → 409) — and neither doc was updated to match.
Found and corrected in a status-check session (audit item 121) before this build closed the
remaining gap. **The lesson, not just the fact:** a commit that lands real feature code needs a
message that says so, or the next reader has no way to know the doc under their eyes is already
wrong.

**The tab now renders.** `SupportTicketsTab.tsx` — the line, the board, the answered list and a
lazily-loaded closed list, Carla's two counts on top, a realtime pill on the same
`employee-support-tickets-sync` Broadcast topic the employee side already uses (now factored into
`src/lib/support/ticket-live.ts`, ending the "restated in two files, no third exists yet" state
those two routes' comments had carried since 2026-09-19). Every claim/rank/reassign/reply/close/
reopen control is enabled or disabled from the SAME `canStaffAct` verdict the routes enforce
(`lifecycle.ts` is pure — no server import — so the client calls the identical function), which is
what makes a control this screen shows and a write the route refuses impossible to have disagree.

**Two gate levels on one screen, and it is deliberate, not a bug.** `app/api/support/tickets`
(claim/rank/reassign) stays `edit`-gated, per the rule two sections up: somebody granted `view` and
not `edit` was held back from deciding who answers a pay dispute. `app/api/support/tickets/[id]/
reply` (reply/close/reopen) is gated at **`view`**, the documented exception, following
`app/api/tickets/[id]/comments/route.ts:43-46` — a "View only" holder can still answer a ticket, the
same way a "View only" dev-board member can still comment on their own. `SupportTicketsTab.tsx`
reflects this: the claim/rank/hand-off row is hidden without `edit`; the reply box, Close and Reopen
are not.

**`support.replied` / `support.answered`, fired for real.** The reply route stamps
`first_response_at` once, on the write where it was `null` going in, and fires `support.answered`
on exactly that write; every later staff line on the same ticket fires `support.replied`. Both map
to `['employee']` — the answerers work the line and the board they already watch, never a badge on
their own dashboard for their own replies. The n8n leg reuses the SAME `support_replied` slug the
employee's own reply route calls in the other direction, `recipient_is_employee` naming which way.

**Not exercised in a browser** — `tsc` is clean and the suite is unaffected (4075/4077, the same
two pre-existing failures tracked in [[main-has-three-failing-tests-2026-09-18]]), but nobody has
clicked through the tab yet. First staff member to open it should confirm the counts resolve and a
claim/reply/close round-trip actually lands.

## What is not built

**The staff-only trial** Carla approved — *"You and the support team try it before any employee
sees it"* — has nothing implementing it. The Help button ships to every employee the moment the
migrations run. Staging it means gating the button on the `employee_support` grant first, or
landing the dashboard wiring in its own later commit. That decision is still Kane's.

## The chat came first

Carla ticked *"Tickets first, add live chat once we know the volume"* (Decision 2). **Kane overrode
it on 2026-09-18** and reaffirmed after the contradiction was put to him; **she has not been told**,
and she is the approver of record. The chat work is
`docs/superpowers/plans/2026-09-19-employee-support-chat.md` and `employee-support-chat.md`.

One consequence that reaches back into this document: **an unanswered chat becomes a ticket**
(Kane's Q1), so these tables are the floor under the chat feature rather than a parallel thing, and
the chat migration has a foreign key into `employee_support_tickets`.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** `scripts/Apply Employee Support migration.cmd`, or
  `node --import tsx scripts/apply-employee-support-migration.mts --apply`. Dry run is the default;
  `--verify` is read-only.
- **APPLIED — measured 2026-09-21 by read-only `--verify`, all checks passed.** This was unknown
  from 2026-09-16 to 2026-09-21: the one earlier run (started by mistake) reported every object
  MISSING, and `.env.local` then held only `.env.example` placeholders for several days — see
  `docs/audits/audit-2026-09-16-session-log.md` Open items 115 and 118. The triage columns
  (`priority`, `triaged_at`, `triaged_by`) landed in the same 2026-09-21 apply via the chat
  launcher; the `triaged_by` lower-casing needs one re-run of that launcher, because the shipped
  normalize trigger predated the column and the first ALTER wrongly said it was covered.
- **Run this migration BEFORE the chat one.** `employee_support_chat_sessions.became_ticket_id` is a
  foreign key into `employee_support_tickets`.
- **Five grants by hand after deploy**: `employee_support` to Carla, Claire, Ainsley, Grace, Alivia.
  Until they exist the staff tabs are empty for everyone.
- **n8n: PENDING.** `support_filed`, `support_replied` if the email leg ships. Recipient handed over
  as `send_to`; the Gmail node never picks one.
- **No cron.** `docs/features/INDEX.md:42` — every `/api/cron/*` 401s on the fail-closed
  `CRON_SECRET` gate and the two declared crons have never once run. Anything with a lifetime
  expires **lazily on read**.
