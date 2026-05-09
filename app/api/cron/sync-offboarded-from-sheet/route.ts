import { NextRequest, NextResponse } from 'next/server';
import { fetchOffboardedSheetAsRows } from '@/lib/google-sheets/fetch-offboarded-sheet';
import {
  applyOffboardedFromSheetRows,
  replaceOffboardedSheetSnapshot,
} from '@/lib/supabase/global-master-list-db';
import { insertAuditLog } from '@/lib/supabase/audit-log';

const SYSTEM_USER = { name: 'GSheets Sync', role: 'System' } as const;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip');
}

/** Same auth model as the master/rates syncs — Bearer CRON_SECRET if configured,
 *  otherwise open (manual-trigger button + local dev). */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return true;
  const got = req.headers.get('authorization') ?? '';
  return got === `Bearer ${expected}`;
}

async function runSync(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      {
        success: false,
        error:
          'SUPABASE_SERVICE_ROLE_KEY is required. Add it to .env — Supabase → Project Settings → API → service_role (secret) key.',
      },
      { status: 400 },
    );
  }

  try {
    const fetched = await fetchOffboardedSheetAsRows();
    // 1. Replace the offboarded_sheet snapshot — this is what the HR Offboarded
    //    tab reads from. Decoupled from global_master_list.
    const snapshot = await replaceOffboardedSheetSnapshot(fetched.rows);
    // 2. ALSO stamp global_master_list.off_boarded_* so anyone in the sheet
    //    drops out of the active_employees view + payroll dashboards. This is
    //    a separate concern from the tab display.
    const result = await applyOffboardedFromSheetRows(fetched.rows);

    console.log('[sync-offboarded-from-sheet] result', {
      sheet: {
        sheetId: fetched.sheetId,
        tabName: fetched.tabName,
        apiRowCount: fetched.apiRowCount,
        headerRowIndex: fetched.headerRowIndex,
        headerColumns: fetched.headerColumns,
        dataRows: fetched.dataRows,
        parsedRows: fetched.rows.length,
        rowsMissingPersonalEmail: fetched.rowsMissingPersonalEmail,
      },
      snapshot,
      masterListIngest: result,
    });

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'offboarded.sheet.sync',
      resource: 'global_master_list',
      resource_id: fetched.sheetId,
      details: {
        source: 'google-sheet',
        sheet_id: fetched.sheetId,
        tab: fetched.tabName,
        sheet_total_rows: fetched.totalRows,
        sheet_data_rows: fetched.dataRows,
        sheet_header_row_index: fetched.headerRowIndex,
        sheet_header_columns: fetched.headerColumns,
        sheet_rows_missing_personal_email: fetched.rowsMissingPersonalEmail,
        parsed_rows: fetched.rows.length,
        snapshot_inserted: snapshot.inserted,
        snapshot_cleared: snapshot.cleared,
        matched: result.matched,
        updated: result.updated,
        skipped_already_offboarded: result.skippedAlreadyOffboarded,
        not_found: result.notFound,
        unmatched_emails: result.unmatchedEmails,
      },
      ip_address: clientIp(req),
    });

    return NextResponse.json({
      success: true,
      sheetId: fetched.sheetId,
      tabName: fetched.tabName,
      totalRows: fetched.totalRows,
      dataRows: fetched.dataRows,
      headerRowIndex: fetched.headerRowIndex,
      headerColumns: fetched.headerColumns,
      apiRowCount: fetched.apiRowCount,
      parsedRows: fetched.rows.length,
      rowsMissingPersonalEmail: fetched.rowsMissingPersonalEmail,
      snapshotInserted: snapshot.inserted,
      snapshotCleared: snapshot.cleared,
      matched: result.matched,
      updated: result.updated,
      skippedAlreadyOffboarded: result.skippedAlreadyOffboarded,
      notFound: result.notFound,
      unmatchedEmails: result.unmatchedEmails,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/cron/sync-offboarded-from-sheet]', msg);

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'offboarded.sheet.sync.error',
      resource: 'global_master_list',
      resource_id: process.env.GOOGLE_SHEETS_MASTER_SHEET_ID ?? null,
      details: { error: msg },
      ip_address: clientIp(req),
    });

    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runSync(req);
}
export async function POST(req: NextRequest) {
  return runSync(req);
}
