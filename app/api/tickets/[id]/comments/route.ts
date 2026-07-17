import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import type { TicketComment } from '@/lib/tickets/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

const SELECT_COLS = 'id, ticket_id, body, author_email, author_name, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/tickets/[id]/comments — the ticket's Updates thread, oldest first.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data, error } = await supabase
    .from('ticket_comments')
    .select(SELECT_COLS)
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ comments: (data ?? []) as TicketComment[] });
}

// POST /api/tickets/[id]/comments — reply to a ticket. Anyone who can see the
// board can reply (the thread is the communication channel around a request —
// a "View only" HR member must still be able to answer a question on their
// ticket); only creating/dragging cards needs the `edit` grant.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let payload: { body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = (payload.body ?? '').trim();
  if (!body) return NextResponse.json({ error: 'Reply cannot be empty' }, { status: 400 });
  if (body.length > 4000) {
    return NextResponse.json({ error: 'Reply is too long (max 4000 characters)' }, { status: 400 });
  }

  const { data: ticket, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, ticket_no, title, created_by, assigned_to, archived_at')
    .eq('id', id)
    .maybeSingle();
  if (ticketErr) return NextResponse.json({ error: ticketErr.message }, { status: 500 });
  if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  if ((ticket as { archived_at: string | null }).archived_at) {
    return NextResponse.json(
      { error: 'This ticket is archived — restore it to keep the conversation going.' },
      { status: 409 },
    );
  }

  const authorName = await lookupFullNameForEmail(authz.sessionEmail);

  const { data, error } = await supabase
    .from('ticket_comments')
    .insert({
      ticket_id: id,
      body,
      author_email: authz.sessionEmail,
      author_name: authorName,
    })
    .select(SELECT_COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    ...actor,
    action: 'ticket.commented',
    resource: 'tickets',
    resource_id: String((ticket as { ticket_no: number }).ticket_no),
    details: { title: (ticket as { title: string }).title, preview: body.slice(0, 120) },
  });

  // In-app HRIS notification (which chimes + toasts for the recipient) for the
  // two people a reply concerns: the ticket's CREATOR — someone answered their
  // request — and its ASSIGNED DEVELOPER — there's new activity on a ticket
  // they're working. Each is skipped when they're the one replying, and nobody
  // is notified twice when they're both creator and assignee. Best-effort: a
  // notification hiccup must not fail the reply that's already saved.
  const t = ticket as {
    ticket_no: number;
    title: string;
    created_by: string;
    assigned_to: string | null;
  };
  const replier = authorName ?? authz.sessionEmail;
  const preview = `${body.slice(0, 140)}${body.length > 140 ? '…' : ''}`;
  const creator = (t.created_by ?? '').trim().toLowerCase();
  const assignee = (t.assigned_to ?? '').trim().toLowerCase();

  const recipients: Array<{ email: string; title: string }> = [];
  if (creator && creator !== authz.sessionEmail) {
    recipients.push({ email: creator, title: `New reply on your ticket #${t.ticket_no}` });
  }
  if (assignee && assignee !== authz.sessionEmail && assignee !== creator) {
    recipients.push({
      email: assignee,
      title: `New reply on ticket #${t.ticket_no} assigned to you`,
    });
  }

  for (const r of recipients) {
    void supabase
      .from('employee_notifications')
      .insert({
        recipient_email: r.email,
        type: 'ticket.replied',
        tone: 'neutral',
        title: r.title,
        message: `${replier} replied on "${t.title}": ${preview}`,
        details: {
          ticket_id: id,
          ticket_no: t.ticket_no,
          comment_id: (data as TicketComment).id,
          author_email: authz.sessionEmail,
        },
      })
      .then(({ error: notifErr }) => {
        if (notifErr) console.warn('[tickets] reply notification failed:', notifErr.message);
      });
  }

  return NextResponse.json({ comment: data as TicketComment });
}
