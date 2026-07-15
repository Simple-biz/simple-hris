import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketRow,
} from './types';

/** Origin used for links inside the emails. NEXTAUTH_URL is localhost during
 *  dev — a link nobody's inbox can open — so anything non-public falls back to
 *  the production origin. */
function publicOrigin(): string {
  const raw = (process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(raw)) {
    return 'https://simple-hris.vercel.app';
  }
  return raw;
}

/**
 * Fire the `ticket_created` webhook (n8n) when a new ticket lands on the
 * board — the n8n side emails the details to the admin. Same resolution as
 * every other outbound hook: Admin → Webhooks entry with slug `ticket_created`
 * first, then the N8N_TICKETS_WEBHOOK_URL env var. Silently a no-op when
 * neither is configured, and never throws — a notification hiccup must not
 * fail the ticket creation it rides on (callers `void` this).
 */
export async function notifyTicketCreated(ticket: TicketRow): Promise<void> {
  try {
    const url = await resolveWebhookUrl('ticket_created', {
      envVars: ['N8N_TICKETS_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ticket.created',
        // Who this alert is FOR: the board owner — never the ticket creator.
        // The n8n Gmail node should use this as its "To" so the recipient is
        // decided here, in one place, instead of per-workflow.
        send_to: 'kaner@simple.biz',
        ticket_no: ticket.ticket_no,
        title: ticket.title,
        description: ticket.description ?? '',
        priority: ticket.priority,
        priority_label: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        status: ticket.status,
        status_label: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
        created_by: ticket.created_by,
        created_by_name: ticket.created_by_name ?? '',
        created_at: ticket.created_at,
        board_url: `${origin}/tickets`,
        // Deep link — the board auto-opens this ticket's details dialog.
        ticket_url: `${origin}/tickets?ticket=${encodeURIComponent(ticket.id)}`,
      }),
      // Bound the call so a slow/unreachable n8n can't hang the create response.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the ticket is already saved.
  }
}

/**
 * Fire the `ticket_done` webhook (n8n) when a ticket lands in the Done column
 * — the n8n side emails the ticket's CREATOR that their request shipped and
 * they can refresh the HRIS and test it. Resolution mirrors notifyTicketCreated
 * (Admin → Webhooks slug `ticket_done`, then N8N_TICKETS_DONE_WEBHOOK_URL).
 * No-op when unconfigured; never throws.
 */
export async function notifyTicketDone(ticket: TicketRow, movedBy: string): Promise<void> {
  try {
    const url = await resolveWebhookUrl('ticket_done', {
      envVars: ['N8N_TICKETS_DONE_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ticket.done',
        // n8n's email node sends to this — the person who filed the ticket.
        send_to: ticket.created_by,
        creator_name: ticket.created_by_name ?? ticket.created_by.split('@')[0],
        ticket_no: ticket.ticket_no,
        title: ticket.title,
        description: ticket.description ?? '',
        priority_label: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        moved_by: movedBy,
        done_at: new Date().toISOString(),
        board_url: `${origin}/tickets`,
        // Deep link — the board auto-opens this ticket's details dialog.
        ticket_url: `${origin}/tickets?ticket=${encodeURIComponent(ticket.id)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the move is already saved.
  }
}

/**
 * Fire the `ticket_assigned` webhook (n8n) when a ticket gets a (new)
 * assignee — the n8n side emails THEM the full ask, pairing with the in-app
 * notification the PATCH route writes. Resolution mirrors the other two
 * hooks (Admin → Webhooks slug `ticket_assigned`, then
 * N8N_TICKETS_ASSIGNED_WEBHOOK_URL). No-op when unconfigured; never throws.
 */
export async function notifyTicketAssigned(ticket: TicketRow, assignedBy: string): Promise<void> {
  try {
    const assignee = (ticket.assigned_to ?? '').trim().toLowerCase();
    if (!assignee) return;
    const url = await resolveWebhookUrl('ticket_assigned', {
      envVars: ['N8N_TICKETS_ASSIGNED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    const assigneeName = await lookupFullNameForEmail(assignee);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ticket.assigned',
        // The assignee — the n8n Gmail node uses this as its "To".
        send_to: assignee,
        assignee_name: assigneeName ?? assignee.split('@')[0],
        assigned_by: assignedBy,
        ticket_no: ticket.ticket_no,
        title: ticket.title,
        description: ticket.description ?? '',
        priority: ticket.priority,
        priority_label: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        status_label: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
        created_by: ticket.created_by,
        created_by_name: ticket.created_by_name ?? ticket.created_by.split('@')[0],
        board_url: `${origin}/tickets`,
        ticket_url: `${origin}/tickets?ticket=${encodeURIComponent(ticket.id)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the assignment is already saved.
  }
}
