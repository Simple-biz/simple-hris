/**
 * Shared shapes for the HRIS Updates Kanban board (/tickets).
 * Pure types + constants — safe to import from client and server code.
 */

/** Board columns, in display order. */
export const TICKET_STATUSES = ['todo', 'in_progress', 'testing', 'done'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  testing: 'Testing',
  done: 'Done',
};

/** The board owner — the single account that owns ticket triage. Every new
 *  ticket defaults to this assignee, and ONLY this account may set, change, or
 *  clear a ticket's `assigned_to` (POST + PATCH /api/tickets enforce it
 *  server-side; the ticket dialog and Admin → Design & Specs pickers render
 *  read-only for everyone else). Distinct from "who can move cards" — see
 *  TICKET_BOARD_MOVERS. Lowercase. */
export const TICKET_BOARD_OWNER = 'kaner@simple.biz';

/** Who may MOVE cards between columns (drag, or the dialog's Column select):
 *  this allowlist (the board owner) PLUS each ticket's assigned developer,
 *  who walks their own ticket across the workflow as they work it. Everyone
 *  else creates tickets and replies. Enforced server-side in
 *  PATCH /api/tickets/[id]; the UI reads the same rule to gate dragging
 *  per card. Lowercase. */
export const TICKET_BOARD_MOVERS = [TICKET_BOARD_OWNER] as const;

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export interface TicketRow {
  id: string;
  ticket_no: number;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  position: number;
  created_by: string;
  created_by_name: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  /** Set when the ticket is archived (soft delete — tickets are never hard
   *  deleted). Archived tickets leave the board but stay in the Archived view
   *  and can be restored by their creator or an admin. */
  archived_at: string | null;
  archived_by: string | null;
  /** Populated by GET /api/tickets (aggregate); absent on single-row writes. */
  comment_count?: number;
}

/** A reply on a ticket's Updates thread. Immutable once posted. */
export interface TicketComment {
  id: string;
  ticket_id: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
}

/** Someone with access to the /tickets board, as returned by
 *  GET /api/tickets/members: an explicit `tickets` feature grant (view/edit)
 *  or the admin role (which bypasses feature gates entirely). Identity fields
 *  come from the master list; they stay null when the grant email has no
 *  active master row. */
export interface TicketMember {
  email: string;
  name: string | null;
  department: string | null;
  photo_url: string | null;
  access: 'admin' | 'edit' | 'view';
}

/** True when a board member can be ASSIGNED tickets as a developer: an
 *  explicit `tickets = edit` grant (Admin → Roles & Permissions → "Ticket
 *  Board" = Edit) or the admin role, which implies edit. View-only members
 *  can watch and reply but never own a ticket. The assignee pickers (ticket
 *  dialog, Admin → Design & Specs) filter on this, and PATCH/POST
 *  /api/tickets enforce it server-side on every `assigned_to` write. */
export function isAssignableDeveloper(m: Pick<TicketMember, 'access'>): boolean {
  return m.access === 'edit' || m.access === 'admin';
}

/** History event kinds recorded in `ticket_events` on every write. */
export const TICKET_EVENT_ACTIONS = ['created', 'updated', 'moved', 'archived', 'restored'] as const;
export type TicketEventAction = (typeof TICKET_EVENT_ACTIONS)[number];

/** One field change inside a `ticket_events` row (`changes` jsonb). */
export interface TicketFieldChange {
  field: 'title' | 'description' | 'priority' | 'status' | 'assigned_to';
  from: string | null;
  to: string | null;
}

/** An entry on a ticket's history trail ("who changed what, when"). Written
 *  server-side on every create/edit/move/archive/restore; rendered in the
 *  ticket dialog's activity feed alongside comments. Immutable. */
export interface TicketEvent {
  id: string;
  ticket_id: string;
  action: TicketEventAction;
  /** Field-level diff for `updated`/`moved`; null for lifecycle actions. */
  changes: TicketFieldChange[] | null;
  actor_email: string;
  actor_name: string | null;
  created_at: string;
}
