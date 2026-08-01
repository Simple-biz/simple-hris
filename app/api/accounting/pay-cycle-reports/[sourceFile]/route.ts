import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  getPayCycleReport,
  unpublishPayCycleReport,
} from '@/lib/accounting/pay-cycle-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 *   GET    → the full frozen snapshot (including every payee row)
 *   DELETE → unpublish. Needed because a mistaken publish would otherwise be
 *            permanent, and unpublish→republish is the only way to refresh a
 *            snapshot that no longer matches reality. Both are audited.
 *
 * The client `encodeURIComponent`s the source file when building the URL, and
 * Next.js DECODES dynamic route params for us — so `params.sourceFile` is already
 * the plain filename. Do not decode it again: a second pass turns a literal `%`
 * (`100%.csv`) into a URIError and a 500, and would mangle any legitimately
 * encoded sequence.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceFile: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { sourceFile: raw } = await params;
  const sourceFile = (raw ?? '').trim();
  if (!sourceFile) return NextResponse.json({ error: 'Missing sourceFile' }, { status: 400 });

  const { report, error } = await getPayCycleReport(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  return NextResponse.json({ report, error: null });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceFile: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'edit');
  if (!authz.ok) return deniedResponse(authz);

  const { sourceFile: raw } = await params;
  const sourceFile = (raw ?? '').trim();
  if (!sourceFile) return NextResponse.json({ error: 'Missing sourceFile' }, { status: 400 });

  const { deleted, snapshot, rawValue, error } = await unpublishPayCycleReport(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });

  // AWAITED, unlike the usual fire-and-forget audit writes: the deleted row was
  // the SOLE copy of the frozen snapshot, so this event is the only surviving
  // record of it — the response must not return (and on serverless, the function
  // must not freeze) before it lands. Same precedent as
  // app/api/payment-dispatches/undo/route.ts's `payment.undone` events.
  //
  // `snapshot` carries the whole frozen value, payees included, so a mis-clicked
  // unpublish is genuinely recoverable rather than merely regrettable. Skipped
  // entirely when nothing was deleted — a no-op delete must not log a deletion.
  let auditError: string | null = null;
  if (deleted) {
    const actor = await getSessionActor();
    const { error: auditErr } = await insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'pay_cycle_report.unpublished',
      resource: 'app_settings',
      resource_id: sourceFile,
      details: {
        source_file: sourceFile,
        cycle_id: snapshot?.cycle_id ?? null,
        label: snapshot?.label ?? null,
        period_start: snapshot?.period_start ?? null,
        period_end: snapshot?.period_end ?? null,
        payee_count: snapshot?.totals.payeeCount ?? null,
        dispatch_count: snapshot?.totals.dispatchCount ?? null,
        totals: snapshot?.totals ?? null,
        published_at: snapshot?.published_at ?? null,
        published_by: snapshot?.published_by ?? null,
        published_by_email: snapshot?.published_by_email ?? null,
        // Verbatim stored JSON — the recovery artifact. Kept even when the row
        // was unreadable (snapshot === null), which is exactly the case where
        // nothing else in this event can describe what was lost.
        snapshot_json: rawValue,
      },
    });
    if (auditErr) {
      auditError = auditErr;
      // The row is ALREADY deleted by this point, so if the audit insert failed
      // the snapshot exists nowhere but this function's memory. Log the verbatim
      // value, not just the key: the whole reason the delete RETURNs its row is
      // to survive exactly this failure, and a log line naming only the source
      // file would lose the artifact it was meant to preserve.
      console.error(
        '[pay-cycle-reports] unpublish audit write FAILED — the deleted snapshot survives only in this log entry',
        { sourceFile, auditErr, snapshot_json: rawValue },
      );
    }
  }

  // On an audit failure the value rides back in the response too, so the caller
  // holds a second copy. Only then — a 300 KB body on every successful unpublish
  // would be waste, and on success the audit row already has it.
  return NextResponse.json(
    auditError
      ? { deleted, error: null, auditError, snapshot_json: rawValue }
      : { deleted, error: null },
  );
}
