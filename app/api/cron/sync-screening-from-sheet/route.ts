import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchScreeningSheetAsRows } from '@/lib/google-sheets/fetch-screening-sheet';
import { replaceScreeningFromRows } from '@/lib/supabase/screening-db';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { cronSessionElevated } from '@/lib/auth/cron-auth';
import { requireElevatedSession } from '@/lib/auth/authorize-email';

const SYSTEM_USER = { name: 'GSheets Sync', role: 'System' } as const;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip');
}

/**
 * Same auth model as the master/rates sync: a valid `Authorization: Bearer
 * CRON_SECRET` short-circuits without a session round-trip; otherwise the caller
 * must hold an elevated session (admin / HR / accounting / CEO). Fail-closed.
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const got = req.headers.get('authorization') ?? '';
  return got === `Bearer ${expected}`;
}

async function runSync(req: NextRequest): Promise<NextResponse> {
  const bearer = isAuthorized(req);
  let actor: string = SYSTEM_USER.name;
  if (!bearer) {
    const authz = await requireElevatedSession();
    if (!authz.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    actor = authz.sessionEmail;
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
    const fetched = await fetchScreeningSheetAsRows();
    const { rows, sheetId, tabName, headerColumns, headerRowIndex, dataRows, apiRowCount } = fetched;

    const stamp = startedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const sourceLabel = `google-sheet:${sheetId.slice(0, 12)}…@${stamp}`;

    const result = await replaceScreeningFromRows(rows, sourceLabel, actor);

    // Count the active board so the UI shows a number matching what it renders.
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { count: activeCount, error: countError } = await sb
      .from('active_screening')
      .select('*', { count: 'exact', head: true });
    if (countError) console.error('[sync-screening-from-sheet] active_screening count failed', countError.message);

    console.log('[sync-screening-from-sheet] result', {
      sheet: { sheetId, tabName, apiRowCount, headerRowIndex, headerColumns, dataRows },
      ingest: result,
      activeCount,
    });

    void insertAuditLog({
      user_name: bearer ? SYSTEM_USER.name : actor,
      user_role: bearer ? SYSTEM_USER.role : 'hr_coordinator',
      action: 'screening.sheet.sync',
      resource: 'screening',
      resource_id: sheetId,
      details: {
        source: 'google-sheet',
        sheet_id: sheetId,
        tab: tabName,
        sheet_data_rows: dataRows,
        sheet_header_row_index: headerRowIndex,
        sheet_header_columns: headerColumns,
        rows: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        reactivated: result.reactivated,
        removed: result.removed,
        unchanged: result.unchanged,
        rows_missing_email: result.rowsMissingEmail,
        duplicates_in_sheet: result.duplicatesInSheet,
        upload_id: result.uploadId,
      },
      ip_address: clientIp(req),
    });

    return NextResponse.json({
      success: true,
      sheetId,
      tabName,
      dataRows,
      headerRowIndex,
      headerColumns,
      apiRowCount,
      activeCount,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/cron/sync-screening-from-sheet]', msg);

    void insertAuditLog({
      user_name: bearer ? SYSTEM_USER.name : actor,
      user_role: bearer ? SYSTEM_USER.role : 'hr_coordinator',
      action: 'screening.sheet.sync.error',
      resource: 'screening',
      resource_id: process.env.GOOGLE_SHEETS_SCREENING_SHEET_ID ?? null,
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
