import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { notifyTicketDone } from '@/lib/tickets/notify';
import {
  TICKET_BOARD_MOVERS,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
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
  'id, ticket_no, title, description, status, priority, position, created_by, created_by_name, assigned_to, created_at, updated_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/tickets/[id] — edit fields and/or move the card.
// Body (all optional): { title, description, priority, status, position, assigned_to }
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

  // Moving a card (column or in-column position) is restricted to the board
  // movers allowlist for now — everyone else may still create tickets, edit
  // their fields, and reply. Compared against the CURRENT row so a no-op
  // status echo from the edit dialog doesn't trip it.
  const beforeRow = before as TicketRow;
  const wantsMove =
    (patch.status !== undefined && patch.status !== beforeRow.status) ||
    (patch.position !== undefined && patch.position !== beforeRow.position);
  if (wantsMove && !(TICKET_BOARD_MOVERS as readonly string[]).includes(authz.sessionEmail)) {
    return NextResponse.json(
      { error: 'Only the board owner can move tickets between columns for now.' },
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

  // Landed in Done → email the creator that their request is ready to test.
  // Fires only on the transition (not on later edits to an already-done card).
  if (moved && ticket.status === 'done') {
    void notifyTicketDone(ticket, authz.sessionEmail);
  }

  return NextResponse.json({ ticket });
}

// DELETE /api/tickets/[id] — only the ticket's creator or an admin.
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

  const isAdmin = authz.roles.includes('admin');
  const isCreator = (before as TicketRow).created_by.toLowerCase() === authz.sessionEmail;
  if (!isAdmin && !isCreator) {
    return NextResponse.json({ error: 'Only the ticket creator or an admin can delete a ticket' }, { status: 403 });
  }

  const { error } = await supabase.from('tickets').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    ...actor,
    action: 'ticket.deleted',
    resource: 'tickets',
    resource_id: String((before as TicketRow).ticket_no),
    details: { title: (before as TicketRow).title, status: (before as TicketRow).status },
  });

  return NextResponse.json({ ok: true });
}
