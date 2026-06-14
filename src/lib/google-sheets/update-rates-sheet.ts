import { getServiceAccountAccessToken } from './auth';

/**
 * Updates the Regular Rate and OT Rate cells for an existing employee row in
 * the "All Dept" Google Sheet rates tab, matched by Work Email.
 *
 * Called when an individual pay structure is saved via Payment Catalog so the
 * negotiated rate is the source of truth in the Sheet too. Department-level
 * pay structures do NOT call this -- they are the onboarding default only and
 * should not overwrite existing per-employee rows.
 *
 * Best-effort by contract: returns { updated: 0, reason } when env is not
 * configured, column is missing, or no matching row is found. Callers should
 * NOT fail the catalog save on this.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateRatesSheetResult = {
  updated: number;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function normHeader(v: unknown): string {
  return norm(v).replace(/\s+/g, ' ');
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

function findHeaderRowIndex(values: unknown[][]): number {
  for (let i = 0; i < values.length; i++) {
    const row = (values[i] ?? []).map(normHeader);
    const hasWorkEmail = row.some((c) => c === 'work email' || c === 'workemail');
    const hasRegular = row.some(
      (c) => c === 'regular rate' || c === 'regular_rate' || c === 'regularrate',
    );
    if (hasWorkEmail && hasRegular) return i;
  }
  return -1;
}

export async function updateEmployeeRateInSheet(args: {
  workEmail: string;
  regularRate: number;
  otRate?: number | null;
}): Promise<UpdateRatesSheetResult> {
  const sheetId = process.env.GOOGLE_SHEETS_RATES_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_RATES_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'rates sheet env not configured' };
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
      `Rates sheet read failed (${getRes.status}): ${getJson.error?.message ?? getRes.statusText}`,
    );
  }

  const values = Array.isArray(getJson.values) ? getJson.values : [];
  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) return { updated: 0, reason: 'header row not found in rates sheet' };

  const headers = (values[headerIdx] ?? []).map(normHeader);
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const regCol = headers.findIndex(
    (h) => h === 'regular rate' || h === 'regular_rate' || h === 'regularrate',
  );
  const otCol = headers.findIndex(
    (h) => h === 'ot rate' || h === 'ot_rate' || h === 'otrate' || h === 'ot rate',
  );

  if (workCol < 0) return { updated: 0, reason: 'Work Email column not found' };
  if (regCol < 0) return { updated: 0, reason: 'Regular Rate column not found' };

  const target = norm(args.workEmail);
  const matchedRows: number[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (workCol >= 0 && norm(row[workCol]) === target) matchedRows.push(i);
  }
  if (matchedRows.length === 0) return { updated: 0, reason: 'employee not found in rates sheet' };

  // Build batchUpdate data: always update Regular Rate; update OT Rate only if
  // the column exists and a value was provided.
  const data: Array<{ range: string; values: unknown[][] }> = [];
  for (const rowIdx of matchedRows) {
    const sheetRow = rowIdx + 1; // 1-based
    data.push({
      range: `${quotedTab}!${colLetter(regCol)}${sheetRow}`,
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
    throw new Error(`Rates sheet batch write failed (${batchRes.status}): ${txt.slice(0, 200)}`);
  }

  return { updated: matchedRows.length };
}
