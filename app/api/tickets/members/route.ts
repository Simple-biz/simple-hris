import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { requireFeatureAccessAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { listTicketMembers } from '@/lib/tickets/members';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

// GET /api/tickets/members — everyone who can see this board (see
// listTicketMembers for the full contract). The board's assignee pickers
// filter this to edit/admin members — the "developers" pool. Gated at `view`
// like the board fetch itself.
export async function GET() {
  const viewz = await requireFeatureAccessAnyView('tickets', 'view');
  if (!viewz.ok) return deniedResponse(viewz);

  const supabase = getClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  try {
    return NextResponse.json({ members: await listTicketMembers(supabase) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not load members' },
      { status: 500 },
    );
  }
}
