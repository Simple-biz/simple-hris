import { getServiceAccountAccessToken } from './auth';
import { toSheetDate } from './sheet-date';

/**
 * Updates the "Start Date" cell of an existing master-list Sheet row, matched by
 * work email (falling back to personal email). Used when a manager edits a
 * hire's orientation date after they've already been promoted into the Sheet —
 * the orientation date IS the Start Date, so the Sheet must follow the edit
 * (otherwise the next Sheet -> Supabase sync would overwrite the corrected date).
 *
 * Best-effort by contract: returns { updated: 0, reason } when the env isn't
 * configured, the header/column is missing, or no row matches — callers should
 * not fail the orientation edit on this.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateMasterSheetStartDateResult = {
  updated: number;
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

/** 0-based column index -> A1 column letter(s). */
function colLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export async function updateMasterSheetStartDate(input: {
  workEmail: string | null;
  personalEmail: string | null;
  startDate: string | null;
}): Promise<UpdateMasterSheetStartDateResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'master sheet env not configured' };
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const authHeader = { Authorization: `Bearer ${token}` };
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
  if (headerIdx < 0) return { updated: 0, reason: 'header row not found in sheet' };

  const headers = (values[headerIdx] ?? []).map((c) =>
    norm(c).replace(/\s+/g, ' '),
  );
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex((h) => h === 'personal email' || h === 'personalemail');
  const startCol = headers.findIndex((h) => h === 'start date' || h === 'startdate');
  if (startCol < 0) return { updated: 0, reason: 'Start Date column not found in sheet' };

  const targetWork = norm(input.workEmail);
  const targetPersonal = norm(input.personalEmail);

  // Match by work email first (the canonical key); fall back to personal email.
  const matched: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    if (targetWork && rowWork === targetWork) matched.push(i);
    else if (!targetWork && targetPersonal && rowPersonal === targetPersonal) matched.push(i);
  }
  if (matched.length === 0) return { updated: 0, reason: 'not found in sheet' };

  // Write the Start Date cell on each matched row (usually exactly one).
  const letter = colLetter(startCol);
  const data = matched.map((rowIdx) => ({
    range: `${quotedTab}!${letter}${rowIdx + 1}`,
    values: [[toSheetDate(input.startDate)]],
  }));

  const batchUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    cache: 'no-store',
  });
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '');
    throw new Error(`Sheets batch write failed (${batchRes.status}): ${txt.slice(0, 200)}`);
  }

  // Pin the edited Start Date cells to mm/dd/yy display. Best-effort.
  try {
    const { formatCellsAsShortDate } = await import('./format-date-cells');
    await formatCellsAsShortDate(matched.map((rowIdx) => ({ row: rowIdx, col: startCol })));
  } catch {
    // cosmetic only
  }

  return { updated: matched.length };
}
