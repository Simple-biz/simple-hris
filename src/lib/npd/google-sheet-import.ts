/**
 * NPD ← the Google Sheet it replaces: one tab's rows for ONE pay week, rebuilt as
 * NPD rows. Pure and isomorphic; the route fetches the grids
 * (src/lib/google-sheets/fetch-npd-sheet.ts) and the page saves the rows through
 * the normal NPD save. Governing doc: docs/features/npd-dashboard.md § Google Sheet sync.
 *
 * Kane, 2026-10-02: "Transfer the button from Payroll Wizard - Initialize Payroll
 * Data - All Dept Payroll CSV, AND WE WILL add a new button Called - "Hogan Payroll
 * Sync" so on NPD we can sync them - and it will load the current week similar week
 * that is Payroll Wizard is on". The wizard's button read the very spreadsheet NPD
 * replaces (GOOGLE_SHEETS_RATES_SHEET_ID, tab "All Dept"); "Hogan" is its HSL tab.
 *
 * How a sheet row becomes an NPD row (the rules scripts/verify-npd-formulas-against-sheet.mts
 * proved identical on ~97,000 formula cells, plus the blank-cell rule below):
 *  - a column NPD has no formula for (hours, rates, bonuses, names …) → the sheet's
 *    value, typed in;
 *  - a column NPD has a formula for, where the sheet cell is the STANDARD formula
 *    (SHEET_FORMULA_PATTERNS) → left to NPD's formula, which gives the same figure;
 *  - anything else in such a column — a typed figure, a one-off formula, or a cell
 *    with NO formula and nothing in it — is typed over (an amber override) with the
 *    sheet's value, blank included. A blank formula-less cell left to NPD's formula
 *    would show a figure the sheet does not have, and the next formula would read it.
 *  - RATE = the constant in the week's USD formulas (=AU12*0.0162575). The most
 *    common one is the sheet's rate; a row whose formula has another keeps its USD
 *    figure as typed, so no figure changes.
 *
 * A cell's TEXT is what the sheet shows when that reads back as exactly the value
 * the sheet holds ("₱11,304.80", "$213.49" for a typed USD …), otherwise the exact
 * number: an hours cell shown "40.25" that holds 40.2533 is stored "40.2533",
 * because NPD's formulas read the text and the sheet's read the number.
 *
 * Rows belong to the week by their Week cell ("Week 9/20/26 - 9/26/26"), PARSED,
 * never by position: a week's rows are scattered through the tab (17 and 24 blocks
 * on 2026-10-02).
 */

import { NPD_COLUMNS, normalizeHeaderText, type NpdSheetKind } from './columns';
import { NPD_DEFAULT_FORMULAS, parseSheetNumber, parseUsdPerPhp } from './formulas';
import { NPD_MAX_ROWS, cleanCell, weekLabel } from './sheet';

/** The two buttons, and the Google Sheet tab each one reads. */
export const GOOGLE_SHEET_TABS: Record<NpdSheetKind, { readonly title: string; readonly button: string }> = {
  all_departments: { title: 'All Dept', button: 'All Dept Payroll CSV' },
  hsl: { title: 'Hogan', button: 'Hogan Payroll Sync' },
};

/**
 * The Google Sheet's standard formula per NPD key, with the row number as {r} and
 * the sheet's own column letters. Read from the sheet 2026-10-01; the verify
 * script and the sync share this one copy.
 */
export const SHEET_FORMULA_PATTERNS: Record<NpdSheetKind, Readonly<Record<string, RegExp>>> = {
  all_departments: {
    ot_rate: /^=AD\{r\}\*1\.5$/,
    hours_until_ot: /^=IF\(AC\{r\}<40,\(40-AC\{r\}\),0\)$/,
    orphan_hours_total_pay: /^=IF\(AC\{r\}>=40,\(AH\{r\}\*AF\{r\}\),IF\(\(AH\{r\}\+AC\{r\}\)<=40,AH\{r\}\*AD\{r\},\(AG\{r\}\*AD\{r\}\)\+\(AH\{r\}-AG\{r\}\)\*AF\{r\}\)\)$/,
    total_hourly_pay: /^=\(\(AC\{r\}\*AD\{r\}\)\+\(AE\{r\}\*AF\{r\}\)\+\(AI\{r\}\)\+\(AJ\{r\}\*AK\{r\}\)\)$/,
    total_pay_php: /^=AM\{r\}\+AO\{r\}\+AP\{r\}\+AQ\{r\}\+AR\{r\}\+AS\{r\}\+AN\{r\}$/,
    php_usd_conversion: /^=AU\{r\}\s*\*\s*([0-9.]+)\s*$/,
  },
  hsl: {
    hogan_we_rate: /^=AB\{r\}\+15$/,
    total_ot_hours: /^=MAX\(0,\(\(AA\{r\}\+AC\{r\}\)-40\)\)$/,
    ot_differential: /^=AB\{r\}\*0\.5$/,
    hours_until_ot: /^=MAX\(0,IF\(\(AC\{r\}\+AA\{r\}\)<40,\(40-\(AA\{r\}\+AC\{r\}\)\),0\)\)$/,
    orphan_hours_total_pay: /^=IF\(\(AA\{r\}\+AC\{r\}\)>=40,AH\{r\}\*\(AB\{r\}\+AF\{r\}\),IF\(\(AH\{r\}\+AC\{r\}\+AA\{r\}\)<40,AH\{r\}\*AB\{r\},\(AG\{r\}\*AB\{r\}\)\+\(AH\{r\}-AG\{r\}\)\*\(AB\{r\}\+AF\{r\}\)\)\)$/,
    total_hourly_pay: /^=\(\(AA\{r\}\*AB\{r\}\)\+\(AC\{r\}\*AD\{r\}\)\)\+\(AE\{r\}\*AF\{r\}\)\+AI\{r\}\+\(AJ\{r\}\*AK\{r\}\)$/,
    total_pay_php: /^=AM\{r\}\+AO\{r\}\+AP\{r\}\+AQ\{r\}\+AR\{r\}\+AS\{r\}\+AN\{r\}$/,
    php_usd_conversion: /^=AU\{r\}\s*\*\s*([0-9.]+)\s*$/,
  },
};

/** A formula with this row's number written as {r}, so one pattern fits every row. */
export function genericFormula(formula: string, rowNo: number): string {
  return formula.replace(new RegExp(`(?<![0-9$])${rowNo}(?![0-9])`, 'g'), '{r}');
}

/** The header row: the first row with a "Work Email" cell. -1 when there is none. */
export function findHeaderRow(grid: readonly (readonly unknown[] | undefined)[]): number {
  return grid.findIndex((r) => (r ?? []).some((c) => typeof c === 'string' && /work\s*email/i.test(c)));
}

/** For each NPD column, the index of the sheet column with its header (first match, as the sheet reads left to right); -1 = none. */
export function mapSheetColumns(sheet: NpdSheetKind, headerRow: readonly unknown[]): number[] {
  const header = headerRow.map((h) => normalizeHeaderText(String(h ?? '')));
  return NPD_COLUMNS[sheet].map((c) => {
    const names = [c.header, ...(c.headerAliases ?? [])].map(normalizeHeaderText);
    return header.findIndex((h) => names.includes(h));
  });
}

// ─── Week labels ─────────────────────────────────────────────────────────────

const WEEK_LABEL_RE = /^\s*(?:week\s*)?(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s*[-–—]\s*(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s*$/i;

function isoDate(m: string, d: string, y: string): string | null {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const month = Number(m);
  const day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * "Week 9/20/26 - 9/26/26" → { start: '2026-09-20', end: '2026-09-26' }. Case,
 * spacing round the dash ("Week 7/19/26 -7/25/26") and 2- or 4-digit years as the
 * sheet types them. Null when it is not a date range.
 */
export function parseSheetWeekLabel(label: string): { start: string; end: string } | null {
  const m = WEEK_LABEL_RE.exec(label);
  if (!m) return null;
  const start = isoDate(m[1]!, m[2]!, m[3]!);
  const end = isoDate(m[4]!, m[5]!, m[6]!);
  return start && end ? { start, end } : null;
}

// ─── Cells ───────────────────────────────────────────────────────────────────

/** The Sheets API gives an error WITH its explanation ("#N/A (Did not find …)"); a copy gives the code. */
const ERROR_EXPLAINED = /^(#[A-Z0-9/!?]+)\s+\([\s\S]*\)$/;

/**
 * One cell's NPD text from the sheet's FORMATTED and UNFORMATTED values. The
 * display text when NPD's own parser reads it back as exactly the sheet's number;
 * otherwise the exact number, so no formula reads a rounded figure.
 */
export function sheetCellText(formatted: unknown, unformatted: unknown): string {
  if (unformatted === undefined || unformatted === null || unformatted === '') return '';
  const shown = formatted === undefined || formatted === null ? '' : String(formatted);
  if (typeof unformatted === 'number') {
    const read = parseSheetNumber(shown);
    if (read.ok && typeof read.n === 'number' && !read.bool && read.n === unformatted) return shown;
    const exact = String(unformatted);
    // 1e-7 is not a figure NPD's parser reads; no payroll cell holds one.
    return /e/i.test(exact) ? shown : exact;
  }
  if (typeof unformatted === 'boolean') return shown || (unformatted ? 'TRUE' : 'FALSE');
  const textValue = shown !== '' ? shown : String(unformatted);
  return textValue.replace(ERROR_EXPLAINED, '$1');
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export type GoogleSheetGrids = {
  /** valueRenderOption=FORMULA */
  readonly formulas: readonly (readonly unknown[] | undefined)[];
  /** valueRenderOption=UNFORMATTED_VALUE (dates as formatted strings) */
  readonly values: readonly (readonly unknown[] | undefined)[];
  /** valueRenderOption=FORMATTED_VALUE */
  readonly formatted: readonly (readonly unknown[] | undefined)[];
};

export type NpdImportRow = {
  readonly values: string[];
  readonly overrides: string[];
  /** The row's number in the Google Sheet tab (1-based), for checking and for the record. */
  readonly sheetRow: number;
};

export type NpdImportSummary = {
  readonly tab: string;
  readonly week: string;
  readonly rows: number;
  /** The rate written into the sheet's USD formulas that week; null = none found. */
  readonly rate: string | null;
  /** USD formulas with a different constant: those rows keep the sheet's USD figure, typed. */
  readonly otherRates: ReadonlyArray<{ rate: string; rows: number }>;
  /** Formula cells taken as typed values (amber), the blank formula-less ones included. */
  readonly typedCells: number;
  readonly skipped: { readonly otherWeek: number; readonly noWeek: number; readonly unreadableWeek: number };
  /** The Week cells as the sheet spells them, for the record. */
  readonly labels: readonly string[];
  readonly clippedCells: number;
};

export type NpdImportResult =
  | { ok: true; rows: NpdImportRow[]; rateText: string; summary: NpdImportSummary }
  | { ok: false; code: 'no_header' | 'missing_columns' | 'no_rows' | 'too_many_rows'; error: string };

const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

/** Build NPD rows for `week` (a Sunday) from one tab's three grids. */
export function buildNpdImport(input: {
  sheet: NpdSheetKind;
  week: string;
  tab: string;
  grids: GoogleSheetGrids;
}): NpdImportResult {
  const { sheet, week, tab, grids } = input;
  const cols = NPD_COLUMNS[sheet];
  const hi = findHeaderRow(grids.formatted);
  if (hi < 0) return { ok: false, code: 'no_header', error: `The Google Sheet's "${tab}" tab has no header row with a Work Email column.` };

  const sheetIndex = mapSheetColumns(sheet, grids.formatted[hi] ?? []);
  const missing = cols.filter((_, i) => sheetIndex[i]! < 0).map((c) => c.header.replace(/\s+/g, ' '));
  if (missing.length) {
    return {
      ok: false,
      code: 'missing_columns',
      error: `The Google Sheet's "${tab}" tab has no column for: ${missing.join(', ')}. Nothing was loaded.`,
    };
  }

  const patterns = SHEET_FORMULA_PATTERNS[sheet];
  const defaults = new Set(NPD_DEFAULT_FORMULAS[sheet].map((f) => f.key));
  const weekCol = sheetIndex[cols.findIndex((c) => c.key === 'week')]!;
  const usdIndex = cols.findIndex((c) => c.key === 'php_usd_conversion');

  type Built = { values: string[]; overrides: string[]; sheetRow: number; rate: number | null; rateText: string | null; usdText: string };
  const built: Built[] = [];
  const skipped = { otherWeek: 0, noWeek: 0, unreadableWeek: 0 };
  const labels = new Set<string>();
  let newest: string | null = null;
  let clippedCells = 0;
  const height = Math.max(grids.formulas.length, grids.values.length, grids.formatted.length);

  for (let r = hi + 1; r < height; r += 1) {
    const fRow = grids.formulas[r] ?? [];
    const vRow = grids.values[r] ?? [];
    const dRow = grids.formatted[r] ?? [];
    if (fRow.every(isBlank) && vRow.every(isBlank) && dRow.every(isBlank)) continue;

    const label = String(dRow[weekCol] ?? vRow[weekCol] ?? '').trim();
    if (label === '') {
      skipped.noWeek += 1;
      continue;
    }
    const parsed = parseSheetWeekLabel(label);
    if (!parsed) {
      skipped.unreadableWeek += 1;
      continue;
    }
    if (newest === null || parsed.start > newest) newest = parsed.start;
    if (parsed.start !== week) {
      skipped.otherWeek += 1;
      continue;
    }
    labels.add(label);

    const rowNo = r + 1;
    const overrides: string[] = [];
    let rate: number | null = null;
    let rateText: string | null = null;
    let usdText = '';
    const values = cols.map((c, i) => {
      const si = sheetIndex[i]!;
      const cleaned = cleanCell(sheetCellText(dRow[si], vRow[si]));
      if (cleaned.clipped) clippedCells += 1;
      const textValue = cleaned.value;
      if (i === usdIndex) usdText = textValue;
      if (!defaults.has(c.key)) return textValue;
      const f = fRow[si];
      const m = typeof f === 'string' && f.startsWith('=') ? patterns[c.key]?.exec(genericFormula(f, rowNo)) : null;
      if (m) {
        if (i === usdIndex) {
          rate = Number(m[1]);
          rateText = m[1]!;
        }
        return '';
      }
      overrides.push(c.key);
      return textValue;
    });
    built.push({ values, overrides, sheetRow: rowNo, rate, rateText, usdText });
  }

  if (built.length === 0) {
    const newestNote = newest && newest !== week ? ` Its newest week is ${weekLabel(newest)}.` : '';
    return {
      ok: false,
      code: 'no_rows',
      error: `The Google Sheet's "${tab}" tab has no rows for ${weekLabel(week)}.${newestNote} Nothing was loaded.`,
    };
  }
  if (built.length > NPD_MAX_ROWS) {
    return {
      ok: false,
      code: 'too_many_rows',
      error: `The Google Sheet's "${tab}" tab has ${built.length} rows for ${weekLabel(week)}; an NPD sheet holds at most ${NPD_MAX_ROWS}. Nothing was loaded.`,
    };
  }

  // The week's rate: the most common constant in its USD formulas (the first seen on a tie).
  const byRate = new Map<number, { text: string; rows: number }>();
  for (const b of built) {
    if (b.rate === null) continue;
    const e = byRate.get(b.rate);
    if (e) e.rows += 1;
    else byRate.set(b.rate, { text: b.rateText!, rows: 1 });
  }
  let chosen: number | null = null;
  for (const [value, e] of byRate) if (chosen === null || e.rows > byRate.get(chosen)!.rows) chosen = value;
  // NPD refuses a rate of 0 or ≥ 1 (pesos per dollar typed the wrong way round);
  // then every USD figure is kept as the sheet's, typed.
  let rateValue: number | null = null;
  if (chosen !== null) {
    const p = parseUsdPerPhp(byRate.get(chosen)!.text);
    if (p.ok && p.rate !== null) rateValue = chosen;
  }
  const rateText = rateValue === null ? '' : byRate.get(rateValue)!.text;

  const rows: NpdImportRow[] = built.map((b) => {
    if (b.rate === null || b.rate === rateValue) return { values: b.values, overrides: b.overrides, sheetRow: b.sheetRow };
    // Another rate in this row's formula: keep the sheet's USD figure, typed.
    const values = [...b.values];
    values[usdIndex] = b.usdText;
    return { values, overrides: [...b.overrides, 'php_usd_conversion'], sheetRow: b.sheetRow };
  });

  return {
    ok: true,
    rows,
    rateText,
    summary: {
      tab,
      week,
      rows: rows.length,
      rate: rateText || null,
      otherRates: [...byRate.entries()]
        .filter(([value]) => value !== rateValue)
        .map(([, e]) => ({ rate: e.text, rows: e.rows })),
      typedCells: rows.reduce((n, r) => n + r.overrides.length, 0),
      skipped,
      labels: [...labels],
      clippedCells,
    },
  };
}
