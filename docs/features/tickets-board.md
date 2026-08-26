# Tickets — HRIS Updates Kanban board (`/tickets`)

A standalone Kanban board for tracking HRIS feature requests / bug tickets,
worked by the internal dev group. Built Jul 15–17, 2026 across many sessions
(commits `7a5e456`, `94ef655`, `e82584a`, `07127b1`, `5c813a4` + uncommitted
Jul 17 work).

## What it is

- **Columns**: To Do → In Progress → Testing → Done (`TICKET_STATUSES` in
  `src/lib/tickets/types.ts`). Cards carry a `ticket_no`, title, description,
  priority (Low/Medium/High/Urgent), assignee, and comment count.
- **Views** (via `TicketsSidebar`): **Overview** (stats landing page — the
  default view on load/refresh), **Board** (the dnd-kit Kanban), **Archived**.
  Deep link `?ticket=<id>` opens that ticket's dialog on top of whatever view
  is showing.
- **Theme**: fixed black + signal-red console in both global themes — see
  [ui-standards.md § 1.4](../design/ui-standards.md). Portaled dialogs/selects
  must re-apply `tickets-theme dark`.

## Access model (dedicated role)

- The `/tickets` route, page layout, and ViewSwitcher entry are gated on the
  dedicated **`tickets` role** (plus admin) — dashboard roles do **not**
  confer access (leak fixed 2026-07-16; the "Ticket Board" tab was removed
  from all four dashboard feature catalogs). Enforced in
  `src/lib/auth/route-access.ts`, `app/tickets/layout.tsx`,
  `src/lib/rbac/views.ts`.
- Inside the board, the per-user `tickets` **feature grant** decides depth:
  `view` = watch and reply; `edit` = can be assigned tickets as a developer
  (`isAssignableDeveloper`); admin implies edit.
  `GET /api/tickets/members` returns the member pool with identity fields
  joined from the master list.

## Assignment + movement (owner-centric)

- **Board owner**: `TICKET_BOARD_OWNER = kaner@simple.biz`. Every new ticket
  **defaults to the owner**, and only the owner may set, change, or clear
  `assigned_to` — enforced server-side in POST `/api/tickets` and PATCH
  `/api/tickets/[id]`; the assignee pickers (ticket dialog, Admin → Design &
  Specs) render read-only for everyone else. (Supersedes the brief
  "developers self-assign" model from commit `07127b1`.)
- **Movers**: cards can be moved (drag or the dialog's Column select) by the
  board owner plus each ticket's assigned developer walking their own ticket
  across the workflow. Everyone else creates tickets and replies.
- Ordering uses **fractional positioning** (midpoint between neighbors — no
  mass renumbering on drop).

## Collaboration & history

- **Comments** (`ticket_comments`): immutable Updates thread per ticket.
- **Events** (`ticket_events`): every create/edit/move/archive/restore is
  recorded server-side with a field-level diff and rendered in the dialog's
  activity feed (`src/lib/tickets/events.ts`,
  `app/api/tickets/[id]/events/route.ts`).
- **Archive, not delete**: tickets are never hard-deleted; archiving stamps
  `archived_at/by`, removes the card from the board, and leaves it restorable
  (by creator or admin) from the Archived view.
- **Live**: Supabase Realtime with a 30s poll + focus-refresh fallback (a
  "Live"/"degraded" indicator tracks the websocket). Refetches never clobber
  an in-flight drag.

## Notifications — who hears what, and why

Five outbound events. Every one of them decides its recipient **in code**, in
`src/lib/tickets/notify.ts`, and hands n8n a `send_to` — the Gmail node never
picks a recipient itself. That is one place to read and one place to fix.

| Event | Webhook slug | Email goes to | In-app type |
| --- | --- | --- | --- |
| Ticket created | `ticket_created` | the board owner (`kaner@`) — never the filer | — |
| Assignee set/changed | `ticket_assigned` | the new assignee | `ticket.assigned` |
| Comment added | `ticket_replied` | **the counterparty** (see below) | `ticket.replied` → creator **and** assignee |
| Column changed | `ticket_moved` | **the creator only** | `ticket.moved` |
| Moved to Done | `ticket_done` | the creator | `ticket.moved` |

The recipient rules are Kane's, 2026-08-21, and both live in one pure module,
`src/lib/tickets/recipients.ts`, so the email leg and the in-app leg can never
drift apart:

- **A comment emails the counterparty** — the ticket's creator, or the assigned
  developer when the creator is the one who typed it. Nobody is ever emailed
  about their own comment. A third party commenting does **not** silence the
  creator.
- **A move emails the creator, and only the creator.** The developer is usually
  the one dragging the card, so mailing them their own move is noise — and the
  dev is deliberately **not** a fallback here, which is the one place the move
  rule differs from the comment rule. Creator moved it themselves → nobody is
  mailed.
- **Every move fires**, including a backward `testing → in_progress` bounce:
  "your ticket went back" is real news, so there is **no status allowlist**. The
  n8n payload carries `direction: forward | backward` so one workflow can phrase
  a bounce differently without hardcoding the column order.
- **`done` is excluded from `ticket_moved`** by the PATCH route, not by the hook.
  It has its own richer "refresh and test it" email, and one move must never send
  two emails. It still writes the in-app `ticket.moved` row.

Two things that look like bugs and are not:

- **The email is narrower than the in-app row on comments.** `ticket.replied`
  rows go to creator *and* assignee; the email goes to one person. A panel row is
  cheap, an inbox is not. Do not "fix" the asymmetry by widening the email.
- **A hook with no configured webhook sends nothing and logs nothing.** Every
  hook resolves its URL (Admin → Webhooks slug first, then the env var) and
  silently returns when there is none. All five are `void`-called with a 10s
  `AbortSignal.timeout` and never throw, because a notification hiccup must not
  fail the comment or move that is already saved.

**An empty `send_to` must never reach n8n.** The Gmail node is stop-on-error, so
an empty To fails the whole workflow run instead of skipping it — which is how
the orientation-email Invalid-To incident happened. `recipients.ts` returns
`null` rather than an empty string, and each hook returns early on it.

## Adjacent surfaces

- **Admin → Design & Specs** (`AdminDesignSpecs.tsx`): an assignment console
  listing tickets with assignee selects (owner-only) and spec content.
- **CEO assistant**: read-only ticket tools in `src/lib/anthropic/ceo-tools.ts`
  let the CEO chat widget report on board state.
- **Overview design**: two passes — a dataviz/IA restructure (Jul 15: "Open
  now" lead figure, week-over-week deltas, animated priority bars) and a
  mockup translation (Jul 17: window-dot card motif, smoked-glass KPI cards
  over a red glow). The black+red palette was explicitly reaffirmed; don't
  introduce the light/violet mockup palette.

## Migrations (run in order, all in Supabase SQL Editor)

| File | What |
| --- | --- |
| `references/sql/migrate/2026-07-15_tickets_kanban.sql` | Tables: tickets, comments + realtime |
| `references/sql/migrate/2026-07-16_tickets_archive_history.sql` | `archived_at/by` + `ticket_events` history |
| `references/sql/migrate/2026-07-16_tickets_dedicated_role_only.sql` | Revokes leaked per-dashboard `tickets` grants (re-grant the Tickets role afterwards to whoever should keep access) |
| `references/sql/alter/2026-08-21_add_ticket_moved_notification_type.sql` | Widens `employee_notifications_type_check` to allow `ticket.moved`. **APPLIED — measured 2026-08-26** (read-only `pg_get_constraintdef`, negative control `definitely.not.a.type.xyz` correctly rejected). Re-check with `node scripts/apply-ticket-moved-notification-type.mjs` (no flag) |

## Deploy notes — update notifications (2026-08-21, re-measured 2026-08-26)

Two external steps were recorded PENDING on 2026-08-21. **Both were measured on
2026-08-26 rather than re-asserted, and they came back split: one is done, one is
not.** That split is the point of this section — the in-app leg is live and the
email leg is not, so a comment now raises a bell and sends no mail.

1. **The CHECK widen — APPLIED.** `ticket.moved` is present in the live
   `employee_notifications_type_check` (42 permitted types), read straight off
   `pg_get_constraintdef` with a negative control (`definitely.not.a.type.xyz`)
   that was correctly rejected — so the read can detect absence and is not merely
   failing to notice it. A full parity sweep of every notification type the app
   can insert against that constraint found **zero rejected**, which is the check
   that would have caught `kpi.scored` shipping dead for three days in August 2026
   (0 rows written, the only trace a `console.warn`). Re-run it any time with
   `node scripts/apply-ticket-moved-notification-type.mjs` (no flag: it reads and
   prints the live definition).
2. **The n8n imports — STILL OPEN, and measured so.** `webhooks.config` in
   `app_settings` holds 22 entries; `ticket_created`, `ticket_done` and
   `ticket_assigned` are configured and active, and **`ticket_replied` and
   `ticket_moved` are both ABSENT.** So `resolveWebhookUrl` returns `null` and
   both hooks no-op by design — no error, no email. Closing it needs
   `references/n8n/ticket-replied-email.workflow.json` and
   `ticket-moved-email.workflow.json` imported, then each webhook URL pasted into
   Admin → Webhooks under `ticket_replied` / `ticket_moved` (or
   `N8N_TICKETS_REPLIED_WEBHOOK_URL` / `N8N_TICKETS_MOVED_WEBHOOK_URL` set).

Neither step may be *inferred* to have happened in either direction — 2026-08-21
recorded both pending and one of them was already done. Read the constraint and
read `webhooks.config`; do not read a doc, this one included.
