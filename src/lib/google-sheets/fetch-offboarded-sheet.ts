import { getServiceAccountAccessToken } from './auth';

/**
 * Pulls the configured "Offboarded" tab of the master Google Sheet and parses
 * each data row into an `OffboardedSheetRow`. Matching against `global_master_list`
 * happens downstream in `applyOffboardedFromSheetRows` — this fetcher only does
 * the read + flexible header mapping.
 *
 * Required env:
 *   - GOOGLE_SHEETS_MASTER_SHEET_ID            — same spreadsheet as master sync
 *   - GOOGLE_SHEETS_OFFBOARDED_TAB_NAME        — defaults to "Offboarded"
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL      (shared)
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY (shared)
 *
 * Header detection: looks for a row containing a "Personal Email" cell
 * (case-insensitive; also accepts personal_email, personalemail). All other
 * columns are optional — Personal Email is the only required field.
 *
 * Recognised optional columns (all matched case-insensitively):
 *   - Work Email | email
 *   - Name | Full Name
 *   - Department | Dept
 *   - Off-boarded At | Off-boarded Date | Date | End Date | Exit Date
 *   - Reason | Off-boarded Reason
 *   - Note | Notes | Off-boarded Note
 *   - By | Off-boarded By
 */

export interface OffboardedSheetRow {
  personal_email: string;
  work_email: string | null;
  name: string | null;
  department: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_note: string | null;
  off_boarded_by: string | null;
}

export interface OffboardedSheetFetchResult {
  rows: OffboardedSheetRow[];
  sheetId: string;
  tabName: string;
  totalRows: number;
  dataRows: number;
  headerRowIndex: number;
  headerColumns: string[];
  apiRowCount: number;
  rowsMissingPersonalEmail: number;
}

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
    if (row.some((c) => c === 'personal email' || c === 'personalemail' || c === 'personal_email')) {
      return i;
    }
  }
  return -1;
}

function findCol(headers: string[], names: string[]): number {
  const lc = headers.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const idx = lc.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseSheetDate(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Sheet exports "5/4/2026" as M/D/YYYY. Native Date parsing of that string is
  // locale-dependent and unreliable on Node — parse explicitly to avoid the
  // server interpreting "5/4/2026" as April 5 (D/M) on a non-US machine.
  const mdY = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdY) {
    const [, mm, dd, yy] = mdY;
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function cellAt(row: unknown[], idx: number): string {
  if (idx < 0) return '';
  return String(row[idx] ?? '').trim();
}

export async function fetchOffboardedSheetAsRows(): Promise<OffboardedSheetFetchResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = (process.env.GOOGLE_SHEETS_OFFBOARDED_TAB_NAME ?? 'Offboarded').trim();
  if (!sheetId) {
    throw new Error(
      'Master sheet target not configured — set GOOGLE_SHEETS_MASTER_SHEET_ID in .env (the Offboarded tab lives on the same spreadsheet as the master list).',
    );
  }

  const token = await getServiceAccountAccessToken(
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  );

  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  const json = (await res.json()) as SheetsValuesResponse;
  if (!res.ok) {
    const apiMsg = json.error?.message ?? res.statusText;
    throw new Error(`Sheets API error (${res.status}): ${apiMsg}`);
  }

  const values = Array.isArray(json.values) ? json.values : [];
  if (values.length === 0) {
    throw new Error(
      `Sheet tab "${tabName}" returned no rows. Verify the tab name (case-sensitive) and that the service account has Viewer access on the spreadsheet.`,
    );
  }

  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(
      `Could not find a header row containing a "Personal Email" column in tab "${tabName}". Add that column header — it's the only required column.`,
    );
  }

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  const dataValues = values.slice(headerIdx + 1);

  const colPersonal = findCol(headers, ['Personal Email', 'personal_email', 'personalemail']);
  const colWork = findCol(headers, ['Work Email', 'work_email', 'email']);
  const colName = findCol(headers, ['Name', 'Full Name']);
  const colDept = findCol(headers, ['Department', 'Dept']);
  const colDate = findCol(headers, [
    'Off-boarded At', 'off_boarded_at', 'Offboarded At',
    'Off-boarded Date', 'Offboarded Date',
    'Date', 'End Date', 'Exit Date', 'Termination Date',
  ]);
  const colReason = findCol(headers, [
    'Offboard Reason', 'Offboard-Reason', 'OffboardReason',
    'Off-boarded Reason', 'Offboarded Reason',
    'Reason',
    'off_boarded_reason', 'offboard_reason',
  ]);
  const colNote = findCol(headers, ['Note', 'Notes', 'Off-boarded Note', 'off_boarded_note']);
  const colBy = findCol(headers, ['By', 'Off-boarded By', 'off_boarded_by']);

  const rows: OffboardedSheetRow[] = [];
  let rowsMissingPersonalEmail = 0;

  for (const r of dataValues) {
    if (r.every((c) => String(c ?? '').trim() === '')) continue;

    const personal = cellAt(r, colPersonal).toLowerCase();
    if (!personal) {
      rowsMissingPersonalEmail += 1;
      continue;
    }

    rows.push({
      personal_email: personal,
      work_email: cellAt(r, colWork) || null,
      name: cellAt(r, colName) || null,
      department: cellAt(r, colDept) || null,
      off_boarded_at: colDate >= 0 ? parseSheetDate(cellAt(r, colDate)) : null,
      off_boarded_reason: cellAt(r, colReason) || null,
      off_boarded_note: cellAt(r, colNote) || null,
      off_boarded_by: cellAt(r, colBy) || null,
    });
  }

  console.log('[fetch-offboarded-sheet]', {
    sheetId, tabName, headerIdx, headers,
    apiRowCount: values.length, dataRowCount: dataValues.length,
    parsedRows: rows.length, rowsMissingPersonalEmail,
    columnIndices: { colPersonal, colWork, colName, colDept, colDate, colReason, colNote, colBy },
  });

  return {
    rows,
    sheetId,
    tabName,
    totalRows: values.length,
    dataRows: dataValues.length,
    headerRowIndex: headerIdx,
    headerColumns: headers,
    apiRowCount: values.length,
    rowsMissingPersonalEmail,
  };
}
