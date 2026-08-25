import { getServiceAccountAccessToken } from './auth';

/**
 * Writes an approved department transfer back into the master Google Sheet.
 *
 * The Sheet is the source of truth for the roster; the master-list sync keys
 * identity on (Work Email, Department), so an approved transfer that changed the
 * dept only in Supabase would be reverted (or duplicated) on the next sync unless
 * the Sheet is updated too. This flips the "Department" cell on the matching row
 * in place.
 *
 * Matching mirrors applyDepartmentTransfer: the row must match the employee by
 * work OR personal email AND currently sit in `fromDepartment`, so a person who
 * holds rows in multiple departments only has the source row moved.
 *
 * Best-effort by contract — callers should record the outcome (sheet_synced /
 * sheet_sync_error) but not block the transfer if this fails.
 */

const WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface SheetsValuesResponse {
  values?: unknown[][];
  error?: { code?: number; message?: string };
}

export type UpdateMasterSheetDepartmentInput = {
  personalEmail: string | null;
  workEmail?: string | null;
  fromDepartment: string;
  toDepartment: string;
};

export type UpdateMasterSheetDepartmentResult = {
  updated: number;
  reason?: string;
  /** The Sheet already reads `toDepartment` on an email-matched row, so there is
   *  nothing to flip and the Sheet is genuinely correct. Distinct from `updated:
   *  0` with no match, which means the Sheet DISAGREES and is real drift. */
  alreadyTarget?: boolean;
  /** An email-matched row exists at all. `false` means the person is not on the
   *  Sheet under either address — the Sheet cannot be reconciled by a cell flip. */
  matchedEmail?: boolean;
  /** Departments found on email-matched rows that are neither `from` nor `to` —
   *  the third-department case, which is drift a retry can never resolve. */
  otherDepartments?: string[];
};

/** What a Department write-back would do to a sheet, decided without any I/O.
 *  Pure so the three outcomes that `sheet_synced` used to conflate — flipped,
 *  already-correct, and drifted — can be pinned by tests. */
export type SheetDepartmentPlan = {
  headerIdx: number;
  /** A1 ranges of the Department cell on every row sitting in `from`. */
  cellRanges: string[];
  alreadyTarget: boolean;
  matchedEmail: boolean;
  otherDepartments: string[];
  reason?: string;
};

export function planSheetDepartmentUpdate(
  values: unknown[][],
  input: { workEmail: string | null; personalEmail: string | null; from: string; to: string; quotedTab: string },
): SheetDepartmentPlan {
  const { workEmail: we, personalEmail: pe, quotedTab } = input;
  const from = norm(input.from);
  const to = norm(input.to);
  const empty = { cellRanges: [], alreadyTarget: false, matchedEmail: false, otherDepartments: [] };

  const headerIdx = findHeaderRowIndex(values);
  if (headerIdx < 0) return { headerIdx, ...empty, reason: 'header row not found in sheet' };

  const headers = (values[headerIdx] ?? []).map((c) => norm(c));
  const deptCol = headers.findIndex((h) => h === 'department');
  const workCol = headers.findIndex((h) => h === 'work email' || h === 'workemail');
  const personalCol = headers.findIndex((h) => h === 'personal email' || h === 'personalemail');
  if (deptCol < 0) return { headerIdx, ...empty, reason: 'no Department column in sheet' };

  const deptLetter = columnToLetter(deptCol + 1);
  const cellRanges: string[] = [];
  const otherDepartments = new Set<string>();
  let alreadyTarget = false;
  let matchedEmail = false;

  for (let i = headerIdx + 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const rowWork = workCol >= 0 ? norm(row[workCol]) : '';
    const rowPersonal = personalCol >= 0 ? norm(row[personalCol]) : '';
    const rowDept = norm(row[deptCol]);
    if (!((we && rowWork === we) || (pe && rowPersonal === pe))) continue;
    matchedEmail = true;
    if (rowDept === from) {
      // Sheet rows are 1-based; `values` is 0-based.
      cellRanges.push(`${quotedTab}!${deptLetter}${i + 1}`);
    } else if (rowDept === to) {
      alreadyTarget = true;
    } else {
      otherDepartments.add(rowDept);
    }
  }

  return {
    headerIdx,
    cellRanges,
    alreadyTarget,
    matchedEmail,
    otherDepartments: [...otherDepartments],
    reason:
      cellRanges.length > 0 || alreadyTarget
        ? undefined
        : matchedEmail
          ? `sheet row is in "${[...otherDepartments].join('" / "')}" — neither the source nor the target department`
          : 'no matching row in source department',
  };
}

function norm(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Mirror of the master-sheet header detection: a row with Department + (Name or Personal Email). */
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

/** 1-based column number → A1 column letter (1→A, 27→AA). */
function columnToLetter(column: number): string {
  let temp: number;
  let letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

export async function updateMasterSheetDepartment(
  input: UpdateMasterSheetDepartmentInput,
): Promise<UpdateMasterSheetDepartmentResult> {
  const sheetId = process.env.GOOGLE_SHEETS_MASTER_SHEET_ID?.trim();
  const tabName = process.env.GOOGLE_SHEETS_MASTER_TAB_NAME?.trim();
  if (!sheetId || !tabName) {
    return { updated: 0, reason: 'master sheet env not configured' };
  }

  const to = input.toDepartment.trim();
  const from = input.fromDepartment.trim().toLowerCase();
  if (!to) return { updated: 0, reason: 'target department is required' };

  const pe = input.personalEmail?.trim().toLowerCase() || null;
  const we = input.workEmail?.trim().toLowerCase() || null;
  if (!pe && !we) return { updated: 0, reason: 'no email to match' };

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
  const plan = planSheetDepartmentUpdate(values, {
    workEmail: we,
    personalEmail: pe,
    from,
    to,
    quotedTab,
  });
  const { cellRanges, alreadyTarget, matchedEmail, otherDepartments } = plan;

  if (cellRanges.length === 0) {
    // No source-dept cell to flip. `alreadyTarget` is the only outcome that means
    // the Sheet is CORRECT; every other zero-write outcome is real drift and must
    // be reported as such, never as a success (see apply-transfer.ts).
    return {
      updated: 0,
      alreadyTarget,
      matchedEmail,
      otherDepartments,
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
  }

  const batchUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: cellRanges.map((r) => ({ range: r, values: [[to]] })),
    }),
    cache: 'no-store',
  });
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '');
    throw new Error(`Sheets batchUpdate failed (${batchRes.status}): ${txt.slice(0, 300)}`);
  }

  return { updated: cellRanges.length, alreadyTarget, matchedEmail, otherDepartments };
}
