import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "user_presence";

function getSb() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** GET ?emails=a@x,b@y — return { lastSeen: { [normEmail]: ISO timestamp } }.
 *  Cap is generous so the My Team roster (own department) fits in one call. */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("emails") ?? "";
  const emails = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => normEmail(s))
        .filter((e): e is string => !!e),
    ),
  ).slice(0, 500);

  if (emails.length === 0) return NextResponse.json({ lastSeen: {} });

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ lastSeen: {} });

  const { data, error } = await supabase
    .from(TABLE)
    .select("email, last_seen_at")
    .in("email", emails);

  if (error) {
    return NextResponse.json({ lastSeen: {}, error: error.message }, { status: 500 });
  }

  const lastSeen: Record<string, string> = {};
  for (const row of (data ?? []) as { email: string; last_seen_at: string }[]) {
    const k = normEmail(row.email);
    if (k && row.last_seen_at) lastSeen[k] = row.last_seen_at;
  }
  return NextResponse.json({ lastSeen });
}
