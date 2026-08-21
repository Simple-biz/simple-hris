import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import {
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  type TicketRow,
  type TicketStatus,
} from './types';
import { commentEmailRecipient, moveEmailRecipient, type TicketParties } from './recipients';

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
 * Fire the `ticket_replied` webhook (n8n) when a comment lands on a ticket —
 * the n8n side emails the ONE person the reply concerns, resolved by
 * `commentEmailRecipient`: the ticket's creator, or the assigned developer when
 * the creator is the one who typed it. Kane's rule 2026-08-21.
 *
 * Resolution mirrors every other hook here (Admin → Webhooks slug
 * `ticket_replied`, then N8N_TICKETS_REPLIED_WEBHOOK_URL). No-op when
 * unconfigured; never throws — the comment is already saved.
 *
 * This is the EMAIL leg only. The in-app `ticket.replied` rows are written by
 * POST /api/tickets/[id]/comments and go to creator AND assignee; the email is
 * deliberately the narrower of the two, because an inbox is not a panel.
 */
export async function notifyTicketReplied(
  ticket: TicketRow | (TicketParties & Pick<TicketRow, 'id' | 'ticket_no' | 'title' | 'priority' | 'status'>),
  comment: { body: string; author_email: string; author_name: string | null },
): Promise<void> {
  try {
    // Decided here, in code, exactly like every other send_to on this board —
    // never inside the n8n workflow. A null recipient means the only party is
    // the person who typed it, and n8n's Gmail node is stop-on-error, so an
    // empty To would fail the whole run rather than skip it.
    const sendTo = commentEmailRecipient(ticket, comment.author_email);
    if (!sendTo) return;

    const url = await resolveWebhookUrl('ticket_replied', {
      envVars: ['N8N_TICKETS_REPLIED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    const recipientName = await lookupFullNameForEmail(sendTo);
    const body = comment.body.trim();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ticket.replied',
        send_to: sendTo,
        recipient_name: recipientName ?? sendTo.split('@')[0],
        // Whether the reader is the requester or the dev changes how the email
        // should read, and n8n cannot work that out from send_to alone.
        recipient_is_creator: sendTo === (ticket.created_by ?? '').trim().toLowerCase(),
        replier_email: comment.author_email,
        replier_name: comment.author_name ?? comment.author_email.split('@')[0],
        ticket_no: ticket.ticket_no,
        title: ticket.title,
        // The whole reply — the point of the email is not having to open the
        // board to read it. The panel excerpt is capped; this is not.
        comment_body: body,
        priority_label: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        status_label: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
        replied_at: new Date().toISOString(),
        board_url: `${origin}/tickets`,
        ticket_url: `${origin}/tickets?ticket=${encodeURIComponent(ticket.id)}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort only — the comment is already saved.
  }
}

/**
 * Fire the `ticket_moved` webhook (n8n) when a ticket changes column — the n8n
 * side emails the ticket's CREATOR where their request went. Kane's rules
 * 2026-08-21: the creator only (never the developer, who is usually the one
 * moving the card), and EVERY move, including a backward Testing → In Progress
 * bounce, because "your ticket went back" is real news.
 *
 * `done` is excluded by the caller, not here: it has its own richer
 * "refresh and test it" email (notifyTicketDone), and one move must never send
 * two emails.
 *
 * Resolution mirrors the other hooks (Admin → Webhooks slug `ticket_moved`,
 * then N8N_TICKETS_MOVED_WEBHOOK_URL). No-op when unconfigured; never throws.
 */
export async function notifyTicketMoved(
  ticket: TicketRow,
  from: TicketStatus,
  movedBy: string,
): Promise<void> {
  try {
    const sendTo = moveEmailRecipient(ticket, movedBy);
    if (!sendTo) return;

    const url = await resolveWebhookUrl('ticket_moved', {
      envVars: ['N8N_TICKETS_MOVED_WEBHOOK_URL'],
    });
    if (!url) return;

    const origin = publicOrigin();
    const order = ['todo', 'in_progress', 'testing', 'done'] as const;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ticket.moved',
        send_to: sendTo,
        creator_name: ticket.created_by_name ?? ticket.created_by.split('@')[0],
        ticket_no: ticket.ticket_no,
        title: ticket.title,
        description: ticket.description ?? '',
        from_status: from,
        from_label: TICKET_STATUS_LABELS[from] ?? from,
        to_status: ticket.status,
        to_label: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
        // Lets one workflow phrase a bounce-back differently from progress
        // without hardcoding the column order in n8n.
        direction: order.indexOf(ticket.status) < order.indexOf(from) ? 'backward' : 'forward',
        priority_label: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        moved_by: movedBy,
        moved_at: new Date().toISOString(),
        board_url: `${origin}/tickets`,
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

/**
 * Both legs of "you've been assigned this ticket", fired the moment a ticket
 * gets a new developer: the in-app HRIS notification (lands instantly in the
 * assignee's Notifications panel) and the `ticket_assigned` n8n email hook.
 * The in-app message carries the full ask (title, priority, details excerpt),
 * so it stands on its own even for someone with no access to the /tickets
 * board. Callers gate on "assignee actually changed, and isn't the actor" —
 * shared by PATCH (re-assignment) and POST (assigned at creation).
 * Fire-and-forget: a notification hiccup must not fail the saved write.
 */
export function sendTicketAssignedNotifications(
  supabase: SupabaseClient,
  ticket: TicketRow,
  assignedBy: string,
): void {
  const assignee = (ticket.assigned_to ?? '').trim().toLowerCase();
  if (!assignee) return;

  void notifyTicketAssigned(ticket, assignedBy);

  const details = (ticket.description ?? '').trim();
  void supabase
    .from('employee_notifications')
    .insert({
      recipient_email: assignee,
      type: 'ticket.assigned',
      tone: 'neutral',
      title: `You've been assigned ticket #${ticket.ticket_no}`,
      message:
        `${assignedBy} assigned you "${ticket.title}" ` +
        `(${TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority} priority).` +
        (details ? ` Details: ${details.slice(0, 200)}${details.length > 200 ? '…' : ''}` : ''),
      details: {
        ticket_id: ticket.id,
        ticket_no: ticket.ticket_no,
        assigned_by: assignedBy,
        priority: ticket.priority,
      },
    })
    .then(({ error }) => {
      if (error) console.warn('[tickets] assignment notification failed:', error.message);
    });
}
