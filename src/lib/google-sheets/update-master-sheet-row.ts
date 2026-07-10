import { getServiceAccountAccessToken } from './auth';
import { toSheetDate } from './sheet-date';

/**
 * Writes several columns of ONE existing master-list Sheet row in a single
 * `values:batchUpdate`. This is the generalized form of
 * `updateMasterSheetStartDate` / `updateMasterSheetDepartment`: instead of one
 * hard-coded column it takes a `cells` map of header LABEL -> value and resolves
 * each label to its column by the sheet's header text (never a fixed A/B/C —
 * this sheet's layout is position-agnostic).
 *
 * Powers the People -> View Modal profile editor: an in-app identity edit writes
 * the DB row AND flips the matching Sheet cells so the next Sheet -> Supabase
 * sync doesn't clobber the edit back to the stale value.
 *
 * Best-effort by contract, same as the sibling helpers: returns
 * `{ updated: 0, reason }` (rather than throwing) when the env isn't configured,
 * the header/row can't be found, or nothing matches — callers should surface a
 * "saved in-app; Sheet not updated" warning but not fail the whole save.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateMasterSheetRowInput = {
  /** Match key — the CURRENT work email of the row (before any edit). */
  workEmail: string | null;
  /** Fallback match key when no work email is present. */
  personalEmail: string | null;
  /** Disambiguate people who hold rows in multiple departments — the CURRENT
   *  department of the row being edited. Omit to match on email alone. */
  matchDepartment?: string | null;
  /** Header LABEL -> new value. Keys are canonical labels (e.g. 'Name',
   *  'Personal Email', 'Start Date', 'Phone Number', 'Location',
   *  'Alternate Work Email', 'Alternate Work Email 2'). A null value clears the
   *  cell. Labels the sheet doesn't have are skipped, not an error. */
  cells: Record<string, string | null>;
};

export type UpdateMasterSheetRowResult = {
  updated: number;
  /** Header labels that couldn't be resolved to a sheet column (informational). */
  skipped?: string[];
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Neutralize spreadsheet formula/auto-parse of user text: Google Sheets treats
 *  a leading =,+,-,@ as a formula (and a leading + as unary plus, which would
 *  strip the '+' off an international phone number under USER_ENTERED). A leading
 *  apostrophe forces the cell to plain text without appearing in the value that
 *  round-trips back on the next sync. Dates are exempt (they must parse). */
function sheetSafeText(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

/** Mirror of the master-sheet header detection: Department + (Name or Personal Email). */
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

/** Acceptable normalized header spellings for each canonical label. */
const HEADER_ALIASES: Record<string, string[]> = {
  'name': ['name'],
  'department': ['department'],
  'personal email': ['personal email', 'personalemail'],
  'work email': ['work email', 'workemail'],
  'start date': ['start date', 'startdate'],
  'location': ['location'],
  'phone number': ['phone number', 'phonenumber', 'phone', 'contact number', 'contactnumber', 'contact'],
};

/** Labels whose value should be written as a short date + pinned mm/dd/yy. */
const DATE_LABELS = new Set(['start date']);

/**
 * Resolve every canonical label in `cells` to a 0-based column index using the
 * sheet's header row. Alternate-work-email columns are resolved POSITIONALLY
 * (the sheet frequently heads both columns identically "Alternate Work Email"),
 * mirroring resolveMasterColumnMapping in global-master-list-db.ts.
 */
function resolveColumns(
  headers: string[],
  labels: string[],
): { byLabel: Map<string, number>; skipped: string[] } {
  const normalized = headers.map((h) => norm(h));
  const byLabel = new Map<string, number>();
  const skipped: string[] = [];

  // Positional slots for the (possibly identically-headed) alternate work emails.
  const altIdxs: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].startsWith('alternate work email')) altIdxs.push(i);
  }

  for (const label of labels) {
    const key = norm(label);
    if (key === 'alternate work email') {
      // First alt slot: prefer an exact "alternate work email" header, else the
      // first alternate-* column.
      const exact = normalized.findIndex((h) => h === 'alternate work email');
      const idx = exact >= 0 ? exact : altIdxs[0] ?? -1;
      if (idx >= 0) byLabel.set(label, idx);
      else skipped.push(label);
      continue;
    }
    if (key === 'alternate work email 2') {
      // Second alt slot: prefer an exact "alternate work email 2" header, else
      // the second alternate-* column.
      const exact = normalized.findIndex((h) => h === 'alternate work email 2');
      const idx = exact >= 0 ? exact : altIdxs[1] ?? -1;
      if (idx >= 0) byLabel.set(label, idx);
      else skipped.push(label);
      continue;
    }
    const aliases = HEADER_ALIASES[key] ?? [key];
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx >= 0) byLabel.set(label, idx);
    else skipped.push(label);
  }
  return { byLabel, skipped };
}

export async function updateMasterSheetRow(
  input: UpdateMasterSheetRowInput,
): Promise<UpdateMasterSheetRowResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'master sheet env not configured' };
  }

  const labels = Object.keys(input.cells);
  if (labels.length === 0) return { updated: 0, reason: 'no cells to write' };

  const we = input.workEmail?.trim().toLowerCase() || null;
  const pe = input.personalEmail?.trim().toLowerCase() || null;
  if (!we && !pe) return { updated: 0, reason: 'no email to match' };
  const matchDept = input.matchDepartment?.trim().toLowerCase() || null;

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

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? ''));
  const headersNorm = headers.map((h) => norm(h));
  const workCol = headersNorm.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headersNorm.findIndex((h) => h === 'personal email' || h === 'personalemail');
  const deptCol = headersNorm.findIndex((h) => h === 'department');

  const { byLabel, skipped } = resolveColumns(headers, labels);
  if (byLabel.size === 0) return { updated: 0, reason: 'no matching columns in sheet', skipped };

  // Find the row(s) matching the identity. Work email is the canonical key, so
  // when it's present we match ONLY on it — personal email is a fallback used
  // solely when there's no work email (personal email is NOT unique here, so an
  // OR would let a bystander who shares the same personal email get clobbered).
  // Optionally require the current department (disambiguates multi-dept people).
  const matched: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    const rowDept = deptCol >= 0 ? norm(row[deptCol]) : '';
    const emailMatch = we ? rowWork === we : !!pe && rowPersonal === pe;
    if (!emailMatch) continue;
    if (matchDept && rowDept !== matchDept) continue;
    matched.push(i);
  }
  if (matched.length === 0) return { updated: 0, reason: 'no matching row in sheet', skipped };

  // Build one batch write across every resolved cell of every matched row.
  const data: Array<{ range: string; values: string[][] }> = [];
  const dateCells: Array<{ row: number; col: number }> = [];
  for (const rowIdx of matched) {
    for (const [label, col] of byLabel) {
      const raw = input.cells[label];
      const isDate = DATE_LABELS.has(norm(label));
      const value = raw == null ? '' : isDate ? toSheetDate(raw) : sheetSafeText(String(raw));
      data.push({ range: `${quotedTab}!${colLetter(col)}${rowIdx + 1}`, values: [[value]] });
      if (isDate) dateCells.push({ row: rowIdx, col });
    }
  }

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

  // Pin any date cells to mm/dd/yy display so they match the column. Best-effort.
  if (dateCells.length > 0) {
    try {
      const { formatCellsAsShortDate } = await import('./format-date-cells');
      await formatCellsAsShortDate(dateCells);
    } catch {
      // cosmetic only — the value itself is a valid date
    }
  }

  return { updated: matched.length, skipped: skipped.length ? skipped : undefined };
}
