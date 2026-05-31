import { getServiceAccountAccessToken } from './auth';

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

interface SpreadsheetMetadata {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
  error?: { code?: number; message?: string };
}

export type DeleteMasterSheetRowsResult = {
  deleted: number;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => norm(c));
    const hasDept = row.some((c) => c === 'department');
    const hasName = row.some((c) => c === 'name');
    const hasPersonal = row.some((c) => c === 'personal email' || c === 'personalemail');
    if (hasDept && (hasName || hasPersonal)) return i;
  }
  return -1;
}

/**
 * Deletes all rows in the master Google Sheet tab that match the given
 * personal_email or work_email. Rows are deleted from bottom to top so
 * indices don't shift between deletes.
 *
 * Best-effort by contract — callers should surface the result but not
 * block other operations on failure.
 */
export async function deleteMasterSheetRowsByEmail(
  personalEmail: string,
  workEmail?: string,
): Promise<DeleteMasterSheetRowsResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { deleted: 0, reason: 'master sheet env not configured' };
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Get the numeric sheetId for the tab (needed for batchUpdate deleteDimension).
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
  const metaRes = await fetch(metaUrl, { headers: authHeader, cache: 'no-store' });
  const metaJson = (await metaRes.json()) as SpreadsheetMetadata;
  if (!metaRes.ok) {
    throw new Error(
      `Sheets metadata failed (${metaRes.status}): ${metaJson.error?.message ?? metaRes.statusText}`,
    );
  }

  const tabMeta = metaJson.sheets?.find(
    (s) => s.properties?.title?.trim().toLowerCase() === tabName.trim().toLowerCase(),
  );
  const numericSheetId = tabMeta?.properties?.sheetId;
  if (numericSheetId === undefined) {
    throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  }

  // Fetch all values to locate matching rows by email.
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
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
    return { deleted: 0, reason: 'header row not found in sheet' };
  }

  const headers = (values[headerIdx] ?? []).map((c) =>
    String(c ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
  );
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex(
    (h) => h === 'personal email' || h === 'personalemail',
  );

  const targetWork = norm(workEmail ?? '');
  const targetPersonal = norm(personalEmail);

  // Collect absolute 0-based sheet row indices for matching data rows.
  const rowsToDelete: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    const matchWork = targetWork !== '' && rowWork === targetWork;
    const matchPersonal = targetPersonal !== '' && rowPersonal === targetPersonal;
    if (matchWork || matchPersonal) {
      rowsToDelete.push(i);
    }
  }

  if (rowsToDelete.length === 0) {
    return { deleted: 0, reason: 'not found in sheet' };
  }

  // Delete from bottom to top so earlier indices remain valid after each delete.
  const requests = rowsToDelete
    .slice()
    .sort((a, b) => b - a)
    .map((rowIdx) => ({
      deleteDimension: {
        range: {
          sheetId: numericSheetId,
          dimension: 'ROWS',
          startIndex: rowIdx,
          endIndex: rowIdx + 1,
        },
      },
    }));

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    cache: 'no-store',
  });
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '');
    throw new Error(
      `Sheets batchUpdate failed (${batchRes.status}): ${txt.slice(0, 300)}`,
    );
  }

  return { deleted: rowsToDelete.length };
}
