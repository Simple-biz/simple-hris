# Employee Support — live chat, a queue, and the ticket it becomes

**STATUS: APPROVED BY KANE 2026-09-19. Q1–Q4 answered. Nothing under `src/` or `app/` written yet.**

**This reverses a signed decision.** Carla ticked Decision 2 on 2026-09-15 — *"Tickets first, add
live chat once we know the volume"* — with the counter-argument on the facing page. Kane overrode
it on 2026-09-18 (*"lets implement the chat support first"*), reaffirmed after the contradiction was
put to him in full (*"yes go do it"*). **Carla has not been told.** She is the approver of record
and she signed the opposite; Kane has a meeting with her pending. Decision 2 and the support hours
both belong in it. This paragraph exists so chat-first is never rediscovered as drift — it is a
named, dated, deliberate override.

**The v1 plan's out-of-scope clause names this feature and calls itself a contract**
(`docs/superpowers/plans/2026-09-14-employee-support.md:258-264`, header at `:6-9`). That file is
amended in the same commit as this one. Two approved documents must not contradict each other; the
next session cannot tell which won.

---

## What Kane ruled

| # | Question | Ruling |
|---|---|---|
| Q1 | An unanswered chat — what happens to it? | **It becomes a ticket.** An `ES-` number, the one-working-day promise, a permanent record. Chat is the front door to the ticket system |
| Q2 | Does the conversation persist? | **Queue entry AND full transcript.** Forced by Q1 — the transcript *is* the ticket's content |
| Q3 | How do the five get in? | **A new `employee_support` role + FeatureViewKey**, hosted at `/tickets` as its own tabs. Not a feature key under the `tickets` view |
| Q4 | How does an agent signal availability? | **An explicit "I'm on the queue" toggle**, with a heartbeat so a closed browser drops them |
| — | Earlier, same session | One global queue, **every agent qualified for everything** (specialisation deferred to the Carla meeting) · position in line, **never a countdown** · **every employee is on EST**, so the Manila/Eastern collision does not apply |

**Taken as mine, stated reversible, not ruled by Kane:** an agent takes *the next waiter*, not a
specific one · an abandoned claim returns the employee to their **original** position, never the
back of the line · one agent holds one live chat at a time · chat messages run through the shipped
`screening.ts` unchanged — flag, never block.

## What governs this

Employee Support **has no row in `docs/features/INDEX.md` and no `docs/features/employee-support.md`**.
Its only INDEX presence is a paragraph inside row 60 (Accounting surfaces) that still reads
"BLUEPRINT POSTED, Q1–Q9 PENDING, NOTHING BUILT" — stale since `99716520`. The governing corpus had
to be assembled rather than looked up. Both docs are created by this work.

- `docs/superpowers/plans/2026-09-14-employee-support.md:152-176` — **the Invariants already govern
  the queue** and were written before the override, so they survive it: the compare-and-set claim
  and its 409; "nobody is waiting" and "we cannot tell" are different states and never both render
  as `0`; an estimate is never a promise; **closing the modal does not leave the queue**; nothing
  here touches pay.
- `references/sql/create/2026-09-16_employee_support.sql:26-33` — **"THIS TABLE IS DELIBERATELY NOT
  ADDED TO supabase_realtime. Do not add it."** with the sanctioned alternative: broadcast the FACT
  that something changed and let the client re-fetch through its own gated route; never put a
  message body on a public topic.
- `docs/features/INDEX.md:42` — **"Never add a cron"**: every `/api/cron/*` 401s on the fail-closed
  `CRON_SECRET` gate (`proxy.ts:246-252`), the two declared crons **have never once run — 0 audit
  rows, ever** — and `vercel.json` stays untouched. Expiry sweeps **lazily on read**.
- `docs/features/tickets-board.md:63-112` — the recipient is decided **in code**, never in n8n;
  `null` never `''`, because the Gmail node is stop-on-error.
- `docs/features/employee-penny-ai.md:143-146` — the employee side has **exactly one fixed
  bottom-right control and Penny owns it**. A second floating launcher is two support desks in one
  corner. Chat goes in the header cluster, not a bubble.
- `SECURITY_AUDIT.md:245` row #50 — `POST /api/presence/heartbeat` takes the email from the
  **request body** when there is no NextAuth session. Presence cannot gate a queue. Recorded here,
  not fixed by this work.

## The precedent

**`src/hooks/useFpuLive.ts` + `src/lib/mesa/fpu-live.ts` + `src/lib/supabase/realtime-broadcast.ts`
+ the pill at `HrFpuEnrollments.tsx:438-444`.** A server-side Broadcast carrying a content-free
signal, every browser re-fetching through its own gated route, a 15s poll floor underneath skipped
while hidden, focus and visibilitychange catch-up, and a three-state Live / Connecting / Polling
indicator that tells the truth when the socket is down.

**NOT `CobrowseChatProvider.tsx`.** It puts message TEXT on a public Broadcast topic (`:147-158`)
and filters the recipient inside the RECEIVING browser. The browser client is anon; no
`private: true` channel and no `realtime.setAuth` call exists anywhere in this repo. Every anon-key
holder subscribed to that topic string receives every message sent on it. `GlobalPingListener.tsx`
repeats the same shape, so it is a house habit rather than a one-off — which is exactly why it is
named here.

**Claiming** copies `app/api/payment-dispatches/route.ts:230-249` — stamp the claim FIRST,
conditional on the row still being unclaimed; zero rows back means a 409 whose copy states that
nothing was recorded. **Lazy expiry** copies `src/lib/bank-update/otp.ts:181` (TTL compared on read,
expired rows never swept) and `app/api/presence/active/route.ts:30-42` (windowed staleness on read).

## Invariants — these do not move

- **A queue position is a COUNT over a set, and PostgREST caps a set at 1000 with no error.**
  `selectAllPaged`, never `.range()`. An unpaged read yields a confidently wrong position.
- **Realtime carries a signal, never content.** No chat message body crosses a Broadcast channel.
  The route writes, broadcasts "session N changed", and every client re-fetches through its gate.
- **The queue entry persists.** A position that does not survive a refresh is a lie, and closing the
  modal does not leave the queue (v1 plan `:175`). Leaving is an explicit action or an expiry.
- **"Nobody is waiting" and "we cannot tell" are different states.** Skeleton, not zero, until the
  number resolves.
- **A position never rises.** An abandoned claim returns the employee to their original rank; the
  employee never pays for an agent's disconnect.
- **The claim is a compare-and-set on NULL; the handoff is a compare-and-set on the CURRENT holder.**
  Two guarded UPDATEs, never one loosened one.
- **`authz.effectiveEmail` writes the row, never the body's email.** The body is a request; the
  session is the answer.
- **404, not 403, on someone else's session id.** A 403 confirms it exists.
- **An empty `send_to` never reaches n8n.** Every hook returns early on `null`.
- **Nothing here touches pay.** No payroll, dispatch, paystub or rate path is read or written, and
  the chat surface does not render pay figures for context.
- **The `employee_support` role grants the support tabs and NOTHING else.** A holder must not reach
  Overview / Board / Archived, by click or by typed URL. Carla signed *"the support team only sees
  support questions."*

## Tasks

- [ ] 1. `references/sql/create/2026-09-19_employee_support_chat.sql` — `employee_support_chat_sessions`
      (own identity series, `work_email`, `filed_by_email`, `status` waiting|claimed|live|ended|abandoned,
      `queued_at`, `claimed_by`/`claimed_at`, `ended_at`, `last_seen_at`, `became_ticket_id` FK to
      `employee_support_tickets`) + `employee_support_chat_messages` (immutable, author side
      employee|agent|system). **RLS ON with no policies**, **NOT** in `supabase_realtime`.
      Both-or-neither CHECKs on every paired column. No `BEGIN`/`COMMIT` — the apply script owns the
      transaction. Every new CHECK covers a brand-new column, so no existing row can violate one and
      the validating scan runs against an empty table.
      **RATIFIED 2026-09-19, a THIRD table this task did not originally name:**
      `employee_support_chat_agents`, which stores Kane's Q4 on-queue toggle and its heartbeat. The
      toggle needed somewhere to live and this task was silent rather than contradictory. It is not
      presence and must never be conflated with it — `POST /api/presence/heartbeat` takes the email
      from the **request body** when there is no session (`SECURITY_AUDIT.md` row #50), so presence
      cannot gate a queue. Expiry is compared **on read**, never swept.
      **RATIFIED, the two `employee_notifications.type` values**: `support_chat.replied` and
      `support_chat.became_ticket`. Chosen during the build, not by Kane — the plan named the n8n
      slugs and the audit family but never these. They must also be mapped to `['employee']` in
      `src/lib/notifications/notification-views.ts`: **an unmapped type has no dashboard badge and
      is effectively invisible.**
- [ ] 2. `references/sql/alter/2026-09-19_employee_support_role.sql` — the `employee_support` value on
      the roles CHECK. **Restate the FULL list**; a subset silently breaks every other role's INSERT.
      Re-read the live constraint before this is ever applied — it cannot be measured locally.
- [ ] 3. `scripts/apply-employee-support-chat-migration.mts` + a `.cmd` launcher — `--dry` default,
      `--apply`, `--verify`, `information_schema` read-back, negative controls, and the two
      `pg_publication_tables` absence assertions. Takes **N sql files** rather than special-casing
      each one, so the pending triage and notification-type files fold in without another rewrite.
- [ ] 4. `src/lib/support/chat-live.ts` — the topic and payload contract, `fpu-live.ts`'s twin.
      Browser-safe constants, its own topic never reused, and the why-Broadcast-not-`postgres_changes`
      reasoning in the header.
- [ ] 5. `src/lib/support/queue.ts` (+ test) — pure. Position, ordering, the cannot-tell state, the
      never-rises rule. Tested at the 1000-row boundary.
- [ ] 6. `src/lib/support/availability.ts` (+ test) — pure. The on-queue toggle's staleness window,
      the heartbeat ratio, and `agentsOnQueue` derived from stamps, never from presence.
- [ ] 7. `src/lib/support/chat-types.ts` (+ test) — the one vocabulary module: statuses, author sides,
      the session-number formatter, employee-facing labels. `types.ts`'s sibling, same discipline.
- [ ] 8. `src/lib/rbac/feature-permissions.ts` · `src/lib/auth/route-access.ts` ·
      `src/lib/rbac/view-tabs.ts` · `ROLE_TO_FEATURE_VIEW` · the ViewSwitcher — the `employee_support`
      role and FeatureViewKey, hosted at `/tickets`, with `VIEW_TAB_IDS.tickets` gaining the support
      tabs and `allowedTabsForUser` doing the per-tab gating. **Do not loosen the existing tickets
      gate.** A support-only holder sees support tabs only, by click or by typed URL.
- [ ] 9. `app/api/employee/support/chat/route.ts` — POST enter queue (one live session per employee),
      GET own position. `selectAllPaged`. Gated like `app/api/employee/documents/route.ts`.
- [ ] 10. `app/api/employee/support/chat/[id]/messages/route.ts` — GET + POST scoped to the caller's
      own session. **404, not 403**, on someone else's id.
- [ ] 11. `app/api/support/chat/queue/route.ts` — agent list + PATCH claim (compare-and-set → **409**
      on a lost race), gated on the new `employee_support` key.
- [ ] 12. `app/api/support/chat/[id]/messages/route.ts` — agent reply; writes the message, the in-app
      notification and the n8n leg.
- [ ] 13. `app/api/support/chat/availability/route.ts` — the on-queue toggle and its heartbeat.
- [ ] 14. **The abandonment path (Q1).** A lazy sweep on read converts an abandoned session into an
      `employee_support_tickets` row, carrying the transcript, stamping `became_ticket_id`, and
      answering the employee with the `ES-` number. This is the ticket side's first real consumer —
      its data layer is already on `main`.
- [ ] 15. `src/lib/audit/registry.ts` — one `employee_support.chat.` family. Actor is
      `auditFrom(request, authz)`, **never** the body.
- [ ] 16. `references/sql/alter/2026-09-19_add_chat_notification_types.sql` — restates the **FULL**
      `employee_notifications` type CHECK plus the chat types, and folds into task 3's script.
- [ ] 17. `src/components/employee/EmployeeSupportChat.tsx` — in the header cluster beside FAQs, in
      **both** mirrored clusters, **never a floating bubble** (Penny owns that corner). Position
      renders as a skeleton until it resolves, never as `0`.
- [ ] 18. `src/components/tickets/SupportChatTab.tsx` + `TicketsSidebar.tsx` — the agent side, with
      the on-queue toggle and the honest Live / Connecting / Polling pill. Re-apply `tickets-theme
      dark` on every portaled surface.
- [ ] 19. Docs: `docs/features/employee-support-chat.md`, **the missing
      `docs/features/employee-support.md`**, a real INDEX row for both, `api-reference.md`,
      `components.md`, memory — all in the same commit.
- [ ] 20. Amend `docs/superpowers/plans/2026-09-14-employee-support.md:6-9` and `:258-264` — the
      out-of-scope contract no longer excludes chat. Same commit.

## Deploy notes

- **MIGRATION PENDING — Kane runs it.** Three SQL files, one launcher. Kane has said *"let us stay in
  local for now"*: `.env.local` holds only `.env.example` placeholders, so nothing was verified and
  **the 2026-09-16 ticket migration's state is UNKNOWN, not unapplied.** Until both run, the routes
  report `migrated: false` and the UI says chat cannot accept sessions yet — **not 500, and not
  silently pretending to save.**
- **⚠ MIGRATION ORDER IS A HARD DEPENDENCY.** This migration **cannot run before** the 2026-09-16
  ticket migration: `became_ticket_id` is a foreign key into `employee_support_tickets`. Both the
  `.sql` precondition block and the apply script's pre-flight name the launcher to run first. Run
  `Apply Employee Support migration.cmd` before `Apply Employee Support Chat migration.cmd` — and
  because the earlier one's state is unknown, `--verify` it first rather than assuming.
- **The two widened CHECK lists are RECONSTRUCTED, not measured** — the roles list from six SQL
  files in git order cross-checked against `VALID_ROLES` (`app/api/employee-roles/route.ts:15-25`),
  the notification list from a seventeen-file chain cross-checked against
  `NOTIFICATION_TYPE_TO_VIEWS`. They are written in an additive, union-with-live shape so a wrong
  reconstruction **cannot DROP** an existing value — but **re-read both live definitions before
  `--apply` anyway.** The files and the `.cmd` both say so.
- **The ticket side still owes its own notification widen** (v1 plan task 3,
  `references/sql/alter/2026-09-16_add_support_notification_types.sql`, for `support.replied` /
  `support.answered`). It has never been written. Written in the same additive shape it is
  order-independent with this one; **written as a flat restatement it would strip both chat types.**
  Copy the shape, not the list.
- **The roles CHECK widen is load-bearing** and must be re-read against the live constraint first.
- **Five grants, by hand, after deploy**: `employee_support` to Carla, Claire, Ainsley, Grace, Alivia.
  Until those exist the staff tabs are empty for everyone.
- **n8n: PENDING Kane.** Slugs if the email leg ships — `support_chat_queued`, `support_chat_replied`.
  Recipient decided in code and handed over as `send_to`; the Gmail node never picks one.
- **No cron.** Expiry and abandonment sweep lazily on read, per `INDEX.md:42`.
- **Proof of work is `tsc` and the test suite**, not a database read. Note `main` carries 3
  pre-existing failures unrelated to this work.

## Out of scope — this is a contract

Payroll · dispatch · paystubs · rates · the existing `tickets` table, its four Kanban columns and
`TICKET_BOARD_OWNER` · the five existing n8n ticket hooks · **the ticket side's own routes and UI
(v1 plan tasks 8–19)** · the Penny filing entry point · urgency ranking and the queueing-line-to-board
promotion · response-time KPIs (Kane: *"lets not implement it now"*) · attachments (Decision 8) ·
per-day caps (Decision 6) · agent specialisation by concern (deferred to the Carla meeting) ·
changing `screening.ts` or `routing.ts` · the presence heartbeat hole (`SECURITY_AUDIT.md` row #50) ·
the ungated `PATCH /api/employee-notifications`.
