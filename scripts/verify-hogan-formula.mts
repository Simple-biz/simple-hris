/**
 * Verify src/lib/payroll/hogan-week-pay.ts against the REAL Hogan sheet export.
 *
 * The sheet is the authority Accounting pays from, so it is the correct oracle for our
 * engine. This replays every populated row through computeHoganWeekPay and asserts our
 * subtotal equals the sheet's own AN ("Total Hourly Pay") arithmetic to the centavo.
 *
 * The CSV is NOT committed — it holds real names and salaries. Export the tab yourself
 * to the repo root (or pass a path) and run:
 *
 *   npx tsx scripts/verify-hogan-formula.mts ["NEW Payroll Dashboard - Hogan.csv"]
 *
 * READ-ONLY: reads a local file, touches no database.
 */
import { existsSync, readFileSync } from 'node:fs';

const { computeHoganWeekPay, collapsedEquivalent } = await import('../src/lib/payroll/hogan-week-pay');

const FILE = process.argv.slice(2).find((a) => a.endsWith('.csv')) ?? 'NEW Payroll Dashboard - Hogan.csv';
if (!existsSync(FILE)) {
  console.error(`Not found: ${FILE}\nExport the Hogan tab as CSV first (it is deliberately not committed).`);
  process.exit(1);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const num = (v: unknown) => {
  const s = String(v ?? '').replace(/[₱,$\s]/g, '');
  if (!s || s === '-') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const blank = (v: unknown) => String(v ?? '').trim() === '';

// Column indices, 0-based: AA=26 … AL=37
const I = { week: 26, mf: 27, rate: 28, we: 29, weRate: 30, ot: 31, otDiff: 32, untilOt: 33, orphanPay: 35, mwHours: 36, mwRate: 37, email: 1 };

const rows = parseCsv(readFileSync(FILE, 'utf8'));
console.log(`${FILE}: ${rows.length} lines\n`);

let checked = 0, ok = 0;
const mismatches: string[] = [];
const ruleFailures = { weRate: 0, otDiff: 0, otHours: 0, untilOt: 0 };
let maxDelta = 0;
let collapsedAgree = 0;

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (blank(r[I.rate]) || (blank(r[I.mf]) && blank(r[I.we]))) continue;
  const mf = num(r[I.mf]), we = num(r[I.we]), rate = num(r[I.rate]);
  if (rate <= 0) continue;
  checked++;

  // the sheet's own arithmetic, straight from its cells
  const sheetTotal =
    Math.round((mf * rate + we * num(r[I.weRate]) + num(r[I.ot]) * num(r[I.otDiff])
      + num(r[I.orphanPay]) + num(r[I.mwHours]) * num(r[I.mwRate])) * 100) / 100;

  const p = computeHoganWeekPay({
    mfHours: mf,
    weHours: we,
    regularRatePhp: rate,
    orphanPayPhp: num(r[I.orphanPay]),
    midweek: blank(r[I.mwHours]) || blank(r[I.mwRate])
      ? null
      : { hours: num(r[I.mwHours]), ratePhp: num(r[I.mwRate]) },
  });

  // Do the sheet's DERIVED columns match our derivation?
  if (!blank(r[I.weRate]) && Math.abs(num(r[I.weRate]) - p.weekendRatePhp) > 0.005) ruleFailures.weRate++;
  if (!blank(r[I.otDiff]) && Math.abs(num(r[I.otDiff]) - p.otDifferentialPhp) > 0.005) ruleFailures.otDiff++;
  if (!blank(r[I.ot]) && Math.abs(num(r[I.ot]) - p.otHours) > 0.02) ruleFailures.otHours++;
  if (!blank(r[I.untilOt]) && Math.abs(num(r[I.untilOt]) - p.hoursUntilOt) > 0.02) ruleFailures.untilOt++;

  const delta = Math.abs(p.totalHourlyPayPhp - sheetTotal);
  maxDelta = Math.max(maxDelta, delta);
  if (delta <= 0.02) ok++;
  else if (mismatches.length < 12) {
    mismatches.push(
      `row ${String(i + 1).padStart(5)} ${String(r[I.email]).slice(0, 24).padEnd(25)} wk=${String(r[I.week]).slice(0, 11).padEnd(12)}` +
        ` M-F=${mf.toFixed(2)} WE=${we.toFixed(2)} rate=${rate}` +
        ` | sheet=${sheetTotal.toFixed(2)} ours=${p.totalHourlyPayPhp.toFixed(2)} Δ=${delta.toFixed(2)}`,
    );
  }

  const c = collapsedEquivalent(p);
  const twoStage = Math.round((p.basePayPhp + p.weekendPayPhp + p.otDifferentialPayPhp) * 100) / 100;
  if (Math.abs(c.totalPhp - twoStage) <= 0.02) collapsedAgree++;
}

console.log('='.repeat(88));
console.log(`rows checked                       : ${checked}`);
console.log(`totals matching the sheet (±₱0.02) : ${ok}   (${((ok / checked) * 100).toFixed(2)}%)`);
console.log(`largest single-row divergence      : ₱${maxDelta.toFixed(2)}`);
console.log(`two-stage == collapsed presentation: ${collapsedAgree}/${checked}`);
console.log('\nDERIVED-COLUMN RULES (0 failures means the sheet never stores an exception):');
console.log(`  "Hogan WE Rate"   != regular + 15   : ${ruleFailures.weRate}`);
console.log(`  "OT Differential" != regular x 0.5  : ${ruleFailures.otDiff}`);
console.log(`  "Total OT Hours"  != max(0,M-F+WE-40): ${ruleFailures.otHours}`);
console.log(`  "Hours Until OT"  != max(0,40-M-F-WE): ${ruleFailures.untilOt}`);
if (mismatches.length) {
  console.log('\nfirst mismatches:');
  mismatches.forEach((m) => console.log('  ' + m));
}
console.log('='.repeat(88));
