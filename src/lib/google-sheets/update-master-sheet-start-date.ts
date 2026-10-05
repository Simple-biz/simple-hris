import { getServiceAccountAccessToken } from './auth';
import { toSheetDate } from './sheet-date';

/**
 * Updates the "Start Date" cell of the hire's own master-list Sheet row, matched
 * by work email AND personal email (see `planSheetStartDateRows`). Used when a
 * manager edits a hire's orientation date after they've already been promoted
 * into the Sheet — the orientation date IS the Start Date, so the Sheet must
 * follow the edit (otherwise the next Sheet -> Supabase sync would overwrite the
 * corrected date).
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

export type SheetStartDatePlan =
  | { startCol: number; rows: number[] }
  | { reason: string };

/**
 * Which Sheet rows (0-based indexes into `values`) carry THIS hire's Start Date.
 *
 * A row matches only when its Work Email AND its Personal Email are the hire's.
 * Work emails are recycled: a work-email-only match rewrote every row carrying
 * the address, and on 2026-09-28 that put three recycled-address hires' start
 * date on the previous holders' Sheet rows (audit item 344) — which the next
 * Sheet -> Supabase sync would copy back over the repaired database rows. A row
 * with no Personal Email cannot prove it is the hire's, so it is skipped; the
 * personal-email-only fallback is gone for the same reason.
 */
export function planSheetStartDateRows(
  values: unknown[][],
  input: { workEmail: string | null; personalEmail: string | null },
): SheetStartDatePlan {
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) return { reason: 'header row not found in sheet' };

  const headers = (values[headerIdx] ?? []).map((c) =>
    norm(c).replace(/\s+/g, ' '),
  );
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex((h) => h === 'personal email' || h === 'personalemail');
  const startCol = headers.findIndex((h) => h === 'start date' || h === 'startdate');
  if (startCol < 0) return { reason: 'Start Date column not found in sheet' };
  if (workCol < 0 || personalCol < 0) {
    return { reason: 'Work Email or Personal Email column not found in sheet' };
  }

  const targetWork = norm(input.workEmail);
  const targetPersonal = norm(input.personalEmail);
  if (!targetWork || !targetPersonal) {
    return { reason: 'work email and personal email are both required to match a row' };
  }

  const rows: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (norm(row[workCol]) === targetWork && norm(row[personalCol]) === targetPersonal) {
      rows.push(i);
    }
  }
  if (rows.length === 0) return { reason: 'not found in sheet' };
  return { startCol, rows };
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
  const plan = planSheetStartDateRows(values, input);
  if ('reason' in plan) return { updated: 0, reason: plan.reason };
  const { startCol, rows: matched } = plan;

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
