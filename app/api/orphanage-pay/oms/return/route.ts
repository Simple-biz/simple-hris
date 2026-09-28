import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { readOmsReturnConfig } from '@/lib/oms/oms-config';
import {
  buildOmsReturnRows,
  cleanReturnAliases,
  parseOrphanageAmounts,
  toOmsReturnRecords,
  weekStartFromSourceFile,
  type OmsReturnBuild,
} from '@/lib/oms/oms-return';
import { insertOmsReturn, latestOmsReturn, probeOmsReturnTable } from '@/lib/oms/oms-return-write';
import { additionsSettingKey, cleanAdditionsSourceFile } from '@/lib/payroll/wizard-additions';
import { getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listOrphanagePayStrict } from '@/lib/supabase/orphanage-pay-db';
import { LOCK_KEY } from '@/lib/supabase/payroll-dispatch-lock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Most rows copied into one `wizard.orphanage_oms_returned` event; `sent` is the full count. */
const RETURNED_AUDIT_MAX_ROWS = 300;

/**
 * Send to OMS — the Orphanage step returns the HRIS's figures to the Orphanage
 * Management System (Kane, 2026-09-26/28: "send back to their System … Emails, Hours
 * that were Regular and OT and the amount … so they can report it to accounting").
 *
 *   GET  ?source_file=&week_start=  → { configured, tableReady, reason, preview, latest }
 *        What a send WOULD carry, built by the same function the POST uses, plus the
 *        newest send OMS already holds for the week. Answers 200 even when sending is
 *        not set up: the preview is real either way, and the modal says what is missing.
 *   POST { source_file, week_start, aliases? } → { pushId, pushedAt, sent, totalPhp, cycleLocked }
 *        ONE append-only insert into OMS's table, then one audit row.
 *
 * The rows are REBUILT HERE from the saved carriers — the additions blob (what PAYS)
 * and `orphanage_pay` (the split) — never taken from the tab. A tab holding stale
 * state is exactly how the 2026-08-18 correction was reverted; it must not be able to
 * send stale money to someone else's accounting. The tab contributes only `aliases`
 * (OMS's own address for a person, relabel only) and must name the same week the
 * source file does.
 *
 * TEST mode is enforced by the panel (the button is LIVE-only); the route cannot see
 * the switch, exactly like the LIVE lock-in.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Sending to OMS
 */

type PreviewResult =
  | { ok: true; sourceFile: string; weekStart: string; build: OmsReturnBuild; cycleLocked: boolean }
  | { ok: false; status: number; error: string };

async function buildPreview(rawSourceFile: unknown, rawWeekStart: unknown, aliases?: ReadonlyMap<string, string>): Promise<PreviewResult> {
  const sourceFile = cleanAdditionsSourceFile(rawSourceFile);
  if (!sourceFile) return { ok: false, status: 400, error: 'source_file required' };
  const weekStart = typeof rawWeekStart === 'string' ? rawWeekStart.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return { ok: false, status: 400, error: 'week_start must be YYYY-MM-DD' };
  const derived = weekStartFromSourceFile(sourceFile);
  if (!derived) return { ok: false, status: 400, error: 'The source file carries no date range — the week cannot be named' };
  if (derived !== weekStart) {
    return { ok: false, status: 400, error: `week_start ${weekStart} is not this source file's week (${derived}) — reload the step` };
  }

  let blobValue: string | null;
  let records: Record<string, unknown>[];
  let lockRaw: string | null;
  try {
    const [blob, recs, lock] = await Promise.all([
      getAppSettingWithMetaStrict(additionsSettingKey(sourceFile)),
      listOrphanagePayStrict(sourceFile),
      getAppSettingWithMetaStrict(LOCK_KEY),
    ]);
    blobValue = blob?.value ?? null;
    records = recs;
    lockRaw = lock?.value ?? null;
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : 'HRIS read failed' };
  }

  const amounts = parseOrphanageAmounts(blobValue);
  if (!amounts.ok) return { ok: false, status: 422, error: amounts.reason };
  const built = buildOmsReturnRows({ orphanageAmounts: amounts.amounts, records, aliases });
  if (!built.ok) return { ok: false, status: 422, error: built.reason };
  return {
    ok: true,
    sourceFile,
    weekStart,
    build: built.build,
    cycleLocked: String(lockRaw ?? '').trim().toLowerCase() === 'true',
  };
}

export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const url = new URL(req.url);
  const preview = await buildPreview(url.searchParams.get('source_file'), url.searchParams.get('week_start'));
  if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: preview.status });
  const body = {
    preview: { ...preview.build, cycleLocked: preview.cycleLocked, weekStart: preview.weekStart },
  };

  const cfg = readOmsReturnConfig();
  if (!cfg.ok) {
    return NextResponse.json({ ...body, configured: false, tableReady: false, reason: cfg.reason, latest: null });
  }
  try {
    const probe = await probeOmsReturnTable(cfg.config);
    if (!probe.ready) return NextResponse.json({ ...body, configured: true, tableReady: false, reason: probe.reason, latest: null });
    const { latest, error } = await latestOmsReturn(cfg.config, preview.weekStart);
    return NextResponse.json({ ...body, configured: true, tableReady: true, reason: null, latest, latestError: error });
  } catch (e) {
    return NextResponse.json(
      { ...body, configured: true, tableReady: false, reason: e instanceof Error ? `OMS is unreachable: ${e.message}` : 'OMS is unreachable', latest: null },
    );
  }
}

export async function POST(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let raw: { source_file?: unknown; week_start?: unknown; aliases?: unknown };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof raw !== 'object' || raw === null) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const aliases = cleanReturnAliases(raw.aliases);
  if (!aliases.ok) return NextResponse.json({ error: aliases.reason }, { status: 400 });

  const cfg = readOmsReturnConfig();
  if (!cfg.ok) return NextResponse.json({ configured: false, reason: cfg.reason }, { status: 503 });

  const preview = await buildPreview(raw.source_file, raw.week_start, aliases.aliases);
  if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: preview.status });
  const { build } = preview;
  if (build.rows.length === 0) {
    return NextResponse.json({ error: 'Nothing is locked in for this period — there is nothing to send' }, { status: 409 });
  }

  try {
    const probe = await probeOmsReturnTable(cfg.config);
    if (!probe.ready) return NextResponse.json({ configured: true, tableReady: false, reason: probe.reason }, { status: 503 });

    const pushId = randomUUID();
    const pushedAt = new Date().toISOString();
    const pushedBy = authz.sessionEmail ?? 'system';
    const records = toOmsReturnRecords(build.rows, {
      pushId,
      pushedAt,
      pushedBy,
      sourceFile: preview.sourceFile,
      weekStart: preview.weekStart,
      cycleLocked: preview.cycleLocked,
    });
    const { error } = await insertOmsReturn(cfg.config, records);
    if (error) return NextResponse.json({ configured: true, tableReady: true, error }, { status: 502 });

    // After the insert landed; awaited so the row is not cut off with the response.
    // A failed audit write never un-sends — OMS already holds the rows.
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'wizard.orphanage_oms_returned',
      resource: 'orphanage_pay',
      resource_id: preview.sourceFile,
      details: {
        push_id: pushId,
        oms_table: cfg.config.table,
        week_start: preview.weekStart,
        source_file: preview.sourceFile,
        sent: build.rows.length,
        total_php: build.totals.amountPhp,
        cycle_locked: preview.cycleLocked,
        verdict_counts: build.verdictCounts,
        records_without_amount: build.recordsWithoutAmount,
        rows: records.slice(0, RETURNED_AUDIT_MAX_ROWS),
        rows_truncated: records.length > RETURNED_AUDIT_MAX_ROWS,
        cycle: { source_file: preview.sourceFile },
      },
    }).catch(() => undefined);

    return NextResponse.json({
      configured: true,
      tableReady: true,
      pushId,
      pushedAt,
      sent: build.rows.length,
      totalPhp: build.totals.amountPhp,
      cycleLocked: preview.cycleLocked,
      error: null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? `OMS is unreachable: ${e.message}` : 'OMS is unreachable' }, { status: 502 });
  }
}
