import { getServiceAccountAccessToken } from './auth';

/**
 * Writes an approved department transfer back into the master Google Sheet.
 *
 * The Sheet is the source of truth for the roster; the master-list sync keys
 * identity on (Work Email, Department), so an approved transfer that changed the
 * dept only in Supabase would be reverted (or duplicated) on the next sync unless
 * the Sheet is updated too. This flips the "Department" cell on the matching row
 * in place.
 *
 * Matching mirrors applyDepartmentTransfer: the row must match the employee by
 * work OR personal email AND currently sit in `fromDepartment`, so a person who
 * holds rows in multiple departments only has the source row moved.
 *
 * Best-effort by contract — callers should record the outcome (sheet_synced /
 * sheet_sync_error) but not block the transfer if this fails.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateMasterSheetDepartmentInput = {
  personalEmail: string | null;
  workEmail?: string | null;
  fromDepartment: string;
  toDepartment: string;
};

export type UpdateMasterSheetDepartmentResult = {
  updated: number;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Mirror of the master-sheet header detection: a row with Department + (Name or Personal Email). */
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

/** 1-based column number → A1 column letter (1→A, 27→AA). */
function columnToLetter(column: number): string {
  let temp: number;
  let letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

export async function updateMasterSheetDepartment(
  input: UpdateMasterSheetDepartmentInput,
): Promise<UpdateMasterSheetDepartmentResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'master sheet env not configured' };
  }

  const to = input.toDepartment.trim();
  const from = input.fromDepartment.trim().toLowerCase();
  if (!to) return { updated: 0, reason: 'target department is required' };

  const pe = input.personalEmail?.trim().toLowerCase() || null;
  const we = input.workEmail?.trim().toLowerCase() || null;
  if (!pe && !we) return { updated: 0, reason: 'no email to match' };

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
    return { updated: 0, reason: 'header row not found in sheet' };
  }

  const headers = (values[headerIdx] ?? []).map((c) => norm(c));
  const deptCol = headers.findIndex((h) => h === 'department');
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex((h) => h === 'personal email' || h === 'personalemail');
  if (deptCol < 0) return { updated: 0, reason: 'no Department column in sheet' };

  // Collect the A1 ranges of the Department cell on every matching source row.
  const deptLetter = columnToLetter(deptCol + 1);
  const cellRanges: string[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    const rowDept = norm(row[deptCol]);
    const matchEmail = (we && rowWork === we) || (pe && rowPersonal === pe);
    if (matchEmail && rowDept === from) {
      // Sheet rows are 1-based; `values` is 0-based.
      cellRanges.push(`${quotedTab}!${deptLetter}${i + 1}`);
    }
  }

  if (cellRanges.length === 0) {
    return { updated: 0, reason: 'no matching row in source department' };
  }

  const batchUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: cellRanges.map((r) => ({ range: r, values: [[to]] })),
    }),
    cache: 'no-store',
  });
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '');
    throw new Error(`Sheets batchUpdate failed (${batchRes.status}): ${txt.slice(0, 300)}`);
  }

  return { updated: cellRanges.length };
}
