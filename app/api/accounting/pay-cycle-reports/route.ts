import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  listCycleStatus,
  listPayCycleReports,
  publishPayCycleReport,
} from '@/lib/accounting/pay-cycle-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Reports.
 *
 *   GET  → published reports + which cycles may still be published
 *   POST → publish one cycle (freeze it), edit-gated
 *
 * Both ride the accounting `documents` feature — the tab they live in — so no
 * new permission is introduced.
 */
export async function GET() {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  // Sequential on purpose: listCycleStatus needs the published list to know what
  // is already reported, and it used to call listPayCycleReports() itself — so
  // every Documents page load ran that prefix scan TWICE, each time pulling every
  // snapshot's full payee JSON only to strip it to summaries. Handing the loaded
  // list down costs one round trip of latency and saves the whole second read.
  const reportsRes = await listPayCycleReports();
  if (reportsRes.error) {
    return NextResponse.json({ error: reportsRes.error }, { status: 500 });
  }
  const statusRes = await listCycleStatus(reportsRes.published);
  // A failed eligibility read must not hide reports that were already
  // published — degrade to "nothing publishable" and surface the reason.
  return NextResponse.json({
    published: reportsRes.published,
    unreadable: reportsRes.unreadable,
    publishable: statusRes.publishable,
    incomplete: statusRes.incomplete,
    error: statusRes.error,
  });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'edit');
  if (!authz.ok) return deniedResponse(authz);

  let body: { source_file?: unknown };
  try {
    body = (await req.json()) as { source_file?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sourceFile =
    typeof body.source_file === 'string' ? body.source_file.trim().slice(0, 300) : '';
  if (!sourceFile) {
    return NextResponse.json({ error: 'source_file is required' }, { status: 400 });
  }

  const actor = await getSessionActor();
  const email = actor.user_name === 'anonymous' ? '' : actor.user_name;
  const result = await publishPayCycleReport({
    sourceFile,
    publishedBy: email ? email.split('@')[0] : 'Accounting',
    publishedByEmail: email,
  });

  if (result.notComplete) {
    return NextResponse.json(
      {
        error: 'This cycle is no longer fully paid — refresh and check Payment Dispatch.',
        notComplete: result.notComplete,
      },
      { status: 409 },
    );
  }
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });

  if (!result.already && result.report) {
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'pay_cycle_report.published',
      resource: 'app_settings',
      resource_id: sourceFile,
      details: {
        source_file: sourceFile,
        cycle_id: result.report.cycle_id,
        label: result.report.label,
        payee_count: result.report.totals.payeeCount,
        dispatch_count: result.report.totals.dispatchCount,
        paid_usd: result.report.totals.paidUSD,
        paid_php: result.report.totals.paidPHP,
      },
    });
  }

  return NextResponse.json({
    report: result.report,
    already: result.already,
    error: null,
  });
}
