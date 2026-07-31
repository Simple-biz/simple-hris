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
 * `sourceFile` arrives URL-encoded (Hubstaff filenames contain dots and
 * underscores, and MAY contain characters that need escaping) — always decode.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceFile: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { sourceFile: raw } = await params;
  const sourceFile = decodeURIComponent(raw ?? '').trim();
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
  const sourceFile = decodeURIComponent(raw ?? '').trim();
  if (!sourceFile) return NextResponse.json({ error: 'Missing sourceFile' }, { status: 400 });

  const { deleted, error } = await unpublishPayCycleReport(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'pay_cycle_report.unpublished',
    resource: 'app_settings',
    resource_id: sourceFile,
    details: { source_file: sourceFile },
  });

  return NextResponse.json({ deleted, error: null });
}
