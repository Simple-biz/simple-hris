# Employee Support — an employee-filed ticket and a staffed section on /tickets

**STATUS: APPROVED BY CARLA 2026-09-15 (signed, `Employee-Support-for-approval.pdf`).
THE DATA LAYER SHIPPED 2026-09-16 in `99716520` — the header below said "nothing written yet" for
three days after it landed. Built: the two tables, the `--apply` script, and the four pure modules
(`hours`, `routing`, `screening`, `recipients`) with 31 tests. NOT built: every route, every
component, the `employee_support` feature key, the `employee_notifications` CHECK widen (task 3 has
no file at all), and the feature doc. Migration state UNKNOWN — it has never been verified, and
`.env.local` currently holds only `.env.example` placeholders.**

**~~The live chat and the queue are OUT of v1.~~ SUPERSEDED 2026-09-19 — chat is being built
FIRST.** Carla took Decision 2 — *tickets first, add live chat once we know the volume* — and
**Kane overrode it on 2026-09-18** (*"lets implement the chat support first"*), reaffirmed after
the contradiction was put to him in full. **Carla has not been told; she is the approver of record
and she signed the opposite.** Her pending meeting with Kane carries it, along with the support
hours. The chat work has its own plan at
`docs/superpowers/plans/2026-09-19-employee-support-chat.md`, where **Q3, Q4, Q5 and Q8 are now
answered** — Q4 one global queue with every agent qualified for everything, Q8 position and never a
countdown, Q3 an unanswered chat BECOMES a ticket, Q5 the queue entry and the full transcript both
persist. Do not read the Q-lines below as open; read that plan.

---

## What was asked

1. A second button beside **FAQs** on the Employee Dashboard header → opens a modal that files
   a support ticket.
2. Those tickets land in a new **Employee Support** section on the Tickets Dashboard, where
   staff answer them.
3. A filter surfacing the **latest ticket that came in from the employee side**.
4. Each row carries **Name · Work Email · Concern · Ticket Number · Reply**.
5. The employee sees **their previous tickets** and the replies on them.
6. A **live chat** with a **queue** — ask for the queue, see your position, see a live counter
   estimating when you will be served.

## The three findings that change the shape of the build

These were measured against the tree, not assumed. Each one is a reason the obvious build is
the wrong build.

### 1. `public.tickets` is anon-readable, and support tickets are not dev tickets

`references/sql/migrate/2026-07-15_tickets_kanban.sql` creates `tickets`, `ticket_comments`
and `ticket_events` with **no `ENABLE ROW LEVEL SECURITY` and no policy** (a repo-wide grep for
`ROW LEVEL SECURITY` returns zero ticket hits), and lines 121–135 add all three to the
**`supabase_realtime` publication**. Authorization is 100% in the route handlers, which is
survivable for "the dnd-kit board flickers on drop" and is not survivable for *"my manager is
underpaying me"*. Anything filed through Employee Support is HR-grade content — pay disputes,
complaints about a named manager, medical and bank questions — and putting it in a table any
anon-key holder can `select *` from is a new hole, not a reuse.

`SECURITY_AUDIT.md:59` (finding 24) and `:79` (finding 44) already flag the ~48 service-role
tables. This feature should not add the most sensitive one to that list.

### 2. Every ticket is force-assigned to Kane, and only Kane can reassign

`app/api/tickets/route.ts:91-93`:

```ts
const isOwner = authz.sessionEmail === TICKET_BOARD_OWNER;
const requestedAssignee = (body.assigned_to ?? '').trim().toLowerCase();
const assignedTo = isOwner ? requestedAssignee || TICKET_BOARD_OWNER : TICKET_BOARD_OWNER;
```

`TICKET_BOARD_OWNER = 'kaner@simple.biz'` (`src/lib/tickets/types.ts:23`), PATCH enforces the
same owner-only rule (`app/api/tickets/[id]/route.ts:171-181`), and `notifyTicketCreated`
hardcodes `send_to: 'kaner@simple.biz'` (`src/lib/tickets/notify.ts:44-47`) as a *second literal
copy* of the address. Reusing the `tickets` table means every employee support request is
assigned to Kane, emails Kane, and cannot be handed to a support staffer by anyone but Kane.
Requirement 2 ("staff answer employee queries") contradicts that rule directly.

Also: archive/restore is creator-or-admin only (`app/api/tickets/[id]/route.ts:374-381`), and
the creator here is an employee who cannot reach the route at all — so **only an admin could
ever close an Employee Support ticket**, never a non-admin support staffer.

### 3. An employee cannot call any `/api/tickets/*` route, and must not reach `/tickets`

`requireFeatureAccessAnyView('tickets', …)` iterates the caller's roles through
`ROLE_TO_FEATURE_VIEW` (`src/lib/rbac/feature-permissions.ts:97-106`). There is no `employee`
key, so a plain employee falls out of the loop into the default-deny at
`src/lib/auth/authorize-feature.ts:128`. An employee is *a signed-in user with an empty roles
array* — there is no `employee` role and no `employee` FeatureViewKey.

`src/lib/auth/route-access.ts:47` gates `/tickets` on `['tickets','admin']`, re-checked in
`app/tickets/layout.tsx:10`. `src/lib/notifications/notification-actions.ts:84-86` already says
in a comment that roleless assignees "get bounced home by the proxy". **The employee's ticket
history can never live at `/tickets`** — it belongs inside `/employee`, and the employee side
needs its own session-scoped route namespace.

The precedent for exactly this actor shape already exists: `app/api/resignation-requests/route.ts`
— an employee files something that lands on a staff surface. `authorizeEmailAccess(body.email)`,
then the row is written with **`authz.effectiveEmail`, never the body's value**
(`app/api/time-adjustments/route.ts:135` does the same).

---

## What Carla ruled — 2026-09-15, signed

| Her decision | Ruling | What it settles |
|---|---|---|
| 1 · Who answers | **Carla, Claire, Ainsley, Grace, Alivia** — named individuals, not a team | **Settles Q2.** None of the five holds the `tickets` role, and granting it would hand them the whole HRIS dev board ([[tickets-dedicated-role-only]]). The **new `employee_support` feature key is now required, not preferred** |
| 2 · Chat now or tickets first | **Tickets first** | **Defers the chat, the queue and the counter entirely.** Q3, Q4, Q5, Q8 are *unanswered*, not resolved |
| 3 · Support hours | **Mon–Fri, 9 AM – 5 PM EST** | Her words, and **EST, not Manila** — see the open question below |
| 4 · Categories | **CORRECTED 2026-09-19.** The six proposed, **plus** Gmail / Hubstaff / Roboform issues, **plus** language screening. There is **no "minus"** — both printed category lines were ticked and **nothing was crossed out**, so the instruction *"Cross out anything you don't want"* was answered by addition only. Time adjustments stayed a category and were **restricted**, not removed; schedules and time-off were **never on the list** to remove. Nine categories, which is what `src/lib/support/types.ts:27-37` shipped | **Expands Q7 well past a category list** — see below |
| 5 · Reply promise | **Within one working day** | Shown to the employee on filing. Not an SLA anything enforces |
| 6 · Daily cap | **No limit** | The fail-closed per-day counter comes out of the build |
| 7 · Leavers | **No — access ends the day they leave** | **Overrules our suggestion of 30 days.** She read the final-pay argument and said no; recorded below as a consequence, not re-argued |
| 8 · Attachments | **Not in v1** | **Settles Q9** |

### What Decision 4 actually asked for

Her write-in is four separate requirements, only one of which is a category list:

1. **Add** Gmail issues · Hubstaff issues · Roboform issues.
2. **Time adjustments are restricted** — an employee may ask *about an adjustment that has
   already been approved*, and may **not request one** through support.
3. **Schedules and time-off are a manager question** and do not belong here either.
4. **Screen for hateful or hurtful language before it is submitted**, and **flag unprofessional
   behaviour**.

(2) and (3) are a routing rule: two subjects that must be steered somewhere else rather than
silently accepted. (4) is **content moderation, which was never scoped** — it is the reason
three questions below are open rather than assumed.

### Still ours to answer, untouched by Carla

| # | Standing recommendation |
|---|---|
| Q1 | **New tables**, not a discriminator on `tickets` — findings 1 + 2; own lifecycle, own numbering, RLS on with no policies, out of the realtime publication |
| Q6 | ~~**Needs-reply first, newest first within it**~~ — **CORRECTED 2026-09-19: Q6 was never ours to answer, and the standing recommendation inverted the half Carla had already ruled.** Page 1 of the signed proposal says *"Sorted so the longest-waiting unanswered question is at the top, **not the newest**."* "Needs-reply first" agrees with her and is already encoded as `needsStaffReply` (`src/lib/support/types.ts:115-123`); the **tiebreaker** was the inversion. The rule is **needs-reply first, then LONGEST-WAITING first within it, dated from filing**. Kane's 2026-09-18 urgency ranking sits above it: urgency DESC, then longest-waiting within each band |

### Three questions Carla's answers opened

- **N1 · Moderation: block, warn, or flag after the fact?** "Prescreen" reads as *stop it before
  it is sent*. That means refusing a submission, which means a false positive silences an
  employee with a real complaint — on the one channel built for complaints. And "flag
  unprofessional behaviour" needs a destination: who sees a flag, is the employee told, and does
  the ticket still reach the queue? There is **no moderation anything in this repo today** — no
  wordlist, no classifier, no review surface. Every option here is new build.
- **~~N2 · 9–5 EST, or 9–5 Manila?~~ RULED 2026-09-16 by Kane: EST, as Carla wrote it.**
  Support is open **Mon–Fri 9 AM – 5 PM Eastern = 9 PM – 5 AM Manila**. This is the first
  surface in the HRIS whose operating window is **not** Manila — every date, week and cutoff
  elsewhere is (`manilaDayIso`, the Sunday pay week, `hsl.week_model_cutover`), so this is a
  deliberate exception and is written down as one. Two consequences, both load-bearing:
  - **The hours are never displayed as a bare "9 AM – 5 PM".** A Manila-based employee reading
    an unlabelled 9–5 is wrong by twelve hours. The form and the empty state show **both zones**
    — e.g. *"Support is open 9 AM – 5 PM Eastern (9 PM – 5 AM Manila), Mon–Fri"* — and the
    conversion is computed, never a hardcoded second string that drifts at a DST change.
  - **Eastern observes DST and Manila does not.** EST → EDT moves the Manila window by an hour
    twice a year, so the window is stored as an **IANA zone (`America/New_York`) plus local
    clock times**, never as a fixed UTC offset. A stored `-05:00` is a bug that surfaces in
    March.
- **N3 · Is the time-adjustment restriction a guard or a sentence?** Copy that says *"ask your
  manager"* is cheap. Refusing a ticket whose category is "time adjustment" and whose subject has
  no approved adjustment on record is a real lookup and a real refusal path.

### Recorded consequence of Decision 7

Access ending on the last day means **a leaver still has no route to ask about final pay** —
the case named in the proposal. Carla ruled on it with that in front of her. Recorded here so it
is not rediscovered later as an oversight; reopening it is her call, not a defect to fix.

## Invariants — these do not move

- **The row is written with `authz.effectiveEmail`, never the body's email.** The body is a
  request; the session is the answer. (`app/api/time-adjustments/route.ts:135`.)
- **`work_email` on the row is the master `work_email`**, resolved server-side from the session
  identity — not the address the person happened to sign in with. An employee's session email
  can be a personal or alternate address (`aliasEmails`, `EmployeeDashboard.tsx:920-933`).
- **Realtime carries a signal, never content.** No support message body ever crosses a
  Broadcast channel, because every subscriber on a public topic receives every payload. No
  `private: true` channel exists anywhere in this repo today.
- **`postgres_changes` is not available to this table.** It is dead for the anon browser on any
  RLS-guarded table ([[supabase-realtime-anon-rls-dead]]), and making it work would mean a
  permissive anon SELECT policy — exactly what must not exist here. **A poll is the floor**,
  not the fallback.
- **An empty `send_to` must never reach n8n** (`docs/features/tickets-board.md:109-112`) — the
  Gmail node is stop-on-error. Employee-filed tickets are the case most likely to produce a null
  recipient, so every hook returns early on `null`.
- **The queue claim is a compare-and-set**, never a read-then-write. A failed claim is a 409 the
  UI re-reads from, never an auto-merge.
- **"Nobody is waiting" and "we cannot tell how long the wait is" are different states** and are
  never merged into `0`. Skeleton, not zero, until the number resolves.
- **An estimate is never a promise.** The counter is labelled as an estimate everywhere it
  appears, and it counts *up* from "waiting since" when it has no basis to count down from.
- **Closing the modal does not leave the queue.** Leaving is an explicit action or an expiry.
- **Nothing here touches pay.** No payroll, dispatch, paystub or rate path is read or written.

## Tasks — v1, tickets only

Chat, queue and counter are **not here**. They return as their own plan when Carla asks for them.

- [x] 1. `references/sql/create/2026-09-16_employee_support.sql` — `employee_support_tickets`
      (own `ticket_no` identity series, `work_email`, `filed_by_email`, `category`, `concern`,
      `status` open|claimed|answered|closed, `claimed_by`/`claimed_at`, `first_response_at`,
      `closed_at`, `flagged_at`/`flag_reason`) + `employee_support_messages` (immutable, author
      side employee|staff). **RLS ON with no policies**, **not** in the `supabase_realtime`
      publication. No queue table in v1. No `BEGIN`/`COMMIT` in the file — the apply script owns
      the transaction. **Shape of the flag columns depends on N1.**
- [x] 2. `scripts/apply-employee-support-migration.mts` — `--apply` gate, dry run by default,
      `information_schema` read-back plus an independent PostgREST probe. **Kane runs it.**
- [ ] 3. `references/sql/alter/2026-09-16_add_support_notification_types.sql` — restates the
      **FULL** `employee_notifications` type CHECK list plus `support.replied` /
      `support.answered`. Restating a subset silently breaks every other type's INSERT. Re-read
      the live list first — [[migration-pending-claims-are-folklore]].
- [x] 4. `src/lib/support/types.ts` — `SupportStatus`, `SupportCategory` (the nine Carla
      approved), the ticket-number formatter. One vocabulary module, the `profile-tabs.ts`
      pattern. **The two routed-away subjects are values in this module**, not strings in a
      component, so the form and the guard cannot disagree.
- [x] 5. `src/lib/support/routing.ts` (+ test) — pure. Given a category, answer
      *accept · steer to manager · ask only about an approved adjustment*. Decision 4 items
      2 and 3. **Shape depends on N3.**
- [x] 6. `src/lib/support/screening.ts` (+ test) — pure. **Blocked on N1.** Whatever it does, it
      returns a verdict; it never writes, never notifies, and the route decides what the verdict
      means. Fails **open on an internal error** — a screening bug must not swallow a complaint.
- [x] 7. `src/lib/support/recipients.ts` (+ test) — who hears about a support event, mirroring
      `src/lib/tickets/recipients.ts`. Returns `null`, never `''`.
- [ ] 8. `app/api/employee/support/route.ts` — GET (own tickets) + POST (file), gated like
      `app/api/employee/documents/route.ts` with the `authorizeEmailAccess` + `effectiveEmail`
      write rule from `resignation-requests`. `selectAllPaged` on every read. **No per-day cap —
      Decision 6.**
- [ ] 9. `app/api/employee/support/[id]/messages/route.ts` — GET + POST scoped to the caller's
      own ticket (**404, not 403**, on someone else's id — a 403 confirms it exists).
- [ ] 10. `app/api/support/tickets/route.ts` (staff) — gated on the new `employee_support`
      feature key. GET list + PATCH claim (compare-and-set → **409** on a lost race).
- [ ] 11. `app/api/support/tickets/[id]/reply/route.ts` — gated at **`view`**, not `edit`
      (`app/api/tickets/[id]/comments/route.ts:43-46`). Writes the message, the in-app
      notification and the n8n leg.
- [ ] 12. `src/lib/rbac/feature-permissions.ts` — the `employee_support` feature key under the
      `tickets` view, so the five named people can hold it with `tickets: hidden`. **Grant is an
      admin action, no migration.**
- [ ] 13. `src/lib/audit/registry.ts` — one `employee_support.` family, surfaces
      `['employee','tickets']`. Actor is `auditFrom(request, authz)`, **never** the body. A
      flag or a refusal is audited; so is a reply.
- [ ] 14. `src/lib/notifications/notification-views.ts` — map the two new types to `['employee']`.
- [x] 14b. `src/lib/support/hours.ts` (+ test) — the support window as an **IANA zone
      (`America/New_York`) plus local clock times**, never a fixed offset; `isSupportOpen(at)`
      and a formatter that renders **both zones**. Tested across a **US DST boundary**, because
      Eastern shifts and Manila does not. This is the first non-Manila window in the system.
- [ ] 15. `src/components/employee/EmployeeSupportDialog.tsx` — file + history, **two panes, not
      three**. Copies `TimeAdjustmentDialog`'s prop shape and `RequestDocumentsTab`'s status-chip
      `Record` pair. Shows the **one working day** promise (Decision 5) and the **support hours in
      both zones** (Decision 3 + N2) — never a bare "9 AM – 5 PM", which a Manila reader is
      twelve hours wrong about.
- [ ] 16. `EmployeeDashboard.tsx` — the button beside FAQs in **both** clusters: mobile icon at
      ~`:2700-2710`, desktop labelled at ~`:2753-2764`. Unread badge copies `GiftBellButton`.
- [ ] 17. `src/components/tickets/SupportSection.tsx` + `TicketsSidebar.tsx` — a **fourth view**
      beside Overview / Board / Archived; a new branch in the `AnimatePresence mode="wait"` at
      `TicketsBoard.tsx:665`. Re-apply `tickets-theme dark` on every portaled surface.
- [ ] 18. `src/hooks/useLiveRefresh.ts` on both sides with `pollMs` as the **floor**.
- [ ] 19. Docs: `docs/features/employee-support.md`, the `INDEX.md` row, `api-reference.md` +
      `components.md` in the same commit ([[reference-docs-rot-silently]]), memory entry.

## Tasks added 2026-09-18 — Kane's rulings in a live session

Seven additions and two corrections, all ruled by Kane on 2026-09-18. None of them contradicts
anything Carla ticked; **all of them grow v1 past what she signed**, and she has not been shown
them. They belong in the same meeting as Decision 2.

- [ ] 21. **Close a ticket.** Kane: *"We should have the ability to close a ticket."* The schema
      already has `closed_by` / `closed_at` and a CHECK admitting `closed` — **no route ever sets
      them**, so the closed state is currently unreachable. Who may close (assignee, any answerer,
      admin) and what a reply on a closed ticket does (reopen, or refuse with a sentence) are part
      of this task. Carla signed *"Nothing is deleted — closed questions stay readable by both."*
- [ ] 22. **Urgency ranking.** Kane: *"the people who can access the tickets tab can designate a
      ticket to its urgency … they can rank it."* Mirror `TICKET_PRIORITIES`
      (`src/lib/tickets/types.ts:33`) for the vocabulary, but the support column is **nullable**
      and the dev board's is `not null default 'medium'` — the four VALUES are shared, the column
      is not. **Do not widen `TICKET_PRIORITY_LABELS` or add a fifth value to `TICKET_PRIORITIES`**;
      the support side carries its own nullability.
- [ ] 23. **The queueing line and the board.** Kane: *"There should be a queing line then they rank
      it by urgency which goes up to the board."* `priority IS NULL` = still in the line; ranked =
      on the board. Three columns moving as a set under a both-or-neither CHECK
      (`priority` / `triaged_at` / `triaged_by`). **Starvation is the risk**: an unranked ticket
      that nobody triages never reaches the board, so the line is the default landing view, never a
      drawer. Carla signed *"One screen listing every question"* — a line plus a board is two
      lists, so **the counts span both or the split hides work**.
- [ ] 24. **Auto-claim on first touch, with handoff.** Kane: *"Whoever touches the ticket first
      should automatically be assigned to that ticket unless they pass it off to another person."*
      A "touch" is the first **action** (rank, reply, explicit claim), never a read — otherwise
      browsing the line claims everything scrolled past. *Assumed, reversible, not ruled.* The claim
      is a CAS on NULL; the handoff is a CAS on the **current holder**. Both audited with both
      names. This is the **reverse** of the dev board's owner-only rule, deliberately.
- [ ] 25. **The employee track map.** Kane: *"in the employee side they can have a track map on what
      is the status of their tickets depending on the status in Kanban."* The vocabulary already
      ships and is already employee-facing: `SUPPORT_STATUS_LABELS` = Waiting / Being looked at /
      Answered / Closed (`src/lib/support/types.ts:58-63`). Those are the track stops.
- [ ] 26. **Filing from inside Penny, with the conversation as context.** Kane: *"if they have ran
      out of 10 prompts for Penny they should be able to file a ticket within Penny also Penny would
      record their previous Chats in there … so the People responding would get proper context."*
      **There is no Penny transcript anywhere today** — `penny_employee_usage`
      (`references/sql/create/2026-08-19_penny_employee_usage.sql:41-64`) is a METER with no question
      text and no answer text, and the live conversation sits in `sessionStorage` and dies with the
      tab. So: **capture at file time** from the live in-memory conversation, NOT server-side
      persistence of every Penny chat — that would build a permanent record of every employee's pay
      questions, which runs straight into the privacy paragraph Carla signed. The transcript must be
      unmistakably labelled as Penny's output: *"Automatic answers"* is in her NOT-included table,
      and Penny's computed-vs-paid reconciliation was wrong until the 2026-09-17 fix.
- [ ] 27. **The at-a-glance counts.** *"Counts at a glance: how many need a reply, how many were
      answered today"* is one of the four bullets Carla approved for the answerers and it had **no
      task**. `needsStaffReply` and `first_response_at` already exist. State which day "today" means.
- [ ] 28. **The staff-only trial gate.** *"You and the support team try it before any employee sees
      it"* is step 2 of what she approved, and it appears **nowhere in this repo** — task 16 puts the
      button on every employee dashboard on deploy. Land task 16 as its **own commit**, after the
      five have used it for real.

**Response-time / KPI records are explicitly DEFERRED** — Kane: *"lets not implement it now but
sooner we would have a ticket Response time and KPI Records."* It costs nothing to wait:
`claimed_at`, `first_response_at` and `closed_at` are already columns, so the history accrues from
the first ticket whether or not anything reads it.

**Two open questions were resolved in code rather than by an approver, and Carla has not been told:**
**N1** — she wrote *"prescreen"*, and `screening.ts` flags without ever blocking (defensible: a
blocking filter turns a false positive into an employee who cannot report harassment on the channel
built for it). **N3** — she wrote *"shouldn't be able to request an adjustment through the support
channels"*, and `routing.ts` shows a notice and accepts the ticket anyway. N3 is the weaker of the
two and should go back to her.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** Two SQL files (Tasks 1 and 3), both shipped as a Node
  script with an `--apply` gate. `.env.local` is production service-role and this session is
  read-only, so nothing is executed here. Until it runs the routes report `migrated: false` and
  the UI says support cannot accept tickets yet — **not 500, and not silently pretend to save**
  (the `manager-scheduling` precedent).
- **The `employee_notifications` CHECK widen is load-bearing**: until it runs, every `support.*`
  insert is rejected and the notification is dead.
- **Five grants, by hand, after deploy**: `employee_support` to Carla, Claire, Ainsley, Grace and
  Alivia. Until those exist the staff section is empty for everyone.
- **n8n: PENDING Kane.** Two slugs if the email leg ships — `support_filed`, `support_replied`.
  Recipient decided in code and handed over as `send_to`; the Gmail node never picks one.
- **No cron.** Nothing here needs one in v1 — the queue that would have needed sweeping is gone.

## Out of scope — this is a contract

Payroll · dispatch · paystubs · rates · the existing `tickets` table and its four Kanban columns ·
`TICKET_BOARD_OWNER` · the five existing n8n ticket hooks · Penny · attachments (Decision 8) ·
per-day caps (Decision 6) · leaver access (Decision 7) · ~~**the live chat, the queue and the
served-by counter (Decision 2)**~~ · the ungated `PATCH /api/employee-notifications` (a pre-existing
hole this feature sits beside — recorded, not fixed here, and its own `hardening` pass).

**AMENDED 2026-09-19.** The live chat, the queue and the served-by counter are **no longer excluded
here** — Kane's 2026-09-18 override moved them to their own plan,
`docs/superpowers/plans/2026-09-19-employee-support-chat.md`, which is being built first. This
clause is amended rather than deleted because it was a stated contract and the amendment is the
record of who changed it and when. **The rest of this list still binds**, and the chat plan carries
its own out-of-scope contract which excludes this plan's tasks 8–19 in turn.
