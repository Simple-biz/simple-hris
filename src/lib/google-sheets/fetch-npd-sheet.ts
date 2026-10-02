import { getServiceAccountAccessToken } from './auth';
import { GOOGLE_SHEET_TABS, type GoogleSheetGrids } from '../npd/google-sheet-import';
import type { NpdSheetKind } from '../npd/columns';

/**
 * READ-ONLY: one tab of the Google Sheet NPD replaces, three ways (formula text,
 * exact values, displayed text), for NPD's Google Sheet sync
 * (src/lib/npd/google-sheet-import.ts, docs/features/npd-dashboard.md § Google Sheet sync).
 *
 *  - All Departments ← the spreadsheet the Payroll Wizard's "All Dept Payroll CSV"
 *    button read before it moved to NPD (2026-10-02): GOOGLE_SHEETS_RATES_SHEET_ID,
 *    tab GOOGLE_SHEETS_RATES_TAB_NAME (default "All Dept").
 *  - HSL ← the sheet Kane named for it, 2026-10-02: "we will use this sheet for HSL -
 *    https://docs.google.com/spreadsheets/d/1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4/edit?gid=406220700".
 *    PINNED here, and the tab is found by its gid (406220700, titled "Hogan" on
 *    2026-10-02), so a rename or an env change cannot point it at another sheet.
 *
 * Scope `spreadsheets.readonly`: nothing here can write to the sheet. The rates
 * route that also reads GOOGLE_SHEETS_RATES_* stays DISABLED (rates belong to the
 * Payment Catalog); this reads the sheet into NPD only.
 */

export const HSL_SOURCE = { spreadsheetId: '1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4', gid: 406220700 } as const;

export class NpdSheetNotConfiguredError extends Error {}

type Source = { spreadsheetId: string } & ({ tab: string; gid?: undefined } | { gid: number; tab?: undefined });

export function npdSheetSource(sheet: NpdSheetKind): Source {
  if (sheet === 'hsl') return { spreadsheetId: HSL_SOURCE.spreadsheetId, gid: HSL_SOURCE.gid };
  const spreadsheetId = process.env.GOOGLE_SHEETS_RATES_SHEET_ID?.trim();
  if (!spreadsheetId) {
    throw new NpdSheetNotConfiguredError(
      'The All Dept Google Sheet is not configured: GOOGLE_SHEETS_RATES_SHEET_ID is not set on this server.',
    );
  }
  return { spreadsheetId, tab: process.env.GOOGLE_SHEETS_RATES_TAB_NAME?.trim() || GOOGLE_SHEET_TABS.all_departments.title };
}

type ValuesResponse = { values?: unknown[][]; error?: { message?: string } };
type MetaResponse = { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>; error?: { message?: string } };

const FETCH_TIMEOUT_MS = 60_000;

async function getJson<T extends { error?: { message?: string } }>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`Google Sheets could not be read (${res.status}): ${json.error?.message ?? res.statusText}`);
  return json;
}

/** The tab's title for a gid: the values API addresses tabs by title only. */
async function titleForGid(spreadsheetId: string, gid: number, token: string): Promise<string> {
  const meta = await getJson<MetaResponse>(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    token,
  );
  const title = meta.sheets?.find((s) => s.properties?.sheetId === gid)?.properties?.title;
  if (!title) throw new Error(`The Google Sheet has no tab with gid ${gid} any more. Nothing was loaded.`);
  return title;
}

export async function fetchNpdSheetGrids(sheet: NpdSheetKind): Promise<{ tab: string; grids: GoogleSheetGrids }> {
  const source = npdSheetSource(sheet);
  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const tab = source.gid !== undefined ? await titleForGid(source.spreadsheetId, source.gid, token) : source.tab;
  // From A1 so row index + 1 is the sheet's row number (the formula patterns use it);
  // open-ended rows, because the tabs grow every week.
  const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A1:CZ`);
  const read = async (render: 'FORMULA' | 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE'): Promise<unknown[][]> => {
    const json = await getJson<ValuesResponse>(
      `https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}/values/${range}` +
        `?valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`,
      token,
    );
    return Array.isArray(json.values) ? json.values : [];
  };
  const [formulas, values, formatted] = await Promise.all([read('FORMULA'), read('UNFORMATTED_VALUE'), read('FORMATTED_VALUE')]);
  return { tab, grids: { formulas, values, formatted } };
}
