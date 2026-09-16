import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { readOmsConfig } from '@/lib/oms/oms-config';
import { omsWeekStatus, pullOmsApprovedHours } from '@/lib/oms/oms-hours';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Orphanage Management System (OMS) read for the Payroll Wizard's Orphanage step.
 *
 *   GET ?mode=status&week_start=YYYY-MM-DD  → { configured, approvedCount, latestUpdatedAt }
 *   GET ?mode=pull&week_start=YYYY-MM-DD    → { configured, rows, approvedCount, latestUpdatedAt, truncated }
 *
 * READ-ONLY against a separate Supabase project (env `OMS_*`, see
 * docs/features/orphanage-oms-pull.md). Only APPROVED rows for the one week are ever
 * read. Nothing here touches HRIS tables: matching and pricing happen in the wizard
 * (`resolveOrphanageHourRows`), and a LIVE lock-in rides the existing additions +
 * `orphanage_pay` writes, which carry their own edit gate.
 *
 * `status` is the cheap call the tab makes on open and after every pull so the
 * "ready to pull" indicator can speak; `pull` fires ONLY from the Load button.
 *
 * Every branch answers JSON, including "not configured" (503) and "OMS unreachable"
 * (502) — a non-JSON body from this URL means the request never reached the handler.
 * The configuration itself is never returned; a failure names the env VARIABLE.
 */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'status';
  const weekStart = (url.searchParams.get('week_start') ?? '').trim();
  if (mode !== 'status' && mode !== 'pull') {
    return NextResponse.json({ error: 'mode must be "status" or "pull"' }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ error: 'week_start must be YYYY-MM-DD' }, { status: 400 });
  }

  const cfg = readOmsConfig();
  if (!cfg.ok) {
    return NextResponse.json({ configured: false, reason: cfg.reason, missing: cfg.missing }, { status: 503 });
  }

  try {
    if (mode === 'status') {
      const status = await omsWeekStatus(cfg.config, weekStart);
      return NextResponse.json({ configured: true, ...status });
    }
    const result = await pullOmsApprovedHours(cfg.config, weekStart, weekLabelFor(weekStart));
    return NextResponse.json({ configured: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'OMS read failed';
    return NextResponse.json({ configured: true, error: message }, { status: 502 });
  }
}

/** "9/13- 9/19" — the sheet's pay-week label, used only when OMS has no label column. */
function weekLabelFor(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!));
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (x: Date) => `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  return `${fmt(start)}- ${fmt(end)}`;
}
