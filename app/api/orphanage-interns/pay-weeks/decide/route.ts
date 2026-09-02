import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { decideInternPayWeek } from '@/lib/supabase/orphanage-intern-pay-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/orphanage-interns/pay-weeks/decide
 *   { source_file, decision: 'accepted' | 'rejected' | 'reopen', note? }
 *
 * Accounting's side of the hand-off (Payroll Wizard → Interns view). Accept
 * turns the week into pending Payment Dispatch items; reject sends it back to
 * the Orphanage Manager with a required note; reopen puts an accepted week
 * back to submitted and is REFUSED while any of its dispatch rows is paid.
 * Accounting never edits an intern's hours, rate or bank here — accept/reject only.
 */
export async function PATCH(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let body: { source_file?: unknown; decision?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sourceFile = typeof body.source_file === 'string' ? body.source_file.trim() : '';
  const decision = body.decision;
  const note = typeof body.note === 'string' ? body.note : null;
  if (!sourceFile) return NextResponse.json({ error: 'source_file is required' }, { status: 400 });
  if (decision !== 'accepted' && decision !== 'rejected' && decision !== 'reopen') {
    return NextResponse.json({ error: "decision must be 'accepted', 'rejected' or 'reopen'" }, { status: 400 });
  }

  const actor = await getSessionActor();
  const by = actor.user_name !== 'anonymous' ? actor.user_name : null;
  const result = await decideInternPayWeek(sourceFile, decision, by, note);
  if (result.error) return NextResponse.json({ error: result.error }, { status: result.conflict ? 409 : 400 });

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action:
      decision === 'accepted'
        ? 'orphanage_intern_pay.week_accepted'
        : decision === 'rejected'
          ? 'orphanage_intern_pay.week_rejected'
          : 'orphanage_intern_pay.week_reopened',
    resource: 'orphanage_intern_pay',
    resource_id: sourceFile,
    details: {
      source_file: sourceFile,
      note: (note ?? '').trim() || null,
      rows: result.rows.map((r) => ({ intern_email: r.intern_email, gross_php: r.gross_php, intern_share_php: r.intern_share_php, orphanage_share_php: r.orphanage_share_php })),
    },
  });
  return NextResponse.json({ rows: result.rows, error: null });
}
