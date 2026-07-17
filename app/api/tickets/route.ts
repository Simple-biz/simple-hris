import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureAccessAnyView, requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { logTicketEvent } from '@/lib/tickets/events';
import { listTicketMembers } from '@/lib/tickets/members';
import { notifyTicketCreated, sendTicketAssignedNotifications } from '@/lib/tickets/notify';
import { TICKET_BOARD_OWNER, TICKET_PRIORITIES, isAssignableDeveloper, type TicketRow } from '@/lib/tickets/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

const SELECT_COLS =
  'id, ticket_no, title, description, status, priority, position, created_by, created_by_name, assigned_to, created_at, updated_at, archived_at, archived_by';

// GET /api/tickets — the live board (archived tickets excluded), plus the
// caller's own access level so the UI knows whether to offer create/drag
// (`edit`) or render read-only. `?archived=1` returns the archive instead,
// newest-archived first, for the board's Archived view.
export async function GET(req: NextRequest) {
  const viewz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!viewz.ok) return deniedResponse(viewz);
  const editz = await requireFeatureAccessAnyView('tickets', 'edit');

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const wantArchived = req.nextUrl.searchParams.get('archived') === '1';
  let query = supabase.from('tickets').select(`${SELECT_COLS}, ticket_comments(count)`);
  query = wantArchived
    ? query.not('archived_at', 'is', null).order('archived_at', { ascending: false })
    : query
        .is('archived_at', null)
        .order('position', { ascending: true })
        .order('created_at', { ascending: false });
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Flatten the nested count aggregate into a plain number per ticket.
  const tickets = ((data ?? []) as Array<TicketRow & { ticket_comments?: { count: number }[] }>).map(
    ({ ticket_comments, ...t }) => ({ ...t, comment_count: ticket_comments?.[0]?.count ?? 0 }),
  );

  return NextResponse.json({
    tickets,
    access: editz.ok ? 'edit' : 'view',
    viewer: viewz.sessionEmail,
    isAdmin: viewz.roles.includes('admin'),
  });
}

// POST /api/tickets — create a ticket in the "To Do" column (top of the column).
// Body: { title, description?, priority?, assigned_to? }
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEditAnyView('tickets');
  if (!authz.ok) return deniedResponse(authz);

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { title?: string; description?: string; priority?: string; assigned_to?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const title = (body.title ?? '').trim();
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: 'title is too long (max 200)' }, { status: 400 });
  const priority = (body.priority ?? 'medium').trim().toLowerCase();
  if (!TICKET_PRIORITIES.includes(priority as (typeof TICKET_PRIORITIES)[number])) {
    return NextResponse.json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(', ')}` }, { status: 400 });
  }

  // Assignment is owner-only. Every new ticket lands on the board owner's desk
  // by default — that's the triage inbox. ONLY the owner may route a ticket
  // straight to a developer at creation; everyone else's requests default to
  // the owner regardless of what they send (reassignment later is likewise
  // owner-only — see PATCH). A developer pick must hold Edit access to the
  // Ticket Board (Roles & Permissions) or be an admin, i.e. appear in the
  // /api/tickets/members pool as edit/admin — the owner themselves is always
  // valid, so the default skips the lookup.
  const isOwner = authz.sessionEmail === TICKET_BOARD_OWNER;
  const requestedAssignee = (body.assigned_to ?? '').trim().toLowerCase();
  const assignedTo = isOwner ? requestedAssignee || TICKET_BOARD_OWNER : TICKET_BOARD_OWNER;
  if (assignedTo !== TICKET_BOARD_OWNER) {
    try {
      const members = await listTicketMembers(supabase);
      if (!members.some((m) => m.email === assignedTo && isAssignableDeveloper(m))) {
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

  // New cards land on top of "To Do": one slot above the column's current top.
  const { data: top } = await supabase
    .from('tickets')
    .select('position')
    .eq('status', 'todo')
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();
  const position = ((top?.position as number | undefined) ?? 1) - 1;

  const createdByName = await lookupFullNameForEmail(authz.sessionEmail);

  const { data, error } = await supabase
    .from('tickets')
    .insert({
      title,
      description: (body.description ?? '').trim() || null,
      status: 'todo',
      priority,
      position,
      created_by: authz.sessionEmail,
      created_by_name: createdByName,
      assigned_to: assignedTo,
    })
    .select(SELECT_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    ...actor,
    action: 'ticket.created',
    resource: 'tickets',
    resource_id: String((data as TicketRow).ticket_no),
    details: { title, priority },
  });

  // First entry on the ticket's history trail.
  logTicketEvent(supabase, {
    ticketId: (data as TicketRow).id,
    action: 'created',
    actorEmail: authz.sessionEmail,
    actorName: createdByName,
  });

  // Email-the-admin automation: fire the ticket_created webhook (n8n) with the
  // full request details. Fire-and-forget — see notifyTicketCreated.
  void notifyTicketCreated(data as TicketRow);

  // Owner routed a ticket to a developer at creation → tell them right away
  // (in-app + email). Skipped for the owner-by-default case: those tickets land
  // on the owner's own desk, and the owner already learns of every new ticket
  // via the ticket_created webhook — no need for a redundant "assigned to you".
  if (isOwner && assignedTo !== authz.sessionEmail) {
    sendTicketAssignedNotifications(supabase, data as TicketRow, authz.sessionEmail);
  }

  return NextResponse.json({ ticket: data as TicketRow });
}
