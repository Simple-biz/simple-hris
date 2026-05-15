import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { bumpForceLogoutFor } from "@/lib/auth/force-logout";
import { FEATURE_ACCESS_LEVELS, type FeatureAccess } from "@/lib/rbac/feature-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip");
}

function getSb() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** GET ?email=... — list every active feature permission for one user. */
export async function GET(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const email = req.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ rows: [], error: "supabase unavailable" });

  const { data, error } = await supabase
    .from("employee_feature_permissions")
    .select("id, work_email, view_key, feature, access, granted_by, granted_at")
    .eq("work_email", email)
    .is("revoked_at", null)
    .order("view_key")
    .order("feature");

  if (error) return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

/**
 * POST { email, view, feature, access } — upsert a permission. Setting access
 * to `'hidden'` revokes any active row (default state is hidden when no row
 * exists). Force-logs out the affected user so their session reflects the
 * change on the next request.
 */
export async function POST(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { email?: string; view?: string; feature?: string; access?: string } = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const email = (body.email ?? "").trim().toLowerCase();
  const view = (body.view ?? "").trim();
  const feature = (body.feature ?? "").trim();
  const access = (body.access ?? "").trim() as FeatureAccess | "hidden";

  if (!email || !view || !feature) {
    return NextResponse.json({ error: "email, view, and feature are required" }, { status: 400 });
  }
  if (!FEATURE_ACCESS_LEVELS.includes(access as FeatureAccess) && access !== "hidden") {
    return NextResponse.json({ error: "access must be hidden, view, or edit" }, { status: 400 });
  }

  const supabase = getSb();
  if (!supabase) return NextResponse.json({ success: false, error: "supabase unavailable" }, { status: 500 });

  // Revoke any existing active row first — emulates an upsert without needing
  // a deferrable unique constraint on a partial index.
  const nowIso = new Date().toISOString();
  const { error: revokeErr } = await supabase
    .from("employee_feature_permissions")
    .update({ revoked_at: nowIso })
    .eq("work_email", email)
    .eq("view_key", view)
    .eq("feature", feature)
    .is("revoked_at", null);
  if (revokeErr) {
    return NextResponse.json({ success: false, error: revokeErr.message }, { status: 500 });
  }

  // For `hidden` the revoke alone is enough — leave no active row.
  if (access !== "hidden") {
    const { error: insertErr } = await supabase
      .from("employee_feature_permissions")
      .insert({
        work_email: email,
        view_key: view,
        feature,
        access,
        granted_by: authz.effectiveEmail,
      });
    if (insertErr) {
      return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 });
    }
  }

  void insertAuditLog({
    user_name: authz.effectiveEmail,
    user_role: "admin",
    action: access === "hidden" ? "feature_permission.revoke" : "feature_permission.grant",
    resource: "employee_feature_permissions",
    resource_id: `${email}:${view}:${feature}`,
    details: { view, feature, access },
    ip_address: clientIp(req),
  });

  // Bump force-logout so the user's session reloads with the new permission
  // set on their next page load. Skip when the admin is editing their own
  // row — admins bypass per-tab gates entirely, and force-logging-out
  // yourself nukes the in-flight admin session and 403s every subsequent
  // click in the permission grid.
  const adminEmail = authz.effectiveEmail.trim().toLowerCase();
  if (adminEmail !== email) {
    void bumpForceLogoutFor(email);
  }

  return NextResponse.json({ success: true });
}
