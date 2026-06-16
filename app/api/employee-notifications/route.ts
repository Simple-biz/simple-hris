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
import { NOTIFICATION_TYPE_FEATURE_GATE } from "@/lib/notifications/notification-views";

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

/**
 * The feature-gated notification types the signed-in viewer may NOT see, so the
 * GET query can exclude them. A gated type (see NOTIFICATION_TYPE_FEATURE_GATE)
 * is hidden unless the viewer holds a role mapping to the gate's view AND has at
 * least `view` access to its feature — i.e. they were granted it from the
 * HR / Admin Roles tab. Admins (and unresolved sessions) hide nothing. Global
 * types — like the payroll-processing lock — are never gated.
 *
 * Excluding at query time, rather than after the 50-row limit, keeps an
 * authorized-but-ungated viewer's other notifications from being crowded out by
 * a backlog of notifications they aren't allowed to read.
 */
async function hiddenGatedTypesForViewer(): Promise<string[]> {
  const gatedTypes = Object.keys(NOTIFICATION_TYPE_FEATURE_GATE);
  if (gatedTypes.length === 0) return [];

  const session = (await getServerSession(authOptions)) as SessionLike;
  const sessionEmail = normEmail(session?.user?.email ?? "") ?? "";
  const roles = (session?.user?.roles ?? []) as string[];
  if (!sessionEmail || roles.includes("admin")) return [];

  const viewsForRoles = new Set<FeatureViewKey>(
    roles
      .map((r) => ROLE_TO_FEATURE_VIEW[r])
      .filter((v): v is FeatureViewKey => !!v),
  );

  // A gated type is reachable only if the viewer holds a role for its view; the
  // rest are hidden outright. Skip the feature-permission lookup entirely when
  // nothing is reachable — the common case for plain employees, who never hold a
  // role-mapped view.
  const reachable = gatedTypes.filter(
    (t) => viewsForRoles.has(NOTIFICATION_TYPE_FEATURE_GATE[t].view),
  );
  if (reachable.length === 0) return gatedTypes;

  const perms = await fetchFeaturePermissionsForEmail(sessionEmail);

  return gatedTypes.filter((type) => {
    const gate = NOTIFICATION_TYPE_FEATURE_GATE[type];
    const canSee =
      viewsForRoles.has(gate.view) &&
      resolveFeatureAccess(perms, gate.view, gate.feature) !== "hidden";
    return !canSee;
  });
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

  const hiddenTypes = await hiddenGatedTypesForViewer();

  let query = supabase
    .from('employee_notifications')
    .select('id, type, tone, title, message, details, read_at, created_at')
    .eq('recipient_email', email);
  if (hiddenTypes.length > 0) {
    // PostgREST `not.in` exclusion — quote each value so any future type string
    // with reserved characters stays literal.
    query = query.not('type', 'in', `(${hiddenTypes.map((t) => `"${t}"`).join(',')})`);
  }

  const { data, error } = await query
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
