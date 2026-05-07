import { getServiceAccountAccessToken } from './auth';

/**
 * Pulls the configured Google Sheet master-list tab and returns RFC-4180 CSV
 * text shaped exactly like the Excel `MASTERLIST` export (sentinel rows + header
 * + data) so the existing `replaceGlobalMasterListFromCsvText` ingest accepts it.
 *
 * Required env:
 *   - GOOGLE_SHEETS_MASTER_SHEET_ID   — spreadsheet id (between /d/ and /edit)
 *   - GOOGLE_SHEETS_MASTER_TAB_NAME   — tab name, e.g. "MASTERLIST" or "Roster"
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL  (shared with rates sync)
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY  (shared with rates sync)
 *
 * The Google Sheet itself is expected to start at row 1 with column headers
 * (Department, Name, Personal Email, Work Email, Start Date, …) and have data
 * from row 2 onward — the typical sheet layout. We synthesize the two
 * "MASTERLIST" sentinel rows that the Excel exporter normally produces.
 */

interface SheetsValuesResponse {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

export interface MasterSheetFetchResult {
  csvText: string;
  sheetId: string;
  tabName: string;
  /** Total grid rows pulled from the sheet (header + data, before sentinel injection). */
  totalRows: number;
  /** Data rows (excludes the header). */
  dataRows: number;
  /** Index (0-based) where the auto-detect found the MASTERLIST header within the raw sheet. */
  headerRowIndex: number;
  /** Header column names (as the sheet has them) — useful for verifying the column mapping. */
  headerColumns: string[];
  /** Raw row count returned by the Google Sheets API (before any trimming). */
  apiRowCount: number;
}

function csvEscapeCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function gridToCsvRows(values: unknown[][]): string[] {
  if (values.length === 0) return [];
  const width = values.reduce((m, row) => Math.max(m, row.length), 0);
  return values.map((row) => {
    const padded = row.length === width ? row : [...row, ...Array(width - row.length).fill('')];
    return padded.map(csvEscapeCell).join(',');
  });
}

/**
 * Locate the row that matches the validator's signature for a MASTERLIST header
 * (Department column + Name or Personal Email column, all case-insensitive). Lets
 * us tolerate sheets that have a title, blank rows, or their own MASTERLIST banner
 * before the actual header row. Returns -1 if no row qualifies.
 *
 * Mirrors `validateMasterListCsvLayout` in `global-master-list-db.ts` so behavior
 * is consistent — change both if the validator gets stricter.
 */
function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
    const hasDept = row.some((c) => c === 'department');
    const hasName = row.some((c) => c === 'name');
    const hasPersonal = row.some((c) => c === 'personal email' || c === 'personalemail');
    if (hasDept && (hasName || hasPersonal)) return i;
  }
  return -1;
}

export async function fetchMasterSheetAsCsv(): Promise<MasterSheetFetchResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    throw new Error(
      'Master-list sheet target not configured — set GOOGLE_SHEETS_MASTER_SHEET_ID and GOOGLE_SHEETS_MASTER_TAB_NAME in .env.',
    );
  }

  const token = await getServiceAccountAccessToken(
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  );

  // Sheets API A1 notation requires tab names with spaces / special chars to
  // be wrapped in single quotes (literal quotes inside doubled). Always quoting
  // is safe — bare names accept it too.
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const json = (await res.json()) as SheetsValuesResponse;
  if (!res.ok) {
    const apiMsg = json.error?.message ?? res.statusText;
    throw new Error(`Sheets API error (${res.status}): ${apiMsg}`);
  }

  const values = Array.isArray(json.values) ? json.values : [];
  if (values.length === 0) {
    throw new Error(
      `Sheet tab "${tabName}" returned no rows. Verify the tab name (case-sensitive) and that the service account has Viewer access.`,
    );
  }

  // Auto-detect the header row so we tolerate title rows, blank rows, or an
  // existing "MASTERLIST" banner above the headers.
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(
      `Could not find a MASTERLIST header row in sheet "${tabName}". Looked for a row containing a "Department" cell plus a "Name" or "Personal Email" cell (case-insensitive). Make sure those columns exist.`,
    );
  }

  // Drop everything above the header — could be a title, blank rows, or a
  // pre-existing MASTERLIST sentinel; we synthesize our own sentinels below.
  const trimmedValues = values.slice(headerIdx);
  const headerAndData = gridToCsvRows(trimmedValues);

  // Synthesize the two MASTERLIST sentinel rows the Excel exporter normally emits,
  // so `validateMasterListCsvLayout` finds the marker in rows 1–2 and the header on row 3.
  // Width matches the data so the CSV parser keeps a rectangular grid.
  const width = trimmedValues.reduce((m, row) => Math.max(m, row.length), 0);
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const sentinelRow1 = ['MASTERLIST', ...Array(Math.max(0, width - 1)).fill('')]
    .map(csvEscapeCell)
    .join(',');
  const sentinelRow2 = [
    `Synced from Google Sheet · ${stamp}`,
    ...Array(Math.max(0, width - 1)).fill(''),
  ]
    .map(csvEscapeCell)
    .join(',');

  const csvText = [sentinelRow1, sentinelRow2, ...headerAndData].join('\n');

  const headerColumns = (values[headerIdx] ?? []).map((c) => String(c ?? '').trim());

  // Diagnostic — surface these in the dev server log so we can see exactly what
  // the sheet API returned and how the fetcher processed it.
  console.log('[fetch-master-sheet]', {
    sheetId,
    tabName,
    apiRowCount: values.length,
    headerRowIndex: headerIdx,
    headerColumns,
    rowsAfterHeaderSlice: trimmedValues.length,
    csvCharLen: csvText.length,
  });

  return {
    csvText,
    sheetId,
    tabName,
    totalRows: values.length,
    // Data rows = everything after the detected header within the trimmed slice.
    dataRows: Math.max(0, trimmedValues.length - 1),
    headerRowIndex: headerIdx,
    headerColumns,
    apiRowCount: values.length,
  };
}
