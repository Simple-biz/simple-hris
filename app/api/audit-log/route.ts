import { NextResponse } from 'next/server';
import { fetchAuditLog, insertAuditLog, clearAuditLog } from '@/lib/supabase/audit-log';
import type { NewAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─── GET /api/audit-log ───────────────────────────────────────────────────────
// Returns the most recent audit log entries (default: 100).

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 500);

  try {
    const { rows, error } = await fetchAuditLog(limit);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

// ─── POST /api/audit-log ─────────────────────────────────────────────────────
// Writes a new audit log entry. Called by the client after any settings change.

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<NewAuditLog>;

    if (!body.action || !body.resource || !body.user_name || !body.user_role) {
      return NextResponse.json({ error: 'Missing required fields: action, resource, user_name, user_role' }, { status: 400 });
    }

    // Best-effort IP from forwarding headers (proxy / Vercel edge)
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : (request.headers.get('x-real-ip') ?? null);

    const { error } = await insertAuditLog({
      user_name:   body.user_name,
      user_role:   body.user_role,
      action:      body.action,
      resource:    body.resource,
      resource_id: body.resource_id ?? null,
      details:     body.details ?? null,
      ip_address:  ip,
    });

    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── DELETE /api/audit-log ───────────────────────────────────────────────────
// Clears all audit log entries.

export async function DELETE() {
  try {
    const { error } = await clearAuditLog();
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
