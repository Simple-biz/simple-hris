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
  phoneNumber?: string | null;
  location?: string | null;
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
    case 'phone number':
    case 'phonenumber':
    case 'phone':
    case 'contact number':
    case 'contactnumber':
    case 'contact':
      return input.phoneNumber ?? '';
    case 'location':
      return input.location ?? '';
    default:
      return '';
  }
}

function colByHeader(headers: string[], ...names: string[]): number {
  return headers.findIndex((h) => {
    const n = h.trim().toLowerCase().replace(/\s+/g, ' ');
    return names.includes(n);
  });
}

/**
 * Appends MANY new-hire rows to the master Sheet in a single round trip: one
 * read (to locate the header + dedupe), one contiguous `values.update` write,
 * and one batched cell-format call. This is what the bulk-promote path uses —
 * appending one row at a time would re-read the whole sheet per hire (3-4
 * network calls each), which serialized into the request that was timing out at
 * the 60s function limit (504) for a dozen hires.
 *
 * Returns one result per input, index-aligned. Dedupes against rows already in
 * the sheet AND against earlier inputs in the same batch (so two ready hires
 * that share a personal email don't both get written). Best-effort by contract,
 * same as the single-row helper: a thrown read/write error should be caught by
 * the caller and treated as "none appended".
 */
export async function appendMasterSheetRows(
  inputs: AppendMasterRowInput[],
): Promise<AppendMasterRowResult[]> {
  if (inputs.length === 0) return [];
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return inputs.map(() => ({ appended: false, reason: 'master sheet env not configured' }));
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const authHeader = { Authorization: `Bearer ${token}` };

  // Pull the tab ONCE for the whole batch.
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
  const workCol = colByHeader(headers, 'work email', 'workemail');
  const personalCol = colByHeader(headers, 'personal email', 'personalemail');
  const startCol = colByHeader(headers, 'start date', 'startdate');

  // Emails already in the sheet (dedupe target).
  const existingWork = new Set<string>();
  const existingPersonal = new Set<string>();
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (workCol >= 0) {
      const w = norm(row[workCol]);
      if (w) existingWork.add(w);
    }
    if (personalCol >= 0) {
      const p = norm(row[personalCol]);
      if (p) existingPersonal.add(p);
    }
  }

  // `values` is contiguous from row 1, so the first empty sheet row (1-indexed)
  // is values.length + 1. We write every new row contiguously from there.
  const firstRow = values.length + 1;
  const results: AppendMasterRowResult[] = new Array(inputs.length);
  const newRows: string[][] = [];
  const cellsToFormat: Array<{ row: number; col: number }> = [];
  // Within-batch dedupe so we never write the same identity twice in one call.
  const seenWork = new Set<string>();
  const seenPersonal = new Set<string>();

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const w = norm(input.workEmail);
    const p = norm(input.personalEmail);
    const dup =
      (!!w && (existingWork.has(w) || seenWork.has(w))) ||
      (!!p && (existingPersonal.has(p) || seenPersonal.has(p)));
    if (dup) {
      results[i] = { appended: false, reason: 'already present in sheet' };
      continue;
    }
    if (w) seenWork.add(w);
    if (p) seenPersonal.add(p);
    // The new row's 0-based sheet row index = (firstRow - 1) + offset, where
    // offset is how many rows we've already queued this batch.
    const sheetRowIdx = firstRow - 1 + newRows.length;
    newRows.push(headers.map((h) => valueForHeader(h, input)));
    if (startCol >= 0) cellsToFormat.push({ row: sheetRowIdx, col: startCol });
    results[i] = { appended: true };
  }

  if (newRows.length === 0) return results;

  // ONE contiguous write, anchored at column A (see the long note that used to
  // live on appendMasterSheetRow: the `:append` endpoint mis-detects this
  // sheet's left edge, so we pin to A{firstRow} explicitly).
  const writeRange = encodeURIComponent(`${quotedTab}!A${firstRow}`);
  const updateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${writeRange}` +
    `?valueInputOption=USER_ENTERED`;
  const updateRes = await fetch(updateUrl, {
    method: 'PUT',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: newRows }),
    cache: 'no-store',
  });
  if (!updateRes.ok) {
    const txt = await updateRes.text().catch(() => '');
    throw new Error(`Sheets write failed (${updateRes.status}): ${txt.slice(0, 200)}`);
  }

  // Pin all the new Start Date cells to mm/dd/yy in ONE batched format call.
  if (cellsToFormat.length > 0) {
    try {
      const { formatCellsAsShortDate } = await import('./format-date-cells');
      await formatCellsAsShortDate(cellsToFormat);
    } catch {
      // formatting is cosmetic - the values are already valid dates
    }
  }

  return results;
}

/**
 * Single-row convenience wrapper over `appendMasterSheetRows`. Kept so the
 * single Promote button's code path is unchanged.
 */
export async function appendMasterSheetRow(
  input: AppendMasterRowInput,
): Promise<AppendMasterRowResult> {
  const [res] = await appendMasterSheetRows([input]);
  return res ?? { appended: false, reason: 'unknown' };
}
