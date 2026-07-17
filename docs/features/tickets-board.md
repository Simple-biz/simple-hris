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
- **Notifications**: assignment fires an n8n email
  (`references/n8n/ticket-assigned-email.workflow.json`, webhook configured in
  Admin → Webhooks) and in-app notifications via
  `src/lib/tickets/notify.ts` → NotificationsPanel.

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
