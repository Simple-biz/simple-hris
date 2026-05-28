import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "user_presence";

function getSb() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** POST { email?, name? } — stamp last_seen_at=now() for the caller.
 *  Email is taken from the NextAuth session when present; otherwise from the
 *  body (employees who logged in via the sessionStorage path don't have a
 *  NextAuth session). Mirrors the loose auth posture of the rest of the
 *  My Team / presence surface. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  let body: { email?: string; name?: string } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch {
    // Empty / non-JSON body is fine — session may still provide the email.
  }

  const email =
    normEmail(session?.user?.email ?? null) ?? normEmail(body.email ?? null);
  if (!email) {
    return NextResponse.json({ error: "no email available" }, { status: 400 });
  }

  const name = (session?.user?.name ?? body.name ?? null)?.toString().trim() || null;

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ error: "supabase unavailable" }, { status: 500 });

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      { email, name, last_seen_at: new Date().toISOString() },
      { onConflict: "email" },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
