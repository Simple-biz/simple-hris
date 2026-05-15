import { bumpForceLogoutFor } from "@/lib/auth/force-logout";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip");
}

/**
 * Admin-only — forcibly invalidate every active session for the given email.
 * Stamps a per-email timestamp in `app_settings.auth.force_logout_map`; the
 * NextAuth `jwt` callback wipes any token whose `iat` is older than the stamp
 * on its next fire, and the middleware rejects empty tokens. Fresh sign-ins
 * (after the stamp) are unaffected.
 */
export async function POST(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let email = "";
  let reason: string | null = null;
  try {
    const body = (await req.json()) as { email?: string; reason?: string };
    email = (body?.email ?? "").trim();
    reason = body?.reason?.trim() ?? null;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  // Refuse self-targeted force-logouts — admins who revoke a role on their
  // own row would otherwise wipe the in-flight session and 403 every
  // subsequent admin action in the same browser session.
  if (email.toLowerCase() === authz.effectiveEmail.trim().toLowerCase()) {
    return NextResponse.json({ success: true, skipped: 'self' });
  }

  const { error } = await bumpForceLogoutFor(email);
  if (error) {
    return NextResponse.json({ success: false, error }, { status: 500 });
  }

  void insertAuditLog({
    user_name: authz.effectiveEmail,
    user_role: "admin",
    action: "auth.force_logout",
    resource: "session",
    resource_id: email.toLowerCase(),
    details: { reason },
    ip_address: clientIp(req),
  });

  return NextResponse.json({ success: true, email: email.toLowerCase() });
}
