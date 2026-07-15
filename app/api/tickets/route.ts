import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureAccessAnyView, requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { TICKET_STATUSES, TICKET_PRIORITIES, type TicketRow } from '@/lib/tickets/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

const SELECT_COLS =
  'id, ticket_no, title, description, status, priority, position, created_by, created_by_name, assigned_to, created_at, updated_at';

// GET /api/tickets — the whole board, plus the caller's own access level so
// the UI knows whether to offer create/drag (`edit`) or render read-only.
export async function GET() {
  const viewz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!viewz.ok) return deniedResponse(viewz);
  const editz = await requireFeatureAccessAnyView('tickets', 'edit');

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data, error } = await supabase
    .from('tickets')
    .select(`${SELECT_COLS}, ticket_comments(count)`)
    .order('position', { ascending: true })
    .order('created_at', { ascending: false });
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
// Body: { title, description?, priority? }
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEditAnyView('tickets');
  if (!authz.ok) return deniedResponse(authz);

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { title?: string; description?: string; priority?: string };
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

  return NextResponse.json({ ticket: data as TicketRow });
}
