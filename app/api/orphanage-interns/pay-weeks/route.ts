import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { buildInternWeekPreview, internPayRowsFromPreview } from '@/lib/interns/intern-week-server';
import { listInternsByEmail } from '@/lib/supabase/orphanage-interns-db';
import { submitInternPayWeek, withdrawInternPayWeek } from '@/lib/supabase/orphanage-intern-pay-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The mini wizard's Lock in / Withdraw. Orphanage-dashboard writers only.
 *
 *  POST   /api/orphanage-interns/pay-weeks   { source_file }  → recompute server-side, write `submitted`
 *  DELETE /api/orphanage-interns/pay-weeks?source_file=…&all=1 → withdraw a submitted/rejected week
 *
 * The client's figures are never trusted: the route re-runs the ONE pricer and
 * refuses on exactly the gates the button shows. 409 once Accounting accepted.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);

  let body: { source_file?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sourceFile = typeof body.source_file === 'string' ? body.source_file.trim() : '';
  if (!sourceFile) return NextResponse.json({ error: 'source_file is required' }, { status: 400 });

  const { preview, error } = await buildInternWeekPreview(sourceFile);
  if (error || !preview) return NextResponse.json({ error: error ?? 'Preview failed' }, { status: 404 });
  if (preview.blockers.length > 0) {
    const accepted = preview.existing.status === 'accepted';
    return NextResponse.json({ error: preview.blockers.join(' '), blockers: preview.blockers }, { status: accepted ? 409 : 422 });
  }

  const { byEmail, error: pErr } = await listInternsByEmail();
  if (pErr) return NextResponse.json({ error: pErr }, { status: 500 });
  const byId = new Map([...byEmail.values()].map((p) => [p.id, p]));
  const rows = internPayRowsFromPreview(preview, byId);
  if (rows.length === 0) return NextResponse.json({ error: 'Nothing to lock in.' }, { status: 422 });

  const actor = await getSessionActor();
  const by = actor.user_name !== 'anonymous' ? actor.user_name : null;
  const result = await submitInternPayWeek(sourceFile, rows, by);
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 500 });

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern_pay.week_submitted',
    resource: 'orphanage_intern_pay',
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      week_start: preview.weekStart,
      week_end: preview.weekEnd,
      share_mode: preview.config.shareMode,
      payout_week: preview.pab.payoutWeek,
      pab_month: preview.pab.month,
      totals: preview.totals,
      rows: result.rows.map((r) => ({
        intern_email: r.intern_email,
        hours_paid: r.hours_paid,
        rate_php: r.rate_php,
        pay_php: r.pay_php,
        pab_php: r.pab_php,
        gross_php: r.gross_php,
        orphanage_share_php: r.orphanage_share_php,
        intern_share_php: r.intern_share_php,
      })),
    },
  });

  return NextResponse.json({ rows: result.rows, error: null }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);
  const sourceFile = req.nextUrl.searchParams.get('source_file')?.trim();
  const all = req.nextUrl.searchParams.get('all') === '1';
  if (!sourceFile) return NextResponse.json({ error: 'source_file is required' }, { status: 400 });
  // Explicit flag, like the orphanage step's period wipe: a bare DELETE never
  // silently widens to the whole week.
  if (!all) return NextResponse.json({ error: 'Pass all=1 to withdraw the whole week.' }, { status: 400 });

  const result = await withdrawInternPayWeek(sourceFile);
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern_pay.week_withdrawn',
    resource: 'orphanage_intern_pay',
    resource_id: sourceFile,
    // Snapshot every withdrawn row — nothing is destroyed unrecorded.
    details: { source_file: sourceFile, rows: result.deleted },
  });
  return NextResponse.json({ ok: true, deleted: result.deleted.length });
}
