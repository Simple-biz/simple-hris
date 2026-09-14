# Employee Support — an employee-filed ticket, a staffed section on /tickets, and a live chat queue

**STATUS: AWAITING APPROVAL. Nothing under `src/` or `app/` has been written.**
Blueprint brief posted 2026-09-14, session `d937b520`. **Q1–Q9 are open** — the task list
below is written against the *recommended* answer to each, and every task that would change
carries the Q that changes it. Do not start Task 1 until Kane has answered.

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

## Decisions taken as recommendations (each is a Q — see the brief)

| # | Recommendation | Because |
|---|---|---|
| Q1 | **New tables**, not a discriminator on `tickets` | findings 1 + 2 above; own lifecycle, own numbering, RLS-on-no-policies, out of the realtime publication |
| Q2 | Section lives on `/tickets` as asked, gated on a **new `employee_support` feature key** under the existing `tickets` view | keeps `/tickets` role-gated; lets a staffer hold `employee_support: edit` with `tickets: hidden` rather than re-opening the 2026-07-16 leak |
| Q3 | **The chat IS the ticket** — one thread, escalated to real-time | a separate channel is a second inbox that will drift from the first |
| Q4 | **One global queue**, claimed by a server-side compare-and-set | two agents cannot both take position 1; same shape as the dispatch 409 guard |
| Q5 | Messages **persisted**; Realtime carries a *signal only*, content comes from a gated fetch | the only shipped chat filters recipients **client-side** (`CobrowseChatProvider.tsx` — every subscriber receives every payload and drops it in JS). That is an anti-precedent for a private HR thread |
| Q6 | **Needs-reply first, newest first within it**, plus a "new since you last looked" marker | "latest" as a pure sort buries a 3-day-old unanswered ticket under a just-filed one |
| Q7 | Short **category list + free-text concern** | category is the routing key later; free text is what the employee actually needs to say |
| Q8 | ETA says **"No wait-time data yet"** until it has samples | there is zero handle-time data anywhere in the repo; day one every formula has an empty denominator |
| Q9 | **No attachments in v1** | a screenshot of a wrong payslip is the obvious first ask, but Storage signing + retention is its own build |

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

## Tasks

- [ ] 1. `references/sql/create/2026-09-14_employee_support.sql` — `employee_support_tickets`
      (own `ticket_no` identity series, `work_email`, `filed_by_email`, `category`, `concern`,
      `status` open|claimed|answered|closed, `claimed_by`/`claimed_at`, `queue_joined_at`,
      `first_response_at`, `closed_at`) + `employee_support_messages` (immutable, author side
      employee|staff) + `employee_support_queue`. **RLS ON with no policies**, **not** added to
      the `supabase_realtime` publication. No `BEGIN`/`COMMIT` inside the file — the apply script
      owns the transaction.
- [ ] 2. `scripts/apply-employee-support-migration.mts` — `--apply` gate, dry run by default,
      `information_schema` read-back plus an independent PostgREST probe. **Kane runs it.**
- [ ] 3. `references/sql/alter/2026-09-14_add_support_notification_types.sql` — restates the
      **FULL** `employee_notifications` type CHECK list (42 values today) **plus**
      `support.replied` / `support.answered`. Restating a subset silently breaks every other
      type's INSERT.
- [ ] 4. `src/lib/support/types.ts` — `SupportStatus`, `SupportCategory`, the ticket-number
      formatter, `isStaffSide`. One vocabulary module, the `profile-tabs.ts` pattern.
- [ ] 5. `src/lib/support/queue.ts` (+ `queue.test.ts`, `node:test`) — **pure**: position from an
      ordered list, ETA from a sample set that **returns `null` on an empty denominator**, the
      expiry predicate, and the claim precondition. Every branch tested, especially zero-sample.
- [ ] 6. `src/lib/support/recipients.ts` (+ test) — who hears about a support event, mirroring
      `src/lib/tickets/recipients.ts`. Returns `null`, never `''`.
- [ ] 7. `app/api/employee/support/route.ts` — GET (own tickets) + POST (file), gated exactly like
      `app/api/employee/documents/route.ts` (session email) with the `authorizeEmailAccess` +
      `effectiveEmail` write rule from `resignation-requests`. `selectAllPaged` on every read.
      Fail-closed per-day cap modelled on the Penny ledger.
- [ ] 8. `app/api/employee/support/[id]/messages/route.ts` — GET + POST, **scoped to the caller's
      own ticket** (404, not 403, on someone else's id — a 403 confirms it exists).
- [ ] 9. `app/api/employee/support/queue/route.ts` — join / poll / leave. Server clock only; the
      client never sends a timestamp.
- [ ] 10. `app/api/support/tickets/route.ts` (staff) — gated on the new `employee_support` feature
      key. GET list + PATCH claim (compare-and-set → **409** on a lost race).
- [ ] 11. `app/api/support/tickets/[id]/reply/route.ts` — gated at **`view`**, not `edit`
      (`app/api/tickets/[id]/comments/route.ts:43-46` — a view-only member must be able to
      answer). Writes the message, the in-app notification and the n8n leg.
- [ ] 12. `src/lib/audit/registry.ts` — one `employee_support.` family, surfaces
      `['employee','tickets']`. Both members already exist on `AuditSurface`. Actor is
      `auditFrom(request, authz)`, **never** the body.
- [ ] 13. `src/lib/notifications/notification-views.ts` — map the two new types to `['employee']`
      beside the existing `ticket.replied` / `.assigned` / `.moved`.
- [ ] 14. `src/components/employee/EmployeeSupportDialog.tsx` — the modal: file + history + chat +
      queue. Copies `TimeAdjustmentDialog`'s prop shape
      (`{open, onOpenChange, employeeEmail, employeeName, onSubmitted}`) and
      `RequestDocumentsTab`'s status-chip `Record` pair.
- [ ] 15. `EmployeeDashboard.tsx` — the button beside FAQs in **both** clusters: mobile icon at
      ~`:2700-2710`, desktop labelled at ~`:2753-2764`. Unread badge copies `GiftBellButton`
      (`:4156-4202`), not a new idiom.
- [ ] 16. `src/components/tickets/SupportSection.tsx` + `TicketsSidebar.tsx` — a **fourth view**
      beside Overview / Board / Archived, a new branch in the `AnimatePresence mode="wait"` at
      `TicketsBoard.tsx:665`. Must re-apply `tickets-theme dark` on every portaled surface.
- [ ] 17. `src/hooks/useLiveRefresh.ts` wiring on both sides with `pollMs` as the **floor**.
- [ ] 18. Docs: `docs/features/employee-support.md`, the `INDEX.md` row, `api-reference.md` +
      `components.md` in the same commit ([[reference-docs-rot-silently]]), memory entry.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** Two SQL files (Task 1, Task 3), both shipped as a Node
  script with an `--apply` gate. `.env.local` is production service-role and this session is
  read-only, so nothing is executed here. Until it runs the routes must report `migrated: false`
  and the UI must say support cannot accept tickets yet — **not 500, and not silently pretend to
  save** (the `manager-scheduling` precedent).
- **The `employee_notifications` CHECK widen is load-bearing**: until it runs, every `support.*`
  insert is rejected and the notification is dead.
- **n8n: PENDING Kane.** Two new webhook slugs if the email leg ships — `support_filed`,
  `support_replied`. Recipient is decided in code and handed over as `send_to`; the Gmail node
  never picks one.
- **No cron.** Both existing Vercel crons have never executed
  ([[scheduled-deletion-cron-never-ran]]), so queue expiry is swept **lazily on read**, never on
  a schedule.
- **New RBAC feature key** `employee_support` under the `tickets` view — granting it is an admin
  action in the existing grants UI, no migration.

## Out of scope — this is a contract

Payroll · dispatch · paystubs · rates · the existing `tickets` table and its four Kanban columns ·
`TICKET_BOARD_OWNER` · the five existing n8n ticket hooks · Penny · the ungated
`PATCH /api/employee-notifications` (a pre-existing hole this feature sits beside — it is
recorded, not fixed here, and fixing it is its own `hardening` pass).
