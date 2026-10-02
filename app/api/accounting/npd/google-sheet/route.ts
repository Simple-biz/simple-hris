import { NextResponse } from 'next/server';

import { auditFrom } from '@/lib/audit/context';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { isNpdSheetKind } from '@/lib/npd/columns';
import { buildNpdImport } from '@/lib/npd/google-sheet-import';
import { isSundayIso, weekLabel } from '@/lib/npd/sheet';
import { NpdSheetNotConfiguredError, fetchNpdSheetGrids } from '@/lib/google-sheets/fetch-npd-sheet';
import { resolveCurrentWeek } from '@/lib/payroll/payroll-readiness';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { readLastNpdSyncs } from '@/lib/supabase/npd-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NPD's Google Sheet sync — the "All Dept Payroll CSV" button (moved here from
 * Payroll Wizard → Initialize Payroll Data, 2026-10-02) and "Hogan Payroll Sync".
 * Governing doc: docs/features/npd-dashboard.md § Google Sheet sync.
 *
 * GET                    → the Payroll Wizard's week and when each tab last synced it:
 *                          { week, sourceFile, lastSync: { all_departments, hsl }, lastSyncError }.
 *                          The timestamp is the server's, written when a sync's SAVE
 *                          landed (`npd.sheet.synced`, PUT /api/accounting/npd).
 * GET ?sheet=<tab>       → that tab's rows for the wizard's week, rebuilt as NPD
 *                          rows: { week, sourceFile, tab, rows, rateText, summary }.
 *
 * ONLY THE CURRENT WEEK (Kane, 2026-10-02: "MAKE SURE when we sync only the current
 * week"): this route takes no week. It always uses the wizard's, and only rows
 * labelled with that week come back. The save refuses a sync for any other week.
 *
 * READ-ONLY. This route writes nothing but its audit row. The page puts the rows on
 * the grid and saves them through PUT /api/accounting/npd, so the removed-rows
 * audit, the lock and the version check apply to a sync exactly as to a paste.
 *
 * "The week the Payroll Wizard is on" = its live (is_current) Hubstaff upload's
 * week, the same resolver Payroll Readiness uses. There is NO calendar fallback:
 * no upload, an unreadable upload list, or a filename that names no Sunday is
 * refused — a sync into a guessed week would fill the wrong sheet.
 *
 * Gate: the `npd` EDIT grant (the only people who can save what it loads).
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'npd');
  if (!authz.ok) return deniedResponse(authz);

  let wizard: Awaited<ReturnType<typeof resolveCurrentWeek>>;
  try {
    wizard = await resolveCurrentWeek();
  } catch (e) {
    return NextResponse.json(
      { error: `The Payroll Wizard's week could not be read: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503, headers: NO_STORE },
    );
  }
  if (wizard.degraded.length > 0) {
    return NextResponse.json(
      { error: "The Payroll Wizard's week could not be read (its Hubstaff upload list failed to load). Nothing was loaded." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!wizard.sourceFile) {
    return NextResponse.json(
      { error: 'The Payroll Wizard has no week yet: no Hubstaff timesheet has been uploaded.' },
      { status: 409, headers: NO_STORE },
    );
  }
  if (!isSundayIso(wizard.weekStart)) {
    return NextResponse.json(
      {
        error: `The Payroll Wizard's upload "${wizard.sourceFile}" does not name a Sunday–Saturday week, so there is no NPD week to load.`,
      },
      { status: 409, headers: NO_STORE },
    );
  }
  const week = wizard.weekStart;
  const sourceFile = wizard.sourceFile;

  const sheet = new URL(req.url).searchParams.get('sheet');
  if (sheet === null) {
    const last = await readLastNpdSyncs(week);
    return NextResponse.json(
      {
        week,
        sourceFile,
        lastSync: last.ok ? last.bySheet : null,
        lastSyncError: last.ok ? null : `When this week was last synced could not be read: ${last.error}`,
      },
      { headers: NO_STORE },
    );
  }
  if (!isNpdSheetKind(sheet)) {
    return NextResponse.json({ error: 'sheet must be all_departments or hsl' }, { status: 400 });
  }

  let fetched: Awaited<ReturnType<typeof fetchNpdSheetGrids>>;
  try {
    fetched = await fetchNpdSheetGrids(sheet);
  } catch (e) {
    const notConfigured = e instanceof NpdSheetNotConfiguredError;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), missing: notConfigured || undefined },
      { status: notConfigured ? 503 : 502, headers: NO_STORE },
    );
  }

  const result = buildNpdImport({ sheet, week, tab: fetched.tab, grids: fetched.grids });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code, week, sourceFile },
      { status: result.code === 'no_rows' ? 404 : 422, headers: NO_STORE },
    );
  }

  // Who pulled which tab into which week, and what it held. The save that follows
  // writes npd.sheet.saved (and npd.rows.removed first) as for any save.
  await insertAuditLog({
    ...auditFrom(req, authz),
    action: 'npd.google_sheet.loaded',
    resource: 'npd_sheet',
    resource_id: `${sheet}:${week}`,
    details: {
      sheet,
      week,
      week_label: weekLabel(week),
      wizard_source_file: sourceFile,
      tab: fetched.tab,
      row_count: result.summary.rows,
      rate: result.summary.rate,
      other_rates: result.summary.otherRates,
      typed_cells: result.summary.typedCells,
      skipped: result.summary.skipped,
      labels: result.summary.labels,
    },
  });

  return NextResponse.json(
    { week, sourceFile, tab: fetched.tab, rows: result.rows, rateText: result.rateText, summary: result.summary },
    { headers: NO_STORE },
  );
}
