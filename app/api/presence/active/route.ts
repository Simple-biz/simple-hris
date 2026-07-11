import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "user_presence";
const DEFAULT_WINDOW_S = 120;
const MAX_WINDOW_S = 900;

function getSb() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/**
 * GET ?withinSeconds=120 — everyone whose heartbeat landed within the window.
 *
 * This is the RELIABLE "actively using the app right now" signal: the heartbeat
 * is a plain HTTP POST fired every 60s while a tab is visible, so it lands even
 * when a client's Realtime WebSocket is blocked/throttled/dropped (corporate
 * firewalls, flaky networks). The `hris-presence` Realtime channel is richer
 * (live page/tab) but fragile — people whose WS never connects silently vanish
 * from it. The Global Master List backs its "online" detection with THIS so an
 * actively-working person is never shown as offline just because their realtime
 * link didn't come up. Returns `{ active: { [normEmail]: { last_seen_at, name } } }`.
 */
export async function GET(req: NextRequest) {
  const raw = Number(req.nextUrl.searchParams.get("withinSeconds"));
  const windowS = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WINDOW_S) : DEFAULT_WINDOW_S;
  const since = new Date(Date.now() - windowS * 1000).toISOString();

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ active: {} });

  const { data, error } = await supabase
    .from(TABLE)
    .select("email, name, last_seen_at")
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(2000);

  if (error) {
    return NextResponse.json({ active: {}, error: error.message }, { status: 500 });
  }

  const active: Record<string, { last_seen_at: string; name: string | null }> = {};
  for (const row of (data ?? []) as { email: string; name: string | null; last_seen_at: string }[]) {
    const k = normEmail(row.email);
    // Keep the first (newest) stamp per person — the query is already sorted desc.
    if (k && row.last_seen_at && !active[k]) {
      active[k] = { last_seen_at: row.last_seen_at, name: row.name ?? null };
    }
  }
  return NextResponse.json({ active, windowSeconds: windowS });
}
