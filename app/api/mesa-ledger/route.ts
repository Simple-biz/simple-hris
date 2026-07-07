import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import {
  MESA_LEDGER_SELECT,
  summarizeMember,
  summarizeMembers,
  type MesaLedgerEvent,
} from '@/lib/mesa/ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_ledger';
const PAGE = 1000; // Supabase caps a single select at 1000 rows — page past it.

/**
 * Fetch every row matching the (optional) email filter, paging past the
 * 1000-row PostgREST ceiling. `email` is already lowercased by the caller.
 */
async function fetchAllEvents(
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  email?: string,
): Promise<{ rows: MesaLedgerEvent[]; error: string | null }> {
  const rows: MesaLedgerEvent[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(TABLE).select(MESA_LEDGER_SELECT).range(from, from + PAGE - 1);
    // Case-insensitive exact match on the member's email.
    if (email) q = q.ilike('email', email);
    const { data, error } = await q;
    if (error) return { rows, error: error.message };
    const batch = (data ?? []) as MesaLedgerEvent[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { rows, error: null };
}

// GET /api/mesa-ledger
//   ?email=xxx  => employee's own contribution summary + event timeline (authorizeEmailAccess)
//   (no email)  => per-member summaries across the whole program (requireElevatedSession)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email')?.trim().toLowerCase() || undefined;
    const includeEvents = searchParams.get('events') !== '0';

    const authz = email ? await authorizeEmailAccess(email) : await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    // Self/elevated single-member view — scope to the authorized effective email.
    if (email && authz.ok) {
      const { rows, error } = await fetchAllEvents(supabase, authz.effectiveEmail);
      if (error) return NextResponse.json({ error }, { status: 500 });
      const summary = rows.length ? summarizeMember(rows) : null;
      // Newest-first timeline for the member's history table.
      const events = includeEvents
        ? rows
            .slice()
            .sort((a, b) => (b.deposit_date ?? b.disbursement_date ?? '').localeCompare(a.deposit_date ?? a.disbursement_date ?? ''))
        : [];
      return NextResponse.json({ summary, events });
    }

    // Elevated program-wide view — aggregate per member.
    const { rows, error } = await fetchAllEvents(supabase);
    if (error) return NextResponse.json({ error }, { status: 500 });
    const members = summarizeMembers(rows);
    return NextResponse.json({ members });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
