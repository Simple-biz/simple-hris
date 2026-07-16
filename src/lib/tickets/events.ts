import type { SupabaseClient } from '@supabase/supabase-js';
import type { TicketEventAction, TicketFieldChange } from '@/lib/tickets/types';

/**
 * Append a row to a ticket's history trail (`ticket_events`). Fire-and-forget:
 * history must never fail the write it describes, so errors only warn. The
 * dialog's activity feed reads these back via GET /api/tickets/[id]/events.
 */
export function logTicketEvent(
  supabase: SupabaseClient,
  args: {
    ticketId: string;
    action: TicketEventAction;
    actorEmail: string;
    actorName?: string | null;
    /** Field-level diff for `updated`/`moved`; omit for lifecycle actions. */
    changes?: TicketFieldChange[];
  },
): void {
  void supabase
    .from('ticket_events')
    .insert({
      ticket_id: args.ticketId,
      action: args.action,
      changes: args.changes && args.changes.length > 0 ? args.changes : null,
      actor_email: args.actorEmail,
      actor_name: args.actorName ?? null,
    })
    .then(({ error }) => {
      if (error) console.warn('[tickets] history event failed:', error.message);
    });
}
