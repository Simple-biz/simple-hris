import { getServiceAccountAccessToken } from './auth';

/**
 * Updates the Hourly Rate and OT rate cells for an existing agent row in the
 * "Hogan Agents Pay Plan" Google Sheet (HOGAN SMITH AGENT PAY PLAN), matched by
 * Email.
 *
 * Called when an INDIVIDUAL Hogan pay structure is saved via Payment Catalog so
 * the negotiated rate stays in sync in the Pay Plan sheet too. By contract this
 * is a SURGICAL write: it touches only the Hourly Rate (always) and OT rate
 * (when present) cells of matched rows. It never adds or deletes rows and never
 * touches the hand-curated KPI/Bonus, Scoreboard, Notes, HSL Name, or Role
 * columns. Employees not present in the sheet are skipped.
 *
 * Department-level structures do NOT call this (they are the onboarding default
 * only). See app/api/payment-catalog/pay-structures/route.ts.
 *
 * Best-effort by contract: returns { updated: 0, reason } when env is not
 * configured, a required column is missing, or no matching row is found.
 * Callers should NOT fail the catalog save on this.
 *
 * Required env (shared with the read-side fetcher in fetch-hsl-sheet.ts):
 *   - GOOGLE_SHEETS_HSL_SHEET_ID
 *   - GOOGLE_SHEETS_HSL_TAB_NAME
 *   - GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateHslPayPlanResult = {
  updated: number;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Strip everything but a-z0-9 for tolerant header matching ("OT rate" -> "otrate"). */
function normHeader(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function colLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const EMAIL_HEADERS = ['email', 'workemail'];
const HOURLY_HEADERS = ['hourlyrate', 'regularrate', 'hourly'];
const OT_HEADERS = ['otrate', 'overtimerate', 'ot'];
const NAME_OR_DEPT_HEADERS = ['departmentrole', 'department', 'role', 'fullname', 'name'];

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map(normHeader);
    const hasEmail = row.some((c) => EMAIL_HEADERS.includes(c));
    const hasRateOrDept =
      row.some((c) => HOURLY_HEADERS.includes(c)) ||
      row.some((c) => NAME_OR_DEPT_HEADERS.includes(c));
    if (hasEmail && hasRateOrDept) return i;
  }
  return -1;
}

export async function updateHslPayPlanRate(args: {
  workEmail: string;
  regularRate: number;
  otRate?: number | null;
}): Promise<UpdateHslPayPlanResult> {
  const sheetId = process.env.GOOGLE_SHEETS_HSL_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_HSL_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'HSL pay plan sheet env not configured' };
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
    throw new Error(
      `HSL pay plan read failed (${getRes.status}): ${getJson.error?.message ?? getRes.statusText}`,
    );
  }

  const values = Array.isArray(getJson.values) ? getJson.values : [];
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) return { updated: 0, reason: 'header row not found in HSL pay plan sheet' };

  const headers = (values[headerIdx] ?? []).map(normHeader);
  const emailCol = headers.findIndex((h) => EMAIL_HEADERS.includes(h));
  const hourlyCol = headers.findIndex((h) => HOURLY_HEADERS.includes(h));
  const otCol = headers.findIndex((h) => OT_HEADERS.includes(h));

  if (emailCol < 0) return { updated: 0, reason: 'Email column not found' };
  if (hourlyCol < 0) return { updated: 0, reason: 'Hourly Rate column not found' };

  const target = norm(args.workEmail);
  const matchedRows: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (norm(row[emailCol]) === target) matchedRows.push(i);
  }
  if (matchedRows.length === 0) return { updated: 0, reason: 'agent not found in HSL pay plan sheet' };

  // Surgical: only Hourly Rate (always) + OT rate (when a column + value exist).
  // USER_ENTERED keeps each cell's existing currency number format intact.
  const data: Array<{ range: string; values: unknown[][] }> = [];
  for (const rowIdx of matchedRows) {
    const sheetRow = rowIdx + 1; // 1-based
    data.push({
      range: `${quotedTab}!${colLetter(hourlyCol)}${sheetRow}`,
      values: [[args.regularRate]],
    });
    if (otCol >= 0 && args.otRate != null) {
      data.push({
        range: `${quotedTab}!${colLetter(otCol)}${sheetRow}`,
        values: [[args.otRate]],
      });
    }
  }

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    cache: 'no-store',
  });
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '');
    throw new Error(`HSL pay plan batch write failed (${batchRes.status}): ${txt.slice(0, 200)}`);
  }

  return { updated: matchedRows.length };
}
