import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;

/**
 * DELETE /api/employee-notifications/clear-all
 * Body: { email: string; ids?: string[] }
 *
 * Deletes all notifications for `email`. When `ids` is provided only those
 * rows are deleted (optimistic-UI reconciliation). Ownership enforced:
 * you may only clear your own notifications unless you're an admin.
 */
export async function DELETE(req: Request) {
  const session = (await getServerSession(authOptions)) as SessionLike;
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const roles = (session?.user?.roles ?? []) as string[];
  const isAdmin = roles.includes('admin');

  let body: { email?: string; ids?: string[] } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const targetEmail = normEmail(body.email ?? '') ?? '';
  if (!targetEmail) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }
  if (targetEmail !== sessionEmail && !isAdmin) {
    return NextResponse.json({ error: "You can only clear your own notifications." }, { status: 403 });
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ success: false }, { status: 500 });
  }

  const query = supabase.from('employee_notifications');
  const ids = Array.isArray(body.ids) && body.ids.length > 0 ? body.ids : null;

  const { error } = ids
    ? await query.delete().eq('recipient_email', targetEmail).in('id', ids)
    : await query.delete().eq('recipient_email', targetEmail);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
