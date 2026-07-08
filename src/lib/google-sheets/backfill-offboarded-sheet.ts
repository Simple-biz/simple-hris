import { getServiceAccountAccessToken } from './auth';
import { fieldForHeader, formatOffboardDate, type FieldKey } from './append-offboarded-sheet';

/**
 * One-off backfill for the Google Sheet "Offboarded" tab.
 *
 * Older offboards (and the manual-fix backlog) left the Location / Contact
 * Number / Start Date / Offboard Reason / Offboarded Date columns blank because
 * the append automation never populated them (see append-offboarded-sheet.ts).
 * This walks every data row, matches it to the master record via a caller-
 * supplied resolver (keyed on personal or work email), and fills ONLY the blank
 * target cells — anything a human already typed is left untouched.
 *
 * Column detection reuses `fieldForHeader` from the append module so the writer
 * and the backfill can never disagree about which header is which.
 *
 * Best-effort by contract; pass `dryRun` to preview the exact cell writes
 * without mutating the sheet.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Only these fields are backfilled — the rest of the row (name, dept, emails) is
// either the match key or already present, and note/by are not on this sheet.
const BACKFILL_FIELDS = new Set<FieldKey>([
  'location',
  'phone',
  'start_date',
  'off_boarded_at',
  'reason',
]);

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

/** What the master knows about one offboarded person. `reasonLabel` is already
 *  mapped to the sheet's dropdown label; `offBoardedAt` is an ISO timestamp. */
export interface OffboardedMasterRecord {
  location: string | null;
  phone: string | null;
  startDate: string | null;
  reasonLabel: string | null;
  offBoardedAt: string | null;
}

/** Resolve a sheet row (personal + work email, both lowercased) to its master
 *  record, or null if the person isn't found. */
export type MasterResolver = (
  personalEmail: string,
  workEmail: string,
) => OffboardedMasterRecord | null;

export interface BackfillCellChange {
  /** 1-based sheet row number (what you see in the row gutter). */
  row: number;
  field: FieldKey;
  value: string;
  /** A1 range of the target cell, e.g. `'Offboarded'!H12`. */
  a1: string;
}

export interface BackfillOffboardedResult {
  dryRun: boolean;
  scannedRows: number;
  matchedRows: number;
  filledCells: number;
  byField: Partial<Record<FieldKey, number>>;
  /** Personal emails (or work emails) present on the sheet with no master match. */
  unmatched: string[];
  /** Every staged cell write (also returned on a real run, for the audit trail). */
  changes: BackfillCellChange[];
}

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map((c) => norm(c));
    if (row.some((c) => c === 'personal email' || c === 'personalemail' || c === 'personal_email')) {
      return i;
    }
  }
  return -1;
}

/** 0-based column index → A1 letter (0→A, 25→Z, 26→AA). */
function columnLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function valueForField(field: FieldKey, rec: OffboardedMasterRecord): string {
  switch (field) {
    case 'location':
      return rec.location ?? '';
    case 'phone':
      return rec.phone ?? '';
    case 'start_date':
      return rec.startDate ?? '';
    case 'off_boarded_at':
      return formatOffboardDate(rec.offBoardedAt);
    case 'reason':
      return rec.reasonLabel ?? '';
    default:
      return '';
  }
}

export async function backfillOffboardedSheet(
  resolve: MasterResolver,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillOffboardedResult> {
  const dryRun = opts.dryRun ?? false;
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_OFFBOARDED_TAB_NAME?.trim() || 'Offboarded';
  if (!sheetId) {
    throw new Error('GOOGLE_SHEETS_MASTER_SHEET_ID not configured');
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
    throw new Error(`Sheets read failed (${getRes.status}): ${getJson.error?.message ?? getRes.statusText}`);
  }

  const values = Array.isArray(getJson.values) ? getJson.values : [];
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) {
    throw new Error(`Could not find header row in Offboarded tab "${tabName}" (need a "Personal Email" column).`);
  }

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? ''));

  // Map each column index to the field it holds (only the ones we care about).
  const colToField = new Map<number, FieldKey>();
  let personalCol = -1;
  let workCol = -1;
  headers.forEach((h, idx) => {
    const field = fieldForHeader(h);
    if (!field) return;
    if (field === 'personal_email') personalCol = idx;
    else if (field === 'work_email') workCol = idx;
    else if (BACKFILL_FIELDS.has(field)) colToField.set(idx, field);
  });

  if (personalCol < 0 && workCol < 0) {
    throw new Error('Offboarded tab has neither a Personal Email nor a Work Email column to match on.');
  }

  const changes: BackfillCellChange[] = [];
  const byField: Partial<Record<FieldKey, number>> = {};
  const unmatched = new Set<string>();
  let scannedRows = 0;
  let matchedRows = 0;

  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (row.every((c) => String(c ?? '').trim() === '')) continue; // skip fully blank rows

    const personal = personalCol >= 0 ? norm(row[personalCol]) : '';
    const work = workCol >= 0 ? norm(row[workCol]) : '';
    if (!personal && !work) continue;
    scannedRows += 1;

    const rec = resolve(personal, work);
    if (!rec) {
      unmatched.add(personal || work);
      continue;
    }
    matchedRows += 1;

    for (const [colIdx, field] of colToField) {
      const existing = String(row[colIdx] ?? '').trim();
      if (existing !== '') continue; // never clobber a value already in the sheet
      const value = valueForField(field, rec);
      if (!value) continue; // master has nothing to offer for this cell
      changes.push({
        row: i + 1,
        field,
        value,
        a1: `${quotedTab}!${columnLetter(colIdx)}${i + 1}`,
      });
      byField[field] = (byField[field] ?? 0) + 1;
    }
  }

  if (!dryRun && changes.length > 0) {
    // One per-cell A1 range each. valueInputOption=USER_ENTERED so Sheets parses
    // dates/labels the same way the append path does.
    const data = changes.map((c) => ({ range: c.a1, values: [[c.value]] }));

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
    const batchRes = await fetch(batchUrl, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      cache: 'no-store',
    });
    if (!batchRes.ok) {
      const txt = await batchRes.text().catch(() => '');
      throw new Error(`Sheets batchUpdate failed (${batchRes.status}): ${txt.slice(0, 300)}`);
    }
  }

  return {
    dryRun,
    scannedRows,
    matchedRows,
    filledCells: changes.length,
    byField,
    unmatched: [...unmatched],
    changes,
  };
}
