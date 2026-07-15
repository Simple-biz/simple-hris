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
