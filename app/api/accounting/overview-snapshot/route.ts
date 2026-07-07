import { NextRequest, NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import {
  upsertAppSetting,
  accountingOverviewSnapshotKey,
  type AccountingOverviewSnapshot,
} from '@/lib/supabase/app-settings';
import type { HubstaffMasterRow } from '@/lib/payroll/hubstaff-reconciliation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The Accounting Overview publishes its EXACT hero "Total payout" here (per pay
 * cycle) so the CEO System Overview board mirrors it instead of recomputing a
 * base figure that drifts low once PAB is added. Rate-visible only (admin /
 * accounting / ceo) — the same gate as the other payroll-figure endpoints.
 */
export async function POST(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    sourceFile?: string;
    totalPayoutPhp?: number | null;
    totalPayoutUsd?: number | null;
    activeWorkers?: number | null;
    masterTotal?: number | null;
    bonusesKeyedIn?: number | null;
    emailsMatched?: number | null;
    masterOnlyCount?: number | null;
    hubstaffOnlyCount?: number | null;
    exceptionsCount?: number | null;
    pabFinalized?: boolean;
    periodLabel?: string | null;
    periodWeek?: number | null;
    reconRows?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sourceFile = (body.sourceFile ?? '').trim();
  if (!sourceFile || sourceFile === '__all__') {
    return NextResponse.json(
      { error: 'A concrete sourceFile is required' },
      { status: 400 },
    );
  }
  if (typeof body.totalPayoutPhp !== 'number' || !Number.isFinite(body.totalPayoutPhp)) {
    return NextResponse.json({ error: 'totalPayoutPhp must be a finite number' }, { status: 400 });
  }

  // Only keep finite numbers; everything else → null (the CEO falls back).
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Sanitize the reconciliation breakdown: coerce every field to a string and
  // cap the row count so a malformed / oversized payload can't bloat app_settings.
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const reconRows: HubstaffMasterRow[] = Array.isArray(body.reconRows)
    ? (body.reconRows as unknown[]).slice(0, 5000).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        return {
          status: str(o.status),
          reason: str(o.reason),
          name: str(o.name),
          workEmail: str(o.workEmail),
          personalEmail: str(o.personalEmail),
          department: str(o.department),
          hours: str(o.hours),
        };
      })
    : [];

  const snapshot: AccountingOverviewSnapshot = {
    totalPayoutPhp: Math.round(body.totalPayoutPhp * 100) / 100,
    totalPayoutUsd:
      typeof body.totalPayoutUsd === 'number' && Number.isFinite(body.totalPayoutUsd)
        ? Math.round(body.totalPayoutUsd * 100) / 100
        : null,
    activeWorkers: num(body.activeWorkers),
    masterTotal: num(body.masterTotal),
    bonusesKeyedIn: num(body.bonusesKeyedIn),
    emailsMatched: num(body.emailsMatched),
    masterOnlyCount: num(body.masterOnlyCount),
    hubstaffOnlyCount: num(body.hubstaffOnlyCount),
    exceptionsCount: num(body.exceptionsCount),
    pabFinalized: body.pabFinalized === true,
    periodLabel: typeof body.periodLabel === 'string' ? body.periodLabel : null,
    periodWeek: num(body.periodWeek),
    reconRows,
    ts: new Date().toISOString(),
  };

  const { error } = await upsertAppSetting(
    accountingOverviewSnapshotKey(sourceFile),
    JSON.stringify(snapshot),
  );
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
