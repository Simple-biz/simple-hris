import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { isNpdSheetKind } from '@/lib/npd/columns';
import { isSundayIso, removedRows, rowForAudit, validateSaveBody } from '@/lib/npd/sheet';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listNpdWeeks, readNpdSheet, readNpdSheetMeta, saveNpdSheet, type NpdFailure } from '@/lib/supabase/npd-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NPD — Accounting → New Payroll Dashboard. The manual payroll sheet Accounting
 * pastes from Google Sheets: one sheet per tab (All Departments | HSL) per pay
 * week. Governing doc: docs/features/npd-dashboard.md.
 *
 * Gate: the `npd` accounting feature — `view` to read, `edit` to save — admin
 * bypass inside `requireFeatureAccess`. Nothing else reads these tables.
 *
 * Why a route of its own and not `/api/app-settings`: the rows carry per-person
 * pay figures and bank last-4s, and the `app_settings` family is readable by every
 * signed-in user (memory app-settings-final-pay-readable-by-every-employee). The
 * HRIS vs NPD step was told to share NPD data only on QC Compare's pattern — own
 * route, author stamped by the server, audit before anything is removed — and
 * this is that pattern.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

function failed(f: NpdFailure) {
  // A missing table is "not set up yet" (503), anything else is a read/write
  // failure (500). Neither is ever an empty sheet.
  return NextResponse.json({ error: f.error, missing: f.missing }, { status: f.missing ? 503 : 500, headers: NO_STORE });
}

/**
 * GET ?sheet=hsl&week=2026-09-20 → that sheet, whole.
 * GET ?list=weeks               → every tab + week that has a sheet.
 */
export async function GET(req: Request) {
  const authz = await requireFeatureAccess('accounting', 'npd', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const url = new URL(req.url);
  if (url.searchParams.get('list') === 'weeks') {
    const r = await listNpdWeeks();
    if (!r.ok) return failed(r);
    return NextResponse.json({ weeks: r.weeks }, { headers: NO_STORE });
  }

  const sheet = url.searchParams.get('sheet');
  const week = url.searchParams.get('week');
  if (!isNpdSheetKind(sheet)) {
    return NextResponse.json({ error: 'sheet must be all_departments or hsl' }, { status: 400 });
  }
  if (!isSundayIso(week)) {
    return NextResponse.json({ error: 'week must be a Sunday (YYYY-MM-DD)' }, { status: 400 });
  }

  const r = await readNpdSheet(sheet, week);
  if (!r.ok) return failed(r);
  return NextResponse.json(
    {
      sheet,
      week,
      version: r.meta.version,
      rowCount: r.meta.rowCount,
      updatedAt: r.meta.updatedAt,
      updatedBy: r.meta.updatedBy,
      rows: r.rows,
    },
    { headers: NO_STORE },
  );
}

/**
 * PUT `{ sheet, week, expectedVersion, rows: [{ id, values }] }` — replace the
 * sheet. `expectedVersion` is the version the editor loaded; a mismatch is 409.
 *
 * Order matters and is source-guarded (npd-route.test.ts):
 *   1. validate · 2. read the current sheet (refuse if it cannot be read — we
 *   could not say what this save removes) · 3. early 409 on a stale version ·
 *   4. AUDIT THE REMOVED ROWS FIRST, refusing the save if that audit fails ·
 *   5. the atomic save (which re-checks the version under a row lock) ·
 *   6. `npd.sheet.saved`.
 * `saved_by` is the SESSION email, never anything from the body.
 */
export async function PUT(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'npd');
  if (!authz.ok) return deniedResponse(authz);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = validateSaveBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { sheet, week, expectedVersion, rows } = parsed.value;
  const resourceId = `${sheet}:${week}`;

  const current = await readNpdSheet(sheet, week);
  if (!current.ok) return failed(current);
  if (current.meta.version !== expectedVersion) {
    return conflictResponse(current.meta.version, current.meta.updatedBy, current.meta.updatedAt);
  }

  // Another person typed these rows. Their contents go on the record BEFORE they
  // leave the table, and a save whose removals cannot be recorded does not happen.
  const removed = removedRows(current.rows, rows);
  if (removed.length > 0) {
    const audit = await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'npd.rows.removed',
      resource: 'npd_sheet',
      resource_id: resourceId,
      details: {
        sheet,
        week,
        from_version: current.meta.version,
        removed_count: removed.length,
        rows: removed.map((r) => rowForAudit(sheet, r)),
      },
    });
    if (audit.error) {
      return NextResponse.json(
        { error: 'The rows this save removes could not be recorded, so nothing was saved. Try again.' },
        { status: 500 },
      );
    }
  }

  const saved = await saveNpdSheet({ sheet, week, expectedVersion, savedBy: authz.sessionEmail, rows });
  if (!saved.ok) {
    if (saved.conflict) {
      const meta = await readNpdSheetMeta(sheet, week);
      return conflictResponse(
        saved.currentVersion,
        meta.ok ? meta.meta.updatedBy : null,
        meta.ok ? meta.meta.updatedAt : null,
      );
    }
    if (removed.length > 0) {
      // The removal above was recorded but did not happen. Say so on the record.
      await insertAuditLog({
        ...auditFrom(req, authz),
        action: 'npd.sheet.save_failed',
        resource: 'npd_sheet',
        resource_id: resourceId,
        details: { sheet, week, from_version: current.meta.version, error: saved.error },
      });
    }
    return failed(saved);
  }

  await insertAuditLog({
    ...auditFrom(req, authz),
    action: 'npd.sheet.saved',
    resource: 'npd_sheet',
    resource_id: resourceId,
    details: {
      sheet,
      week,
      version: saved.meta.version,
      row_count: saved.meta.rowCount,
      previous_row_count: current.meta.rowCount,
      removed_count: removed.length,
    },
  });

  return NextResponse.json(
    {
      version: saved.meta.version,
      rowCount: saved.meta.rowCount,
      updatedAt: saved.meta.updatedAt,
      updatedBy: saved.meta.updatedBy,
    },
    { headers: NO_STORE },
  );
}

function conflictResponse(version: number, updatedBy: string | null, updatedAt: string | null) {
  return NextResponse.json(
    {
      error: 'Someone else saved this sheet after you opened it.',
      conflict: true,
      version,
      updatedBy,
      updatedAt,
    },
    { status: 409, headers: NO_STORE },
  );
}
