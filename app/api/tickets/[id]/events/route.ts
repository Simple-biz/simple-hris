import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import type { TicketEvent } from '@/lib/tickets/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

const SELECT_COLS = 'id, ticket_id, action, changes, actor_email, actor_name, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/tickets/[id]/events — the ticket's history trail (who changed
// what, when), oldest first. Rendered in the dialog's activity feed
// interleaved with the Updates thread. Anyone who can see the board can read.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data, error } = await supabase
    .from('ticket_events')
    .select(SELECT_COLS)
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ events: (data ?? []) as TicketEvent[] });
}
