/**
 * HRIS vs NPD — the NPD side read from NPD's own LOCKED sheets.
 *
 * Kane, 2026-10-02: "once the values from NPD are both locked from ALL DEPT AND HSL - The
 * values from there will automatically feed here in the validation step and will show us the
 * mismatch and all those people that aren't in each other's list". So when Accounting → NPD
 * has BOTH tabs (All Departments and HSL) locked in for the wizard's week, the Validation
 * step's HRIS vs NPD tab takes its NPD figures from those two locked sheets instead of a paste.
 *
 * PURE: no React, no fetch, no Supabase. The route reads the sheets and hands them in; the
 * browser parses what comes back; the save route rebuilds it to prove it.
 *
 * THE RULES (docs/features/payroll-wizard-hris-vs-npd.md § NPD's locked sheets feed the step)
 * -------------------------------------------------------------------------------------------
 * 1. **The feed IS a paste.** The two sheets become one tab-separated text, one line per
 *    non-blank NPD row: `<tab> row <n>`, the Work Email cell, the PHP USD Conversion cell,
 *    exactly as stored. That text goes through `parseNpdPaste`, unchanged — so the step's
 *    paste contract applies to it word for word (npd-dashboard.md § Not connected, "the
 *    dollar column must be parsed and refused exactly as that step's paste contract says"):
 *    ₱ refused, `#VALUE!` refused, a blank dollar cell refused, every refusal listed with the
 *    tab and row it came from. The same text is what Save output stores and re-derives.
 * 2. **Only the Work Email column is the key** (Kane, 2026-09-30: "we are connecting this to
 *    the work email"). Name, personal address and every other column are not read.
 * 3. **The dollar column is PHP USD Conversion**, the column a paste ends at (the sheet's
 *    `=AU*rate`). Total Pay US Workers is NOT compared and never added to it; the feed counts
 *    the rows that carry it (`usWorkersRows`) so the step can say so.
 * 4. **A blank row is not data** (`isBlankRow`, NPD's own rule) and is skipped; its position
 *    still counts, so "row 12" is the grid's row 12. Every other row is a line, and a line
 *    with no work email is refused, never dropped.
 * 5. **The first line is a signature** naming the NPD week and the version of each locked
 *    sheet. It has no email, so the parser skips it as the header, and the save route reads it
 *    back to rebuild the text from the sheets and refuse a save that no longer matches them.
 * 6. **A cell can never break the line structure.** A tab inside a cell becomes `⇥` and a line
 *    break `⏎`, so a cell stays one cell and the parser refuses it rather than reading half of
 *    it. (A space would not do: `parseUsdCell` strips spaces, so "$1⏎00" must not become "$100".)
 */

import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';
import { NPD_COLUMNS, NPD_SHEETS, NPD_SHEET_LABELS, type NpdSheetKind } from '@/lib/npd/columns';
import { isBlankRow, isSundayIso, type NpdRow } from '@/lib/npd/sheet';

/** The NPD column read as each person's key. */
export const NPD_FEED_EMAIL_KEY = 'work_email';
/** The NPD column read as each person's dollar figure (rule 3). */
export const NPD_FEED_USD_KEY = 'php_usd_conversion';
/** Counted, never compared (rule 3). */
export const NPD_FEED_US_WORKERS_KEY = 'total_pay_us_workers';

/** How often the open tab checks NPD's lock again (only while visible). Each check is two
 *  header reads once the feed is held (`known`), so it can be frequent without cost. */
export const NPD_FEED_RECHECK_MS = 60_000;

/** How every feed text starts (rule 5). A hand paste never begins with this. */
export const NPD_FEED_SIGNATURE_PREFIX = 'NPD locked sheets, week ';

function columnIndex(sheet: NpdSheetKind, key: string): number {
  const i = NPD_COLUMNS[sheet].findIndex((c) => c.key === key);
  if (i < 0) throw new Error(`NPD ${sheet} has no ${key} column`);
  return i;
}

/** Rule 6: one cell stays one cell. */
function neutralCell(v: string): string {
  return v.replace(/\t/g, '⇥').replace(/\r\n|\r|\n/g, '⏎');
}

export function npdFeedSignature(week: string, versions: Readonly<Record<NpdSheetKind, number>>): string {
  return `${NPD_FEED_SIGNATURE_PREFIX}${week}: ${NPD_SHEETS.map((s) => `${NPD_SHEET_LABELS[s]} v${versions[s]}`).join(', ')}`;
}

/** The line label a row's refusal is shown with: "All Departments row 12". */
export function npdFeedRowLabel(sheet: NpdSheetKind, rowNo: number): string {
  return `${NPD_SHEET_LABELS[sheet]} row ${rowNo}`;
}

export interface NpdFeedSheetInput {
  version: number;
  rows: readonly NpdRow[];
}

export interface NpdFeedBuild {
  /** The paste the step parses and Save output stores. */
  text: string;
  /** Lines contributed by each tab (non-blank rows). */
  linesBySheet: Record<NpdSheetKind, number>;
  /** Rows (both tabs) with Total Pay US Workers filled: not compared (rule 3). */
  usWorkersRows: number;
}

/** Both locked sheets → the feed text (rules 1–6). All Departments first, then HSL, each in grid order. */
export function buildNpdFeedText(input: {
  week: string;
  sheets: Readonly<Record<NpdSheetKind, NpdFeedSheetInput>>;
}): NpdFeedBuild {
  const versions = { all_departments: input.sheets.all_departments.version, hsl: input.sheets.hsl.version };
  const lines: string[] = [
    `${npdFeedSignature(input.week, versions)}\tWork Email\tPHP USD Conversion`,
  ];
  const linesBySheet: Record<NpdSheetKind, number> = { all_departments: 0, hsl: 0 };
  let usWorkersRows = 0;
  for (const sheet of NPD_SHEETS) {
    const emailAt = columnIndex(sheet, NPD_FEED_EMAIL_KEY);
    const usdAt = columnIndex(sheet, NPD_FEED_USD_KEY);
    const usAt = columnIndex(sheet, NPD_FEED_US_WORKERS_KEY);
    input.sheets[sheet].rows.forEach((row, i) => {
      if (isBlankRow(row)) return;
      if ((row.values[usAt] ?? '').trim() !== '') usWorkersRows += 1;
      lines.push(
        [npdFeedRowLabel(sheet, i + 1), neutralCell(row.values[emailAt] ?? ''), neutralCell(row.values[usdAt] ?? '')].join('\t'),
      );
      linesBySheet[sheet] += 1;
    });
  }
  return { text: lines.join('\n'), linesBySheet, usWorkersRows };
}

/**
 * What a stored NPD text is: an ordinary paste, a feed (its week and versions), or something
 * that starts like a feed but is not one exactly — which the save route refuses rather than
 * treating as a paste.
 */
export type NpdFeedSignatureRead =
  | { kind: 'paste' }
  | { kind: 'feed'; week: string; versions: Record<NpdSheetKind, number> }
  | { kind: 'malformed' };

const SIGNATURE_RE = /^NPD locked sheets, week (\d{4}-\d{2}-\d{2}): All Departments v(\d{1,9}), HSL v(\d{1,9})\tWork Email\tPHP USD Conversion$/;

export function readNpdFeedSignature(text: string): NpdFeedSignatureRead {
  if (!text.startsWith(NPD_FEED_SIGNATURE_PREFIX)) return { kind: 'paste' };
  const first = text.split('\n', 1)[0] ?? '';
  const m = SIGNATURE_RE.exec(first);
  if (!m || !isSundayIso(m[1])) return { kind: 'malformed' };
  return { kind: 'feed', week: m[1]!, versions: { all_departments: Number(m[2]), hsl: Number(m[3]) } };
}

// ─── Which NPD week a wizard week is ──────────────────────────────────────────

/**
 * The wizard's week key (the Hubstaff filename) → NPD's week (that range's START, which must
 * be a Sunday). The same start `resolveCurrentWeek` / `weekKeyFromSourceFile` key on. A
 * filename with no range, or one that does not start on a Sunday, has NO NPD week: there is
 * no calendar fallback, because reading a guessed week would compare the wrong sheets.
 */
export function npdWeekForSourceFile(sourceFile: string): { ok: true; week: string } | { ok: false; reason: string } {
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range) return { ok: false, reason: `"${sourceFile}" names no date range, so there is no NPD week to read.` };
  const s = range.start;
  const week = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
  if (!isSundayIso(week)) {
    return { ok: false, reason: `"${sourceFile}" starts on ${week}, not a Sunday, so it matches no NPD week.` };
  }
  return { ok: true, week };
}

// ─── What the route returns, and how the browser reads it ────────────────────

/** One NPD tab for the week, as the step shows it. */
export type NpdFeedTabStatus =
  /** No sheet saved for that tab and week, or one with no rows. */
  | { state: 'none' }
  | { state: 'unlocked'; version: number; rowCount: number; updatedAt: string | null; updatedBy: string | null }
  | { state: 'locked'; version: number; rowCount: number; lockedAt: string; lockedBy: string | null };

export function npdFeedTabStatus(meta: {
  sheetId: string | null;
  version: number;
  rowCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
}): NpdFeedTabStatus {
  if (!meta.sheetId || meta.rowCount === 0) return { state: 'none' };
  if (meta.lockedAt) {
    return { state: 'locked', version: meta.version, rowCount: meta.rowCount, lockedAt: meta.lockedAt, lockedBy: meta.lockedBy };
  }
  return { state: 'unlocked', version: meta.version, rowCount: meta.rowCount, updatedAt: meta.updatedAt, updatedBy: meta.updatedBy };
}

/** The feed exists only when BOTH tabs are locked (Kane: "both locked from ALL DEPT AND HSL"). */
export function bothNpdTabsLocked(tabs: Readonly<Record<NpdSheetKind, NpdFeedTabStatus>>): boolean {
  return NPD_SHEETS.every((s) => tabs[s].state === 'locked');
}

export interface NpdFeedPayload {
  week: string;
  tabs: Record<NpdSheetKind, NpdFeedTabStatus>;
  /**
   * The feed, present ONLY when both tabs are locked. `'unchanged'` = the caller already holds
   * this exact feed (it sent the same versions in `known`, and both are still locked), so the
   * rows were not re-sent.
   */
  feed: null | 'unchanged' | ({ versions: Record<NpdSheetKind, number> } & NpdFeedBuild);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseTab(raw: unknown): NpdFeedTabStatus | null {
  if (!isObj(raw)) return null;
  if (raw.state === 'none') return { state: 'none' };
  if (!isCount(raw.version) || !isCount(raw.rowCount)) return null;
  if (raw.state === 'locked' && typeof raw.lockedAt === 'string' && raw.lockedAt && strOrNull(raw.lockedBy)) {
    return { state: 'locked', version: raw.version, rowCount: raw.rowCount, lockedAt: raw.lockedAt, lockedBy: raw.lockedBy };
  }
  if (raw.state === 'unlocked' && strOrNull(raw.updatedAt) && strOrNull(raw.updatedBy)) {
    return { state: 'unlocked', version: raw.version, rowCount: raw.rowCount, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy };
  }
  return null;
}

/**
 * The route's JSON → a payload, or null when it is not one. A bad payload is an ERROR on the
 * step, never "NPD is not locked": the step must not fall back to a paste on a reply it could
 * not read and call that the truth.
 */
export function parseNpdFeedPayload(raw: unknown): NpdFeedPayload | null {
  if (!isObj(raw) || !isSundayIso(raw.week) || !isObj(raw.tabs)) return null;
  const all = parseTab(raw.tabs.all_departments);
  const hsl = parseTab(raw.tabs.hsl);
  if (!all || !hsl) return null;
  const tabs = { all_departments: all, hsl };
  const locked = bothNpdTabsLocked(tabs);
  const f = raw.feed;
  if (f === null) return locked ? null : { week: raw.week, tabs, feed: null };
  if (!locked) return null;
  if (f === 'unchanged') return { week: raw.week, tabs, feed: 'unchanged' };
  if (
    !isObj(f) || typeof f.text !== 'string' || !isObj(f.versions) || !isObj(f.linesBySheet) || !isCount(f.usWorkersRows)
    || !NPD_SHEETS.every((s) => isCount((f.versions as Obj)[s]) && isCount((f.linesBySheet as Obj)[s]))
  ) {
    return null;
  }
  const versions = { all_departments: f.versions.all_departments as number, hsl: f.versions.hsl as number };
  // The text must be the feed for exactly these versions of exactly this week.
  const sig = readNpdFeedSignature(f.text);
  if (sig.kind !== 'feed' || sig.week !== raw.week || NPD_SHEETS.some((s) => sig.versions[s] !== versions[s])) return null;
  if (NPD_SHEETS.some((s) => (tabs[s] as { version: number }).version !== versions[s])) return null;
  return {
    week: raw.week,
    tabs,
    feed: {
      text: f.text,
      versions,
      linesBySheet: { all_departments: f.linesBySheet.all_departments as number, hsl: f.linesBySheet.hsl as number },
      usWorkersRows: f.usWorkersRows,
    },
  };
}

/** `?known=3,5` → the versions the caller already holds, or null. */
export function parseKnownVersions(raw: string | null): Record<NpdSheetKind, number> | null {
  const m = /^(\d{1,9}),(\d{1,9})$/.exec((raw ?? '').trim());
  return m ? { all_departments: Number(m[1]), hsl: Number(m[2]) } : null;
}
