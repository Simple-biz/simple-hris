import { getServiceAccountAccessToken } from './auth';
import {
  SCREENING_COLUMNS,
  SCREENING_IDENTITY_COLUMNS,
  SCREENING_ORDER_HEADER,
  SCREENING_ORDER_FIELD,
  acceptedHeaders,
  normalizeHeader,
} from '@/lib/screening/columns';

/**
 * Pulls the "Screenings 2.0" Google Sheet tab and returns the wanted columns
 * (Name … Referral) as objects keyed by DB column name, ready for
 * `replaceScreeningFromRows`. Sibling of `fetch-master-sheet.ts` — same auth and
 * Sheets API call, but the column mapping is bespoke because this sheet has two
 * columns both titled "Remarks" and a few columns to the left of "Name" we skip.
 *
 * Required env:
 *   - GOOGLE_SHEETS_SCREENING_SHEET_ID  — spreadsheet id (between /d/ and /edit)
 *   - GOOGLE_SHEETS_SCREENING_TAB_NAME  — the tab/sheet name (gid's title)
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL        (shared with the master sync)
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY  (shared with the master sync)
 *
 * The service account must have at least Viewer access to the sheet.
 */

interface SheetsValuesResponse {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
  error?: { code?: number; message?: string; status?: string };
}

export interface ScreeningSheetFetchResult {
  /** Data rows keyed by DB column (e.g. { "Name": "…", "Email Address": "…" }). */
  rows: Record<string, string>[];
  sheetId: string;
  tabName: string;
  /** The detected header row's raw cell text (for diagnostics). */
  headerColumns: string[];
  /** 0-based index of the detected header row within the raw grid. */
  headerRowIndex: number;
  /** Number of data rows returned (after dropping fully-empty rows). */
  dataRows: number;
  /** Raw row count from the Sheets API (before any trimming). */
  apiRowCount: number;
}

/**
 * Find the header row: the first row that has a "Name" cell AND a "Referral" or
 * "Email"/"Email Address" cell (case/space-insensitive). Tolerates a title row,
 * blank rows, or a banner above the real header.
 */
function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const cells = (values[i] ?? []).map(normalizeHeader);
    const hasName = cells.includes('name');
    const hasAnchor =
      cells.includes('referral') || cells.includes('email') || cells.includes('email address');
    if (hasName && hasAnchor) return i;
  }
  return -1;
}

/**
 * Resolve each wanted column to a header-row index by consuming matches
 * left→right. Consuming (rather than "first match") is what disambiguates the
 * two "Remarks" columns: the first fills `Initial Remarks`, the second `Remarks 2`.
 * Returns the per-column index (or -1) plus the list of columns that had no match.
 */
function resolveColumnIndices(headerRow: unknown[]): { indices: number[]; missing: string[] } {
  const cells = headerRow.map(normalizeHeader);
  const consumed = new Set<number>();
  const indices: number[] = [];
  const missing: string[] = [];

  SCREENING_COLUMNS.forEach((col, k) => {
    // Blank-header column (e.g. the scheduled-date cell): resolve positionally as
    // the cell right after its anchor, and only if that neighbor's header is
    // actually blank — so a layout change can't silently grab a named column.
    if (col.blankAfter) {
      const anchorPos = SCREENING_COLUMNS.findIndex((c) => c.db === col.blankAfter);
      const anchorIdx = anchorPos >= 0 && anchorPos < k ? indices[anchorPos]! : -1;
      const cand = anchorIdx >= 0 ? anchorIdx + 1 : -1;
      if (cand >= 0 && cand < cells.length && !consumed.has(cand) && cells[cand] === '') {
        consumed.add(cand);
        indices.push(cand);
      } else {
        indices.push(-1); // absent → stays empty; never a "missing column" error
      }
      return;
    }
    const accepted = acceptedHeaders(col);
    let found = -1;
    for (let i = 0; i < cells.length; i++) {
      if (consumed.has(i)) continue;
      if (accepted.includes(cells[i]!)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      missing.push(col.sheetHeader);
      indices.push(-1);
    } else {
      consumed.add(found);
      indices.push(found);
    }
  });
  return { indices, missing };
}

export async function fetchScreeningSheetAsRows(): Promise<ScreeningSheetFetchResult> {
  const sheetId = process.env.GOOGLE_SHEETS_SCREENING_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_SCREENING_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    throw new Error(
      'Screening sheet target not configured — set GOOGLE_SHEETS_SCREENING_SHEET_ID and GOOGLE_SHEETS_SCREENING_TAB_NAME in .env.',
    );
  }

  const token = await getServiceAccountAccessToken(
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  );

  // A1 notation needs tab names with spaces/special chars single-quoted (inner
  // quotes doubled). Always quoting is safe.
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

  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(
      `Could not find the screening header row in tab "${tabName}". Looked for a row with a "Name" cell plus a "Referral" or "Email Address" cell (case-insensitive).`,
    );
  }

  const headerRow = values[headerIdx] ?? [];
  const headerColumns = headerRow.map((c) => String(c ?? '').trim());
  const { indices, missing } = resolveColumnIndices(headerRow);
  if (missing.length > 0) {
    throw new Error(
      `Screening sheet is missing expected column(s): ${missing.join(', ')}. ` +
        `Found headers: ${headerColumns.filter(Boolean).join(', ')}. ` +
        `Fix the sheet headers or update SCREENING_COLUMNS in src/lib/screening/columns.ts.`,
    );
  }

  // The sheet's own "Grid ID" sequence column (outside the display range) — used
  // only to order the board latest-first. -1 if the sheet has no such column.
  const gridIdx = headerRow.map(normalizeHeader).indexOf(normalizeHeader(SCREENING_ORDER_HEADER));

  const dataGrid = values.slice(headerIdx + 1);
  const rows: Record<string, string>[] = [];
  for (const raw of dataGrid) {
    const row: Record<string, string> = {};
    SCREENING_COLUMNS.forEach((col, k) => {
      const idx = indices[k]!;
      row[col.db] = idx >= 0 ? String(raw[idx] ?? '').trim() : '';
    });
    // Keep only rows that actually represent a candidate (have a Name or Email).
    // Drops the blank/spacer rows at the bottom of the sheet — even when a
    // fill-down formula in some other column leaves a stray value behind.
    const hasEntry = SCREENING_IDENTITY_COLUMNS.some((c) => (row[c] ?? '').trim() !== '');
    if (!hasEntry) continue;
    row[SCREENING_ORDER_FIELD] = gridIdx >= 0 ? String(raw[gridIdx] ?? '').trim() : '';
    rows.push(row);
  }

  // Diagnostic — surface exactly what the API returned and how it mapped.
  console.log('[fetch-screening-sheet]', {
    sheetId,
    tabName,
    apiRowCount: values.length,
    headerRowIndex: headerIdx,
    headerColumns,
    resolvedIndices: indices,
    dataRows: rows.length,
  });

  return {
    rows,
    sheetId,
    tabName,
    headerColumns,
    headerRowIndex: headerIdx,
    dataRows: rows.length,
    apiRowCount: values.length,
  };
}
