import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { isNpdSheetKind } from '@/lib/npd/columns';
import { recomputeSheet } from '@/lib/npd/formulas';
import { isSundayIso, removedRows, rowForAudit, validateLockBody, validateSaveBody } from '@/lib/npd/sheet';
import { resolveCurrentWeek } from '@/lib/payroll/payroll-readiness';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  NPD_LOCK_NOT_SET_UP,
  listNpdWeeks,
  lockNpdSheet,
  readNpdSheet,
  readNpdSheetMeta,
  saveNpdSheet,
  unlockNpdSheet,
  type NpdFailure,
} from '@/lib/supabase/npd-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NPD — Accounting → New Payroll Dashboard. The manual payroll sheet Accounting
 * pastes from Google Sheets: one sheet per tab (All Departments | HSL) per pay
 * week. Governing doc: docs/features/npd-dashboard.md.
 *
 * Gate: the `npd` accounting feature — `view` to read, `edit` to save, lock and
 * unlock — admin bypass inside `requireFeatureAccess`. The one other reader is the
 * Payroll Wizard's HRIS vs NPD step (`app/api/payroll-wizard/npd-feed/route.ts`,
 * 2026-10-02): read-only, BOTH tabs locked only, Work Email + PHP USD Conversion
 * only, behind this same `npd` view grant plus `payroll_wizard` view.
 *
 * Lock in (PATCH): a locked sheet takes no save. The database enforces it
 * (npd_save_sheet raises npd_sheet_locked under the row lock), and this route
 * answers 423 before it even tries, so a refused save writes no audit row.
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
      lockedAt: r.meta.lockedAt,
      lockedBy: r.meta.lockedBy,
      usdPerPhp: r.meta.usdPerPhp,
      columnFormulas: r.meta.columnFormulas,
      rows: r.rows,
    },
    { headers: NO_STORE },
  );
}

/**
 * PUT `{ sheet, week, expectedVersion, usdPerPhp, columnFormulas, rows: [{ id,
 * values, overrides, formulas }] }` — replace the sheet. `expectedVersion` is the
 * version the editor loaded; a mismatch is 409.
 *
 * FORMULAS ARE RECALCULATED HERE, on every save (src/lib/npd/formulas.ts), so a
 * stored formula cell always holds what its formula gives. The browser's figures
 * are never trusted; only a cell it lists as typed over keeps the browser's text.
 *
 * Order matters and is source-guarded (npd-wiring.test.ts):
 *   1. validate · 2. read the current sheet (refuse if it cannot be read — we
 *   could not say what this save removes) · 3. 423 if it is LOCKED, then 409 on
 *   a stale version (the database checks in the same order) ·
 *   4. AUDIT THE REMOVED ROWS FIRST, refusing the save if that audit fails ·
 *   5. the atomic save (which re-checks lock and version under a row lock) ·
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
  const { sheet, week, expectedVersion, usdPerPhp, columnFormulas, googleSheetSync } = parsed.value;
  const rows = recomputeSheet(sheet, parsed.value.rows, { columnFormulas, rate: usdPerPhp });
  const resourceId = `${sheet}:${week}`;

  // A Google Sheet sync fills ONLY the Payroll Wizard's current week (Kane,
  // 2026-10-02: "MAKE SURE when we sync only the current week"). Refused before
  // anything is read or written; an ordinary save of any week is unaffected.
  if (googleSheetSync) {
    const wizard = await resolveCurrentWeek();
    if (wizard.degraded.length > 0 || !wizard.sourceFile || wizard.weekStart !== week) {
      const current = wizard.degraded.length === 0 && wizard.sourceFile && isSundayIso(wizard.weekStart) ? ` (${wizard.weekStart})` : '';
      return NextResponse.json(
        {
          error: `A Google Sheet sync only fills the Payroll Wizard's current week${current}, and this is not it. Nothing was saved.`,
          syncWeek: true,
        },
        { status: 422, headers: NO_STORE },
      );
    }
  }

  const current = await readNpdSheet(sheet, week);
  if (!current.ok) return failed(current);
  if (current.meta.lockedAt) return lockedResponse(current.meta.lockedBy, current.meta.lockedAt);
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

  const saved = await saveNpdSheet({
    sheet,
    week,
    expectedVersion,
    savedBy: authz.sessionEmail,
    rows,
    usdPerPhp,
    columnFormulas,
  });
  if (!saved.ok) {
    if (saved.locked) {
      // Locked between the read above and the save. Nothing was written; a
      // removal recorded above did not happen, so say so on the record.
      if (removed.length > 0) {
        await insertAuditLog({
          ...auditFrom(req, authz),
          action: 'npd.sheet.save_failed',
          resource: 'npd_sheet',
          resource_id: resourceId,
          details: { sheet, week, from_version: current.meta.version, error: 'npd_sheet_locked' },
        });
      }
      const meta = await readNpdSheetMeta(sheet, week);
      return lockedResponse(meta.ok ? meta.meta.lockedBy : null, meta.ok ? meta.meta.lockedAt : null);
    }
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
      // Formula settings are part of what pays out on paper: record when they move.
      ...(String(usdPerPhp ?? '') !== String(current.meta.usdPerPhp ?? '')
        ? { usd_per_php: { from: current.meta.usdPerPhp, to: usdPerPhp === null ? null : String(usdPerPhp) } }
        : {}),
      ...(JSON.stringify(columnFormulas) !== JSON.stringify(current.meta.columnFormulas)
        ? { column_formulas: { from: current.meta.columnFormulas, to: columnFormulas } }
        : {}),
      ...(googleSheetSync ? { google_sheet_sync: googleSheetSync.tab } : {}),
    },
  });

  // The sync's timestamp: the time this save landed, stamped by the server. The bar
  // on each NPD tab reads it back ("Last synced …"). It is written only after a
  // save that succeeded, so a sync that never saved is never shown as synced.
  const syncedAt = googleSheetSync ? (saved.meta.updatedAt ?? new Date().toISOString()) : null;
  if (googleSheetSync) {
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'npd.sheet.synced',
      resource: 'npd_sheet',
      resource_id: resourceId,
      details: {
        sheet,
        week,
        version: saved.meta.version,
        row_count: saved.meta.rowCount,
        tab: googleSheetSync.tab,
        wizard_source_file: googleSheetSync.sourceFile,
        synced_at: syncedAt,
        synced_by: authz.sessionEmail,
      },
    });
  }

  return NextResponse.json(
    {
      version: saved.meta.version,
      rowCount: saved.meta.rowCount,
      updatedAt: saved.meta.updatedAt,
      updatedBy: saved.meta.updatedBy,
      usdPerPhp: saved.meta.usdPerPhp,
      columnFormulas: saved.meta.columnFormulas,
      ...(googleSheetSync ? { syncedAt, syncedBy: authz.sessionEmail } : {}),
    },
    { headers: NO_STORE },
  );
}

/**
 * PATCH `{ action: 'lock', sheet, week, expectedVersion }` — lock the sheet at the
 * version the editor is looking at. Needs a saved sheet with rows.
 * PATCH `{ action: 'unlock', sheet, week, reason }` — clear the lock. The reason is
 * required, and the unlock is AUDITED FIRST: if that audit cannot be written the
 * sheet stays locked (the reason is the whole record of why locked-in values may
 * change again). Who locked / unlocked is the SESSION email, never the body.
 */
export async function PATCH(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'npd');
  if (!authz.ok) return deniedResponse(authz);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = validateLockBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value;
  const { sheet, week } = body;
  const resourceId = `${sheet}:${week}`;

  if (body.action === 'lock') {
    const locked = await lockNpdSheet({
      sheet,
      week,
      expectedVersion: body.expectedVersion,
      lockedBy: authz.sessionEmail,
    });
    if (!locked.ok) {
      if (locked.refusal === 'conflict') {
        const meta = await readNpdSheetMeta(sheet, week);
        return conflictResponse(
          locked.currentVersion ?? (meta.ok ? meta.meta.version : 0),
          meta.ok ? meta.meta.updatedBy : null,
          meta.ok ? meta.meta.updatedAt : null,
        );
      }
      if (locked.refusal === 'locked') {
        const meta = await readNpdSheetMeta(sheet, week);
        return lockedResponse(meta.ok ? meta.meta.lockedBy : null, meta.ok ? meta.meta.lockedAt : null);
      }
      if (locked.refusal === 'empty') {
        return NextResponse.json({ error: 'Nothing to lock: this sheet has no saved rows yet.' }, { status: 400 });
      }
      if (locked.refusal === 'missing') {
        return NextResponse.json({ error: NPD_LOCK_NOT_SET_UP, missing: true }, { status: 503 });
      }
      return NextResponse.json({ error: locked.error }, { status: 500 });
    }
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'npd.sheet.locked',
      resource: 'npd_sheet',
      resource_id: resourceId,
      details: { sheet, week, version: locked.version, row_count: locked.rowCount },
    });
    return NextResponse.json(
      { locked: true, lockedAt: locked.lockedAt, lockedBy: locked.lockedBy, version: locked.version },
      { headers: NO_STORE },
    );
  }

  // Unlock. Read first: an unlock of a sheet that is not locked records nothing.
  const current = await readNpdSheetMeta(sheet, week);
  if (!current.ok) return failed(current);
  if (!current.meta.lockedAt) {
    return NextResponse.json({ error: 'This sheet is not locked.', locked: false }, { status: 409, headers: NO_STORE });
  }

  const audit = await insertAuditLog({
    ...auditFrom(req, authz),
    action: 'npd.sheet.unlocked',
    resource: 'npd_sheet',
    resource_id: resourceId,
    details: {
      sheet,
      week,
      version: current.meta.version,
      reason: body.reason,
      locked_by: current.meta.lockedBy,
      locked_at: current.meta.lockedAt,
    },
  });
  if (audit.error) {
    return NextResponse.json(
      { error: 'The reason for this unlock could not be recorded, so the sheet stays locked. Try again.' },
      { status: 500 },
    );
  }

  const unlocked = await unlockNpdSheet({ sheet, week, unlockedBy: authz.sessionEmail });
  if (!unlocked.ok) {
    // The unlock recorded above did not happen. Say so on the record.
    await insertAuditLog({
      ...auditFrom(req, authz),
      action: 'npd.sheet.unlock_failed',
      resource: 'npd_sheet',
      resource_id: resourceId,
      details: { sheet, week, error: unlocked.error },
    });
    if (unlocked.refusal === 'not_locked') {
      return NextResponse.json({ error: 'This sheet is not locked.', locked: false }, { status: 409, headers: NO_STORE });
    }
    if (unlocked.refusal === 'missing') {
      return NextResponse.json({ error: NPD_LOCK_NOT_SET_UP, missing: true }, { status: 503 });
    }
    return NextResponse.json({ error: unlocked.error }, { status: 500 });
  }
  return NextResponse.json({ locked: false, version: unlocked.version }, { headers: NO_STORE });
}

function lockedResponse(lockedBy: string | null, lockedAt: string | null) {
  return NextResponse.json(
    {
      error: 'This sheet is locked in. Nothing on it can change until it is unlocked.',
      locked: true,
      lockedBy,
      lockedAt,
    },
    { status: 423, headers: NO_STORE },
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
