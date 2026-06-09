import { getServiceAccountAccessToken } from './auth';
import { toSheetDate } from './sheet-date';

/**
 * Appends a single new-hire row to the master-list Google Sheet so a hire
 * promoted in-app also lands in the source-of-truth Sheet (otherwise the next
 * Sheet -> Supabase sync would drop them out of `active_employees`).
 *
 * Requires the service account to have **Editor** access to the sheet and the
 * read/write `spreadsheets` scope. Idempotent: if the hire's work or personal
 * email is already present in the sheet, it skips rather than duplicating.
 *
 * Best-effort by contract — callers should not fail the promote if this throws
 * or returns { appended: false }.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

export type AppendMasterRowInput = {
  name: string;
  personalEmail: string;
  workEmail: string;
  department: string;
  startDate?: string | null;
};

export type AppendMasterRowResult = {
  appended: boolean;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Match the same header signature the reader uses (Department + Name/Personal Email). */
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

/** Resolve a header label to a known field; returns the value to write or '' . */
function valueForHeader(header: string, input: AppendMasterRowInput): string {
  const h = header.trim().toLowerCase().replace(/\s+/g, ' ');
  switch (h) {
    case 'department':
      return input.department ?? '';
    case 'name':
      return input.name ?? '';
    case 'personal email':
    case 'personalemail':
      return input.personalEmail ?? '';
    case 'work email':
    case 'workemail':
      return input.workEmail ?? '';
    case 'start date':
    case 'startdate':
      return toSheetDate(input.startDate);
    default:
      return '';
  }
}

export async function appendMasterSheetRow(
  input: AppendMasterRowInput,
): Promise<AppendMasterRowResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { appended: false, reason: 'master sheet env not configured' };
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Pull the tab once: lets us locate the header row, align columns, and check
  // for an existing entry so we don't append a duplicate.
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
      `Could not find the MASTERLIST header row in tab "${tabName}" (need a "Department" cell plus "Name" or "Personal Email").`,
    );
  }

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? ''));
  const workCol = headers.findIndex((h) => {
    const n = h.trim().toLowerCase().replace(/\s+/g, ' ');
    return n === 'work email' || n === 'workemail';
  });
  const personalCol = headers.findIndex((h) => {
    const n = h.trim().toLowerCase().replace(/\s+/g, ' ');
    return n === 'personal email' || n === 'personalemail';
  });

  // Duplicate guard — scan data rows below the header.
  const targetWork = norm(input.workEmail);
  const targetPersonal = norm(input.personalEmail);
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    if ((targetWork && rowWork === targetWork) || (targetPersonal && rowPersonal === targetPersonal)) {
      return { appended: false, reason: 'already present in sheet' };
    }
  }

  // Build a row aligned to the sheet's column order; unknown columns stay blank.
  // headers[0] is column A (the API returns rows from column A), so this array
  // is A-aligned by construction.
  const newRow = headers.map((h) => valueForHeader(h, input));

  // Write to the first empty row, anchored at column A via an explicit
  // `values.update`. We deliberately do NOT use the `:append` endpoint with a
  // whole-tab range: its "find the table and pick a start column" heuristic
  // mis-detected this sheet's left edge and dropped rows starting at column H
  // (shifting Department->H, Name->J, etc.). `values` is contiguous from row 1,
  // so the next empty sheet row (1-indexed) is values.length + 1.
  const targetRow = values.length + 1;
  const writeRange = encodeURIComponent(`${quotedTab}!A${targetRow}`);
  const updateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${writeRange}` +
    `?valueInputOption=USER_ENTERED`;
  const updateRes = await fetch(updateUrl, {
    method: 'PUT',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: [newRow] }),
    cache: 'no-store',
  });
  if (!updateRes.ok) {
    const txt = await updateRes.text().catch(() => '');
    throw new Error(`Sheets write failed (${updateRes.status}): ${txt.slice(0, 200)}`);
  }

  // Pin the new Start Date cell to mm/dd/yy so it displays like the rest of the
  // column (a freshly appended row inherits no column format). Best-effort.
  const startCol = headers.findIndex((h) => {
    const n = h.trim().toLowerCase().replace(/\s+/g, ' ');
    return n === 'start date' || n === 'startdate';
  });
  if (startCol >= 0) {
    try {
      const { formatCellsAsShortDate } = await import('./format-date-cells');
      await formatCellsAsShortDate([{ row: targetRow - 1, col: startCol }]);
    } catch {
      // formatting is cosmetic — the value is already a valid date
    }
  }

  return { appended: true };
}
