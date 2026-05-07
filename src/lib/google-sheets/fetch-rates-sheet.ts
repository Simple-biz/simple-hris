import { getServiceAccountAccessToken } from './auth';

/**
 * Pulls the configured Google Sheet rates tab and returns it as RFC-4180 CSV
 * text. The CSV is shaped exactly like the "All Dept" payroll dashboard export,
 * so the same `replaceEmployeeHourlyRatesFromCsv` ingest pipeline can consume it.
 *
 * Required env:
 *   - GOOGLE_SHEETS_RATES_SHEET_ID         — the spreadsheet id (between /d/ and /edit)
 *   - GOOGLE_SHEETS_RATES_TAB_NAME         — tab name, e.g. "All Dept"
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL  — client_email from the service-account JSON
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY — private_key from the JSON (literal \n is fine)
 */

interface SheetsValuesResponse {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

export interface RatesSheetFetchResult {
  csvText: string;
  sheetId: string;
  tabName: string;
  /** Total grid rows pulled (header + data). */
  totalRows: number;
  /** Data rows (excludes header). */
  dataRows: number;
}

function csvEscapeCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function gridToCsv(values: unknown[][]): string {
  if (values.length === 0) return '';
  // Pad short rows up to the widest row width so CSV stays rectangular —
  // Google Sheets returns trailing-empty cells trimmed per row.
  const width = values.reduce((m, row) => Math.max(m, row.length), 0);
  return values
    .map((row) => {
      const padded = row.length === width ? row : [...row, ...Array(width - row.length).fill('')];
      return padded.map(csvEscapeCell).join(',');
    })
    .join('\n');
}

export async function fetchRatesSheetAsCsv(): Promise<RatesSheetFetchResult> {
  const sheetId = process.env.GOOGLE_SHEETS_RATES_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_RATES_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    throw new Error(
      'Google Sheet target not configured — set GOOGLE_SHEETS_RATES_SHEET_ID and GOOGLE_SHEETS_RATES_TAB_NAME in .env.',
    );
  }

  const token = await getServiceAccountAccessToken(
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  );

  // Sheets API A1 notation requires tab names with spaces / special chars to
  // be wrapped in single quotes (and any literal single quote inside the name
  // doubled). Always quoting is safe — bare names accept it too.
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  // FORMATTED_VALUE keeps date strings (e.g. "Week 4/15/24 - 4/21/24") readable
  // for the Week parser. Numeric rate cells still come through as numeric strings.
  const range = encodeURIComponent(quotedTab);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  console.log('[fetch-rates-sheet] requesting', {
    sheetId,
    tabName,
    quotedTab,
    encodedRange: range,
    fullUrl: url,
  });

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
  const csvText = gridToCsv(values);
  const totalRows = values.length;
  const dataRows = Math.max(0, totalRows - 1);

  console.log('[fetch-rates-sheet]', {
    sheetId,
    tabName,
    apiRowCount: totalRows,
    headerColumns: (values[0] ?? []).map((c) => String(c ?? '').trim()),
    csvCharLen: csvText.length,
  });

  return { csvText, sheetId, tabName, totalRows, dataRows };
}
