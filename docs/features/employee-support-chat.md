# Employee Support live chat — a queue, five answerers, and the ticket a dead chat becomes

An employee opens chat from their dashboard header, sees **where they are in the line**, and waits
for one of five named people to pick them up. If nobody does, the chat **becomes a support ticket**
with an `ES-` number and the one-working-day promise — so going unanswered is a state the system
handles rather than a hole someone falls through.

Built 2026-09-19 → 2026-09-21, commits `e59a16ea` (the build) and the follow-up closing seven
review findings. **Not reachable yet:** the migration is unapplied, no grants exist, and every route
answers `migrated: false` rather than pretending to save.

> **This reverses a signed decision.** Carla ticked *"Tickets first, add live chat once we know the
> volume"* on 2026-09-15. Kane overrode it on 2026-09-18 and reaffirmed when the contradiction was
> put to him. **She has not been told and she is the approver of record.** Plan:
> `docs/superpowers/plans/2026-09-19-employee-support-chat.md`. Sibling doc: `employee-support.md`.

## Key files

| Piece | File |
| --- | --- |
| Tables | `references/sql/create/2026-09-19_employee_support_chat.sql` |
| Role + notification CHECK widens | `references/sql/alter/2026-09-19_employee_support_role.sql` · `..._add_chat_notification_types.sql` |
| Migration runner | `scripts/apply-employee-support-chat-migration.mts` + `Apply Employee Support Chat migration.cmd` |
| Vocabulary — statuses, sides, `ESC-` format | `src/lib/support/chat-types.ts` |
| Live channel contract | `src/lib/support/chat-live.ts` |
| Position, ordering, the unknown state | `src/lib/support/queue.ts` |
| The on-queue toggle | `src/lib/support/availability.ts` |
| Conversion rules (pure) | `src/lib/support/abandonment.ts` |
| The sweep (I/O) | `src/lib/support/chat-sweep.ts` |
| Employee routes | `app/api/employee/support/chat/` |
| Agent routes | `app/api/support/chat/` |
| Employee UI | `src/components/employee/EmployeeSupportChat.tsx` |
| Agent UI | `src/components/tickets/SupportChatTab.tsx` |
| Access | `src/lib/rbac/feature-permissions.ts` · `view-tabs.ts` · `src/lib/auth/route-access.ts` |

## The sweep must have more than one caller

**This is the rule most likely to be undone, because undoing it looks like a tidy-up.**

An unanswered chat becomes a ticket lazily, on read — there is no cron and there must not be one
(`docs/features/INDEX.md:42`: every `/api/cron/*` 401s on the fail-closed `CRON_SECRET` gate, and
the two declared crons have never once run).

The sweep originally lived inside the agent queue route, which gave it exactly one caller. That
meant the promise fired **only while an agent was looking** — and the chats that go unanswered are
precisely the ones nobody is watching. An employee could wait, go quiet, and learn nothing until
somebody opened the board on Monday.

So it lives in `chat-sweep.ts` and **both** GETs call it: the agent queue, and the employee's own.
An employee checking their place is the read that always happens, which makes it the read that has
to convert. It runs *before* the state read, so the response that says "this expired" already
carries the number it became. A Next.js route module cannot export a helper — that is why this is a
module, and why moving it back into a route re-opens the defect.

## Three guards that look removable and are not

**Every status flip re-asserts staleness in its own WHERE.** `planSweep` decides once, but the
writes can land seconds later — a plan can queue ten conversions, each doing a transcript read, a
ticket lookup, an insert, two updates and a notification. In that window the employee's own GET
beats `last_seen_at`, because they came back. Without `.lt('last_seen_at', staleCutoff)` on both
flips, the sweep converts a live person's chat and mints them a ticket while they are watching it.
A check-then-act read must carry its condition into the UPDATE
(`app/api/contractor/invoices/[id]/route.ts:118-145`).

**The `completes` path takes a lease.** The convert path is safe because its status flip *is* a
compare-and-set. The completes path has no flip to ride on — the row is already `abandoned` and
already unstamped, which is exactly the state two readers agree on. Two polls landing together
would both find no existing ticket and both insert, leaving a second orphaned `ES-` number carrying
the promise for a question already answered. The lease is a conditional touch of `ended_at` pinned
to the value just read; the loser gets zero rows and stops.

**A position never rises.** Rank is `queued_at` alone, and the trigger **RAISES** on any attempt to
change it (SQL `:363-369`) rather than silently correcting — an UPDATE that tried to move somebody's
place is a bug in a route, and a quietly corrected bug is one nobody fixes. A released claim
re-enters with its original stamp, so the employee never pays for an agent's disconnect.

## Realtime carries a signal, never content

The route writes, broadcasts *"session N changed"*, and every client re-fetches through its own
gated route. **No message body, no email, no name, no queue position crosses the topic.**

This is not caution for its own sake: there is no `private: true` channel and no `realtime.setAuth`
call anywhere in this repo, so a Broadcast topic is readable by any holder of the public anon key.
Two shipped surfaces already get this wrong — `CobrowseChatProvider.tsx` puts message text on a
public topic and filters recipients in the *receiving* browser, and `GlobalPingListener.tsx` repeats
it. Neither is a precedent to follow. The tables are also deliberately **absent from
`supabase_realtime`**, because delivering `postgres_changes` to an anon browser would require a
permissive anon SELECT policy on pay disputes.

## Two catalogs, one route

The five answerers hold `employee_support`; the dev board holds `tickets`. Both surfaces live at
`/tickets` and share **nothing else**.

**The disjointness of the two feature catalogs IS the gate, in both directions.**
`requireFeatureAccessAnyView` maps each of the caller's roles to *its* view and resolves the feature
only there, so a support holder resolves `tickets` to hidden (and `/api/tickets` 403s them) while a
tickets holder resolves `support_chat` to hidden. A test asserts the two catalogs never share a key.

Two things that must stay as they are:

- **`VIEW_TAB_IDS.tickets` stays `[]`.** A support tab listed there would be gated by the `tickets`
  overlay, which the `tickets` role auto-provisions to `edit` wholesale.
- **The support view lists no fallback tab.** `allowedTabsForUser` falls back to `FALLBACK_TABS`
  (`overview`) when the overlay grants nothing, so a support view containing `overview` would land
  an un-provisioned holder on the dev board's Overview. `FALLBACK_TABS` is exported purely so a test
  can assert the lists stay disjoint — adding `overview` to the support tabs fails CI.

`ticketsHostAccess(roles, perms)` is the single decision function for what a visitor sees, so the
sidebar nav, the landing and any inner guard cannot disagree.

## Availability is declared, never inferred

An agent is on the queue because they **said so** — an explicit toggle plus a heartbeat, stored in
`employee_support_chat_agents`. It is not presence: `POST /api/presence/heartbeat` takes the email
from the **request body** when there is no session (`SECURITY_AUDIT.md` row #50), so anyone can
stamp anyone present. Beyond the security problem, presence answers *"were they around"* where this
must answer *"is someone about to pick me up"*.

Four states, never two: agents on and waiting · agents on and busy · nobody on · **we cannot tell**.
An unreadable agents table is not an empty one.

## "Nobody is waiting" and "we cannot tell" are different

`QueueState` carries `waiting`, `position` **and** `resolved`. `resolved: true` with a null position
means the caller is genuinely not in the line; `resolved: false` means we could not work it out and
the UI owes them a skeleton. **Nothing renders `0` for an unknown**, and the position is **never
clamped** — 100th in line is something the employee deserves told honestly so they can file a ticket
instead.

A position is a COUNT over a set and PostgREST caps a set at 1000 rows with no error, so every
queue read pages with `selectAllPaged`. An unpaged read yields a confidently wrong position, which
is worse than none.

## Hours are Eastern only

Kane, 2026-09-18: *"every employee is on EST so dont mind the time zone please."* The chat surface
builds its own sentence from `SUPPORT_OPEN_HOUR` / `SUPPORT_CLOSE_HOUR` and does **not** call
`describeSupportHours`, which renders a Manila zone nobody in the company is in. `hours.ts` is left
alone — its other caller is the ticket form, whose copy is a separate decision.

It also does not reuse `describeSupportAvailability`: that promises the message is still accepted,
which is true of a ticket and false of a chat nobody is sitting in.

## Deploy notes

- **APPLIED 2026-09-21 — measured by read-only `--verify`, 171 checks OK.** The three chat tables
  (RLS on, out of `supabase_realtime`), the role widen (14 roles, nothing dropped), both
  notification widens, and the triage columns. The launcher now applies **six** files; two landed
  short on the first run because it was run before the sixth was folded in: the chat **`category`**
  column, and the **`triaged_by`** lower-casing (the ALTER's trigger claim was false; fixed in the
  trigger). **One re-run of the same launcher lands both** — every file is idempotent. Launcher:
  `scripts/Apply Employee Support Chat migration.cmd`; `--verify` is read-only.
- **Order mattered and was honoured**: the 2026-09-16 ticket migration was applied first —
  `became_ticket_id` is a foreign key into `employee_support_tickets` — and its state, unknown for
  five days, is now **measured APPLIED**.
- **Both widened CHECK lists are RECONSTRUCTED, not measured** — `.env.local` holds only
  `.env.example` placeholders, so nothing could be probed. They are written additively so a wrong
  reconstruction cannot DROP a value, but **re-read both live definitions before `--apply`**.
- **Five grants by hand after deploy**: `employee_support` to Carla, Claire, Ainsley, Grace, Alivia.
  `VALID_ROLES` offers the role but the DB CHECK rejects the INSERT until the widen runs.
- **n8n: PENDING.** `support_chat_queued`, `support_chat_replied`. Recipient decided in code and
  handed over as `send_to`; `null` never `''`, because the Gmail node is stop-on-error.
- **No cron**, and do not add one. Expiry and conversion sweep lazily on read.
- **A missing index is named rather than hidden**: no partial index covers
  `status = 'abandoned' AND became_ticket_id IS NULL`, the recovery read's predicate. Correct and
  cheap while the table is small; it belongs in the next migration.
