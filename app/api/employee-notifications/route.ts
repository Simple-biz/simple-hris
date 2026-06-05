import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { normEmail } from "@/lib/email/norm-email";
import {
  fetchFeaturePermissionsForEmail,
  resolveFeatureAccess,
  ROLE_TO_FEATURE_VIEW,
  type FeatureViewKey,
} from "@/lib/rbac/feature-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;

/**
 * Whether `email` may delete (dismiss) notifications. Deleting is an "edit"
 * action: an explicit `edit` grant on the notifications feature in any of the
 * user's role-views allows it; an explicit read-only (`view`) grant with no
 * `edit` anywhere blocks it. The default (no row) allows it — matching the UI,
 * which keeps delete enabled on dashboards that don't yet enforce per-feature
 * permissions. Admins always pass.
 */
async function viewerMayDeleteNotifications(email: string, roles: string[]): Promise<boolean> {
  if (roles.includes("admin")) return true;
  const perms = await fetchFeaturePermissionsForEmail(email);
  let restricted = false;
  for (const role of roles) {
    const view = ROLE_TO_FEATURE_VIEW[role] as FeatureViewKey | undefined;
    if (!view) continue;
    const access = resolveFeatureAccess(perms, view, "notifications");
    if (access === "edit") return true; // an edit grant anywhere wins
    if (access === "view") restricted = true; // explicitly read-only somewhere
  }
  return !restricted;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const email = url.searchParams.get('email')?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "email query param required" }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ notifications: [] });
  }

  const { data, error } = await supabase
    .from('employee_notifications')
    .select('id, type, tone, title, message, details, read_at, created_at')
    .eq('recipient_email', email)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ notifications: [], error: error.message });
  }
  return NextResponse.json({ notifications: data ?? [] });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id')?.trim();
  if (!id) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }

  const session = (await getServerSession(authOptions)) as SessionLike;
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const roles = (session?.user?.roles ?? []) as string[];
  const isAdmin = roles.includes('admin');

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ success: false }, { status: 500 });
  }

  // Fetch the row first so we can enforce ownership: you may only dismiss your
  // own notifications. Admins may dismiss anyone's (e.g. support cleanup).
  const { data: row, error: fetchErr } = await supabase
    .from('employee_notifications')
    .select('id, recipient_email')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 });
  }
  if (!row) {
    // Already gone — treat as success so the optimistic UI removal stands.
    return NextResponse.json({ success: true });
  }

  const owns =
    (row as { recipient_email?: string | null }).recipient_email?.trim().toLowerCase() ===
    sessionEmail;
  if (!owns && !isAdmin) {
    return NextResponse.json(
      { error: "You can only delete your own notifications." },
      { status: 403 },
    );
  }

  if (!(await viewerMayDeleteNotifications(sessionEmail, roles))) {
    return NextResponse.json(
      { error: "You don't have permission to delete notifications." },
      { status: 403 },
    );
  }

  const { error } = await supabase.from('employee_notifications').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

export async function PATCH(req: Request) {
  const { id, ids, email } = await req.json().catch(() => ({} as Record<string, unknown>));
  const targetIds = Array.isArray(ids) ? ids : id ? [id] : [];
  const normEmail = typeof email === 'string' ? email.trim().toLowerCase() : null;

  if (targetIds.length === 0 && !normEmail) {
    return NextResponse.json({ error: "id, ids, or email required" }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ success: false }, { status: 500 });
  }

  const query = supabase.from('employee_notifications').update({ read_at: new Date().toISOString() });
  const { error } = targetIds.length > 0
    ? await query.in('id', targetIds)
    : await query.eq('recipient_email', normEmail!).is('read_at', null);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
