import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { validateOmsSavePayload } from '@/lib/oms/oms-save';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertOmsSave, latestOmsSaveForWeek, probeOmsHoursTable } from '@/lib/supabase/orphanage-oms-hours-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * OMS saves — `public.orphanage_oms_hours`, the HRIS's own record of what the
 * Orphanage Management System said for a week and what the HRIS resolved it to.
 *
 *   GET  ?week_start=YYYY-MM-DD → { tableReady, reason, latest: OmsSaveSummary | null }
 *   POST { week_start, source_file, mode, approved_count, latest_updated_at, truncated, rows[] }
 *        → { saveId, saved }   one append-only snapshot; audit `wizard.orphanage_oms_saved`
 *
 * NOT MONEY: this never touches the additions blob or `orphanage_pay`. A Save is
 * allowed in TEST mode for exactly that reason. Until the migration is applied the
 * probe fails and both verbs answer 503 `tableReady:false` with the script to run —
 * never a 500 into a toast. Every branch answers JSON.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Saving
 */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const weekStart = (new URL(req.url).searchParams.get('week_start') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'week_start must be YYYY-MM-DD' }, { status: 400 });
  }

  const probe = await probeOmsHoursTable();
  if (!probe.ready) return NextResponse.json({ tableReady: false, reason: probe.reason, latest: null }, { status: 503 });

  const { save, error } = await latestOmsSaveForWeek(weekStart);
  if (error) return NextResponse.json({ tableReady: true, error }, { status: 500 });
  return NextResponse.json({ tableReady: true, reason: null, latest: save });
}

export async function POST(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = validateOmsSavePayload(raw);
  if (!body.ok) return NextResponse.json({ error: body.reason }, { status: 400 });

  const probe = await probeOmsHoursTable();
  if (!probe.ready) return NextResponse.json({ tableReady: false, reason: probe.reason }, { status: 503 });

  const actor = authz.sessionEmail ?? 'system';
  const { saveId, saved, error } = await insertOmsSave({ payload: body.payload, actor });
  if (error) return NextResponse.json({ saveId, saved, error }, { status: 500 });

  const matched = body.payload.rows.filter((r) => r.matched);
  void insertAuditLog({
    user_name: actor,
    user_role: authz.roles[0] ?? 'accounting',
    action: 'wizard.orphanage_oms_saved',
    resource: 'orphanage_oms_hours',
    resource_id: saveId,
    details: {
      save_id: saveId,
      week_start: body.payload.week_start,
      source_file: body.payload.source_file,
      mode: body.payload.mode,
      rows: saved,
      matched: matched.length,
      skipped: body.payload.rows.length - matched.length,
      total_php: Math.round(matched.reduce((s, r) => s + (r.amountPhp ?? 0), 0) * 100) / 100,
      approved_count: body.payload.approved_count,
      latest_updated_at: body.payload.latest_updated_at,
      truncated: body.payload.truncated,
    },
  });

  return NextResponse.json({ tableReady: true, saveId, saved, error: null });
}
