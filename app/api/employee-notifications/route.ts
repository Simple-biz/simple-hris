import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

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
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ success: false }, { status: 500 });
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
