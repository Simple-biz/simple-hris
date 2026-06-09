import { getServiceAccountAccessToken } from './auth';

/**
 * Applies a `mm/dd/yy` DATE number-format to specific cells of the master Sheet
 * tab, so app-written Start Dates display like the rest of the column
 * ("06/08/26") instead of the spreadsheet's automatic date format. Newly
 * appended rows inherit no column format, so the value alone would render as
 * `2026-06-10` / `6/10/2026`; this pins the display.
 *
 * Best-effort: returns silently if env/tab/metadata can't be resolved. The
 * value itself is still a real date regardless of whether this succeeds.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SpreadsheetMetadata {
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  error?: { code?: number; message?: string };
}

/**
 * @param cells 0-based {row, col} grid coordinates within the tab.
 */
export async function formatCellsAsShortDate(
  cells: Array<{ row: number; col: number }>,
): Promise<void> {
  if (cells.length === 0) return;
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) return;

  const token = await getServiceAccountAccessToken(WRITE_SCOPE);
  const authHeader = { Authorization: `Bearer ${token}` };

  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
  const metaRes = await fetch(metaUrl, { headers: authHeader, cache: 'no-store' });
  const metaJson = (await metaRes.json()) as SpreadsheetMetadata;
  if (!metaRes.ok) return;
  const tabMeta = metaJson.sheets?.find(
    (s) => s.properties?.title?.trim().toLowerCase() === tabName.trim().toLowerCase(),
  );
  const numericSheetId = tabMeta?.properties?.sheetId;
  if (numericSheetId === undefined) return;

  const requests = cells.map((c) => ({
    repeatCell: {
      range: {
        sheetId: numericSheetId,
        startRowIndex: c.row,
        endRowIndex: c.row + 1,
        startColumnIndex: c.col,
        endColumnIndex: c.col + 1,
      },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'mm/dd/yy' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  }));

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    cache: 'no-store',
  });
}
