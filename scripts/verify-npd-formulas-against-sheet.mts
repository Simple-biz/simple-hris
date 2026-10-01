/**
 * [NPD-FORMULAS] READ-ONLY check that NPD's formula engine gives the Google
 * Sheet's own figures. Reads the NEW Payroll Dashboard spreadsheet's "All Dept"
 * and "Hogan" tabs with the HRIS service account (scope spreadsheets.readonly),
 * rebuilds every row as an NPD row, runs src/lib/npd/formulas.ts, and compares
 * each formula cell with the value the sheet computed.
 *
 *   node --import tsx scripts/verify-npd-formulas-against-sheet.mts
 *
 * Writes nothing anywhere. Prints counts, and for a mismatch only the sheet row
 * number and the two figures — never a name or an email.
 *
 * How a sheet row becomes an NPD row:
 *  - a column NPD has no formula for (hours and bonuses, which are XLOOKUPs into an
 *    hours tab in the sheet) → the sheet's computed value, typed in;
 *  - a column NPD has a formula for, where the sheet cell is the standard formula
 *    → left to NPD's formula;
 *  - where the sheet cell is TYPED, or holds a one-off formula → typed in, as an
 *    NPD override, with the sheet's value. That is what NPD does with such a cell.
 *  - RATE = the constant in that row's USD formula (=AU*0.0162575).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// CJS interop: the repo's .mts scripts import src modules as a default export.
import columnsModule from '../src/lib/npd/columns';
import formulasModule from '../src/lib/npd/formulas';
import authModule from '../src/lib/google-sheets/auth';
import type { NpdSheetKind } from '../src/lib/npd/columns';
import type { FormulaRow } from '../src/lib/npd/formulas';

const { NPD_COLUMNS, normalizeHeaderText } = columnsModule;
const { NPD_DEFAULT_FORMULAS, evaluateRow } = formulasModule;
const { getServiceAccountAccessToken } = authModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const SPREADSHEET = '1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4';
const TABS: Array<{ title: string; sheet: NpdSheetKind }> = [
  { title: 'All Dept', sheet: 'all_departments' },
  { title: 'Hogan', sheet: 'hsl' },
];

/** The sheet's standard formula per NPD key, row number as {r}, letters as in the sheet. */
const SHEET_PATTERNS: Record<NpdSheetKind, Record<string, RegExp>> = {
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

async function main() {
  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const values = async (title: string, render: 'FORMULA' | 'UNFORMATTED_VALUE') => {
    const range = encodeURIComponent(`'${title}'!A1:CZ12000`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET}/values/${range}?valueRenderOption=${render}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = (await res.json()) as { values?: unknown[][]; error?: unknown };
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    return j.values ?? [];
  };

  let failures = 0;
  for (const { title, sheet } of TABS) {
    const [formulas, computed] = await Promise.all([values(title, 'FORMULA'), values(title, 'UNFORMATTED_VALUE')]);
    const hi = formulas.findIndex((r) => r.some((c) => typeof c === 'string' && /work\s*email/i.test(c)));
    const header = (formulas[hi] ?? []).map((h) => normalizeHeaderText(String(h ?? '')));
    const cols = NPD_COLUMNS[sheet];
    // NPD column → sheet column index, by header text (first match, like the sheet's left-to-right).
    const sheetIndex = cols.map((c) => {
      const names = [c.header, ...(c.headerAliases ?? [])].map(normalizeHeaderText);
      return header.findIndex((h) => names.includes(h));
    });
    const missing = cols.filter((_, i) => sheetIndex[i]! < 0).map((c) => c.key);
    if (missing.length) console.log(`  ${title}: NPD columns with no sheet column: ${missing.join(', ')}`);
    const defaults = new Set(NPD_DEFAULT_FORMULAS[sheet].map((f) => f.key));
    const emailCol = sheetIndex[cols.findIndex((c) => c.key === 'work_email')]!;

    const tally = new Map<string, { exact: number; display: number; mismatch: number; typed: number; oneOff: number }>();
    for (const k of defaults) tally.set(k, { exact: 0, display: 0, mismatch: 0, typed: 0, oneOff: 0 });
    const shown = new Map<string, number>();
    let rows = 0;
    let noRate = 0;

    for (let r = hi + 1; r < formulas.length; r += 1) {
      const fRow = formulas[r] ?? [];
      const vRow = computed[r] ?? [];
      if (!(typeof fRow[emailCol] === 'string' && /@/.test(fRow[emailCol] as string))) continue;
      rows += 1;
      const rowNo = r + 1;
      const generic = (s: string) => s.replace(new RegExp(`(?<![0-9$])${rowNo}(?![0-9])`, 'g'), '{r}');

      let rate: number | null = null;
      const overrides: string[] = [];
      const standard = new Set<string>();
      const valuesOut = cols.map((c, i) => {
        const si = sheetIndex[i]!;
        const f = si >= 0 ? fRow[si] : undefined;
        const v = si >= 0 ? vRow[si] : undefined;
        // An error comes back from the API with its explanation ("#N/A (Did not find ...)");
        // a copy from the sheet gives just the code, which is what NPD receives.
        const text = v === undefined || v === null ? '' : String(v).replace(/^(#[A-Z0-9/!?]+)\s+\(.*\)$/s, '$1');
        if (!defaults.has(c.key)) return text;
        const isFormula = typeof f === 'string' && f.startsWith('=');
        const m = isFormula ? SHEET_PATTERNS[sheet][c.key]!.exec(generic(f as string)) : null;
        if (m) {
          standard.add(c.key);
          if (c.key === 'php_usd_conversion') rate = Number(m[1]);
          return '';
        }
        if (text !== '') {
          overrides.push(c.key);
          const t = tally.get(c.key)!;
          if (isFormula) t.oneOff += 1;
          else t.typed += 1;
        }
        return text;
      });
      if (rate === null) noRate += 1;

      const row: FormulaRow = { id: String(rowNo), values: valuesOut, overrides, formulas: {} };
      const result = evaluateRow(sheet, row, { columnFormulas: {}, rate });
      for (const key of standard) {
        const si = sheetIndex[cols.findIndex((c) => c.key === key)]!;
        const sheetValue = vRow[si];
        const mine = result[key];
        const t = tally.get(key)!;
        let exact = false;
        let display = false;
        if (typeof sheetValue === 'number' && mine?.kind === 'value') {
          exact = mine.n === sheetValue;
          display = Math.round(mine.n * 100) === Math.round(sheetValue * 100) || Math.abs(mine.n - sheetValue) < 0.005;
        } else if (typeof sheetValue === 'string' && sheetValue.startsWith('#') && mine?.kind === 'error') {
          exact = display = sheetValue.toUpperCase().startsWith(mine.err);
        } else if ((sheetValue === '' || sheetValue === undefined) && mine?.kind === 'value' && mine.n === 0) {
          exact = display = true;
        }
        if (exact) t.exact += 1;
        else if (display) t.display += 1;
        else {
          t.mismatch += 1;
          const n = shown.get(key) ?? 0;
          if (n < 5) {
            shown.set(key, n + 1);
            console.log(`  MISMATCH ${title} row ${rowNo} ${key}: sheet ${JSON.stringify(sheetValue)} vs NPD ${mine ? JSON.stringify(mine.kind === 'value' ? mine.n : mine.text) : '—'}`);
          }
        }
      }
    }

    console.log(`\n${title} → ${sheet}: ${rows} people-rows, ${noRate} with no rate in their USD cell`);
    for (const [key, t] of tally) {
      const compared = t.exact + t.display + t.mismatch;
      console.log(
        `  ${key.padEnd(24)} compared ${String(compared).padStart(5)}  exact ${String(t.exact).padStart(5)}  same at 2dp ${String(t.display).padStart(4)}  MISMATCH ${String(t.mismatch).padStart(4)}   (typed in the sheet ${t.typed}, one-off formula ${t.oneOff})`,
      );
      failures += t.mismatch;
    }
  }
  console.log(failures ? `\n${failures} formula cell(s) differ from the sheet.` : '\nEvery compared formula cell matches the sheet.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('Failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
