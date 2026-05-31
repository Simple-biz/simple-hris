import { getServiceAccountAccessToken } from './auth';

/**
 * Appends a single row to the Google Sheet "Offboarded" tab when HR offboards
 * someone in-app, so the row persists through the next sync-offboarded-from-sheet
 * cron (which TRUNCATE+INSERTs offboarded_sheet from the sheet).
 *
 * Column matching mirrors the flexible header detection in fetch-offboarded-sheet.ts.
 * Unknown columns are left blank. Best-effort — callers should not fail the
 * offboard if this throws.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type AppendOffboardedRowInput = {
  personalEmail: string;
  workEmail?: string | null;
  name?: string | null;
  department?: string | null;
  startDate?: string | null;
  offBoardedAt?: string | null;
  offBoardedReason?: string | null;
  offBoardedNote?: string | null;
  offBoardedBy?: string | null;
};

export type AppendOffboardedRowResult = {
  appended: boolean;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => norm(c));
    if (row.some((c) => c === 'personal email' || c === 'personalemail' || c === 'personal_email')) {
      return i;
    }
  }
  return -1;
}

function valueForHeader(header: string, input: AppendOffboardedRowInput): string {
  const h = norm(header);
  switch (h) {
    case 'personal email':
    case 'personalemail':
    case 'personal_email':
      return input.personalEmail ?? '';
    case 'work email':
    case 'workemail':
    case 'email':
      return input.workEmail ?? '';
    case 'name':
    case 'full name':
      return input.name ?? '';
    case 'department':
    case 'dept':
      return input.department ?? '';
    case 'start date':
    case 'startdate':
      return input.startDate ?? '';
    case 'off-boarded at':
    case 'off-boarded date':
    case 'date':
    case 'end date':
    case 'exit date':
    case 'termination date':
      return input.offBoardedAt
        ? new Date(input.offBoardedAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : '';
    case 'reason':
    case 'off-boarded reason':
    case 'offboard-reason':
    case 'offboard reason':
      return input.offBoardedReason ?? '';
    case 'note':
    case 'notes':
    case 'off-boarded note':
      return input.offBoardedNote ?? '';
    case 'by':
    case 'off-boarded by':
      return input.offBoardedBy ?? '';
    default:
      return '';
  }
}

export async function appendOffboardedSheetRow(
  input: AppendOffboardedRowInput,
): Promise<AppendOffboardedRowResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_OFFBOARDED_TAB_NAME?.trim() || 'Offboarded';
  if (!sheetId) {
    return { appended: false, reason: 'GOOGLE_SHEETS_MASTER_SHEET_ID not configured' };
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const authHeader = { Authorization: `Bearer ${token}` };

  const getUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const getRes = await fetch(getUrl, { headers: authHeader, cache: 'no-store' });
  const getJson = (await getRes.json()) as SheetsValuesResponse;
  if (!getRes.ok) {
    throw new Error(
      `Sheets read failed (${getRes.status}): ${getJson.error?.message ?? getRes.statusText}`,
    );
  }

  const values = Array.isArray(getJson.values) ? getJson.values : [];
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(
      `Could not find header row in Offboarded tab "${tabName}" (need a "Personal Email" column).`,
    );
  }

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? ''));
  const newRow = headers.map((h) => valueForHeader(h, input));

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(appendUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [newRow] }),
    cache: 'no-store',
  });
  if (!appendRes.ok) {
    const txt = await appendRes.text().catch(() => '');
    throw new Error(`Sheets append failed (${appendRes.status}): ${txt.slice(0, 200)}`);
  }

  return { appended: true };
}
