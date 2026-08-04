/**
 * READ-ONLY: does the Hogan sheet count WEEKEND hours toward the 40h OT threshold?
 * Decided empirically from rows where BOTH weekend hours and OT hours are nonzero.
 *
 *   hypothesis A (M-F only):   AF == max(0, AB - 40)
 *   hypothesis B (all 7 days): AF == max(0, AB + AD - 40)
 */
import { readFileSync } from 'node:fs';

const FILE = 'NEW Payroll Dashboard - Hogan.csv';

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

const rows = parseCsv(readFileSync(FILE, 'utf8'));
const H = rows[0];
// indices: AA=26 Week, AB=27, AC=28, AD=29, AE=30, AF=31, AG=32, AH=33
const I = { week: 26, mf: 27, rate: 28, we: 29, weRate: 30, ot: 31, otDiff: 32, untilOt: 33, email: 1, name: 20 };

let bothNonZero = 0, matchA = 0, matchB = 0;
const examples: string[] = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const mf = num(r[I.mf]), we = num(r[I.we]), ot = num(r[I.ot]);
  if (we <= 0 || ot <= 0) continue;
  bothNonZero++;
  const a = Math.max(0, mf - 40);
  const b = Math.max(0, mf + we - 40);
  const okA = Math.abs(ot - a) < 0.02;
  const okB = Math.abs(ot - b) < 0.02;
  if (okA) matchA++;
  if (okB) matchB++;
  if (examples.length < 14) {
    examples.push(
      `row ${String(i + 1).padStart(5)} ${String(r[I.email]).slice(0, 26).padEnd(27)} wk=${String(r[I.week]).slice(0, 10).padEnd(11)}` +
        ` M-F=${mf.toFixed(2).padStart(6)} WE=${we.toFixed(2).padStart(6)} OT=${ot.toFixed(2).padStart(6)}` +
        `  A(mf-40)=${a.toFixed(2).padStart(6)}${okA ? ' ✓' : '  '}` +
        `  B(mf+we-40)=${b.toFixed(2).padStart(6)}${okB ? ' ✓' : '  '}`,
    );
  }
}
console.log('=== rows with BOTH weekend hours and OT hours ===');
console.log(`  count: ${bothNonZero}`);
console.log(`  matches A (OT from M-F only)     : ${matchA}`);
console.log(`  matches B (OT from all 7 days)   : ${matchB}\n`);
examples.forEach((e) => console.log('  ' + e));

// Does "Hours Until OT" (AH) ever account for weekend hours?
let ahFromMf = 0, ahFromAll = 0, ahRows = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const mf = num(r[I.mf]), we = num(r[I.we]);
  const ah = String(r[I.untilOt] ?? '').trim();
  if (ah === '' || we <= 0) continue;
  ahRows++;
  if (Math.abs(num(ah) - Math.max(0, 40 - mf)) < 0.02) ahFromMf++;
  if (Math.abs(num(ah) - Math.max(0, 40 - mf - we)) < 0.02) ahFromAll++;
}
console.log(`\n=== "Hours Until OT" on rows WITH weekend hours (n=${ahRows}) ===`);
console.log(`  == 40 - M-F           : ${ahFromMf}`);
console.log(`  == 40 - M-F - WE      : ${ahFromAll}`);

// erjiee, by email, newest weeks
console.log('\n=== erjiee@simple.biz rows (by Work Email) ===');
const mine = rows
  .map((r, i) => ({ r, i }))
  .filter((x) => /^erjiee@simple\.biz$/i.test(String(x.r[I.email] ?? '').trim()));
console.log(`  found ${mine.length}`);
for (const { r, i } of mine.slice(-8)) {
  const mf = num(r[I.mf]), we = num(r[I.we]), ot = num(r[I.ot]);
  const total = mf * num(r[I.rate]) + we * num(r[I.weRate]) + ot * num(r[I.otDiff]);
  console.log(
    `  row ${String(i + 1).padStart(5)} wk=${String(r[I.week]).slice(0, 12).padEnd(13)}` +
      ` M-F=${mf.toFixed(2).padStart(6)}@${String(r[I.rate]).padStart(5)}` +
      ` WE=${we.toFixed(2).padStart(6)}@${String(r[I.weRate]).padStart(5)}` +
      ` OT=${ot.toFixed(2).padStart(5)}@${String(r[I.otDiff]).padStart(6)}` +
      `  subtotal=${total.toFixed(2)}`,
  );
}
