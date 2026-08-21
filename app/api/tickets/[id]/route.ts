import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { logTicketEvent } from '@/lib/tickets/events';
import { listTicketMembers } from '@/lib/tickets/members';
import {
  notifyTicketDone,
  notifyTicketMoved,
  sendTicketAssignedNotifications,
} from '@/lib/tickets/notify';
import { moveEmailRecipient } from '@/lib/tickets/recipients';
import {
  TICKET_BOARD_MOVERS,
  TICKET_BOARD_OWNER,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITIES,
  isAssignableDeveloper,
  type TicketFieldChange,
  type TicketRow,
  type TicketStatus,
  type TicketPriority,
} from '@/lib/tickets/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

const SELECT_COLS =
  'id, ticket_no, title, description, status, priority, position, created_by, created_by_name, assigned_to, created_at, updated_at, archived_at, archived_by';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fields whose edits land on the ticket's history trail. `position` is
 *  deliberately absent — in-column reorders are noise, not history. */
const TRACKED_FIELDS = ['title', 'description', 'priority', 'status', 'assigned_to'] as const;

// PATCH /api/tickets/[id] — edit fields, move the card, or restore from the
// archive. Body (all optional): { title, description, priority, status,
// position, assigned_to, archived: false }. Every field change is recorded in
// `ticket_events` so the dialog can show who changed what, when.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEditAnyView('tickets');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: {
    title?: string;
    description?: string | null;
    priority?: string;
    status?: string;
    position?: number;
    assigned_to?: string | null;
    archived?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data: before, error: fetchErr } = await supabase
    .from('tickets')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!before) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  const beforeRow = before as TicketRow;

  // ── Restore from the archive (the only write allowed on an archived row) ──
  if (body.archived === false) {
    if (!beforeRow.archived_at) {
      return NextResponse.json({ error: 'Ticket is not archived' }, { status: 400 });
    }
    const isAdmin = authz.roles.includes('admin');
    const isCreator = beforeRow.created_by.toLowerCase() === authz.sessionEmail;
    if (!isAdmin && !isCreator) {
      return NextResponse.json(
        { error: 'Only the ticket creator or an admin can restore a ticket' },
        { status: 403 },
      );
    }
    const { data, error } = await supabase
      .from('tickets')
      .update({ archived_at: null, archived_by: null })
      .eq('id', id)
      .select(SELECT_COLS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      ...actor,
      action: 'ticket.restored',
      resource: 'tickets',
      resource_id: String(beforeRow.ticket_no),
      details: { title: beforeRow.title, status: beforeRow.status },
    });
    logTicketEvent(supabase, {
      ticketId: id,
      action: 'restored',
      actorEmail: authz.sessionEmail,
      actorName: await lookupFullNameForEmail(authz.sessionEmail),
    });
    return NextResponse.json({ ticket: data as TicketRow });
  }

  if (beforeRow.archived_at) {
    return NextResponse.json(
      { error: 'This ticket is archived — restore it before editing.' },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = (body.title ?? '').trim();
    if (!title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
    if (title.length > 200) return NextResponse.json({ error: 'title is too long (max 200)' }, { status: 400 });
    patch.title = title;
  }
  if (body.description !== undefined) {
    patch.description = (body.description ?? '').trim() || null;
  }
  if (body.priority !== undefined) {
    const priority = (body.priority ?? '').trim().toLowerCase();
    if (!TICKET_PRIORITIES.includes(priority as TicketPriority)) {
      return NextResponse.json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(', ')}` }, { status: 400 });
    }
    patch.priority = priority;
  }
  if (body.status !== undefined) {
    const status = (body.status ?? '').trim().toLowerCase();
    if (!TICKET_STATUSES.includes(status as TicketStatus)) {
      return NextResponse.json({ error: `status must be one of: ${TICKET_STATUSES.join(', ')}` }, { status: 400 });
    }
    patch.status = status;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
      return NextResponse.json({ error: 'position must be a finite number' }, { status: 400 });
    }
    patch.position = body.position;
  }
  if (body.assigned_to !== undefined) {
    patch.assigned_to = (body.assigned_to ?? '').trim().toLowerCase() || null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // Assignment is owner-only. Only the board owner (TICKET_BOARD_OWNER) may
  // set, change, or clear a ticket's developer. Everyone else can still edit
  // the other fields and — if they're the assignee — move the card, but never
  // touch `assigned_to`. Gated on an ACTUAL change so a no-op echo of the
  // current assignee (e.g. a developer saving the dialog to move their own
  // ticket) still goes through.
  const isOwner = authz.sessionEmail === TICKET_BOARD_OWNER;
  const requestedAssignee = patch.assigned_to as string | null | undefined;
  const assigneeChanged =
    patch.assigned_to !== undefined &&
    (requestedAssignee ?? '') !== (beforeRow.assigned_to ?? '').trim().toLowerCase();
  if (assigneeChanged && !isOwner) {
    return NextResponse.json(
      { error: 'Only the board owner can assign or reassign a ticket.' },
      { status: 403 },
    );
  }

  // The owner's developer pick must be in the assignable pool: the people with
  // an Edit grant on the Ticket Board (Roles & Permissions) or the admin role —
  // the same list the pickers show (/api/tickets/members). Checked only when
  // the assignee actually changes, so tickets carrying a legacy/free-text
  // assignee can still have their other fields edited. Unassigning is free.
  if (requestedAssignee && assigneeChanged) {
    try {
      const members = await listTicketMembers(supabase);
      const developer = members.find(
        (m) => m.email === requestedAssignee && isAssignableDeveloper(m),
      );
      if (!developer) {
        return NextResponse.json(
          {
            error:
              'Only developers with Edit access to the Ticket Board can be assigned. Grant it in Admin → Roles & Permissions first.',
          },
          { status: 400 },
        );
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not verify the assignee' },
        { status: 500 },
      );
    }
  }

  // Moving a card (column or in-column position) is allowed for the board
  // movers allowlist AND the ticket's assigned developer, who walks their own
  // ticket across the workflow. (Assignment itself is owner-only — gated
  // above — so a developer only ever moves a ticket the owner routed to them.)
  // Everyone else may still create tickets, edit fields, and reply. Compared
  // against the CURRENT row so a no-op status echo from the edit dialog
  // doesn't trip it.
  const wantsMove =
    (patch.status !== undefined && patch.status !== beforeRow.status) ||
    (patch.position !== undefined && patch.position !== beforeRow.position);
  const effectiveAssignee = (
    (patch.assigned_to !== undefined ? (patch.assigned_to as string | null) : beforeRow.assigned_to) ?? ''
  )
    .trim()
    .toLowerCase();
  const isMover = (TICKET_BOARD_MOVERS as readonly string[]).includes(authz.sessionEmail);
  if (wantsMove && !isMover && effectiveAssignee !== authz.sessionEmail) {
    return NextResponse.json(
      { error: "Only the board owner or this ticket's assigned developer can move it between columns." },
      { status: 403 },
    );
  }

  const { data, error } = await supabase
    .from('tickets')
    .update(patch)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ticket = data as TicketRow;
  const moved = patch.status !== undefined && patch.status !== beforeRow.status;
  const actor = await getSessionActor();
  void insertAuditLog({
    ...actor,
    action: moved ? 'ticket.moved' : 'ticket.updated',
    resource: 'tickets',
    resource_id: String(ticket.ticket_no),
    details: moved
      ? { title: ticket.title, from: beforeRow.status, to: ticket.status }
      : { title: ticket.title, fields: Object.keys(patch) },
  });

  // History trail: one event per write, carrying the field-level diff. A pure
  // in-column reorder (position only) changes nothing anyone reads, so it
  // writes no event.
  const changes: TicketFieldChange[] = [];
  for (const field of TRACKED_FIELDS) {
    if (patch[field] === undefined) continue;
    const from = beforeRow[field] as string | null;
    const to = ticket[field] as string | null;
    if (from !== to) changes.push({ field, from, to });
  }
  if (changes.length > 0) {
    logTicketEvent(supabase, {
      ticketId: id,
      action: changes.length === 1 && changes[0].field === 'status' ? 'moved' : 'updated',
      actorEmail: authz.sessionEmail,
      actorName: await lookupFullNameForEmail(authz.sessionEmail),
      changes,
    });
  }

  // Landed in Done → email the creator that their request is ready to test.
  // Fires only on the transition (not on later edits to an already-done card).
  if (moved && ticket.status === 'done') {
    void notifyTicketDone(ticket, authz.sessionEmail);
  }

  // ANY OTHER column change → tell the CREATOR where their request went, both
  // legs (Kane 2026-08-21). Three rules are load-bearing here:
  //   · creator only — the developer is usually the one moving the card, so
  //     mailing them their own move is noise. moveEmailRecipient enforces it.
  //   · every move, including a backward Testing → In Progress bounce: "your
  //     ticket went back" is real news, so there is no status allowlist.
  //   · `done` is excluded because notifyTicketDone already sends a richer
  //     "refresh and test it" email — one move must never send two emails.
  // Guarded by `moved`, so a position-only reorder or a title edit sends
  // nothing. Fire-and-forget: a notification must not fail the saved move.
  if (moved && ticket.status !== 'done') {
    void notifyTicketMoved(ticket, beforeRow.status, authz.sessionEmail);
  }

  // In-app leg for the move, on EVERY transition including done — a panel row
  // is cheap, and a creator who does not live in their inbox should still see
  // the card move. `ticket.moved` is a NEW notification type: until the
  // employee_notifications CHECK widen runs
  // (scripts/apply-ticket-moved-notification-type.mjs) every one of these
  // inserts is REJECTED, and the .then below is the only place that says so.
  // That is exactly how kpi.scored shipped dead for three days.
  if (moved) {
    const moveRecipient = moveEmailRecipient(ticket, authz.sessionEmail);
    if (moveRecipient) {
      const fromLabel = TICKET_STATUS_LABELS[beforeRow.status] ?? beforeRow.status;
      const toLabel = TICKET_STATUS_LABELS[ticket.status] ?? ticket.status;
      void supabase
        .from('employee_notifications')
        .insert({
          recipient_email: moveRecipient,
          type: 'ticket.moved',
          tone: ticket.status === 'done' ? 'positive' : 'neutral',
          title: `Ticket #${ticket.ticket_no} moved to ${toLabel}`,
          message:
            `${authz.sessionEmail} moved "${ticket.title}" from ${fromLabel} to ${toLabel}.` +
            (ticket.status === 'done' ? ' Refresh the HRIS and test it out.' : ''),
          details: {
            ticket_id: ticket.id,
            ticket_no: ticket.ticket_no,
            from: beforeRow.status,
            to: ticket.status,
            moved_by: authz.sessionEmail,
          },
        })
        .then(({ error: notifErr }) => {
          if (notifErr) console.warn('[tickets] move notification failed:', notifErr.message);
        });
    }
  }

  // Newly assigned → notify the developer right away (in-app + email legs,
  // see sendTicketAssignedNotifications). Fires only when the assignee
  // actually changes, and never for self-assignment.
  const newAssignee = (ticket.assigned_to ?? '').trim().toLowerCase();
  const prevAssignee = (beforeRow.assigned_to ?? '').trim().toLowerCase();
  if (
    patch.assigned_to !== undefined &&
    newAssignee &&
    newAssignee !== prevAssignee &&
    newAssignee !== authz.sessionEmail
  ) {
    sendTicketAssignedNotifications(supabase, ticket, authz.sessionEmail);
  }

  return NextResponse.json({ ticket });
}

// DELETE /api/tickets/[id] — ARCHIVE the ticket (soft delete). Tickets are
// never hard-deleted: the row keeps its history + Updates thread, disappears
// from the board, and stays restorable from the Archived view. Only the
// ticket's creator or an admin may archive.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEditAnyView('tickets');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data: before, error: fetchErr } = await supabase
    .from('tickets')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!before) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  const beforeRow = before as TicketRow;
  if (beforeRow.archived_at) {
    return NextResponse.json({ error: 'Ticket is already archived' }, { status: 400 });
  }

  const isAdmin = authz.roles.includes('admin');
  const isCreator = beforeRow.created_by.toLowerCase() === authz.sessionEmail;
  if (!isAdmin && !isCreator) {
    return NextResponse.json(
      { error: 'Only the ticket creator or an admin can archive a ticket' },
      { status: 403 },
    );
  }

  const { error } = await supabase
    .from('tickets')
    .update({ archived_at: new Date().toISOString(), archived_by: authz.sessionEmail })
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    ...actor,
    action: 'ticket.archived',
    resource: 'tickets',
    resource_id: String(beforeRow.ticket_no),
    details: { title: beforeRow.title, status: beforeRow.status },
  });
  logTicketEvent(supabase, {
    ticketId: id,
    action: 'archived',
    actorEmail: authz.sessionEmail,
    actorName: await lookupFullNameForEmail(authz.sessionEmail),
  });

  return NextResponse.json({ ok: true });
}
