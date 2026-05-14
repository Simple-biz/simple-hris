import { NextRequest, NextResponse } from 'next/server';
import { fetchRatesSheetAsCsv } from '@/lib/google-sheets/fetch-rates-sheet';
import { replaceEmployeeHourlyRatesFromCsv } from '@/lib/supabase/rates-upload-db';
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
 * Authorization model:
 *   - If CRON_SECRET is set, the request must include `Authorization: Bearer <secret>`.
 *     Vercel Cron sends this header automatically when CRON_SECRET is configured
 *     in the project's environment variables.
 *   - If CRON_SECRET is NOT set, the endpoint is open. Useful for local dev /
 *     manual triggers from the admin CSV-imports tab.
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
    const { csvText, sheetId, tabName, totalRows, dataRows } = await fetchRatesSheetAsCsv();

    if (!csvText.trim()) {
      throw new Error(
        `Google Sheet "${tabName}" returned no rows — verify the tab name and that the service account can read the sheet.`,
      );
    }

    const stamp = startedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const sourceLabel = `google-sheet:${sheetId.slice(0, 12)}…@${stamp}`;

    const result = await replaceEmployeeHourlyRatesFromCsv(csvText, sourceLabel);

    console.log('[sync-rates-from-sheet] result', {
      sheet: { sheetId, tabName, totalRows, dataRows },
      ingest: {
        rowCount: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        uniqueEmployees: result.uniqueEmployees,
        skippedNoWorkEmail: result.skippedNoWorkEmail,
        skippedNoRate: result.skippedNoRate,
        uploadId: result.uploadId,
      },
    });

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.rates.sync',
      resource: 'employee_hourly_rates',
      resource_id: sheetId,
      details: {
        source: 'google-sheet',
        sheet_id: sheetId,
        tab: tabName,
        sheet_total_rows: totalRows,
        sheet_data_rows: dataRows,
        ...result,
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
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[POST /api/cron/sync-rates-from-sheet]', msg);

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: 'csv.rates.sync.error',
      resource: 'employee_hourly_rates',
      resource_id: process.env.GOOGLE_SHEETS_RATES_SHEET_ID ?? null,
      details: { error: msg },
      ip_address: clientIp(req),
    });

    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// Vercel Cron uses GET; the admin tab POSTs from the browser. Both run the same code.
export async function GET(req: NextRequest) {
  return runSync(req);
}
export async function POST(req: NextRequest) {
  return runSync(req);
}
