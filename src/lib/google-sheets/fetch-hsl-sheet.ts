import { getServiceAccountAccessToken } from './auth';

/**
 * Pulls the configured HSL pay-plan Google Sheet ("HOGAN SMITH AGENT PAY PLAN")
 * and returns parsed agent rows ready for the ingest pipeline.
 *
 * Required env:
 *   - GOOGLE_SHEETS_HSL_SHEET_ID    — long string between /d/ and /edit in the URL
 *   - GOOGLE_SHEETS_HSL_TAB_NAME    — exact tab label, e.g. "Hogan Agents Pay Plan"
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL  (shared with master + rates syncs)
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY  (shared with master + rates syncs)
 *
 * The sheet's typical layout (per the screenshot):
 *   Row 1: merged title "HOGAN SMITH AGENT PAY PLAN" / "Last Update: …"
 *   Row 2: column headers (Department/ Role, Full Name, HSL Name, Email,
 *          Hourly Rate, OT rate, KPI/Bonus, Scoreboard, Notes)
 *   Row 3+: data
 *
 * We auto-detect the header row by looking for a row that contains an `email`
 * cell plus either a `department/role` (or `department`) cell — same general
 * pattern as the master-list fetcher. Anything above that row is dropped.
 */

interface SheetsValuesResponse {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

export interface HslAgentRow {
  /** Lowercased + trimmed work email — primary identity key. */
  email: string;
  /** Original "Department/ Role" cell text, trimmed. May be null. */
  role: string | null;
  /** "Full Name" — typically `LastName, FirstName "Nick"` shape. */
  fullName: string | null;
  /** "HSL Name" — the agent's HSL nickname. */
  hslName: string | null;
  /** "Hourly Rate" parsed to a number (₱), or null if blank/unparseable. */
  hourlyRate: number | null;
  /** "OT rate" parsed to a number. */
  otRate: number | null;
  /** "KPI/Bonus" raw text. Often empty / "No KPI" / a free-form bonus blurb. */
  kpiBonus: string | null;
}

export interface HslSheetFetchResult {
  rows: HslAgentRow[];
  sheetId: string;
  tabName: string;
  /** Total grid rows pulled from the sheet (header + data, before parsing). */
  totalRows: number;
  /** Data rows the parser kept (i.e. rows with a non-empty email). */
  dataRows: number;
  /** Rows seen in the data range but skipped because email was missing/blank. */
  skippedNoEmail: number;
  /** Index of the row we treated as the header (0-based, in the original sheet grid). */
  headerRowIndex: number;
  /** Header strings as they appeared on the sheet — useful for audit-log diagnostics. */
  headerColumns: string[];
}

// ─── Helpers ──────────────────────────────────────────────────

/** Normalize a header cell for tolerant matching ("Department/ Role" → "departmentrole"). */
function normHeader(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function findColIndex(headers: string[], ...labels: string[]): number {
  const norms = headers.map(normHeader);
  for (const label of labels) {
    const idx = norms.indexOf(normHeader(label));
    if (idx >= 0) return idx;
  }
  return -1;
}

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function lower(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === '' ? null : s;
}

/** Parse "₱500.00", "500", "1,234.56" → number. Strips currency / commas / spaces. */
function parseCurrency(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const cleaned = String(v).replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => normHeader(String(c ?? '')));
    const hasEmail = row.some((c) => c === 'email' || c === 'workemail');
    const hasDeptOrName =
      row.some((c) => c === 'department' || c === 'departmentrole' || c === 'fullname' || c === 'name');
    if (hasEmail && hasDeptOrName) return i;
  }
  return -1;
}

// ─── Main ─────────────────────────────────────────────────────

export async function fetchHslSheetRows(): Promise<HslSheetFetchResult> {
  const sheetId = process.env.GOOGLE_SHEETS_HSL_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_HSL_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    throw new Error(
      'HSL sheet target not configured — set GOOGLE_SHEETS_HSL_SHEET_ID and GOOGLE_SHEETS_HSL_TAB_NAME in .env.',
    );
  }

  const token = await getServiceAccountAccessToken(
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  );

  // Sheets API A1 notation requires tab names with spaces / special chars to
  // be wrapped in single quotes (literal quotes inside doubled).
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}` +
    `?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

  console.log('[fetch-hsl-sheet] requesting', { sheetId, tabName, quotedTab, fullUrl: url });

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

  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(
      `Could not find a header row in HSL sheet "${tabName}". Looked for a row containing an "Email" cell plus a "Department/Role" or "Full Name" cell (case-insensitive). Verify the sheet uses the same header shape as the HOGAN SMITH AGENT PAY PLAN export.`,
    );
  }

  const headerCells = (values[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  const dataRowsRaw = values.slice(headerIdx + 1);

  // Resolve column positions, tolerant to small label variations.
  const idxRole = findColIndex(headerCells, 'Department/Role', 'Department/ Role', 'Department / Role', 'Department', 'Role');
  const idxFullName = findColIndex(headerCells, 'Full Name', 'Name');
  const idxHslName = findColIndex(headerCells, 'HSL Name', 'HSL');
  const idxEmail = findColIndex(headerCells, 'Email', 'Work Email');
  const idxHourly = findColIndex(headerCells, 'Hourly Rate', 'Regular Rate', 'Hourly');
  const idxOt = findColIndex(headerCells, 'OT Rate', 'OT rate', 'OT', 'Overtime Rate');
  const idxKpi = findColIndex(headerCells, 'KPI/Bonus', 'KPI / Bonus', 'KPI', 'Bonus');

  if (idxEmail < 0) {
    throw new Error(
      `HSL sheet "${tabName}" is missing an Email column on row ${headerIdx + 1}. Found headers: ${headerCells.join(', ')}`,
    );
  }

  const rows: HslAgentRow[] = [];
  let skippedNoEmail = 0;
  for (const raw of dataRowsRaw) {
    if (!raw || raw.every((c) => String(c ?? '').trim() === '')) continue;
    const email = lower(raw[idxEmail]);
    if (!email) {
      skippedNoEmail += 1;
      continue;
    }
    rows.push({
      email,
      role: idxRole >= 0 ? trimOrNull(raw[idxRole]) : null,
      fullName: idxFullName >= 0 ? trimOrNull(raw[idxFullName]) : null,
      hslName: idxHslName >= 0 ? trimOrNull(raw[idxHslName]) : null,
      hourlyRate: idxHourly >= 0 ? parseCurrency(raw[idxHourly]) : null,
      otRate: idxOt >= 0 ? parseCurrency(raw[idxOt]) : null,
      kpiBonus: idxKpi >= 0 ? trimOrNull(raw[idxKpi]) : null,
    });
  }

  console.log('[fetch-hsl-sheet] parsed', {
    sheetId,
    tabName,
    apiRowCount: values.length,
    headerRowIndex: headerIdx,
    headerColumns: headerCells,
    columnIndexes: { idxRole, idxFullName, idxHslName, idxEmail, idxHourly, idxOt, idxKpi },
    parsedRows: rows.length,
    skippedNoEmail,
  });

  return {
    rows,
    sheetId,
    tabName,
    totalRows: values.length,
    dataRows: rows.length,
    skippedNoEmail,
    headerRowIndex: headerIdx,
    headerColumns: headerCells,
  };
}
