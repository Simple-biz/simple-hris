import { NextRequest, NextResponse } from 'next/server';
import { fetchHslSheetRows } from '@/lib/google-sheets/fetch-hsl-sheet';
import { listHslUploads, replaceHslAgentsFromRows } from '@/lib/supabase/hsl-upload-db';
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
 * Same auth model as master/rates syncs: if CRON_SECRET is set the request
 * must include `Authorization: Bearer <secret>`; otherwise the endpoint is
 * open (manual button posts without that header).
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

  const startedAt = new Date();
  try {
    const fetched = await fetchHslSheetRows();
    const { rows, sheetId, tabName, totalRows, dataRows, skippedNoEmail, headerRowIndex, headerColumns } =
      fetched;

    if (rows.length === 0) {
      throw new Error(
        `Google Sheet "${tabName}" returned no rows with usable emails — verify the tab name + sharing.`,
      );
    }

    const stamp = startedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const sourceLabel = `google-sheet:${sheetId.slice(0, 12)}…@${stamp}`;

    const result = await replaceHslAgentsFromRows(rows, sourceLabel);

    console.log('[sync-hsl-from-sheet] result', {
      sheet: { sheetId, tabName, totalRows, dataRows, skippedNoEmail, headerRowIndex, headerColumns },
      ingest: {
        rowCount: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        duplicatesInInput: result.duplicatesInInput,
        uploadId: result.uploadId,
      },
    });

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.hsl.sync',
      resource: 'hsl_team_members',
      resource_id: sheetId,
      details: {
        source: 'google-sheet',
        sheet_id: sheetId,
        tab: tabName,
        sheet_total_rows: totalRows,
        sheet_data_rows: dataRows,
        skipped_no_email: skippedNoEmail,
        sheet_header_row_index: headerRowIndex,
        sheet_header_columns: headerColumns,
        rows: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        duplicates_in_input: result.duplicatesInInput,
        upload_id: result.uploadId,
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
      skippedNoEmail,
      headerRowIndex,
      headerColumns,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/cron/sync-hsl-from-sheet]', msg);

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.hsl.sync.error',
      resource: 'hsl_team_members',
      resource_id: process.env.GOOGLE_SHEETS_HSL_SHEET_ID ?? null,
      details: { error: msg },
      ip_address: clientIp(req),
    });

    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // `?uploads=1` returns the archive listing newest-first (Files tab consumer).
  // Any other GET runs the sync — this is what the legacy "cron" naming served.
  if (new URL(req.url).searchParams.get('uploads') === '1') {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return NextResponse.json(
        { uploads: [], error: 'SUPABASE_SERVICE_ROLE_KEY is not set — required for HSL archive lookup.' },
        { status: 400 },
      );
    }
    try {
      const uploads = await listHslUploads();
      return NextResponse.json({ uploads, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ uploads: [], error: msg }, { status: 500 });
    }
  }
  return runSync(req);
}
export async function POST(req: NextRequest) {
  return runSync(req);
}
