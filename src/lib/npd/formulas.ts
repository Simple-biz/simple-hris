/**
 * NPD formulas — the NEW Payroll Dashboard Google Sheet's formulas, as an
 * EDITABLE formula per cell. Pure, isomorphic, unit-tested (formulas.test.ts)
 * and checked against every row of the live sheet by
 * scripts/verify-npd-formulas-against-sheet.mts.
 *
 * Kane, 2026-10-01: "Copy the formulas in respective of the Columns please this is
 * to ensure we have the values calculated", then "when we right click on the cell
 * it should show the formula beneath that cell please and should be editable".
 * The defaults below were read that day from spreadsheet
 * 1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4 ("All Dept" gid 0, "Hogan" gid
 * 406220700) through the HRIS service account, read-only.
 * Governing doc: docs/features/npd-dashboard.md § Formulas.
 *
 * ── Where a cell's formula comes from (first that applies) ──────────────────
 *   1. the cell is TYPED over (row.overrides has it)  → no formula, the typed text
 *   2. the cell's own formula (row.formulas[key])
 *   3. the sheet's column formula (columnFormulas[key]; "" = this column has none)
 *   4. the default below (the Google Sheet's formula for that column)
 *   otherwise the cell is a typed input.
 *
 * ── Storage form ────────────────────────────────────────────────────────────
 * A formula is stored with references by COLUMN KEY, e.g. `={regular_rate}*1.5`,
 * so inserting rows or reordering columns cannot break it. It is shown and typed
 * in the sheet's own notation, column letter + this row's number: `=H5*1.5`.
 * Only this row's cells can be referenced (NPD formulas are per row, like every
 * formula in the sheet this replaces).
 *
 * ── Evaluation, mirroring Google Sheets ─────────────────────────────────────
 *  - IEEE doubles, evaluated in the order the formula is written, so the same
 *    formula gives the same bits as the sheet. The defaults keep the sheet's
 *    exact expression order. Never "simplify" one: that can move a figure a cent.
 *  - A blank cell is 0. A cell of text (anything that is not a number, a space
 *    included) is TEXT: arithmetic on it is `#VALUE!`, but in a comparison text
 *    ranks above every number (so "Salary" < 40 is FALSE and gives the IF's
 *    else-branch, exactly as the sheet's 'Salary' rows do), and a range or a
 *    reference inside MAX/MIN/SUM skips it. An error cell (`#N/A` …) passes its
 *    error on. IF is lazy, so an error in the branch that is not taken does not
 *    spread. A formula that reaches itself is `#REF!`.
 *  - `RATE` is the sheet's PHP→USD rate (dollars per peso). With no rate typed,
 *    anything using it is BLANK, not 0 and not an error.
 *  - The hours and bonus columns are XLOOKUPs into an hours tab in the Google
 *    Sheet. NPD has no such tab, so they have no default here and are pasted.
 *  - The sheet's "Orphan pay" column (AO) is added into Total Pay PHP. NPD has no
 *    such column and the sheet never filled it (0 of ~13,900 rows, 2026-10-01);
 *    x + 0 is exactly x in IEEE, so leaving it out changes no figure.
 */

import { NPD_COLUMNS, type NpdColumn, type NpdSheetKind } from './columns';

// ─── Values ──────────────────────────────────────────────────────────────────

/** A value inside a formula: a number (a comparison's result is a number flagged bool), text, or an error. */
export type FVal =
  | { ok: true; n: number; bool?: boolean; s?: undefined }
  | { ok: true; s: string; n?: undefined; bool?: undefined }
  | { ok: false; err: string };

/** Internal marker: the formula needs RATE and the sheet has none. Shown blank. */
export const NO_RATE = 'NO_RATE';

const num = (n: number): FVal => ({ ok: true, n });
const bool = (b: boolean): FVal => ({ ok: true, n: b ? 1 : 0, bool: true });
const text = (t: string): FVal => ({ ok: true, s: t });
const err = (e: string): FVal => ({ ok: false, err: e });
const isText = (v: FVal): v is { ok: true; s: string } => v.ok && typeof v.s === 'string';

const ERROR_TOKEN = /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|NULL!|ERROR!)$/i;

/**
 * Read a typed cell the way the sheet's formulas see it. Empty → 0. Accepts what
 * a copy from Google Sheets puts on the clipboard: `₱1,234.56`, `$1,234.56`,
 * `1,234.56`, `-100.00`, `(100.00)`, `PHP 100`, `USD 20`, `40`, TRUE / FALSE.
 * Anything else — a space included, as in the sheet — is TEXT. An error cell
 * passes its own error.
 */
export function parseSheetNumber(raw: string): FVal {
  if (raw === '') return num(0);
  const t = raw.trim();
  if (t === '') return text(raw);
  if (ERROR_TOKEN.test(t)) return err(t.toUpperCase());
  if (/^true$/i.test(t)) return bool(true);
  if (/^false$/i.test(t)) return bool(false);
  let s = t.replace(/−/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/^(?:₱|US\$|\$|PHP|USD)\s*/i, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  if (!/^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(s)) return text(raw);
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return text(raw);
  return num(negative ? -n : n);
}

/** Arithmetic on text is #VALUE!; a boolean is 1 / 0. */
function asNumber(v: FVal): FVal {
  if (!v.ok) return v;
  if (isText(v)) return err('#VALUE!');
  return v;
}

/** The sheet's comparison order: numbers < text < TRUE/FALSE; text compares case-blind. */
function compare(l: FVal, r: FVal): number {
  const rank = (v: FVal) => (isText(v) ? 1 : v.ok && v.bool ? 2 : 0);
  const a = rank(l);
  const b = rank(r);
  if (a !== b) return a - b;
  if (isText(l) && isText(r)) {
    const x = l.s.toLowerCase();
    const y = r.s.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = (l as { n: number }).n;
  const y = (r as { n: number }).n;
  return x < y ? -1 : x > y ? 1 : 0;
}

// ─── Column letters ──────────────────────────────────────────────────────────

/** 0 → A, 25 → Z, 26 → AA — the letter row above the grid's headers. */
export function columnLetter(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function letterIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number; s: string }
  | { t: 'key'; key: string; s: string }
  | { t: 'cell'; col: string; row: number; s: string }
  | { t: 'name'; v: string; s: string }
  | { t: 'op'; v: string; s: string }
  | { t: 'lp' | 'rp' | 'comma' | 'colon'; s: string };

export class FormulaError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\{([a-z0-9_]+)\}/.exec(rest))) out.push({ t: 'key', key: m[1]!, s: m[0] });
    else if ((m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(rest))) out.push({ t: 'num', v: Number(m[0]), s: m[0] });
    else if ((m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/.exec(rest))) out.push({ t: 'cell', col: m[1]!.toUpperCase(), row: Number(m[2]), s: m[0] });
    else if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) out.push({ t: 'name', v: m[0].toUpperCase(), s: m[0] });
    else if ((m = /^(?:<=|>=|<>|[-+*/^=<>%&])/.exec(rest))) out.push({ t: 'op', v: m[0], s: m[0] });
    else if (rest[0] === '(') out.push({ t: 'lp', s: '(' });
    else if (rest[0] === ')') out.push({ t: 'rp', s: ')' });
    else if (rest[0] === ',') out.push({ t: 'comma', s: ',' });
    else if (rest[0] === ':') out.push({ t: 'colon', s: ':' });
    else if (rest[0] === '!' || rest[0] === "'") throw new FormulaError('NPD formulas can only use cells on this sheet.');
    else throw new FormulaError(`Unexpected "${rest[0]}".`);
    i += out[out.length - 1]!.s.length;
  }
  return out;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export type Node =
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; key: string }
  | { k: 'range'; from: string; to: string }
  | { k: 'name'; v: string }
  | { k: 'neg'; x: Node }
  | { k: 'pct'; x: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; fn: string; args: Node[] };

const BINARY: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
export const NPD_FUNCTIONS = ['IF', 'MAX', 'MIN', 'SUM', 'ROUND', 'ABS', 'AND', 'OR'] as const;

/** Parse a STORED formula (`={regular_rate}*1.5`). Throws FormulaError. */
export function parseFormula(stored: string): Node {
  const src = stored.trim().replace(/^=/, '');
  if (src === '') throw new FormulaError('The formula is empty.');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const primary = (): Node => {
    const t = next();
    if (!t) throw new FormulaError('The formula ends too soon.');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'op' && t.v === '-') return { k: 'neg', x: unary() };
    if (t.t === 'op' && t.v === '+') return unary();
    if (t.t === 'lp') {
      const e = expr(0);
      if (next()?.t !== 'rp') throw new FormulaError('A "(" is not closed.');
      return e;
    }
    if (t.t === 'key') {
      if (peek()?.t === 'colon') {
        next();
        const to = next();
        if (to?.t !== 'key') throw new FormulaError('A range needs a cell on both sides of ":".');
        return { k: 'range', from: t.key, to: to.key };
      }
      return { k: 'ref', key: t.key };
    }
    if (t.t === 'cell') throw new FormulaError('Internal: a cell reference was not converted.');
    if (t.t === 'name') {
      if (peek()?.t === 'lp') {
        next();
        const args: Node[] = [];
        if (peek()?.t !== 'rp') {
          for (;;) {
            args.push(expr(0));
            const sep = next();
            if (sep?.t === 'rp') break;
            if (sep?.t !== 'comma') throw new FormulaError(`${t.v}( is not closed.`);
          }
        } else next();
        return { k: 'call', fn: t.v, args };
      }
      if (t.v === 'TRUE' || t.v === 'FALSE') return { k: 'bool', v: t.v === 'TRUE' };
      return { k: 'name', v: t.v };
    }
    throw new FormulaError(`Unexpected "${t.s}".`);
  };

  // Unary minus binds tighter than ^ (the sheet: -2^2 = 4); % is postfix.
  const unary = (): Node => {
    let x = primary();
    while (peek()?.t === 'op' && (peek() as { v: string }).v === '%') {
      next();
      x = { k: 'pct', x };
    }
    return x;
  };

  const expr = (min: number): Node => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !(t.v in BINARY)) break;
      const prec = BINARY[t.v]!;
      if (prec < min) break;
      next();
      // ^ is left-associative in the sheet too: 2^3^2 = 64.
      const r = expr(prec + 1);
      l = { k: 'bin', op: t.v, l, r };
    }
    return l;
  };

  const tree = expr(0);
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p]!.s}".`);
  return tree;
}

// ─── Display ⇄ storage ───────────────────────────────────────────────────────

/**
 * What the person typed (`=H5*1.5`, in row 5) → the stored form (`={regular_rate}*1.5`).
 * Each reference must be a column of this sheet AND this row. The expression is
 * kept exactly as typed apart from the references, so its evaluation order is theirs.
 */
export function toStoredFormula(typed: string, rowNo: number, columns: readonly NpdColumn[]): string {
  const src = typed.trim();
  if (!src.startsWith('=')) throw new FormulaError('A formula starts with "=".');
  const toks = tokenize(src.slice(1));
  let out = '=';
  let prevWord = false;
  for (const t of toks) {
    if (t.t === 'cell') {
      const idx = letterIndex(t.col);
      const col = columns[idx];
      if (!col) throw new FormulaError(`Column ${t.col} is not on this sheet (it ends at ${columnLetter(columns.length - 1)}).`);
      if (t.row !== rowNo) throw new FormulaError(`${t.s} is row ${t.row}. NPD formulas use this row's cells only (row ${rowNo}).`);
      out += `{${col.key}}`;
      prevWord = false;
      continue;
    }
    if (t.t === 'key') {
      if (!columns.some((c) => c.key === t.key)) throw new FormulaError(`Unknown column "${t.key}".`);
      out += t.s;
      prevWord = false;
      continue;
    }
    const s = t.t === 'name' ? t.v : t.s;
    // Keep words apart (no word gluing); everything else is written tight.
    const word = t.t === 'name' || t.t === 'num';
    out += (prevWord && word ? ' ' : '') + s;
    prevWord = word;
  }
  parseFormula(out); // throws on a malformed formula
  validateNames(parseFormula(out));
  return out;
}

/** The stored form → what the sheet would show in row `rowNo`: `=H5*1.5`. */
export function toDisplayFormula(stored: string, rowNo: number, columns: readonly NpdColumn[]): string {
  return stored.replace(/\{([a-z0-9_]+)\}/g, (_, key: string) => {
    const i = columns.findIndex((c) => c.key === key);
    return i < 0 ? '#REF!' : `${columnLetter(i)}${rowNo}`;
  });
}

/** Column keys a stored formula reads, in order of first use (for the legend under the editor). */
export function referencedKeys(stored: string): string[] {
  const seen: string[] = [];
  for (const m of stored.matchAll(/\{([a-z0-9_]+)\}/g)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

function validateNames(node: Node): void {
  switch (node.k) {
    case 'call':
      if (!(NPD_FUNCTIONS as readonly string[]).includes(node.fn)) {
        throw new FormulaError(`${node.fn} is not an NPD function. Use ${NPD_FUNCTIONS.join(', ')}.`);
      }
      node.args.forEach(validateNames);
      return;
    case 'name':
      if (node.v !== 'RATE') throw new FormulaError(`Unknown name "${node.v}". Cells are letter + row (H5); RATE is the PHP→USD rate.`);
      return;
    case 'neg':
    case 'pct':
      validateNames(node.x);
      return;
    case 'bin':
      validateNames(node.l);
      validateNames(node.r);
      return;
    default:
      return;
  }
}

/** Is this a well-formed STORED formula for this sheet? Used by the route on every save. */
export function checkStoredFormula(stored: string, sheet: NpdSheetKind): string | null {
  if (stored.length > NPD_FORMULA_MAX_LENGTH) return `A formula is limited to ${NPD_FORMULA_MAX_LENGTH} characters.`;
  if (!stored.trim().startsWith('=')) return 'A formula starts with "=".';
  try {
    const keys = new Set(NPD_COLUMNS[sheet].map((c) => c.key));
    for (const k of referencedKeys(stored)) if (!keys.has(k)) return `Unknown column "${k}".`;
    validateNames(parseFormula(stored));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Unreadable formula.';
  }
}

export const NPD_FORMULA_MAX_LENGTH = 500;

// ─── Defaults: the Google Sheet's formulas (2026-10-01) ──────────────────────

export type NpdFormat = 'num' | 'money' | 'usd';

export type NpdDefaultFormula = {
  readonly key: string;
  /** The stored formula. Same expression, same order, as the sheet's. */
  readonly formula: string;
  /** The sheet's own column letter and formula, for the record. */
  readonly sheet: string;
};

const TOTAL_PAY_PHP =
  '={total_hourly_pay}+{tech_bonus}+{attendance_bonus}+{performance_bonus}+{additional_bonus}+{mesa_contribution}';

export const NPD_DEFAULT_FORMULAS: Record<NpdSheetKind, readonly NpdDefaultFormula[]> = {
  all_departments: [
    { key: 'ot_rate', formula: '={regular_rate}*1.5', sheet: 'AF =AD*1.5' },
    { key: 'hours_until_ot', formula: '=IF({regular_total_hours}<40,(40-{regular_total_hours}),0)', sheet: 'AG =IF(AC<40,(40-AC),0)' },
    {
      key: 'orphan_hours_total_pay',
      formula:
        '=IF({regular_total_hours}>=40,({orphan_total_hours}*{ot_rate}),IF(({orphan_total_hours}+{regular_total_hours})<=40,{orphan_total_hours}*{regular_rate},({hours_until_ot}*{regular_rate})+({orphan_total_hours}-{hours_until_ot})*{ot_rate}))',
      sheet: 'AI =IF(AC>=40,(AH*AF),IF((AH+AC)<=40,AH*AD,(AG*AD)+(AH-AG)*AF))',
    },
    {
      key: 'total_hourly_pay',
      formula:
        '=(({regular_total_hours}*{regular_rate})+({ot_total_hours}*{ot_rate})+({orphan_hours_total_pay})+({midweek_new_rate_total_hours}*{midweek_new_hourly_rate}))',
      sheet: 'AM =((AC*AD)+(AE*AF)+(AI)+(AJ*AK))',
    },
    { key: 'total_pay_php', formula: TOTAL_PAY_PHP, sheet: 'AU =AM+AO+AP+AQ+AR+AS+AN (AO, Orphan pay, is not an NPD column)' },
    { key: 'php_usd_conversion', formula: '={total_pay_php}*RATE', sheet: 'AV =AU*<the week’s rate, typed into the formula>' },
  ],
  hsl: [
    { key: 'hogan_we_rate', formula: '={mf_rate}+15', sheet: 'AD =AB+15' },
    { key: 'total_ot_hours', formula: '=MAX(0,(({mf_total_hours}+{we_hours})-40))', sheet: 'AE =MAX(0,((AA+AC)-40))' },
    { key: 'ot_differential', formula: '={mf_rate}*0.5', sheet: 'AF =AB*0.5' },
    {
      key: 'hours_until_ot',
      formula: '=MAX(0,IF(({we_hours}+{mf_total_hours})<40,(40-({mf_total_hours}+{we_hours})),0))',
      sheet: 'AG =MAX(0,IF((AC+AA)<40,(40-(AA+AC)),0))',
    },
    {
      key: 'orphan_hours_total_pay',
      formula:
        '=IF(({mf_total_hours}+{we_hours})>=40,{orphan_total_hours}*({mf_rate}+{ot_differential}),IF(({orphan_total_hours}+{we_hours}+{mf_total_hours})<40,{orphan_total_hours}*{mf_rate},({hours_until_ot}*{mf_rate})+({orphan_total_hours}-{hours_until_ot})*({mf_rate}+{ot_differential})))',
      sheet: 'AI =IF((AA+AC)>=40,AH*(AB+AF),IF((AH+AC+AA)<40,AH*AB,(AG*AB)+(AH-AG)*(AB+AF)))',
    },
    {
      key: 'total_hourly_pay',
      formula:
        '=(({mf_total_hours}*{mf_rate})+({we_hours}*{hogan_we_rate}))+({total_ot_hours}*{ot_differential})+{orphan_hours_total_pay}+({midweek_new_rate_total_hours}*{midweek_transition_hourly_rate})',
      sheet: 'AM =((AA*AB)+(AC*AD))+(AE*AF)+AI+(AJ*AK)',
    },
    { key: 'total_pay_php', formula: TOTAL_PAY_PHP, sheet: 'AU =AM+AO+AP+AQ+AR+AS+AN (AO, Orphan pay, is not an NPD column)' },
    { key: 'php_usd_conversion', formula: '={total_pay_php}*RATE', sheet: 'AV =AU*<the week’s rate, typed into the formula>' },
  ],
};

export function defaultFormula(sheet: NpdSheetKind, key: string): string | null {
  return NPD_DEFAULT_FORMULAS[sheet].find((f) => f.key === key)?.formula ?? null;
}

const MONEY_KEYS = new Set([
  'total_hourly_pay',
  'total_pay_php',
  'tech_bonus',
  'attendance_bonus',
  'performance_bonus',
  'additional_bonus',
  'mesa_contribution',
]);
const USD_KEYS = new Set(['php_usd_conversion', 'total_pay_us_workers']);

/** The sheet's number format for a computed figure in this column. */
export function formatFor(key: string): NpdFormat {
  return USD_KEYS.has(key) ? 'usd' : MONEY_KEYS.has(key) ? 'money' : 'num';
}

/** `0.00`, `#,##0.00`, or `"$"#,##0.00` — what the sheet shows. */
export function formatSheetNumber(n: number, format: NpdFormat): string {
  const fixed = Math.abs(n).toFixed(2);
  const grouped =
    format === 'num' ? fixed : fixed.replace(/^(\d+)(\.\d+)$/, (_, i: string, d: string) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + d);
  const body = format === 'usd' ? `$${grouped}` : grouped;
  return n < 0 && fixed !== '0.00' ? `-${body}` : body;
}

/** Does typed text equal a figure at the sheet's display precision (2 dp)? */
export function sameAtDisplay(text: string, value: number): boolean {
  const t = parseSheetNumber(text);
  return t.ok && typeof t.n === 'number' && Math.abs(t.n - value) < 0.005 + 1e-9;
}

// ─── Evaluate ────────────────────────────────────────────────────────────────

export type NpdFormulaContext = {
  /** The sheet's column formulas: key → stored formula, or "" for "no formula". */
  readonly columnFormulas: Readonly<Record<string, string>>;
  /** Dollars per peso, or null when the sheet has none. */
  readonly rate: number | null;
};

export type FormulaRow = {
  readonly id: string;
  readonly values: readonly string[];
  /** Formula cells holding a TYPED value instead. */
  readonly overrides: readonly string[];
  /** This row's own formulas, key → stored formula. */
  readonly formulas: Readonly<Record<string, string>>;
};

/** Where a cell's figure comes from. */
export type CellSource = 'typed' | 'override' | 'cell' | 'column' | 'default';

/** The formula a cell would use, ignoring a typed override (null = none). */
export function formulaBehind(
  sheet: NpdSheetKind,
  row: Pick<FormulaRow, 'formulas'>,
  key: string,
  ctx: NpdFormulaContext,
): { formula: string; source: 'cell' | 'column' | 'default' } | null {
  const own = row.formulas[key];
  if (own) return { formula: own, source: 'cell' };
  if (Object.prototype.hasOwnProperty.call(ctx.columnFormulas, key)) {
    const col = ctx.columnFormulas[key]!;
    return col ? { formula: col, source: 'column' } : null;
  }
  const d = defaultFormula(sheet, key);
  return d ? { formula: d, source: 'default' } : null;
}

const parsed = new Map<string, Node | FormulaError>();
function cachedParse(stored: string): Node | FormulaError {
  let n = parsed.get(stored);
  if (!n) {
    try {
      n = parseFormula(stored);
    } catch (e) {
      n = e instanceof FormulaError ? e : new FormulaError('Unreadable formula.');
    }
    if (parsed.size > 2000) parsed.clear();
    parsed.set(stored, n);
  }
  return n;
}

export type CellResult =
  | { kind: 'value'; n: number; bool?: boolean; text: string }
  /** A formula that just points at a text cell (=B5) shows that text. */
  | { kind: 'text'; text: string }
  | { kind: 'error'; err: string; text: string }
  /** Needs RATE and the sheet has none: shown blank. */
  | { kind: 'blank'; text: '' };

/**
 * One row's figures. For every cell that has a formula behind it (even when
 * typed over), `formula[key]` is what that formula gives; later formulas read a
 * typed-over cell's TYPED value, exactly as the sheet reads a typed cell.
 */
export function evaluateRow(sheet: NpdSheetKind, row: FormulaRow, ctx: NpdFormulaContext): Record<string, CellResult> {
  const cols = NPD_COLUMNS[sheet];
  const index = new Map(cols.map((c, i) => [c.key, i]));
  const overrides = new Set(row.overrides);
  const memo = new Map<string, FVal>();
  const visiting = new Set<string>();
  const results: Record<string, CellResult> = {};

  const runFormula = (key: string, stored: string): FVal => {
    const tree = cachedParse(stored);
    if (tree instanceof FormulaError) return err('#ERROR!');
    if (visiting.has(key)) return err('#REF!');
    visiting.add(key);
    const v = evalNode(tree);
    visiting.delete(key);
    return v;
  };

  /** A cell's value as other formulas read it. */
  const cell = (key: string): FVal => {
    const hit = memo.get(key);
    if (hit) return hit;
    if (visiting.has(key)) return err('#REF!');
    const i = index.get(key);
    if (i === undefined) return err('#REF!');
    const behind = formulaBehind(sheet, row, key, ctx);
    let v: FVal;
    if (behind && !overrides.has(key)) v = runFormula(key, behind.formula);
    else v = parseSheetNumber(row.values[i] ?? '');
    memo.set(key, v);
    return v;
  };

  const rangeValues = (from: string, to: string): FVal[] | FVal => {
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined) return err('#REF!');
    const out: FVal[] = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
      const key = cols[i]!.key;
      const hasFormula = !!formulaBehind(sheet, row, key, ctx) && !overrides.has(key);
      if (hasFormula) {
        out.push(cell(key));
        continue;
      }
      // Like the sheet, a RANGE skips empty cells and plain text (a direct
      // reference does not); an error cell still spreads.
      const raw = row.values[i] ?? '';
      if (raw === '') continue;
      const v = parseSheetNumber(raw);
      if (!isText(v)) out.push(v);
    }
    return out;
  };

  const args = (nodes: Node[]): FVal[] | FVal => {
    const out: FVal[] = [];
    for (const n of nodes) {
      if (n.k === 'range') {
        const r = rangeValues(n.from, n.to);
        if (!Array.isArray(r)) return r;
        out.push(...r);
      } else if (n.k === 'ref') {
        // The sheet's MAX/MIN/SUM skip a referenced cell that is empty or text.
        const i = index.get(n.key);
        const hasFormula = !!formulaBehind(sheet, row, n.key, ctx) && !overrides.has(n.key);
        if (!hasFormula && i !== undefined && (row.values[i] ?? '') === '') continue;
        const v = cell(n.key);
        if (!isText(v)) out.push(v);
      } else {
        const v = evalNode(n);
        if (isText(v)) return err('#VALUE!');
        out.push(v);
      }
    }
    return out;
  };

  const evalNode = (n: Node): FVal => {
    switch (n.k) {
      case 'num':
        return num(n.v);
      case 'bool':
        return bool(n.v);
      case 'ref':
        return cell(n.key);
      case 'range':
        return err('#VALUE!');
      case 'name':
        if (n.v === 'RATE') return ctx.rate === null ? err(NO_RATE) : num(ctx.rate);
        return err('#NAME?');
      case 'neg': {
        const x = asNumber(evalNode(n.x));
        return x.ok ? num(-(x as { n: number }).n) : x;
      }
      case 'pct': {
        const x = asNumber(evalNode(n.x));
        return x.ok ? num((x as { n: number }).n / 100) : x;
      }
      case 'bin': {
        const l0 = evalNode(n.l);
        if (!l0.ok) return l0;
        const r0 = evalNode(n.r);
        if (!r0.ok) return r0;
        if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
          const c = compare(l0, r0);
          switch (n.op) {
            case '=':
              return bool(c === 0);
            case '<>':
              return bool(c !== 0);
            case '<':
              return bool(c < 0);
            case '>':
              return bool(c > 0);
            case '<=':
              return bool(c <= 0);
            default:
              return bool(c >= 0);
          }
        }
        const l = asNumber(l0);
        if (!l.ok) return l;
        const r = asNumber(r0);
        if (!r.ok) return r;
        const a = (l as { n: number }).n;
        const b = (r as { n: number }).n;
        switch (n.op) {
          case '+':
            return num(a + b);
          case '-':
            return num(a - b);
          case '*':
            return num(a * b);
          case '/':
            return b === 0 ? err('#DIV/0!') : num(a / b);
          case '^':
            return num(Math.pow(a, b));
          default:
            return err('#VALUE!');
        }
      }
      case 'call':
        return call(n.fn, n.args);
    }
  };

  const call = (fn: string, nodes: Node[]): FVal => {
    if (fn === 'IF') {
      if (nodes.length < 2 || nodes.length > 3) return err('#N/A');
      const c = evalNode(nodes[0]!);
      if (!c.ok) return c;
      if (isText(c)) return err('#VALUE!');
      if ((c as { n: number }).n !== 0) return evalNode(nodes[1]!);
      return nodes[2] ? evalNode(nodes[2]) : bool(false);
    }
    const vals = args(nodes);
    if (!Array.isArray(vals)) return vals;
    const bad = vals.find((v) => !v.ok);
    if (bad) return bad;
    const ns = vals.map((v) => (v as { n: number }).n ?? 0);
    switch (fn) {
      case 'MAX':
        return num(ns.length ? ns.reduce((a, b) => Math.max(a, b)) : 0);
      case 'MIN':
        return num(ns.length ? ns.reduce((a, b) => Math.min(a, b)) : 0);
      case 'SUM':
        return num(ns.reduce((a, b) => a + b, 0));
      case 'ABS':
        return ns.length === 1 ? num(Math.abs(ns[0]!)) : err('#N/A');
      case 'ROUND': {
        if (ns.length < 1 || ns.length > 2) return err('#N/A');
        const places = Math.trunc(ns[1] ?? 0);
        const f = Math.pow(10, places);
        // Half away from zero, like the sheet.
        return num((Math.sign(ns[0]!) * Math.round(Math.abs(ns[0]!) * f + 1e-9)) / f);
      }
      case 'AND':
        return ns.length ? bool(ns.every((x) => x !== 0)) : err('#N/A');
      case 'OR':
        return ns.length ? bool(ns.some((x) => x !== 0)) : err('#N/A');
      default:
        return err('#NAME?');
    }
  };

  for (const c of cols) {
    const behind = formulaBehind(sheet, row, c.key, ctx);
    if (!behind) continue;
    const v = overrides.has(c.key) ? runFormula(c.key, behind.formula) : cell(c.key);
    results[c.key] = toResult(v, c.key);
  }
  return results;
}

function toResult(v: FVal, key: string): CellResult {
  if (!v.ok) return v.err === NO_RATE ? { kind: 'blank', text: '' } : { kind: 'error', err: v.err, text: v.err };
  if (isText(v)) return { kind: 'text', text: v.s };
  if (v.bool) return { kind: 'value', n: v.n!, bool: true, text: v.n ? 'TRUE' : 'FALSE' };
  return { kind: 'value', n: v.n!, text: formatSheetNumber(v.n!, formatFor(key)) };
}

// ─── Applying formulas to rows ───────────────────────────────────────────────

/** A row with nothing typed in it: its formula cells show nothing, not a column of 0.00s. */
export function rowHasNoInputs(sheet: NpdSheetKind, row: FormulaRow, ctx: NpdFormulaContext): boolean {
  return NPD_COLUMNS[sheet].every((c, i) => {
    const behind = formulaBehind(sheet, row, c.key, ctx);
    if (behind && !row.overrides.includes(c.key)) return true;
    return (row.values[i] ?? '').trim() === '';
  });
}

/**
 * Write every formula cell's figure into the row's text (typed-over cells keep
 * their text). The route runs this on every save, so a stored formula cell always
 * holds what its formula gives, whatever the browser sent.
 */
export function recomputeRow<R extends FormulaRow>(sheet: NpdSheetKind, row: R, ctx: NpdFormulaContext): R {
  const cols = NPD_COLUMNS[sheet];
  const keys = new Set(cols.map((c) => c.key));
  const overrides = row.overrides.filter((k) => keys.has(k) && !!formulaBehind(sheet, row, k, ctx));
  const formulas = Object.fromEntries(Object.entries(row.formulas).filter(([k, f]) => keys.has(k) && !!f));
  const clean = { ...row, overrides, formulas };
  const empty = rowHasNoInputs(sheet, clean, ctx);
  const results = empty ? null : evaluateRow(sheet, clean, ctx);
  let values: string[] | null = null;
  cols.forEach((c, i) => {
    if (overrides.includes(c.key) || !formulaBehind(sheet, clean, c.key, ctx)) return;
    const text = empty ? '' : (results![c.key]?.text ?? '');
    if (row.values[i] !== text) {
      values ??= [...row.values];
      values[i] = text;
    }
  });
  const sameMeta =
    overrides.length === row.overrides.length && Object.keys(formulas).length === Object.keys(row.formulas).length;
  if (!values && sameMeta) return row;
  return { ...clean, values: values ?? row.values };
}

export function recomputeSheet<R extends FormulaRow>(sheet: NpdSheetKind, rows: readonly R[], ctx: NpdFormulaContext): R[] {
  return rows.map((r) => recomputeRow(sheet, r, ctx));
}

/**
 * Apply one edit (rows before → rows after) the way the sheet treats typing:
 *  - `=…` typed into a cell becomes that cell's formula (references: this row);
 *    a formula that does not parse stays as typed text.
 *  - blank in a cell that has a formula behind it clears the cell's own formula
 *    and any typed value, so the column's formula fills it again;
 *  - other text in such a cell is compared with what the formula gives: equal at
 *    2 dp (a paste of the sheet's own figure) → stays a formula; different → a
 *    TYPED value that replaces the formula for that cell;
 *  - then every formula cell is recalculated.
 */
export function applyFormulasToEdit<R extends FormulaRow>(
  sheet: NpdSheetKind,
  before: readonly R[],
  after: readonly R[],
  ctx: NpdFormulaContext,
): R[] {
  const prevById = new Map(before.map((r) => [r.id, r]));
  const cols = NPD_COLUMNS[sheet];
  return after.map((row, rowIndex) => {
    const prev = prevById.get(row.id);
    if (prev === row) return row;
    const overrides = new Set(row.overrides);
    const formulas: Record<string, string> = { ...row.formulas };
    const values = [...row.values];
    const edited: number[] = [];
    cols.forEach((_, i) => {
      if (!prev || (row.values[i] ?? '') !== (prev.values[i] ?? '')) edited.push(i);
    });
    for (const i of edited) {
      const key = cols[i]!.key;
      const text = values[i] ?? '';
      if (text.trim().startsWith('=')) {
        try {
          const stored = toStoredFormula(text, rowIndex + 1, cols);
          const { [key]: _own, ...rest } = formulas;
          void _own;
          // The column's own formula typed back in: no per-cell copy of it.
          if (formulaBehind(sheet, { formulas: rest }, key, ctx)?.formula === stored) delete formulas[key];
          else formulas[key] = stored;
          overrides.delete(key);
          continue;
        } catch {
          // Not a readable formula: keep it as the text that was typed.
        }
      }
      const hadOwn = key in formulas;
      delete formulas[key];
      const behind = formulaBehind(sheet, { formulas }, key, ctx);
      if (!behind) {
        if (hadOwn) overrides.delete(key);
        continue;
      }
      if (text.trim() === '') {
        overrides.delete(key);
        continue;
      }
      overrides.delete(key);
      const result = evaluateRow(sheet, { ...row, values, overrides: [...overrides], formulas }, ctx)[key];
      const same =
        result?.kind === 'value'
          ? sameAtDisplay(text, result.n)
          : result?.kind === 'error'
            ? text.trim().toUpperCase() === result.err
            : false;
      if (!same) overrides.add(key);
    }
    return recomputeRow(sheet, { ...row, values, overrides: [...overrides], formulas }, ctx);
  });
}

/**
 * After the rate or a column formula changed: recalculate, and fold back into
 * the formula any typed value that now equals what the formula gives (pasted
 * USD figures, before the week's rate was typed, are the case this exists for).
 */
export function recomputeAfterSettingsChange<R extends FormulaRow>(sheet: NpdSheetKind, rows: readonly R[], ctx: NpdFormulaContext): R[] {
  const cols = NPD_COLUMNS[sheet];
  return rows.map((row) => {
    if (row.overrides.length === 0) return recomputeRow(sheet, row, ctx);
    const overrides = new Set(row.overrides);
    for (const key of row.overrides) {
      overrides.delete(key);
      const result = evaluateRow(sheet, { ...row, overrides: [...overrides] }, ctx)[key];
      const i = cols.findIndex((c) => c.key === key);
      if (!(result?.kind === 'value' && sameAtDisplay(row.values[i] ?? '', result.n))) overrides.add(key);
    }
    return recomputeRow(sheet, { ...row, overrides: [...overrides] }, ctx);
  });
}

// ─── The PHP→USD rate ────────────────────────────────────────────────────────

/**
 * The sheet's conversion multiplies pesos by dollars-per-peso (0.0162575 that
 * week). A value ≥ 1 is almost certainly pesos-per-dollar (61.51) typed the wrong
 * way round — every USD figure would be ~3,800× too large — so it is refused.
 */
export function parseUsdPerPhp(raw: string): { ok: true; rate: number | null } | { ok: false; error: string } {
  const t = raw.trim();
  if (t === '') return { ok: true, rate: null };
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return { ok: false, error: 'The rate must be a number like 0.0162575.' };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'The rate must be more than 0.' };
  if (n >= 1) {
    return {
      ok: false,
      error: `That looks like pesos per dollar. NPD multiplies pesos by dollars per peso (0.0162575 = 1 ÷ 61.51); for ${t} that is ${(1 / n).toFixed(7)}.`,
    };
  }
  return { ok: true, rate: n };
}
