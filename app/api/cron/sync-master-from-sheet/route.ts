import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchMasterSheetAsCsv } from '@/lib/google-sheets/fetch-master-sheet';
import { replaceGlobalMasterListFromCsvText } from '@/lib/supabase/global-master-list-db';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';

const SYSTEM_USER = { name: 'GSheets Sync', role: 'System' } as const;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip');
}

/**
 * Same auth model as the rates sync: if CRON_SECRET is set the request must
 * include `Authorization: Bearer <secret>`; otherwise the endpoint is open
 * (useful for local dev and the manual-trigger button in the admin UI).
 */
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

  // clearOffboarded=true re-activates anyone in the sheet who was previously offboarded.
  // Passed as a query param (?clearOffboarded=true) or in the JSON body.
  let clearOffboarded = false;
  const url = new URL(req.url);
  if (url.searchParams.get('clearOffboarded') === 'true') {
    clearOffboarded = true;
  } else if (req.method === 'POST') {
    try {
      const body = (await req.clone().json()) as { clearOffboarded?: boolean };
      if (body?.clearOffboarded === true) clearOffboarded = true;
    } catch { /* no body or non-JSON — ignore */ }
  }

  const startedAt = new Date();
  try {
    const fetched = await fetchMasterSheetAsCsv();
    const { csvText, sheetId, tabName, totalRows, dataRows, headerRowIndex, headerColumns, apiRowCount } =
      fetched;

    const stamp = startedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const sourceLabel = `google-sheet:${sheetId.slice(0, 12)}…@${stamp}`;

    const result = await replaceGlobalMasterListFromCsvText(csvText, sourceLabel, { clearOffboarded });

    // Count active (non-offboarded) employees so the UI shows a number matching the HR/Accounting overview.
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { count: activeCount, error: countError } = await sb
      .from('active_employees')
      .select('*', { count: 'exact', head: true });
    if (countError) console.error('[sync-master-from-sheet] active_employees count failed', countError.message);

    // Diagnostic — let the dev terminal show the full picture of where rows went.
    const orphanInserts = Math.max(0, result.inserted - 0); // not isolatable from result alone
    console.log('[sync-master-from-sheet] result', {
      sheet: { sheetId, tabName, apiRowCount, headerRowIndex, headerColumns, dataRows },
      ingest: {
        rowCount: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        rowsMissingPersonalEmail: result.rowsMissingPersonalEmail,
        uploadId: result.uploadId,
      },
      gap: {
        sheetSaysDataRows: dataRows,
        ingestKeptRows: result.rowCount,
        difference: dataRows - result.rowCount,
        difference_note:
          dataRows - result.rowCount > 0
            ? 'Rows were dropped by the empty-row / mapped-column-empty filter inside replaceGlobalMasterListFromCsvText.'
            : 'No drop — sheet data rows == ingested rows.',
        _orphanInsertsHint: orphanInserts,
      },
    });

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.master.sync',
      resource: 'global_master_list',
      resource_id: sheetId,
      details: {
        source: 'google-sheet',
        sheet_id: sheetId,
        tab: tabName,
        sheet_total_rows: totalRows,
        sheet_data_rows: dataRows,
        sheet_header_row_index: headerRowIndex,
        sheet_header_columns: headerColumns,
        rows: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        reonboarded: result.reonboarded,
        rows_missing_personal_email: result.rowsMissingPersonalEmail,
        duplicates_in_csv: result.duplicatesInCsv,
        reconciled_via_work_email: result.reconciledViaWorkEmail,
        upload_id: result.uploadId,
        clear_offboarded: clearOffboarded,
      },
      ip_address: clientIp(req),
    });

    invalidateRateProfilesCache();

    return NextResponse.json({
      success: true,
      sheetId,
      tabName,
      totalRows,
      dataRows,
      headerRowIndex,
      headerColumns,
      apiRowCount,
      activeCount,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/cron/sync-master-from-sheet]', msg);

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.master.sync.error',
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
