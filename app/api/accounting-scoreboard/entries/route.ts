import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
  writeEntry,
} from '@/lib/accounting-scoreboard/server';
import { parseEntryWrite } from '@/lib/accounting-scoreboard/validate';
import { todayEastern } from '@/lib/accounting-scoreboard/week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PUT /api/accounting-scoreboard/entries  { rowId, date, slot, value | null }
 *
 * Set or clear one cell. `value: null` deletes the entry; a 0 is a real count. Any member may
 * edit any cell, as on the sheet, and each write is stamped with the SESSION email. Refused: a
 * future date, a slot the row's section does not have, a day that section does not keep, an
 * archived row, and a row of an archived custom section. Chargeback Outcomes takes `usd` (dollars
 * and cents) and `count` (a whole number); Payroll Problems takes nothing here (its log does).
 */
export async function PUT(req: Request) {
  try {
    const access = await resolveAccess('edit_cells');
    if (!access.ok) return failureResponse(access);
    const parsed = parseEntryWrite(await readJson(req), todayEastern());
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await writeEntry(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ entry: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
