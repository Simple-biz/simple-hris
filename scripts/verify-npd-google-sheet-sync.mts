/**
 * [NPD-SYNC] READ-ONLY end-to-end check of NPD's Google Sheet sync (All Dept Payroll
 * CSV · Hogan Payroll Sync): for EVERY week in both tabs, build the NPD sheet the
 * sync would load (src/lib/npd/google-sheet-import.ts), let NPD's formula engine
 * fill it exactly as the save does, and compare every cell with the Google Sheet.
 *
 *   node --import tsx scripts/verify-npd-google-sheet-sync.mts
 *
 * Reads the sheet with the HRIS service account (spreadsheets.readonly). Writes
 * nothing anywhere. Prints counts, and for a mismatch only the sheet row number, the
 * column key and the two figures — never a name or an email.
 *
 * A cell matches when:
 *  - NPD computes it (standard formula): NPD's figure is the sheet's, to the bit;
 *  - NPD holds it as text (an input, or a typed-over formula cell): read by NPD's
 *    parser it is exactly the sheet's number, or the same text.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// CJS interop: the repo's .mts scripts import src modules as a default export.
import columnsModule from '../src/lib/npd/columns';
import formulasModule from '../src/lib/npd/formulas';
import importModule from '../src/lib/npd/google-sheet-import';
import fetchModule from '../src/lib/google-sheets/fetch-npd-sheet';
import type { NpdSheetKind } from '../src/lib/npd/columns';

const { NPD_COLUMNS } = columnsModule;
const { evaluateRow, formulaBehind, parseSheetNumber, parseUsdPerPhp } = formulasModule;
const { buildNpdImport, findHeaderRow, mapSheetColumns, parseSheetWeekLabel } = importModule;
const { fetchNpdSheetGrids } = fetchModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const ERROR_EXPLAINED = /^(#[A-Z0-9/!?]+)\s+\([\s\S]*\)$/;

async function main() {
  let failures = 0;
  for (const sheet of ['all_departments', 'hsl'] as NpdSheetKind[]) {
    const { tab, grids } = await fetchNpdSheetGrids(sheet);
    const cols = NPD_COLUMNS[sheet];
    const hi = findHeaderRow(grids.formatted);
    const sheetIndex = mapSheetColumns(sheet, grids.formatted[hi] ?? []);
    const weekCol = sheetIndex[cols.findIndex((c) => c.key === 'week')]!;
    const weeks = new Set<string>();
    for (let r = hi + 1; r < grids.formatted.length; r += 1) {
      const p = parseSheetWeekLabel(String(grids.formatted[r]?.[weekCol] ?? ''));
      if (p) weeks.add(p.start);
    }

    let cells = 0;
    let computed = 0;
    let typed = 0;
    let mismatches = 0;
    let rowsTotal = 0;
    const shown = new Map<string, number>();
    console.log(`\n${tab} → ${sheet}: ${weeks.size} weeks`);
    for (const week of [...weeks].sort()) {
      const result = buildNpdImport({ sheet, week, tab, grids });
      if (!result.ok) {
        console.log(`  ${week}: REFUSED — ${result.error}`);
        failures += 1;
        continue;
      }
      const rate = parseUsdPerPhp(result.rateText);
      const ctx = { columnFormulas: {}, rate: rate.ok ? rate.rate : null };
      rowsTotal += result.rows.length;
      for (const r of result.rows) {
        const row = { id: String(r.sheetRow), values: r.values, overrides: r.overrides, formulas: {} };
        const figures = evaluateRow(sheet, row, ctx);
        const sheetValues = grids.values[r.sheetRow - 1] ?? [];
        cols.forEach((c, i) => {
          cells += 1;
          const raw = sheetValues[sheetIndex[i]!];
          const want = raw === undefined || raw === null ? '' : raw;
          const isComputed = !!formulaBehind(sheet, row, c.key, ctx) && !r.overrides.includes(c.key);
          let ok: boolean;
          let mine: unknown;
          if (isComputed) {
            computed += 1;
            const f = figures[c.key];
            mine = f ? (f.kind === 'value' ? f.n : f.text) : '—';
            if (typeof want === 'number') ok = f?.kind === 'value' && f.n === want;
            else if (want === '') ok = f?.kind === 'value' ? f.n === 0 : f?.kind === 'blank';
            else ok = f?.kind === 'error' && String(want).replace(ERROR_EXPLAINED, '$1').toUpperCase() === f.err;
          } else {
            typed += 1;
            const text = r.values[i] ?? '';
            mine = text;
            if (typeof want === 'number') {
              const p = parseSheetNumber(text);
              ok = p.ok && typeof p.n === 'number' && !p.bool && p.n === want;
            } else if (typeof want === 'boolean') ok = text.toUpperCase() === String(want).toUpperCase();
            else ok = text === String(want).replace(ERROR_EXPLAINED, '$1') || (text === '' && String(want).trim() === '');
            // Text the sheet shows differently from its value (a date, say) is still the sheet's display.
            if (!ok && typeof want === 'string') ok = text === String(grids.formatted[r.sheetRow - 1]?.[sheetIndex[i]!] ?? '');
          }
          if (!ok) {
            mismatches += 1;
            const n = shown.get(c.key) ?? 0;
            if (n < 5) {
              shown.set(c.key, n + 1);
              // Figures and error codes only: never a name, an email or a note.
              const show = (v: unknown) =>
                typeof v === 'number' || /^(?:[-$₱(]*[0-9][0-9.,]*\)?|#[A-Z0-9/!?]+|)$/.test(String(v)) ? JSON.stringify(v) : '(text)';
              console.log(`  MISMATCH ${week} row ${r.sheetRow} ${c.key}: sheet ${show(want)} vs NPD ${show(mine)}`);
            }
          }
        });
      }
      const s = result.summary;
      console.log(
        `  ${week}: ${String(s.rows).padStart(4)} rows · rate ${s.rate ?? 'none'}${s.otherRates.length ? ` (+${s.otherRates.map((o) => `${o.rate}×${o.rows}`).join(', ')})` : ''} · typed ${s.typedCells} · skipped other ${s.skipped.otherWeek} / no week ${s.skipped.noWeek} / unreadable ${s.skipped.unreadableWeek}`,
      );
    }
    console.log(`  ${rowsTotal} rows · ${cells} cells (${computed} computed by NPD, ${typed} as text) · MISMATCH ${mismatches}`);
    failures += mismatches;
  }
  console.log(failures ? `\n${failures} problem(s).` : '\nEvery cell of every synced week matches the Google Sheet.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('Failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
