import { getServiceAccountAccessToken } from './auth';

/**
 * Appends a single row to the Google Sheet "Offboarded" tab when HR offboards
 * someone in-app, so the row persists through the next sync-offboarded-from-sheet
 * cron (which TRUNCATE+INSERTs offboarded_sheet from the sheet).
 *
 * Column matching mirrors the flexible header detection in fetch-offboarded-sheet.ts.
 * Unknown columns are left blank. Best-effort — callers should not fail the
 * offboard if this throws.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type AppendOffboardedRowInput = {
  personalEmail: string;
  workEmail?: string | null;
  name?: string | null;
  department?: string | null;
  location?: string | null;
  phoneNumber?: string | null;
  startDate?: string | null;
  offBoardedAt?: string | null;
  offBoardedReason?: string | null;
  offBoardedNote?: string | null;
  offBoardedBy?: string | null;
};

export type AppendOffboardedRowResult = {
  appended: boolean;
  reason?: string;
};

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

/**
 * Which input field feeds each recognised header. The alias lists MIRROR the
 * flexible header detection in fetch-offboarded-sheet.ts so the writer and the
 * reader can never drift out of sync — anything the reader can parse back, the
 * writer knows how to populate. `location`/`phone`/`start_date` are extra
 * columns this sheet carries that the reader ignores but HR still expects filled.
 * Matching is exact after norm() (trim + lowercase); keep it exact so a broad
 * alias like "email" can't swallow a column it wasn't meant to.
 */
export type FieldKey =
  | 'personal_email'
  | 'work_email'
  | 'name'
  | 'department'
  | 'location'
  | 'phone'
  | 'start_date'
  | 'off_boarded_at'
  | 'reason'
  | 'note'
  | 'by';

export const HEADER_ALIASES: Record<FieldKey, string[]> = {
  personal_email: ['personal email', 'personalemail', 'personal_email'],
  work_email: ['work email', 'workemail', 'work_email', 'email'],
  name: ['name', 'full name'],
  department: ['department', 'dept'],
  location: [
    'location', 'address', 'home address', 'current address', 'full address',
    'city', 'city, province', 'address / location', 'address/location',
  ],
  phone: [
    'phone', 'phone number', 'phone_number', 'contact', 'contact number',
    'mobile', 'mobile number', 'cell', 'cellphone', 'cell phone',
  ],
  start_date: [
    'start date', 'startdate', 'start_date', 'date started', 'date of start',
    'hire date', 'date hired', 'joined', 'date joined',
  ],
  off_boarded_at: [
    'off-boarded at', 'off_boarded_at', 'offboarded at',
    'off-boarded date', 'offboarded date', 'date offboarded',
    'date of offboarding', 'offboarding date', 'date of off-boarding',
    'date', 'end date', 'exit date', 'termination date',
  ],
  reason: [
    'offboard reason', 'offboard-reason', 'offboardreason',
    'off-boarded reason', 'offboarded reason',
    'reason for offboarding', 'reason for off-boarding', 'offboarding reason',
    'reason', 'off_boarded_reason', 'offboard_reason',
  ],
  note: ['note', 'notes', 'off-boarded note', 'off_boarded_note'],
  by: ['by', 'off-boarded by', 'off_boarded_by'],
};

// Reverse index: normalized alias → field. Built once at module load.
const HEADER_TO_FIELD = new Map<string, FieldKey>();
for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[FieldKey, string[]]>) {
  for (const alias of aliases) HEADER_TO_FIELD.set(alias, field);
}

/** Which offboarded-sheet field a header cell feeds, or undefined if unrecognised.
 *  Shared with the backfill so the two agree on column detection. */
export function fieldForHeader(header: string): FieldKey | undefined {
  return HEADER_TO_FIELD.get(norm(header));
}

/** Format an ISO timestamp the way the Offboarded "Date" column expects. Written
 *  with valueInputOption=USER_ENTERED so Sheets re-parses it into the cell's own
 *  date format. Exported for reuse by the backfill. */
export function formatOffboardDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function valueForHeader(header: string, input: AppendOffboardedRowInput): string {
  const field = fieldForHeader(header);
  switch (field) {
    case 'personal_email':
      return input.personalEmail ?? '';
    case 'work_email':
      return input.workEmail ?? '';
    case 'name':
      return input.name ?? '';
    case 'department':
      return input.department ?? '';
    case 'location':
      return input.location ?? '';
    case 'phone':
      return input.phoneNumber ?? '';
    case 'start_date':
      return input.startDate ?? '';
    case 'off_boarded_at':
      return formatOffboardDate(input.offBoardedAt);
    case 'reason':
      return input.offBoardedReason ?? '';
    case 'note':
      return input.offBoardedNote ?? '';
    case 'by':
      return input.offBoardedBy ?? '';
    default:
      return '';
  }
}

export async function appendOffboardedSheetRow(
  input: AppendOffboardedRowInput,
): Promise<AppendOffboardedRowResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_OFFBOARDED_TAB_NAME?.trim() || 'Offboarded';
  if (!sheetId) {
    return { appended: false, reason: 'GOOGLE_SHEETS_MASTER_SHEET_ID not configured' };
  }

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const quotedTab = `'${tabName.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(quotedTab);
  const authHeader = { Authorization: `Bearer ${token}` };

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
      `Could not find header row in Offboarded tab "${tabName}" (need a "Personal Email" column).`,
    );
  }

  const headers = (values[headerIdx] ?? []).map((c) => String(c ?? ''));
  const newRow = headers.map((h) => valueForHeader(h, input));

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(appendUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [newRow] }),
    cache: 'no-store',
  });
  if (!appendRes.ok) {
    const txt = await appendRes.text().catch(() => '');
    throw new Error(`Sheets append failed (${appendRes.status}): ${txt.slice(0, 200)}`);
  }

  return { appended: true };
}
