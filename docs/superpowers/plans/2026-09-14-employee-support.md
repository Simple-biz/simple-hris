# Employee Support — an employee-filed ticket and a staffed section on /tickets

**STATUS: APPROVED BY CARLA 2026-09-15 (signed, `Employee-Support-for-approval.pdf`).
Three new questions opened by her answers. Nothing under `src/` or `app/` written yet.**

**The live chat and the queue are OUT of v1.** Carla took Decision 2 — *tickets first, add
live chat once we know the volume*. That is more than half of what was originally asked for,
deferred by the approver, not dropped by us. Q3, Q4, Q5 and Q8 go with it and are not
answered; do not treat them as settled when chat comes back.

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
| 4 · Categories | The six proposed, **plus** Gmail / Hubstaff / Roboform issues, **minus** two routed away, **plus** language screening | **Expands Q7 well past a category list** — see below |
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
| Q6 | **Needs-reply first, newest first within it**, plus a "new since you last looked" marker |

### Three questions Carla's answers opened

- **N1 · Moderation: block, warn, or flag after the fact?** "Prescreen" reads as *stop it before
  it is sent*. That means refusing a submission, which means a false positive silences an
  employee with a real complaint — on the one channel built for complaints. And "flag
  unprofessional behaviour" needs a destination: who sees a flag, is the employee told, and does
  the ticket still reach the queue? There is **no moderation anything in this repo today** — no
  wordlist, no classifier, no review surface. Every option here is new build.
- **N2 · 9–5 EST, or 9–5 Manila?** Every date, week and cutoff in this system is Manila
  (`hsl.week_model_cutover`, `manilaDayIso`, the Sunday pay week). 9–5 EST is **9 PM – 5 AM
  Manila**. For the US-facing floors that is exactly their shift; for everyone else support is
  open only while they sleep. This may be precisely what she meant — it needs one confirmation,
  not an assumption, because it is the difference between two disjoint windows.
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

- [ ] 1. `references/sql/create/2026-09-16_employee_support.sql` — `employee_support_tickets`
      (own `ticket_no` identity series, `work_email`, `filed_by_email`, `category`, `concern`,
      `status` open|claimed|answered|closed, `claimed_by`/`claimed_at`, `first_response_at`,
      `closed_at`, `flagged_at`/`flag_reason`) + `employee_support_messages` (immutable, author
      side employee|staff). **RLS ON with no policies**, **not** in the `supabase_realtime`
      publication. No queue table in v1. No `BEGIN`/`COMMIT` in the file — the apply script owns
      the transaction. **Shape of the flag columns depends on N1.**
- [ ] 2. `scripts/apply-employee-support-migration.mts` — `--apply` gate, dry run by default,
      `information_schema` read-back plus an independent PostgREST probe. **Kane runs it.**
- [ ] 3. `references/sql/alter/2026-09-16_add_support_notification_types.sql` — restates the
      **FULL** `employee_notifications` type CHECK list plus `support.replied` /
      `support.answered`. Restating a subset silently breaks every other type's INSERT. Re-read
      the live list first — [[migration-pending-claims-are-folklore]].
- [ ] 4. `src/lib/support/types.ts` — `SupportStatus`, `SupportCategory` (the nine Carla
      approved), the ticket-number formatter. One vocabulary module, the `profile-tabs.ts`
      pattern. **The two routed-away subjects are values in this module**, not strings in a
      component, so the form and the guard cannot disagree.
- [ ] 5. `src/lib/support/routing.ts` (+ test) — pure. Given a category, answer
      *accept · steer to manager · ask only about an approved adjustment*. Decision 4 items
      2 and 3. **Shape depends on N3.**
- [ ] 6. `src/lib/support/screening.ts` (+ test) — pure. **Blocked on N1.** Whatever it does, it
      returns a verdict; it never writes, never notifies, and the route decides what the verdict
      means. Fails **open on an internal error** — a screening bug must not swallow a complaint.
- [ ] 7. `src/lib/support/recipients.ts` (+ test) — who hears about a support event, mirroring
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
- [ ] 15. `src/components/employee/EmployeeSupportDialog.tsx` — file + history, **two panes, not
      three**. Copies `TimeAdjustmentDialog`'s prop shape and `RequestDocumentsTab`'s status-chip
      `Record` pair. Shows the **one working day** promise (Decision 5) and the **support hours**
      (Decision 3) on the form.
- [ ] 16. `EmployeeDashboard.tsx` — the button beside FAQs in **both** clusters: mobile icon at
      ~`:2700-2710`, desktop labelled at ~`:2753-2764`. Unread badge copies `GiftBellButton`.
- [ ] 17. `src/components/tickets/SupportSection.tsx` + `TicketsSidebar.tsx` — a **fourth view**
      beside Overview / Board / Archived; a new branch in the `AnimatePresence mode="wait"` at
      `TicketsBoard.tsx:665`. Re-apply `tickets-theme dark` on every portaled surface.
- [ ] 18. `src/hooks/useLiveRefresh.ts` on both sides with `pollMs` as the **floor**.
- [ ] 19. Docs: `docs/features/employee-support.md`, the `INDEX.md` row, `api-reference.md` +
      `components.md` in the same commit ([[reference-docs-rot-silently]]), memory entry.

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
per-day caps (Decision 6) · leaver access (Decision 7) · **the live chat, the queue and the
served-by counter (Decision 2)** · the ungated `PATCH /api/employee-notifications` (a pre-existing
hole this feature sits beside — recorded, not fixed here, and its own `hardening` pass).
